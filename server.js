/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║ NEXUS — Real-Time Communication Platform                    ║
 * ║ WebRTC · Socket.IO · Rooms · File Sharing · Render Ready    ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Production-ready server with:
 * - Express static file serving from /public
 * - Socket.IO signaling server for WebRTC
 * - Room management with password-protected lobbies
 * - Real-time messaging, reactions, typing indicators
 * - File-sharing relay support
 * - Optimized for Render deployment
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ───────────────────────────────────────────────────────────────
// App Initialization
// ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? true : '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e7, // 10MB
  transports: ['websocket', 'polling']
});

// ───────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '100', 10);
const MAX_USERS_PER_ROOM = parseInt(process.env.MAX_USERS_PER_ROOM || '12', 10);
const SALT_ROUNDS = 10;
const MAX_MESSAGES_PER_ROOM = 200;
const TOKEN_TTL_MS = 60 * 1000;
const EMPTY_ROOM_DELETE_DELAY_MS = 5 * 60 * 1000;
const STALE_ROOM_TTL_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────────
// Middleware
// ───────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          'https://cdnjs.cloudflare.com',
          'https://cdn.socket.io',
          'https://unpkg.com',
          'https://cdn.jsdelivr.net'
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://cdnjs.cloudflare.com'
        ],
        fontSrc: [
          "'self'",
          'https://fonts.gstatic.com',
          'https://cdnjs.cloudflare.com'
        ],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'wss:', 'ws:', 'https:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        workerSrc: ["'self'", 'blob:']
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false
  })
);

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
    etag: true
  })
);

// ───────────────────────────────────────────────────────────────
// In-Memory Data Stores
// ───────────────────────────────────────────────────────────────
const rooms = new Map();

// Room shape:
// {
//   id, name, slug, joinCode, passwordHash, createdBy, createdAt,
//   users: Map<socketId, { id, username, isAudioOn, isVideoOn, joinedAt }>,
//   messages: [],
//   pendingTokens: Map<token, { createdAt }>
// }

// ───────────────────────────────────────────────────────────────
// Helper Functions
// ───────────────────────────────────────────────────────────────
function generateSlug() {
  const adjectives = [
    'cosmic', 'neon', 'quantum', 'stellar', 'cyber',
    'hyper', 'ultra', 'mega', 'turbo', 'astro'
  ];
  const nouns = [
    'nexus', 'pulse', 'wave', 'core', 'flux',
    'drift', 'spark', 'vortex', 'nova', 'beam'
  ];

  let slug = '';
  let exists = true;

  while (exists) {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 9000) + 1000;
    slug = `${adj}-${noun}-${num}`;

    exists = false;
    for (const room of rooms.values()) {
      if (room.slug === slug) {
        exists = true;
        break;
      }
    }
  }

  return slug;
}

function generateJoinCode() {
  let code = '';
  let exists = true;

  while (exists) {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
    exists = false;

    for (const room of rooms.values()) {
      if (room.joinCode === code) {
        exists = true;
        break;
      }
    }
  }

  return code;
}

function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>&"']/g, (c) => ({
      '<': '<',
      '>': '>',
      '&': '&',
      '"': '"',
      "'": '&#39;'
    }[c]))
    .trim()
    .substring(0, maxLen);
}

function getRoomPublicInfo(room) {
  const users = [];

  room.users.forEach((user, socketId) => {
    users.push({
      ...user,
      socketId
    });
  });

  return {
    id: room.id,
    name: room.name,
    slug: room.slug,
    joinCode: room.joinCode,
    userCount: room.users.size,
    users,
    createdAt: room.createdAt
  };
}

function cleanupExpiredTokens(room) {
  const now = Date.now();
  room.pendingTokens.forEach((value, key) => {
    if (now - value.createdAt > TOKEN_TTL_MS) {
      room.pendingTokens.delete(key);
    }
  });
}

function addRoomMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
    room.messages = room.messages.slice(-MAX_MESSAGES_PER_ROOM);
  }
}

