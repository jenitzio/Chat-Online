const API_BASE = 'https://chat-online-yon4.onrender.com';
const SOCKET_URL = 'https://chat-online-yon4.onrender.com';

let socket = null;
let currentRoomId = null;
let currentUserId = null;
let currentUsername = null;
let authToken = null;

// Views
const homeView = document.getElementById('homeView');
const roomView = document.getElementById('roomView');

// Create room form
const createRoomForm = document.getElementById('createRoomForm');
const createRoomName = document.getElementById('createRoomName');
const createRoomPassword = document.getElementById('createRoomPassword');
const createUsername = document.getElementById('createUsername');

// Join room form
const joinRoomForm = document.getElementById('joinRoomForm');
const joinRoomSlug = document.getElementById('joinRoomSlug');
const joinRoomCode = document.getElementById('joinRoomCode');
const joinRoomPassword = document.getElementById('joinRoomPassword');
const joinUsername = document.getElementById('joinUsername');

// Room UI
const roomTitle = document.getElementById('roomTitle');
const roomMeta = document.getElementById('roomMeta');
const usersList = document.getElementById('usersList');
const messagesList = document.getElementById('messagesList');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const statusBox = document.getElementById('statusBox');

// Canvas
const canvas = document.getElementById('sharedCanvas');
const clearCanvasBtn = document.getElementById('clearCanvasBtn');
let ctx = null;
let drawing = false;
let lastPoint = null;

// Clicker game
const startClickerBtn = document.getElementById('startClickerBtn');
const clickerBtn = document.getElementById('clickerBtn');
const clickerScores = document.getElementById('clickerScores');
const clickerStatus = document.getElementById('clickerStatus');

function showStatus(message, isError = false) {
  if (!statusBox) return;
  statusBox.textContent = message;
  statusBox.style.display = 'block';
  statusBox.style.background = isError ? '#4a1d1d' : '#1d3a4a';
  statusBox.style.color = '#fff';
}

function clearStatus() {
  if (!statusBox) return;
  statusBox.textContent = '';
  statusBox.style.display = 'none';
}

