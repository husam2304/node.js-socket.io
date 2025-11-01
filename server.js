const express = require("express");
const app = express();
const server = require("http").createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json());

// ==================== CONNECTION TRACKING ====================

const userConnections = new Map(); // userId -> socketId
const userRoles = new Map(); // userId -> role
const socketUsers = new Map(); // socketId -> userId (reverse lookup)

// WebRTC call tracking (for peer-to-peer signaling)
const activeCalls = new Map(); // callId -> { callerId, receiverId, status }

// ==================== SOCKET.IO CONNECTION HANDLER ====================

io.on("connection", (socket) => {
  const userId = socket.handshake.auth.userId || `guest-${socket.id}`;
  const role = socket.handshake.auth.role || "Guest";
  const token = socket.handshake.auth.token; // JWT token (not validated here, trusted from mobile)

  // Track connection
  userConnections.set(userId, socket.id);
  socketUsers.set(socket.id, userId);
  userRoles.set(userId, role);

  // Join role-based room
  socket.join(`role-${role}`);
  socket.join(`user-${userId}`); // Personal room for targeted messages

  console.log(`✅ User ${userId} (${role}) connected - Socket: ${socket.id}`);
  console.log(`📊 Total connections: ${userConnections.size}`);

  // ==================== CHAT EVENTS ====================

  // User joins a chat room
  socket.on("chat:join-room", (data) => {
    const { chatRoomId } = data;
    socket.join(`chat-${chatRoomId}`);
    console.log(`💬 User ${userId} joined chat room: ${chatRoomId}`);

    // Notify others in the room
    socket.to(`chat-${chatRoomId}`).emit("chat:user-joined", {
      userId,
      chatRoomId,
      timestamp: new Date().toISOString(),
    });
  });

  // User leaves a chat room
  socket.on("chat:leave-room", (data) => {
    const { chatRoomId } = data;
    socket.leave(`chat-${chatRoomId}`);
    console.log(`💬 User ${userId} left chat room: ${chatRoomId}`);

    socket.to(`chat-${chatRoomId}`).emit("chat:user-left", {
      userId,
      chatRoomId,
      timestamp: new Date().toISOString(),
    });
  });

  // Typing indicator
  socket.on("chat:typing", (data) => {
    const { chatRoomId } = data;
    socket.to(`chat-${chatRoomId}`).emit("chat:user-typing", {
      userId,
      chatRoomId,
      timestamp: new Date().toISOString(),
    });
  });

  // Stop typing indicator
  socket.on("chat:stop-typing", (data) => {
    const { chatRoomId } = data;
    socket.to(`chat-${chatRoomId}`).emit("chat:user-stop-typing", {
      userId,
      chatRoomId,
      timestamp: new Date().toISOString(),
    });
  });

  // ==================== WEBRTC CALL SIGNALING (Direct P2P) ====================

  // Send WebRTC offer
  socket.on("call:offer", (data) => {
    const { callId, receiverId, offer } = data;

    // VALIDATION: Don't send offer back to sender
    if (receiverId === userId) {
      console.error(`❌ Cannot send offer to self: ${userId}`);
      socket.emit("call:error", {
        callId,
        error: "Cannot call yourself",
      });
      return;
    }

    const receiverSocketId = userConnections.get(receiverId);
    if (receiverSocketId) {
      // Send ONLY to receiver, NOT back to sender
      io.to(receiverSocketId).emit("call:offer", {
        callId,
        callerId: userId,
        offer,
        timestamp: new Date().toISOString(),
      });
      console.log(`📞 [OFFER] ${userId} → ${receiverId} (call: ${callId})`);
    } else {
      console.error(`❌ Receiver ${receiverId} not connected`);
      socket.emit("call:error", {
        callId,
        error: "Receiver not connected",
      });
    }
  });

  // Send WebRTC answer
  socket.on("call:answer", (data) => {
    const { callId, callerId, answer } = data;

    // VALIDATION: Don't send answer back to sender
    if (callerId === userId) {
      console.error(`❌ Cannot send answer to self: ${userId}`);
      return;
    }

    const callerSocketId = userConnections.get(callerId);
    if (callerSocketId) {
      // Send ONLY to caller, NOT back to answerer
      io.to(callerSocketId).emit("call:answer", {
        callId,
        answer,  // FIXED: Remove confusing receiverId field
        timestamp: new Date().toISOString(),
      });
      console.log(`📞 [ANSWER] ${userId} → ${callerId} (call: ${callId})`);
    } else {
      console.error(`❌ Caller ${callerId} not connected`);
    }
  });

  // Send ICE candidate
  socket.on("call:ice-candidate", (data) => {
    const { callId, targetUserId, candidate } = data;

    // VALIDATION: Don't send candidate back to sender
    if (targetUserId === userId) {
      console.error(`❌ Cannot send ICE candidate to self: ${userId}`);
      return;
    }

    const targetSocketId = userConnections.get(targetUserId);
    if (targetSocketId) {
      // Send ONLY to target, NOT back to sender
      io.to(targetSocketId).emit("call:ice-candidate", {
        callId,
        candidate,  // FIXED: Removed confusing fromUserId field
        timestamp: new Date().toISOString(),
      });
      console.log(`📞 [ICE] ${userId} → ${targetUserId} (call: ${callId})`);
    } else {
      console.error(`❌ Target ${targetUserId} not connected for ICE candidate`);
    }
  });
  // ==================== GENERAL EVENTS ====================

  // Ping/Pong for keep-alive
  socket.on("ping", () => {
    socket.emit("pong", {
      timestamp: new Date().toISOString(),
      userId
    });
  });

  // Handle disconnect
  socket.on("disconnect", (reason) => {
    const disconnectedUserId = socketUsers.get(socket.id);

    userConnections.delete(disconnectedUserId);
    socketUsers.delete(socket.id);
    userRoles.delete(disconnectedUserId);

    console.log(
      `❌ User ${disconnectedUserId} (${role}) disconnected - Reason: ${reason}`
    );
    console.log(`📊 Total connections: ${userConnections.size}`);
  });
});