function findRoomBySlugOrCode({ slug, code }) {
  for (const room of rooms.values()) {
    if (slug && room.slug === slug) return room;
    if (code && room.joinCode === String(code).toUpperCase()) return room;
  }
  return null;
}

function ensureRoomExists(roomId) {
  return rooms.get(roomId) || null;
}

// ───────────────────────────────────────────────────────────────
// REST API Endpoints
// ───────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Create room
app.post('/api/rooms', async (req, res) => {
  try {
    if (rooms.size >= MAX_ROOMS) {
      return res.status(429).json({
        error: 'Maximum room limit reached. Try again later.'
      });
    }

    const name = sanitize(req.body.name, 80);
    const password = String(req.body.password || '');
    const username = sanitize(req.body.username, 40);

    if (!name || !password || !username) {
      return res.status(400).json({
        error: 'Room name, password, and username are required.'
      });
    }

    if (password.length < 4) {
      return res.status(400).json({
        error: 'Password must be at least 4 characters.'
      });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const roomId = uuidv4();
    const slug = generateSlug();
    const joinCode = generateJoinCode();

    const room = {
      id: roomId,
      name,
      slug,
      joinCode,
      passwordHash,
      createdBy: username,
      createdAt: new Date(),
      users: new Map(),
      messages: [],
      pendingTokens: new Map()
    };

    rooms.set(roomId, room);

    console.log(`[Room Created] "${room.name}" (${room.slug}) by ${room.createdBy}`);

    return res.status(201).json({
      roomId,
      slug,
      joinCode,
      name: room.name
    });
  } catch (err) {
    console.error('[Create Room Error]', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Lookup room by slug or code
app.get('/api/rooms/lookup', (req, res) => {
  const { slug, code } = req.query;

  if (!slug && !code) {
    return res.status(400).json({
      error: 'Provide either slug or code.'
    });
  }

  const room = findRoomBySlugOrCode({ slug, code });

  if (!room) {
    return res.status(404).json({ error: 'Room not found.' });
  }

  return res.json({
    roomId: room.id,
    name: room.name,
    slug: room.slug,
    userCount: room.users.size,
    maxUsers: MAX_USERS_PER_ROOM
  });
});

// Validate room password and issue temporary join token
app.post('/api/rooms/:roomId/validate', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { password } = req.body;

    const room = ensureRoomExists(roomId);

    if (!room) {
      return res.status(404).json({ error: 'Room not found.' });
    }

    if (room.users.size >= MAX_USERS_PER_ROOM) {
      return res.status(403).json({ error: 'Room is full.' });
    }

    const isValid = await bcrypt.compare(String(password || ''), room.passwordHash);

    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    cleanupExpiredTokens(room);

    const token = uuidv4();
    room.pendingTokens.set(token, { createdAt: Date.now() });

    return res.json({
      valid: true,
      token
    });
  } catch (err) {
    console.error('[Validate Error]', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Optional room info endpoint
app.get('/api/rooms/:roomId', (req, res) => {
  const room = ensureRoomExists(req.params.roomId);

  if (!room) {
    return res.status(404).json({ error: 'Room not found.' });
  }

  return res.json(getRoomPublicInfo(room));
});

// SPA room route
app.get('/room/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API 404 fallback
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Frontend catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ───────────────────────────────────────────────────────────────
// Socket.IO Logic
// ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket Connected] ${socket.id}`);

  let currentRoomId = null;
  let currentUser = null;

  function getCurrentRoom() {
    if (!currentRoomId) return null;
    return rooms.get(currentRoomId) || null;
  }

  function leaveCurrentRoom(reason = 'left') {
    const room = getCurrentRoom();
    if (!room || !currentUser) return;

    room.users.delete(socket.id);
    socket.leave(currentRoomId);

    socket.to(currentRoomId).emit('user-left', {
      socketId: socket.id,
      username: currentUser.username,
      userCount: room.users.size,
      reason
    });

    console.log(
      `[User Left] ${currentUser.username} ← "${room.name}" (${room.users.size} users)`
    );

    const roomIdSnapshot = currentRoomId;

    currentRoomId = null;
    currentUser = null;

    if (room.users.size === 0) {
      setTimeout(() => {
        const stillRoom = rooms.get(roomIdSnapshot);
        if (stillRoom && stillRoom.users.size === 0) {
          rooms.delete(roomIdSnapshot);
          console.log(`[Room Deleted] "${stillRoom.name}" (empty)`);
        }
      }, EMPTY_ROOM_DELETE_DELAY_MS);
    }
  }

  // Join room
  socket.on('join-room', ({ roomId, token, username }) => {
    try {
      const room = rooms.get(roomId);

      if (!room) {
        return socket.emit('error-message', { message: 'Room not found.' });
      }

      cleanupExpiredTokens(room);

      if (!room.pendingTokens.has(token)) {
        return socket.emit('error-message', {
          message: 'Invalid or expired token. Please re-enter the password.'
        });
      }

      if (room.users.size >= MAX_USERS_PER_ROOM) {
        room.pendingTokens.delete(token);
        return socket.emit('error-message', {
          message: 'Room is full.'
        });
      }

      room.pendingTokens.delete(token);

      const sanitizedName =
        sanitize(username, 40) || `User-${socket.id.substring(0, 4)}`;

      currentRoomId = roomId;
      currentUser = {
        id: socket.id,
        username: sanitizedName,
        isAudioOn: true,
        isVideoOn: true,
        joinedAt: new Date().toISOString()
      };

      room.users.set(socket.id, currentUser);
      socket.join(roomId);

      console.log(
        `[User Joined] ${sanitizedName} → "${room.name}" (${room.users.size} users)`
      );

      socket.emit('room-joined', {
        room: getRoomPublicInfo(room),
        messages: room.messages.slice(-100),
        userId: socket.id
      });

      socket.to(roomId).emit('user-joined', {
        user: { ...currentUser, socketId: socket.id },
        userCount: room.users.size
      });
    } catch (err) {
      console.error('[Join Room Error]', err);
      socket.emit('error-message', { message: 'Failed to join room.' });
    }
  });

  // WebRTC signaling relay
  socket.on('webrtc-signal', (payload = {}) => {
    try {
      const room = getCurrentRoom();
      if (!room || !currentUser) return;

      const { to, type, offer, answer, candidate, username } = payload;

      if (!to || !type) return;

      io.to(to).emit('webrtc-signal', {
        from: socket.id,
        type,
        offer,
        answer,
        candidate,
        username: username || currentUser.username
      });
    } catch (err) {
      console.error('[WebRTC Signal Error]', err);
    }
  });

  // Audio toggle
  socket.on('toggle-audio', ({ isAudioOn }) => {
    try {
      const room = getCurrentRoom();
      if (!room || !currentUser) return;

      currentUser.isAudioOn = !!isAudioOn;
      room.users.set(socket.id, currentUser);

      socket.to(currentRoomId).emit('user-toggle-audio', {
        socketId: socket.id,
        isAudioOn: currentUser.isAudioOn
      });
    } catch (err) {
      console.error('[Toggle Audio Error]', err);
    }
  });

  // Video toggle
  socket.on('toggle-video', ({ isVideoOn }) => {
    try {
      const room = getCurrentRoom();
      if (!room || !currentUser) return;

      currentUser.isVideoOn = !!isVideoOn;
      room.users.set(socket.id, currentUser);

      socket.to(currentRoomId).emit('user-toggle-video', {
        socketId: socket.id,
        isVideoOn: currentUser.isVideoOn
      });
    } catch (err) {
      console.error('[Toggle Video Error]', err);
    }
  });

  // Chat message
  socket.on('chat-message', ({ text }) => {
    try {
      const room = getCurrentRoom();
      if (!room || !currentUser) return;

      const cleanText = sanitize(text, 4000);
      if (!cleanText.trim()) return;

      const message = {
        id: uuidv4(),
        username: currentUser.username,
        text: cleanText,
        timestamp: new Date().toISOString()
      };

      addRoomMessage(room, message);
      io.to(currentRoomId).emit('chat-message', message);
    } catch (err) {
      console.error('[Chat Message Error]', err);
    }
  });

  // File message
  socket.on('file-message', ({ text, file }) => {
    try {
      const room = getCurrentRoom();
      if (!room || !currentUser) return;

      if (!file || typeof file !== 'object') {
        return socket.emit('error-message', {
          message: 'Invalid file payload.'
        });
      }

      const message = {
        id: uuidv4(),
        username: currentUser.username,
        text: sanitize(text || '', 2000),
        file: {
          name: sanitize(file.name || 'file', 120),
          type: sanitize(file.type || 'application/octet-stream', 120),
          size: Number(file.size || 0),
          data: typeof file.data === 'string' ? file.data : ''
        },
        timestamp: new Date().toISOString()
      };

      addRoomMessage(room, message);
      io.to(currentRoomId).emit('file-message', message);
    } catch (err) {
      console.error('[File Message Error]', err);
      socket.emit('error-message', {
        message: 'Failed to send file.'
      });
    }
  });

  // Typing indicators
  socket.on('typing-start', () => {
    try {
      if (!currentRoomId || !currentUser) return;

      socket.to(currentRoomId).emit('typing-start', {
        username: currentUser.username
      });
    } catch (err) {
      console.error('[Typing Start Error]', err);
    }
  });

  socket.on('typing-stop', () => {
    try {
      if (!currentRoomId || !currentUser) return;

      socket.to(currentRoomId).emit('typing-stop', {
        username: currentUser.username
      });
    } catch (err) {
      console.error('[Typing Stop Error]', err);
    }
  });

  // Reactions
  socket.on('send-reaction', ({ emoji }) => {
    try {
      if (!currentRoomId || !currentUser) return;

      const cleanEmoji = sanitize(String(emoji || ''), 20);
      if (!cleanEmoji) return;

      io.to(currentRoomId).emit('reaction', {
        emoji: cleanEmoji,
        username: currentUser.username,
        socketId: socket.id
      });
    } catch (err) {
      console.error('[Reaction Error]', err);
    }
  });

  // Optional manual leave event, if you ever want it
  socket.on('leave-room', () => {
    leaveCurrentRoom('left');
  });

  // Disconnect
  socket.on('disconnect', (reason) => {
    console.log(`[Socket Disconnected] ${socket.id} (${reason})`);
    leaveCurrentRoom(reason);
  });
});

// ───────────────────────────────────────────────────────────────
// Periodic Cleanup
// ───────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();

  rooms.forEach((room, roomId) => {
    cleanupExpiredTokens(room);

    if (room.users.size === 0 && now - room.createdAt.getTime() > STALE_ROOM_TTL_MS) {
      rooms.delete(roomId);
      console.log(`[Cleanup] Removed stale room "${room.name}"`);
    }
  });
}, 30 * 60 * 1000);

// ───────────────────────────────────────────────────────────────
// Start Server
// ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║ 🚀 NEXUS Platform running on port ${PORT}
║ 📡 Environment: ${process.env.NODE_ENV || 'development'}
║ 🌐 http://localhost:${PORT}
╚══════════════════════════════════════════════════╝
`);
});

// ───────────────────────────────────────────────────────────────
// Graceful Shutdown
// ───────────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received. Shutting down gracefully...');

  io.emit('server-shutdown', {
    message: 'Server is restarting. Please reconnect shortly.'
  });

  server.close(() => {
    console.log('[Server] Closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received. Shutting down gracefully...');

  io.emit('server-shutdown', {
    message: 'Server is shutting down. Please reconnect shortly.'
  });

  server.close(() => {
    console.log('[Server] Closed.');
    process.exit(0);
  });
});