async function safeJsonParse(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  if (!contentType.includes('application/json')) {
    throw new Error(
      `Expected JSON but got ${contentType || 'unknown content type'}.\nServer response:\n${text.substring(0, 300)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON from server.\nResponse:\n${text.substring(0, 300)}`);
  }
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await safeJsonParse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function switchToRoomView() {
  if (homeView) homeView.classList.remove('active');
  if (roomView) roomView.classList.add('active');
}

function switchToHomeView() {
  if (roomView) roomView.classList.remove('active');
  if (homeView) homeView.classList.add('active');
}

function appendMessage(message) {
  if (!messagesList) return;

  const item = document.createElement('div');
  item.className = 'message-item';
  item.innerHTML = `
    <div class="message-head">
      <strong>${escapeHtml(message.username)}</strong>
      <span>${new Date(message.timestamp).toLocaleTimeString()}</span>
    </div>
    <div class="message-body">${escapeHtml(message.text)}</div>
  `;

  messagesList.appendChild(item);
  messagesList.scrollTop = messagesList.scrollHeight;
}

function renderUsers(users = []) {
  if (!usersList) return;
  usersList.innerHTML = '';

  users.forEach(user => {
    const item = document.createElement('div');
    item.className = 'user-item';
    item.innerHTML = `
      <strong>${escapeHtml(user.username)}</strong>
      <span>${user.isAudioOn ? '🎤' : '🔇'} ${user.isVideoOn ? '📹' : '📷 Off'}</span>
    `;
    usersList.appendChild(item);
  });
}

function updateRoomHeader(room) {
  if (roomTitle) roomTitle.textContent = room.name;
  if (roomMeta) {
    roomMeta.textContent = `Slug: ${room.slug} • Code: ${room.joinCode} • Users: ${room.userCount}`;
  }
}

function connectSocket() {
  socket = io(SOCKET_URL, {
    transports: ['websocket', 'polling']
  });

  socket.on('connect', () => {
    showStatus('Connected to server');
  });

  socket.on('connect_error', (err) => {
    showStatus(`Socket connection failed: ${err.message}`, true);
  });

  socket.on('room-joined', ({ room, messages, canvas, clickerGame, userId }) => {
    currentUserId = userId;
    updateRoomHeader(room);
    renderUsers(room.users);

    if (messagesList) messagesList.innerHTML = '';
    messages.forEach(appendMessage);

    loadCanvas(canvas);
    renderClickerScores(clickerGame?.scores || {});
    clickerStatus.textContent = clickerGame?.isActive ? 'Game active' : 'Game idle';

    switchToRoomView();
    clearStatus();
  });

  socket.on('user-joined', ({ user, userCount }) => {
    addSystemMessage(`${user.username} joined the room`);
    refreshRoomUsersLater();
    updateUserCount(userCount);
  });

  socket.on('user-left', ({ username, userCount }) => {
    addSystemMessage(`${username || 'A user'} left the room`);
    refreshRoomUsersLater();
    updateUserCount(userCount);
  });

  socket.on('chat-message', (message) => {
    appendMessage(message);
  });

  socket.on('error-message', ({ message }) => {
    showStatus(message, true);
  });

  socket.on('canvas-draw', (strokeData) => {
    drawStroke(strokeData);
  });

  socket.on('canvas-clear', () => {
    clearCanvasLocal();
  });

  socket.on('clicker-started', ({ endsAt, scores, startedBy }) => {
    renderClickerScores(scores || {});
    if (clickerStatus) {
      clickerStatus.textContent = `Started by ${startedBy}. Ends at ${new Date(endsAt).toLocaleTimeString()}`;
    }
  });

  socket.on('clicker-update', ({ scores }) => {
    renderClickerScores(scores || {});
  });

  socket.on('clicker-ended', ({ scores, winner }) => {
    renderClickerScores(scores || {});
    if (clickerStatus) {
      clickerStatus.textContent = winner
        ? `Winner: ${winner.username} (${winner.score})`
        : 'Game ended';
    }
  });

  socket.on('reaction', ({ emoji, username }) => {
    addSystemMessage(`${username} reacted ${emoji}`);
  });

  socket.on('server-shutdown', ({ message }) => {
    showStatus(message, true);
  });
}

async function createRoom(e) {
  e.preventDefault();
  clearStatus();

  try {
    const payload = {
      name: createRoomName.value.trim(),
      password: createRoomPassword.value.trim(),
      username: createUsername.value.trim()
    };

    const result = await apiFetch('/api/rooms', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    currentRoomId = result.roomId;
    currentUsername = payload.username;

    const validate = await apiFetch(`/api/rooms/${result.roomId}/validate`, {
      method: 'POST',
      body: JSON.stringify({ password: payload.password })
    });

    authToken = validate.token;

    if (!socket) connectSocket();

    socket.emit('join-room', {
      roomId: currentRoomId,
      token: authToken,
      username: currentUsername
    });

    showStatus('Room created. Joining...');
  } catch (err) {
    showStatus(err.message, true);
  }
}

async function joinRoom(e) {
  e.preventDefault();
  clearStatus();

  try {
    const slug = joinRoomSlug.value.trim();
    const code = joinRoomCode.value.trim();
    const password = joinRoomPassword.value.trim();
    const username = joinUsername.value.trim();

    if (!slug && !code) {
      throw new Error('Enter a room slug or join code.');
    }

    const params = new URLSearchParams();
    if (slug) params.append('slug', slug);
    if (code) params.append('code', code);

    const lookup = await apiFetch(`/api/rooms/lookup?${params.toString()}`);

    currentRoomId = lookup.roomId;
    currentUsername = username;

    const validate = await apiFetch(`/api/rooms/${lookup.roomId}/validate`, {
      method: 'POST',
      body: JSON.stringify({ password })
    });

    authToken = validate.token;

    if (!socket) connectSocket();

    socket.emit('join-room', {
      roomId: currentRoomId,
      token: authToken,
      username: currentUsername
    });

    showStatus('Joining room...');
  } catch (err) {
    showStatus(err.message, true);
  }
}

function sendChatMessage(e) {
  e.preventDefault();
  if (!socket || !chatInput) return;

  const text = chatInput.value.trim();
  if (!text) return;

  socket.emit('chat-message', { text });
  chatInput.value = '';
}

function leaveRoom() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  currentRoomId = null;
  currentUserId = null;
  currentUsername = null;
  authToken = null;

  if (messagesList) messagesList.innerHTML = '';
  if (usersList) usersList.innerHTML = '';
  clearCanvasLocal();
  renderClickerScores({});
  if (clickerStatus) clickerStatus.textContent = 'Game idle';

  switchToHomeView();
  showStatus('Left room');
}

function addSystemMessage(text) {
  if (!messagesList) return;

  const item = document.createElement('div');
  item.className = 'message-item system';
  item.textContent = text;
  messagesList.appendChild(item);
  messagesList.scrollTop = messagesList.scrollHeight;
}

function updateUserCount(userCount) {
  if (!roomMeta) return;
  roomMeta.textContent = roomMeta.textContent.replace(/Users:\s*\d+/, `Users: ${userCount}`);
}

function refreshRoomUsersLater() {
  // Optional placeholder if you later add a room-state sync endpoint
}

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#39;');
}

