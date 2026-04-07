require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const slugify = require("slugify");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL ? [process.env.CLIENT_URL] : "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors({
  origin: process.env.CLIENT_URL ? [process.env.CLIENT_URL] : "*"
}));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

/*
============================================================
IN-MEMORY DATA
Replace with database later
============================================================
*/

const rooms = new Map();
/*
room shape:
{
  id,
  name,
  slug,
  joinCode,
  passwordHash,
  creatorUserId,
  createdAt,
  messages: [],
  users: Map<socketId, {
    socketId,
    userId,
    username,
    isAdmin,
    isAudioOn,
    isVideoOn,
    joinedAt
  }>
}
*/

const userSessions = new Map();
/*
socketId -> {
  roomId,
  userId,
  username
}
*/

/*
============================================================
UTILS
============================================================
*/

function makeJoinCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function uniqueSlug(baseName) {
  const base = slugify(baseName, { lower: true, strict: true }) || "room";
  let slug = base;
  let count = 1;

  while ([...rooms.values()].some(r => r.slug === slug)) {
    slug = `${base}-${count++}`;
  }
  return slug;
}

function uniqueJoinCode() {
  let code = makeJoinCode();
  while ([...rooms.values()].some(r => r.joinCode === code)) {
    code = makeJoinCode();
  }
  return code;
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    slug: room.slug,
    joinCode: room.joinCode,
    userCount: room.users.size,
    creatorUserId: room.creatorUserId,
    createdAt: room.createdAt,
    users: [...room.users.values()].map(u => ({
      socketId: u.socketId,
      userId: u.userId,
      username: u.username,
      isAdmin: u.isAdmin,
      isAudioOn: u.isAudioOn,
      isVideoOn: u.isVideoOn,
      joinedAt: u.joinedAt
    }))
  };
}

function signRoomToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function verifyRoomToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function findRoomById(roomId) {
  return rooms.get(roomId) || null;
}

function findRoomBySlug(slug) {
  return [...rooms.values()].find(r => r.slug === slug) || null;
}

function findRoomByCode(code) {
  return [...rooms.values()].find(r => r.joinCode === code.toUpperCase()) || null;
}

function getSocketUserRoom(socket) {
  const session = userSessions.get(socket.id);
  if (!session) return null;
  const room = findRoomById(session.roomId);
  if (!room) return null;
  const user = room.users.get(socket.id);
  if (!user) return null;
  return { room, user, session };
}

function addSystemMessage(room, text) {
  const message = {
    id: uuidv4(),
    type: "system",
    username: "System",
    text,
    timestamp: Date.now()
  };
  room.messages.push(message);
  if (room.messages.length > 200) room.messages.shift();
  io.to(room.id).emit("chat-message", message);
}

function addUserMessage(room, username, text) {
  const message = {
    id: uuidv4(),
    type: "user",
    username,
    text,
    timestamp: Date.now()
  };
  room.messages.push(message);
  if (room.messages.length > 200) room.messages.shift();
  return message;
}

function emitRoomUsers(room) {
  io.to(room.id).emit("room-users-updated", {
    users: publicRoom(room).users,
    userCount: room.users.size
  });
}

function sanitizeMessage(text) {
  return String(text || "").trim().slice(0, 4000);
}

function sanitizeUsername(name) {
  return String(name || "").trim().slice(0, 32);
}

/*
============================================================
API ROUTES
============================================================
*/

// Health
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

// Create room
app.post("/api/rooms", async (req, res) => {
  try {
    const { name, password, username } = req.body || {};

    const cleanName = String(name || "").trim().slice(0, 80);
    const cleanPassword = String(password || "").trim();
    const cleanUsername = sanitizeUsername(username);

    if (!cleanName) {
      return res.status(400).json({ error: "Room name is required." });
    }

    if (cleanPassword.length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters." });
    }

    if (!cleanUsername) {
      return res.status(400).json({ error: "Username is required." });
    }

    const roomId = uuidv4();
    const creatorUserId = uuidv4();
    const passwordHash = await bcrypt.hash(cleanPassword, 10);
    const slug = uniqueSlug(cleanName);
    const joinCode = uniqueJoinCode();

    const room = {
      id: roomId,
      name: cleanName,
      slug,
      joinCode,
      passwordHash,
      creatorUserId,
      createdAt: Date.now(),
      messages: [],
      users: new Map()
    };

    rooms.set(roomId, room);

    const token = signRoomToken({
      roomId,
      userId: creatorUserId,
      username: cleanUsername,
      isAdmin: true
    });

    return res.status(201).json({
      roomId,
      name: cleanName,
      slug,
      joinCode,
      creatorUserId,
      token
    });
  } catch (err) {
    console.error("CREATE ROOM ERROR:", err);
    return res.status(500).json({ error: "Failed to create room." });
  }
});

