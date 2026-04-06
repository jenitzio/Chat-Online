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

// ── App Initialization ──────────────────────────────────────────
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e7,
  transports: ['websocket', 'polling']
});

// ── Constants ───────────────────────────────────────────────────
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS) || 100;
const MAX_USERS_PER_ROOM = parseInt(process.env.MAX_USERS_PER_ROOM) || 12;
const SALT_ROUNDS = 10;

// ── Middleware ───────────────────────────────────────────────────
app.use(compression());
app.use(cors());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        "https://cdnjs.cloudflare.com",
        "https://cdn.socket.io",
        "https://unpkg.com",
        "https://cdn.jsdelivr.net"
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdnjs.cloudflare.com"
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "https://cdnjs.cloudflare.com"
      ],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:"],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true
}));

// ── In-Memory Data Stores ───────────────────────────────────────
const rooms = new Map();

// ── Helper Functions ────────────────────────────────────────────
function generateSlug() {
  const adjectives = ['cosmic', 'neon', 'quantum', 'stellar', 'cyber', 'hyper', 'ultra', 'mega', 'turbo', 'astro'];
  const nouns = ['nexus', 'pulse', 'wave', 'core', 'flux', 'drift', 'spark', 'vortex', 'nova', 'beam'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `${adj}-${noun}-${num}`;
}

function generateJoinCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>&"']/g, c => ({
      '<': '<',
      '>': '>',
      '&': '&',
      '"': '"',
      "'": '&#39;'
    })[c])
    .substring(0, 500);
}