// Canvas
function setupCanvas() {
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  clearCanvasLocal();

  canvas.addEventListener('mousedown', (e) => {
    drawing = true;
    lastPoint = getCanvasPoint(e);
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!drawing || !socket) return;
    const point = getCanvasPoint(e);

    const stroke = {
      from: lastPoint,
      to: point,
      color: '#ffffff',
      width: 2
    };

    drawStroke(stroke);
    socket.emit('canvas-draw', stroke);
    lastPoint = point;
  });

  window.addEventListener('mouseup', () => {
    drawing = false;
    lastPoint = null;
  });

  clearCanvasBtn?.addEventListener('click', () => {
    if (!socket) return;
    clearCanvasLocal();
    socket.emit('canvas-clear');
  });
}

function getCanvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

function drawStroke(stroke) {
  if (!ctx || !stroke?.from || !stroke?.to) return;
  ctx.strokeStyle = stroke.color || '#fff';
  ctx.lineWidth = stroke.width || 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(stroke.from.x, stroke.from.y);
  ctx.lineTo(stroke.to.x, stroke.to.y);
  ctx.stroke();
}

function clearCanvasLocal() {
  if (!ctx || !canvas) return;
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function loadCanvas(canvasState) {
  clearCanvasLocal();
  if (!canvasState?.strokes) return;
  canvasState.strokes.forEach(drawStroke);
}

// Clicker
function setupClicker() {
  startClickerBtn?.addEventListener('click', () => {
    if (!socket) return;
    socket.emit('clicker-start');
  });

  clickerBtn?.addEventListener('click', () => {
    if (!socket) return;
    socket.emit('clicker-click');
  });
}

function renderClickerScores(scores) {
  if (!clickerScores) return;
  clickerScores.innerHTML = '';

  Object.entries(scores).forEach(([username, score]) => {
    const item = document.createElement('div');
    item.className = 'score-item';
    item.textContent = `${username}: ${score}`;
    clickerScores.appendChild(item);
  });
}

// Bind events
createRoomForm?.addEventListener('submit', createRoom);
joinRoomForm?.addEventListener('submit', joinRoom);
chatForm?.addEventListener('submit', sendChatMessage);
leaveRoomBtn?.addEventListener('click', leaveRoom);

setupCanvas();
setupClicker();