// ==================== REST API FOR ASP.NET INTEGRATION ====================

// Send chat message to specific user
app.post("/notify/chat/message", (req, res) => {
  const { chatRoomId, recipientIds, messageData } = req.body;

  if (!chatRoomId || !recipientIds || !messageData) {
    return res.status(400).json({
      success: false,
      error: "chatRoomId, recipientIds, and messageData are required",
    });
  }

  let deliveredCount = 0;
  const results = {};

  recipientIds.forEach((userId) => {
    const socketId = userConnections.get(userId);
    if (socketId) {
      io.to(socketId).emit("chat:message", messageData);
      results[userId] = true;
      deliveredCount++;
    } else {
      results[userId] = false;
    }
  });

  // Also emit to chat room (for any connected users)
  io.to(`chat-${chatRoomId}`).emit("chat:message", messageData);

  console.log(`💬 Chat message sent to ${deliveredCount}/${recipientIds.length} users in room ${chatRoomId}`);

  res.json({
    success: true,
    deliveredCount,
    totalRecipients: recipientIds.length,
    results,
  });
});

// Notify about message read status
app.post("/notify/chat/read", (req, res) => {
  const { chatRoomId, userId, messageId } = req.body;

  if (!chatRoomId || !messageId) {
    return res.status(400).json({
      success: false,
      error: "chatRoomId and messageId are required",
    });
  }

  // Emit to everyone in the chat room
  io.to(`chat-${chatRoomId}`).emit("chat:message-read", {
    chatRoomId,
    messageId,
    readBy: userId,
    timestamp: new Date().toISOString(),
  });

  console.log(`✓ Message ${messageId} marked as read by ${userId}`);

  res.json({ success: true });
});

// Send call notification (call initiated from .NET)
app.post("/notify/call/incoming", (req, res) => {
  const { callId, receiverId, callerData } = req.body;

  if (!callId || !receiverId || !callerData) {
    return res.status(400).json({
      success: false,
      error: "callId, receiverId, and callerData are required",
    });
  }

  const receiverSocketId = userConnections.get(receiverId);

  if (receiverSocketId) {
    io.to(receiverSocketId).emit("call:incoming", {
      callId,
      callerId: callerData.callerId,
      callerName: callerData.callerName,
      callerImage: callerData.callerImage,
      timestamp: new Date().toISOString(),
    });

    console.log(`📞 Incoming call notification sent to ${receiverId} from ${callerData.callerName}`);
    return res.json({ success: true, delivered: true });
  }

  console.log(`⚠️ User ${receiverId} not connected for call notification`);
  res.json({ success: true, delivered: false });
});

// Call answered notification
app.post("/notify/call/answered", (req, res) => {
  const { callId, callerId } = req.body;

  if (!callId || !callerId) {
    return res.status(400).json({
      success: false,
      error: "callId and callerId are required",
    });
  }

  const callerSocketId = userConnections.get(callerId);

  if (callerSocketId) {
    io.to(callerSocketId).emit("call:answered", {
      callId,
      timestamp: new Date().toISOString(),
    });

    console.log(`📞 Call ${callId} answered notification sent to ${callerId}`);
    return res.json({ success: true, delivered: true });
  }

  res.json({ success: true, delivered: false });
});

// Call ended notification
app.post("/notify/call/ended", (req, res) => {
  const { callId, userIds } = req.body;

  if (!callId || !userIds) {
    return res.status(400).json({
      success: false,
      error: "callId and userIds are required",
    });
  }

  let deliveredCount = 0;
  userIds.forEach((userId) => {
    const socketId = userConnections.get(userId);
    if (socketId) {
      io.to(socketId).emit("call:ended", {
        callId,
        timestamp: new Date().toISOString(),
      });
      deliveredCount++;
    }
  });

  console.log(`📞 Call ${callId} ended notification sent to ${deliveredCount} users`);
  res.json({ success: true, deliveredCount });
});

