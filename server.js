const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"]
}));
app.use(express.json({ limit: "10mb" }));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 10 * 1024 * 1024
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "replace_this_secret";

/*
  Example in-memory room store.
  Replace with your actual DB/store if you already have one.
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
  users: [
    {
      socketId,
      username,
      isAudioOn,
      isVideoOn
    }
  ],
  messages: []
}
*/

function getRoomById(roomId) {
  return rooms.get(roomId);
}

function sanitizeRoom(room) {
  return {
    roomId: room.id,
    name: room.name,
    slug: room.slug,
    joinCode: room.joinCode,
    userCount: room.users.length,
    users: room.users.map(u => ({
      socketId: u.socketId,
      username: u.username,
      isAudioOn: u.isAudioOn,
      isVideoOn: u.isVideoOn
    }))
  };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("join-room", ({ roomId, token, username }) => {
    try {
      if (!roomId || !token || !username) {
        socket.emit("error-message", { message: "Missing room join data." });
        return;
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        socket.emit("error-message", { message: "Invalid or expired token." });
        return;
      }

      const room = getRoomById(roomId);
      if (!room) {
        socket.emit("error-message", { message: "Room not found." });
        return;
      }

      // remove any stale user with same socket
      room.users = room.users.filter(u => u.socketId !== socket.id);

      const user = {
        socketId: socket.id,
        username: username.trim(),
        isAudioOn: false,
        isVideoOn: false
      };

      room.users.push(user);

      socket.data.roomId = roomId;
      socket.data.username = user.username;

      socket.join(roomId);

      socket.emit("room-joined", {
        room: sanitizeRoom(room),
        messages: room.messages || []
      });

      socket.to(roomId).emit("user-joined", {
        user,
        userCount: room.users.length
      });

      console.log(`${username} joined room ${roomId}`);
    } catch (err) {
      console.error("join-room error:", err);
      socket.emit("error-message", { message: "Failed to join room." });
    }
  });

  socket.on("chat-message", ({ text }) => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;

    if (!roomId || !username || !text?.trim()) return;

    const room = getRoomById(roomId);
    if (!room) return;

    const message = {
      username,
      text: text.trim(),
      timestamp: Date.now()
    };

    room.messages.push(message);
    io.to(roomId).emit("chat-message", message);
  });

  socket.on("file-message", ({ text, file }) => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;

    if (!roomId || !username || !file) return;

    const room = getRoomById(roomId);
    if (!room) return;

    const message = {
      username,
      text: text || "",
      file: {
        name: file.name,
        type: file.type,
        size: file.size,
        data: file.data
      },
      timestamp: Date.now()
    };

    room.messages.push(message);
    io.to(roomId).emit("file-message", message);
  });

  socket.on("typing-start", () => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;
    if (!roomId || !username) return;

    socket.to(roomId).emit("typing-start", { username });
  });

  socket.on("typing-stop", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    socket.to(roomId).emit("typing-stop");
  });

  socket.on("send-reaction", ({ emoji }) => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;
    if (!roomId || !username || !emoji) return;

    io.to(roomId).emit("reaction", { username, emoji });
  });

  socket.on("toggle-audio", ({ isAudioOn }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoomById(roomId);
    if (!room) return;

    const user = room.users.find(u => u.socketId === socket.id);
    if (!user) return;

    user.isAudioOn = !!isAudioOn;

    socket.to(roomId).emit("user-toggle-audio", {
      socketId: socket.id,
      isAudioOn: user.isAudioOn
    });
  });

  socket.on("toggle-video", ({ isVideoOn }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoomById(roomId);
    if (!room) return;

    const user = room.users.find(u => u.socketId === socket.id);
    if (!user) return;

    user.isVideoOn = !!isVideoOn;

    socket.to(roomId).emit("user-toggle-video", {
      socketId: socket.id,
      isVideoOn: user.isVideoOn
    });
  });

  /*
    WebRTC signaling relay
    This is the key part for mic/video setup.
  */
  socket.on("webrtc-signal", ({ to, type, offer, answer, candidate, username }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !to || !type) return;

    io.to(to).emit("webrtc-signal", {
      from: socket.id,
      type,
      offer,
      answer,
      candidate,
      username: username || socket.data.username
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;

    if (!roomId) return;

    const room = getRoomById(roomId);
    if (!room) return;

    room.users = room.users.filter(u => u.socketId !== socket.id);

    socket.to(roomId).emit("user-left", {
      socketId: socket.id,
      username,
      userCount: room.users.length
    });

    console.log(`Socket disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