// Lookup room by slug or code
app.get("/api/rooms/lookup", (req, res) => {
  try {
    const { slug, code } = req.query;

    let room = null;
    if (slug) room = findRoomBySlug(String(slug).trim());
    if (code) room = findRoomByCode(String(code).trim());

    if (!room) {
      return res.status(404).json({ error: "Room not found." });
    }

    return res.json({
      roomId: room.id,
      name: room.name,
      slug: room.slug,
      joinCode: room.joinCode,
      userCount: room.users.size
    });
  } catch (err) {
    console.error("LOOKUP ERROR:", err);
    return res.status(500).json({ error: "Room lookup failed." });
  }
});

// Validate room password and issue room token
app.post("/api/rooms/:roomId/validate", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { password, username } = req.body || {};

    const room = findRoomById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found." });
    }

    const ok = await bcrypt.compare(String(password || ""), room.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid room password." });
    }

    const cleanUsername = sanitizeUsername(username || "Guest");
    const userId = uuidv4();
    const isAdmin = false;

    const token = signRoomToken({
      roomId: room.id,
      userId,
      username: cleanUsername,
      isAdmin
    });

    return res.json({
      ok: true,
      token
    });
  } catch (err) {
    console.error("VALIDATE ERROR:", err);
    return res.status(500).json({ error: "Password validation failed." });
  }
});