function getRoomPublicInfo(room) {
  const users = [];
  room.users.forEach((user, socketId) => {
    users.push({ ...user, socketId });
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

// ── REST API Endpoints ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/rooms', async (req, res) => {
  try {
    if (rooms.size >= MAX_ROOMS) {
      return res.status(429).json({ error: 'Maximum room limit reached. Try again later.' });
    }

    const { name, password, username } = req.body;
    if (!name || !password || !username) {
      return res.status(400).json({ error: 'Room name, password, and username are required.' });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const roomId = uuidv4();
    const slug = generateSlug();
    const joinCode = generateJoinCode();

    const room = {
      id: roomId,
      name: sanitize(name),
      slug,
      joinCode,
      passwordHash,
      createdBy: sanitize(username),
      createdAt: new Date(),
      users: new Map(),
      messages: [],
      canvas: { strokes: [], backgroundColor: '#1a1a2e' },
      clickerGame: { scores: new Map(), isActive: false, endsAt: null, duration: 15 }
    };

    rooms.set(roomId, room);
    console.log(`[Room Created] "${room.name}" (${slug}) by ${room.createdBy}`);

    res.status(201).json({
      roomId,
      slug,
      joinCode,
      name: room.name
    });
  } catch (err) {
    console.error('[Create Room Error]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/api/rooms/lookup', (req, res) => {
  const { slug, code } = req.query;
  let foundRoom = null;

  rooms.forEach(room => {
    if ((slug && room.slug === slug) || (code && room.joinCode === code.toUpperCase())) {
      foundRoom = room;
    }
  });

  if (!foundRoom) {
    return res.status(404).json({ error: 'Room not found.' });
  }

  res.json({
    roomId: foundRoom.id,
    name: foundRoom.name,
    slug: foundRoom.slug,
    userCount: foundRoom.users.size,
    maxUsers: MAX_USERS_PER_ROOM
  });
});

app.post('/api/rooms/:roomId/validate', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { password } = req.body;
    const room = rooms.get(roomId);

    if (!room) {
      return res.status(404).json({ error: 'Room not found.' });
    }

    if (room.users.size >= MAX_USERS_PER_ROOM) {
      return res.status(403).json({ error: 'Room is full.' });
    }

    const isValid = await bcrypt.compare(password, room.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const token = uuidv4();
    if (!room.pendingTokens) room.pendingTokens = new Map();
    room.pendingTokens.set(token, { createdAt: Date.now() });

    room.pendingTokens.forEach((val, key) => {
      if (Date.now() - val.createdAt > 60000) room.pendingTokens.delete(key);
    });

    res.json({ valid: true, token });
  } catch (err) {
    console.error('[Validate Error]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/room/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Socket.IO Signaling & Real-Time Logic ───────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket Connected] ${socket.id}`);

  let currentRoom = null;
  let currentUser = null;

  socket.on('join-room', ({ roomId, token, username }) => {
    const room = rooms.get(roomId);
    if (!room) {
      return socket.emit('error-message', { message: 'Room not found.' });
    }

    if (!room.pendingTokens || !room.pendingTokens.has(token)) {
      return socket.emit('error-message', { message: 'Invalid or expired token. Please re-enter the password.' });
    }
    room.pendingTokens.delete(token);

    if (room.users.size >= MAX_USERS_PER_ROOM) {
      return socket.emit('error-message', { message: 'Room is full.' });
    }

    const sanitizedName = sanitize(username) || `User-${socket.id.substring(0, 4)}`;

    currentRoom = roomId;
    currentUser = {
      id: socket.id,
      username: sanitizedName,
      isAudioOn: true,
      isVideoOn: true,
      joinedAt: new Date()
    };

    room.users.set(socket.id, currentUser);
    socket.join(roomId);

    console.log(`[User Joined] ${sanitizedName} → "${room.name}" (${room.users.size} users)`);

    socket.emit('room-joined', {
      room: getRoomPublicInfo(room),
      messages: room.messages.slice(-100),
      canvas: room.canvas,
      clickerGame: {
        scores: Object.fromEntries(room.clickerGame.scores),
        isActive: room.clickerGame.isActive,
        endsAt: room.clickerGame.endsAt
      },
      userId: socket.id
    });

    socket.to(roomId).emit('user-joined', {
      user: { ...currentUser, socketId: socket.id },
      userCount: room.users.size
    });
  });

  socket.on('webrtc-offer', ({ offer, to }) => {
    socket.to(to).emit('webrtc-offer', { offer, from: socket.id });
  });

  socket.on('webrtc-answer', ({ answer, to }) => {
    socket.to(to).emit('webrtc-answer', { answer, from: socket.id });
  });

  socket.on('webrtc-ice-candidate', ({ candidate, to }) => {
    socket.to(to).emit('webrtc-ice-candidate', { candidate, from: socket.id });
  });

  socket.on('toggle-audio', ({ isAudioOn }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    currentUser.isAudioOn = isAudioOn;
    room.users.set(socket.id, currentUser);
    socket.to(currentRoom).emit('user-toggle-audio', { socketId: socket.id, isAudioOn });
  });

  socket.on('toggle-video', ({ isVideoOn }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    currentUser.isVideoOn = isVideoOn;
    room.users.set(socket.id, currentUser);
    socket.to(currentRoom).emit('user-toggle-video', { socketId: socket.id, isVideoOn });
  });

  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const message = {
      id: uuidv4(),
      username: currentUser.username,
      text: sanitize(text),
      timestamp: new Date().toISOString()
    };

    room.messages.push(message);
    if (room.messages.length > 200) {
      room.messages = room.messages.slice(-200);
    }

    io.to(currentRoom).emit('chat-message', message);
  });

  socket.on('typing-start', () => {
    if (!currentRoom || !currentUser) return;
    socket.to(currentRoom).emit('typing-start', { username: currentUser.username });
  });

  socket.on('typing-stop', () => {
    if (!currentRoom || !currentUser) return;
    socket.to(currentRoom).emit('typing-stop', { username: currentUser.username });
  });

  socket.on('canvas-draw', (strokeData) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.canvas.strokes.push(strokeData);
    if (room.canvas.strokes.length > 5000) {
      room.canvas.strokes = room.canvas.strokes.slice(-3000);
    }

    socket.to(currentRoom).emit('canvas-draw', strokeData);
  });

  socket.on('canvas-clear', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.canvas.strokes = [];
    io.to(currentRoom).emit('canvas-clear');
  });

  socket.on('clicker-start', () => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || room.clickerGame.isActive) return;

    const duration = room.clickerGame.duration * 1000;
    room.clickerGame.isActive = true;
    room.clickerGame.scores = new Map();
    room.clickerGame.endsAt = new Date(Date.now() + duration);

    room.users.forEach((user) => {
      room.clickerGame.scores.set(user.username, 0);
    });

    io.to(currentRoom).emit('clicker-started', {
      endsAt: room.clickerGame.endsAt,
      scores: Object.fromEntries(room.clickerGame.scores),
      startedBy: currentUser.username
    });

    setTimeout(() => {
      if (room.clickerGame.isActive) {
        room.clickerGame.isActive = false;
        const finalScores = Object.fromEntries(room.clickerGame.scores);
        const winner = Object.entries(finalScores).sort((a, b) => b[1] - a[1])[0];

        io.to(currentRoom).emit('clicker-ended', {
          scores: finalScores,
          winner: winner ? { username: winner[0], score: winner[1] } : null
        });
      }
    }, duration);
  });

  socket.on('clicker-click', () => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.clickerGame.isActive) return;

    const current = room.clickerGame.scores.get(currentUser.username) || 0;
    room.clickerGame.scores.set(currentUser.username, current + 1);

    io.to(currentRoom).emit('clicker-update', {
      scores: Object.fromEntries(room.clickerGame.scores)
    });
  });

  socket.on('send-reaction', ({ emoji }) => {
    if (!currentRoom || !currentUser) return;
    io.to(currentRoom).emit('reaction', {
      emoji,
      username: currentUser.username,
      socketId: socket.id
    });
  });

  socket.on('screen-share-started', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('screen-share-started', { socketId: socket.id });
  });

  socket.on('screen-share-stopped', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('screen-share-stopped', { socketId: socket.id });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Socket Disconnected] ${socket.id} (${reason})`);

    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        const roomIdToDelete = currentRoom;
        room.users.delete(socket.id);

        socket.to(currentRoom).emit('user-left', {
          socketId: socket.id,
          username: currentUser?.username,
          userCount: room.users.size
        });

        console.log(`[User Left] ${currentUser?.username} ← "${room.name}" (${room.users.size} users)`);

        if (room.users.size === 0) {
          setTimeout(() => {
            const r = rooms.get(roomIdToDelete);
            if (r && r.users.size === 0) {
              rooms.delete(roomIdToDelete);
              console.log(`[Room Deleted] "${r.name}" (empty)`);
            }
          }, 5 * 60 * 1000);
        }
      }
    }
  });
});

// ── Periodic Cleanup ────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (room.users.size === 0 && now - room.createdAt.getTime() > 24 * 60 * 60 * 1000) {
      rooms.delete(id);
      console.log(`[Cleanup] Removed stale room "${room.name}"`);
    }
  });
}, 30 * 60 * 1000);

// ── Start Server ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║ 🚀 NEXUS Platform running on port ${PORT} ║
║ 📡 Environment: ${(process.env.NODE_ENV || 'development').padEnd(24)}║
║ 🌐 http://localhost:${PORT} ║
╚══════════════════════════════════════════════════╝
`);
});

// ── Graceful Shutdown ───────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received. Shutting down gracefully...');
  io.emit('server-shutdown', { message: 'Server is restarting. Please reconnect shortly.' });
  server.close(() => {
    console.log('[Server] Closed.');
    process.exit(0);
  });
});