// Call rejected notification
app.post("/notify/call/rejected", (req, res) => {
  const { callId, callerId } = req.body;

  if (!callId || !callerId) {
    return res.status(400).json({
      success: false,
      error: "callId and callerId are required",
    });
  }

  const callerSocketId = userConnections.get(callerId);

  if (callerSocketId) {
    io.to(callerSocketId).emit("call:rejected", {
      callId,
      timestamp: new Date().toISOString(),
    });

    console.log(`📞 Call ${callId} rejected notification sent to ${callerId}`);
    return res.json({ success: true, delivered: true });
  }

  res.json({ success: true, delivered: false });
});

// ==================== EXISTING NOTIFICATION ENDPOINTS ====================

// Send to single user
app.post("/notify/user", (req, res) => {
  const { userId, event, data } = req.body;

  if (!userId || !event) {
    return res.status(400).json({
      success: false,
      error: "userId and event are required",
    });
  }

  const socketId = userConnections.get(userId);

  if (socketId) {
    io.to(socketId).emit(event, data);
    console.log(`📤 Sent ${event} to user ${userId}`);
    return res.json({ success: true, delivered: true });
  }

  console.log(`⚠️ User ${userId} not connected`);
  res.json({ success: true, delivered: false });
});

// Send to multiple users
app.post("/notify/users", (req, res) => {
  const { userIds, event, data } = req.body;

  if (!userIds || !Array.isArray(userIds) || !event) {
    return res.status(400).json({
      success: false,
      error: "userIds (array) and event are required",
    });
  }

  const results = {};
  let deliveredCount = 0;

  userIds.forEach((userId) => {
    const socketId = userConnections.get(userId);
    if (socketId) {
      io.to(socketId).emit(event, data);
      results[userId] = true;
      deliveredCount++;
    } else {
      results[userId] = false;
    }
  });

  console.log(`📤 Sent ${event} to ${deliveredCount}/${userIds.length} users`);
  res.json({
    success: true,
    results,
    deliveredCount,
    totalUsers: userIds.length,
  });
});

// Broadcast to role
app.post("/notify/role", (req, res) => {
  const { role, event, data } = req.body;

  if (!role || !event) {
    return res.status(400).json({
      success: false,
      error: "role and event are required",
    });
  }

  const usersInRole = Array.from(userRoles.entries()).filter(
    ([_, userRole]) => userRole.toLowerCase() === role.toLowerCase()
  ).length;

  io.to(`role-${role}`).emit(event, data);

  console.log(`📣 Broadcast ${event} to role ${role} (${usersInRole} users)`);
  res.json({ success: true, usersCount: usersInRole });
});

// Broadcast to all
app.post("/notify/all", (req, res) => {
  const { event, data } = req.body;

  if (!event) {
    return res.status(400).json({
      success: false,
      error: "event is required",
    });
  }

  io.emit(event, data);

  console.log(`📣 Broadcast ${event} to all (${userConnections.size} users)`);
  res.json({ success: true, usersCount: userConnections.size });
});

// ==================== UTILITY ENDPOINTS ====================

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "bxpress-realtime",
    connections: userConnections.size,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Get connection stats
app.get("/stats", (req, res) => {
  const roleStats = {};

  userRoles.forEach((role, userId) => {
    roleStats[role] = (roleStats[role] || 0) + 1;
  });

  res.json({
    totalConnections: userConnections.size,
    roleStats,
    activeCalls: activeCalls.size,
    timestamp: new Date().toISOString(),
  });
});

// Get connections list (for debugging)
app.get("/connections", (req, res) => {
  const connections = Array.from(userConnections.entries()).map(
    ([userId, socketId]) => ({
      userId,
      socketId,
      role: userRoles.get(userId),
    })
  );

  res.json({ connections, total: connections.length });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    service: "BxPress Real-time Service",
    version: "2.0.0",
    status: "running",
    connections: userConnections.size,
    features: ["chat", "calls", "notifications"],
    endpoints: {
      chat: {
        "POST /notify/chat/message": "Send chat message to users",
        "POST /notify/chat/read": "Notify message read status",
      },
      calls: {
        "POST /notify/call/incoming": "Notify incoming call",
        "POST /notify/call/answered": "Notify call answered",
        "POST /notify/call/ended": "Notify call ended",
        "POST /notify/call/rejected": "Notify call rejected",
      },
      notifications: {
        "POST /notify/user": "Send to single user",
        "POST /notify/users": "Send to multiple users",
        "POST /notify/role": "Broadcast to role",
        "POST /notify/all": "Broadcast to all",
      },
      utility: {
        "GET /health": "Health check",
        "GET /stats": "Connection statistics",
        "GET /connections": "List all connections",
      },
    },
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({
    success: false,
    error: err.message,
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║                                              ║
║   🚀 BxPress Real-time Service              ║
║                                              ║
║   Features: Chat, Calls, Notifications      ║
║   Port: ${PORT}                                   ║
║   Environment: ${process.env.NODE_ENV || "development"}              ║
║                                              ║
╚══════════════════════════════════════════════╝
    `);
  console.log("📡 Socket.IO Events:");
  console.log("   💬 Chat: join-room, leave-room, typing, stop-typing");
  console.log("   📞 Calls: offer, answer, ice-candidate");
  console.log("   📤 Notifications: via REST API\n");
  console.log("🔌 Waiting for connections...\n");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, closing server...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});