/*
============================================================
SOCKET.IO
============================================================
*/

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // join-room
  socket.on("join-room", async (payload = {}) => {
    try {
      const { roomId, token, username } = payload;

      if (!roomId || !token) {
        socket.emit("error-message", { message: "Missing roomId or token." });
        return;
      }

      let decoded;
      try {
        decoded = verifyRoomToken(token);
      } catch {
        socket.emit("error-message", { message: "Invalid or expired token." });
        return;
      }

      if (decoded.roomId !== roomId) {
        socket.emit("error-message", { message: "Token does not match room." });
        return;
      }

      const room = findRoomById(roomId);
      if (!room) {
        socket.emit("error-message", { message: "Room not found." });
        return;
      }

      // Prevent duplicate username in same room
      const requestedName = sanitizeUsername(username || decoded.username || "Guest");
      const duplicate = [...room.users.values()].find(
        u => u.username.toLowerCase() === requestedName.toLowerCase()
      );
      if (duplicate) {
        socket.emit("error-message", { message: "Username already taken in this room." });
        return;
      }

      await socket.join(room.id);

      const user = {
        socketId: socket.id,
        userId: decoded.userId,
        username: requestedName,
        isAdmin: decoded.userId === room.creatorUserId || !!decoded.isAdmin,
        isAudioOn: false,
        isVideoOn: false,
        joinedAt: Date.now()
      };

      room.users.set(socket.id, user);
      userSessions.set(socket.id, {
        roomId: room.id,
        userId: user.userId,
        username: user.username
      });

      socket.emit("room-joined", {
        room: publicRoom(room),
        messages: room.messages
      });

      socket.to(room.id).emit("user-joined", {
        user,
        userCount: room.users.size
      });

      emitRoomUsers(room);
      addSystemMessage(room, `${user.username} joined the room.`);
    } catch (err) {
      console.error("JOIN ROOM ERROR:", err);
      socket.emit("error-message", { message: "Failed to join room." });
    }
  });

  // chat-message
  socket.on("chat-message", ({ text } = {}) => {
    try {
      const data = getSocketUserRoom(socket);
      if (!data) return;

      const { room, user } = data;
      const cleanText = sanitizeMessage(text);

      if (!cleanText) return;

      const message = addUserMessage(room, user.username, cleanText);
      io.to(room.id).emit("chat-message", message);
    } catch (err) {
      console.error("CHAT MESSAGE ERROR:", err);
    }
  });

  // typing indicators
  socket.on("typing-start", () => {
    const data = getSocketUserRoom(socket);
    if (!data) return;
    socket.to(data.room.id).emit("typing-start", { username: data.user.username });
  });

  socket.on("typing-stop", () => {
    const data = getSocketUserRoom(socket);
    if (!data) return;
    socket.to(data.room.id).emit("typing-stop", { username: data.user.username });
  });

  // reactions
  socket.on("send-reaction", ({ emoji } = {}) => {
    const data = getSocketUserRoom(socket);
    if (!data) return;

    const safeEmoji = String(emoji || "").slice(0, 8);
    if (!safeEmoji) return;

    io.to(data.room.id).emit("reaction", {
      username: data.user.username,
      emoji: safeEmoji
    });
  });

  // media state sync
  socket.on("toggle-audio", ({ isAudioOn } = {}) => {
    const data = getSocketUserRoom(socket);
    if (!data) return;

    data.user.isAudioOn = !!isAudioOn;

    io.to(data.room.id).emit("user-toggle-audio", {
      socketId: socket.id,
      userId: data.user.userId,
      username: data.user.username,
      isAudioOn: data.user.isAudioOn
    });

    emitRoomUsers(data.room);
  });

  socket.on("toggle-video", ({ isVideoOn } = {}) => {
    const data = getSocketUserRoom(socket);
    if (!data) return;

    data.user.isVideoOn = !!isVideoOn;

    io.to(data.room.id).emit("user-toggle-video", {
      socketId: socket.id,
      userId: data.user.userId,
      username: data.user.username,
      isVideoOn: data.user.isVideoOn
    });

    emitRoomUsers(data.room);
  });

  /*
  ============================================================
  WEBRTC SIGNALING
  ============================================================
  Frontend flow:
  - when a new user joins, existing users create RTCPeerConnection
  - existing user sends offer to target socket
  - target sends answer back
  - both exchange ICE candidates
  */

  socket.on("webrtc-offer", ({ targetSocketId, offer } = {}) => {
    const data = getSocketUserRoom(socket);
    if (!data) return;

    const targetUser = data.room.users.get(targetSocketId);
    if (!targetUser) return;

    io.to(targetSocketId).emit("webrtc-offer", {
      fromSocketId: socket.id,
      fromUserId: data.user.userId,
      fromUsername: data.user.username,
      offer
    });
  });

  socket.on("webrtc-answer", ({ targetSocketId, answer } = {}) => {
    const data = getSocketUserRoom(socket);
    if (!data) return;

    const targetUser = data.room.users.get(targetSocketId);
    if (!targetUser) return;

    io.to(targetSocketId).emit("webrtc-answer", {
      fromSocketId: socket.id,
      fromUserId: data.user.userId,
      fromUsername: data.user.username,
      answer
    });
  });

  socket.on("webrtc-ice-candidate", ({ targetSocketId, candidate } = {}) => {
    const data = getSocketUserRoom(socket);
    if (!data) return;

    const targetUser = data.room.users.get(targetSocketId);
    if (!targetUser) return;

    io.to(targetSocketId).emit("webrtc-ice-candidate", {
      fromSocketId: socket.id,
      fromUserId: data.user.userId,
      fromUsername: data.user.username,
      candidate
    });
  });

  /*
  ============================================================
  ADMIN
  ============================================================
  creator of room is admin
  later you can add promoted admins
  */

  socket.on("admin-kick-user", ({ targetSocketId, reason } = {}) => {
    try {
      const data = getSocketUserRoom(socket);
      if (!data) return;

      const { room, user } = data;

      if (!user.isAdmin) {
        socket.emit("error-message", { message: "Admin access required." });
        return;
      }

      if (!targetSocketId || targetSocketId === socket.id) {
        socket.emit("error-message", { message: "Invalid target user." });
        return;
      }

      const targetUser = room.users.get(targetSocketId);
      if (!targetUser) {
        socket.emit("error-message", { message: "Target user not found." });
        return;
      }

      io.to(targetSocketId).emit("admin-kicked", {
        message: reason
          ? `You were removed by the admin: ${reason}`
          : "You were removed by the room admin."
      });

      io.sockets.sockets.get(targetSocketId)?.leave(room.id);
      io.sockets.sockets.get(targetSocketId)?.disconnect(true);

      // cleanup happens in disconnect
    } catch (err) {
      console.error("ADMIN KICK ERROR:", err);
      socket.emit("error-message", { message: "Failed to remove user." });
    }
  });

  // optional admin state request
  socket.on("admin-get-room-state", () => {
    const data = getSocketUserRoom(socket);
    if (!data) return;

    if (!data.user.isAdmin) {
      socket.emit("error-message", { message: "Admin access required." });
      return;
    }

    socket.emit("admin-room-state", {
      room: publicRoom(data.room),
      messages: data.room.messages
    });
  });

  // ping/pong quality helper
  socket.on("ping-check", () => {
    socket.emit("pong-check");
  });

  // disconnect
  socket.on("disconnect", () => {
    try {
      const session = userSessions.get(socket.id);
      if (!session) {
        console.log("Socket disconnected:", socket.id);
        return;
      }

      const room = findRoomById(session.roomId);
      if (!room) {
        userSessions.delete(socket.id);
        return;
      }

      const user = room.users.get(socket.id);
      room.users.delete(socket.id);
      userSessions.delete(socket.id);

      if (user) {
        socket.to(room.id).emit("user-left", {
          socketId: socket.id,
          username: user.username,
          userCount: room.users.size
        });

        addSystemMessage(room, `${user.username} left the room.`);
      }

      emitRoomUsers(room);

      // auto-delete empty rooms
      if (room.users.size === 0) {
        rooms.delete(room.id);
        console.log(`Deleted empty room: ${room.name} (${room.id})`);
      }

      console.log("Socket disconnected:", socket.id);
    } catch (err) {
      console.error("DISCONNECT ERROR:", err);
    }
  });
});

/*
============================================================
GOOGLE AUTH PREP PLACEHOLDER
============================================================
This is just a placeholder route.
Real Google sign-in should use Passport or Firebase Auth.
*/

app.get("/api/auth/google/status", (req, res) => {
  res.json({
    ready: false,
    message: "Google auth not implemented yet. Backend prepared for future integration."
  });
});

/*
============================================================
START
============================================================
*/

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
