const state = {
  socket: null,
  username: '',
  roomId: '',
  roomSlug: '',
  roomName: '',
  roomJoinCode: '',
  roomToken: '',
  currentUserId: '',
  currentRoomInfo: null,
  isAudioOn: true,
  isVideoOn: true,
  typingTimeout: null,
  isDrawing: false,
  lastX: 0,
  lastY: 0
};

// Views
const homeView = document.getElementById('homeView');
const lobbyView = document.getElementById('lobbyView');
const roomView = document.getElementById('roomView');

// Messages
const homeMessage = document.getElementById('homeMessage');
const lobbyMessage = document.getElementById('lobbyMessage');
const roomMessage = document.getElementById('roomMessage');

// Forms / inputs
const createRoomForm = document.getElementById('createRoomForm');
const lookupRoomForm = document.getElementById('lookupRoomForm');
const validatePasswordForm = document.getElementById('validatePasswordForm');

const createUsername = document.getElementById('createUsername');
const roomName = document.getElementById('roomName');
const roomPassword = document.getElementById('roomPassword');

const joinUsername = document.getElementById('joinUsername');
const roomLookup = document.getElementById('roomLookup');
const joinPassword = document.getElementById('joinPassword');

// Lobby
const lobbyRoomName = document.getElementById('lobbyRoomName');
const lobbyRoomSlug = document.getElementById('lobbyRoomSlug');
const lobbyUserCount = document.getElementById('lobbyUserCount');
const lobbyMaxUsers = document.getElementById('lobbyMaxUsers');

// Room
const roomTitle = document.getElementById('roomTitle');
const roomJoinCode = document.getElementById('roomJoinCode');
const userList = document.getElementById('userList');
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const typingIndicator = document.getElementById('typingIndicator');

const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const toggleVideoBtn = document.getElementById('toggleVideoBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const backToHomeBtn = document.getElementById('backToHomeBtn');
const sendReactionBtn = document.getElementById('sendReactionBtn');

const drawCanvas = document.getElementById('drawCanvas');
const clearCanvasBtn = document.getElementById('clearCanvasBtn');
const ctx = drawCanvas.getContext('2d');

const startClickerBtn = document.getElementById('startClickerBtn');
const clickerBtn = document.getElementById('clickerBtn');
const clickerStatus = document.getElementById('clickerStatus');
const clickerScores = document.getElementById('clickerScores');

// ------------------------
// Helpers
// ------------------------
function showView(view) {
  [homeView, lobbyView, roomView].forEach(v => v.classList.remove('active'));
  view.classList.add('active');
}

function setMessage(el, message, type = '') {
  el.textContent = message || '';
  el.className = `message ${type}`.trim();
}

async function safeJson(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  if (!contentType.includes('application/json')) {
    throw new Error(
      `Expected JSON but got ${contentType || 'unknown content type'}.\nServer response:\n${text.slice(0, 200)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
  }
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  const data = await safeJson(response);

  if (!response.ok) {
    throw new Error(data.error || 'Request failed.');
  }

  return data;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&',
    '<': '<',
    '>': '>',
    '"': '"',
    "'": '&#39;'
  }[ch]));
}

function renderUsers(users = []) {
  userList.innerHTML = '';
  users.forEach(user => {
    const li = document.createElement('li');
    li.innerHTML = `
      <strong>${escapeHtml(user.username)}</strong>
      ${user.socketId === state.currentUserId ? ' (You)' : ''}
      <br>
      <small>Audio: ${user.isAudioOn ? 'On' : 'Off'} | Video: ${user.isVideoOn ? 'On' : 'Off'}</small>
    `;
    userList.appendChild(li);
  });
}

function addChatMessage(message) {
  const div = document.createElement('div');
  div.className = 'chat-message';
  div.innerHTML = `
    <div class="meta">
      <strong>${escapeHtml(message.username)}</strong> ·
      ${new Date(message.timestamp).toLocaleTimeString()}
    </div>
    <div>${escapeHtml(message.text)}</div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChat(messages = []) {
  chatMessages.innerHTML = '';
  messages.forEach(addChatMessage);
}

function renderScores(scores = {}) {
  const entries = Object.entries(scores);
  if (!entries.length) {
    clickerScores.innerHTML = '<em>No scores yet</em>';
    return;
  }

  clickerScores.innerHTML = entries
    .sort((a, b) => b[1] - a[1])
    .map(([username, score]) => `<div><strong>${escapeHtml(username)}</strong>: ${score}</div>`)
    .join('');
}

function updateRoomHeader(room) {
  roomTitle.textContent = room.name || 'Room';
  roomJoinCode.textContent = room.joinCode || '-';
}

function resetCanvas() {
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
}

function drawStroke(stroke) {
  if (!stroke) return;
  ctx.strokeStyle = stroke.color || '#000000';
  ctx.lineWidth = stroke.lineWidth || 2;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(stroke.fromX, stroke.fromY);
  ctx.lineTo(stroke.toX, stroke.toY);
  ctx.stroke();
}

function renderCanvas(canvasState) {
  resetCanvas();
  if (!canvasState || !Array.isArray(canvasState.strokes)) return;
  canvasState.strokes.forEach(drawStroke);
}

function connectSocket() {
  if (state.socket && state.socket.connected) return;

  state.socket = io({
    transports: ['websocket', 'polling']
  });

  state.socket.on('connect', () => {
    console.log('Socket connected:', state.socket.id);
  });

  state.socket.on('error-message', ({ message }) => {
    setMessage(roomMessage, message, 'error');
  });

  state.socket.on('room-joined', payload => {
    state.currentUserId = payload.userId;
    state.currentRoomInfo = payload.room;
    state.roomJoinCode = payload.room.joinCode || '';

    updateRoomHeader(payload.room);
    renderUsers(payload.room.users || []);
    renderChat(payload.messages || []);
    renderCanvas(payload.canvas);
    renderScores(payload.clickerGame?.scores || {});
    clickerStatus.textContent = payload.clickerGame?.isActive
      ? `Active until ${new Date(payload.clickerGame.endsAt).toLocaleTimeString()}`
      : 'Not started';

    setMessage(roomMessage, `Joined room "${payload.room.name}"`, 'success');
    showView(roomView);
  });

  state.socket.on('user-joined', ({ user, userCount }) => {
    if (!state.currentRoomInfo) return;
    state.currentRoomInfo.users.push(user);
    renderUsers(state.currentRoomInfo.users);
    setMessage(roomMessage, `${user.username} joined the room. Users: ${userCount}`, 'success');
  });

  state.socket.on('user-left', ({ socketId, username, userCount }) => {
    if (!state.currentRoomInfo) return;
    state.currentRoomInfo.users = state.currentRoomInfo.users.filter(u => u.socketId !== socketId);
    renderUsers(state.currentRoomInfo.users);
    setMessage(roomMessage, `${username || 'A user'} left the room. Users: ${userCount}`);
  });

  state.socket.on('user-toggle-audio', ({ socketId, isAudioOn }) => {
    if (!state.currentRoomInfo) return;
    const user = state.currentRoomInfo.users.find(u => u.socketId === socketId);
    if (user) {
      user.isAudioOn = isAudioOn;
      renderUsers(state.currentRoomInfo.users);
    }
  });

  state.socket.on('user-toggle-video', ({ socketId, isVideoOn }) => {
    if (!state.currentRoomInfo) return;
    const user = state.currentRoomInfo.users.find(u => u.socketId === socketId);
    if (user) {
      user.isVideoOn = isVideoOn;
      renderUsers(state.currentRoomInfo.users);
    }
  });

  state.socket.on('chat-message', message => {
    addChatMessage(message);
  });

  state.socket.on('typing-start', ({ username }) => {
    typingIndicator.textContent = `${username} is typing...`;
  });

  state.socket.on('typing-stop', () => {
    typingIndicator.textContent = '';
  });

  state.socket.on('reaction', ({ emoji, username }) => {
    setMessage(roomMessage, `${username} reacted ${emoji}`, 'success');
  });

  state.socket.on('canvas-draw', stroke => {
    drawStroke(stroke);
  });

  state.socket.on('canvas-clear', () => {
    resetCanvas();
  });

  state.socket.on('clicker-started', ({ endsAt, scores, startedBy }) => {
    clickerStatus.textContent = `Started by ${startedBy} · ends at ${new Date(endsAt).toLocaleTimeString()}`;
    renderScores(scores);
  });

  state.socket.on('clicker-update', ({ scores }) => {
    renderScores(scores);
  });

  state.socket.on('clicker-ended', ({ scores, winner }) => {
    clickerStatus.textContent = winner
      ? `Winner: ${winner.username} (${winner.score})`
      : 'Game ended';
    renderScores(scores);
  });

  state.socket.on('server-shutdown', ({ message }) => {
    setMessage(roomMessage, message, 'error');
  });

  state.socket.on('disconnect', reason => {
    console.log('Socket disconnected:', reason);
  });
}

// ------------------------
// Create room
// ------------------------
createRoomForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setMessage(homeMessage, 'Creating room...');

  try {
    const username = createUsername.value.trim();
    const name = roomName.value.trim();
    const password = roomPassword.value.trim();

    const data = await apiFetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, name, password })
    });

    state.username = username;
    state.roomId = data.roomId;
    state.roomSlug = data.slug;
    state.roomName = data.name;

    lobbyRoomName.textContent = data.name;
    lobbyRoomSlug.textContent = data.slug;
    lobbyUserCount.textContent = '0';
    lobbyMaxUsers.textContent = '-';

    joinPassword.value = password;

    setMessage(homeMessage, `Room created successfully. Slug: ${data.slug}`, 'success');
    showView(lobbyView);
    setMessage(lobbyMessage, 'Room created. Enter the password to continue.', 'success');
  } catch (err) {
    console.error(err);
    setMessage(homeMessage, err.message, 'error');
  }
});

// ------------------------
// Lookup room
// ------------------------
lookupRoomForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setMessage(homeMessage, 'Looking up room...');

  try {
    const username = joinUsername.value.trim();
    const lookup = roomLookup.value.trim();

    state.username = username;

    const isCode = !lookup.includes('-') && lookup.length <= 8;
    const query = isCode
      ? `/api/rooms/lookup?code=${encodeURIComponent(lookup)}`
      : `/api/rooms/lookup?slug=${encodeURIComponent(lookup)}`;

    const data = await apiFetch(query);

    state.roomId = data.roomId;
    state.roomSlug = data.slug;
    state.roomName = data.name;

    lobbyRoomName.textContent = data.name;
    lobbyRoomSlug.textContent = data.slug;
    lobbyUserCount.textContent = data.userCount;
    lobbyMaxUsers.textContent = data.maxUsers;

    showView(lobbyView);
    setMessage(lobbyMessage, 'Room found. Enter the password to continue.', 'success');
    setMessage(homeMessage, '', '');
  } catch (err) {
    console.error(err);
    setMessage(homeMessage, err.message, 'error');
  }
});

// ------------------------
// Validate room password + join socket room
// ------------------------
validatePasswordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setMessage(lobbyMessage, 'Validating password...');

  try {
    const password = joinPassword.value.trim();

    const data = await apiFetch(`/api/rooms/${encodeURIComponent(state.roomId)}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    state.roomToken = data.token;

    connectSocket();

    state.socket.emit('join-room', {
      roomId: state.roomId,
      token: state.roomToken,
      username: state.username
    });

    setMessage(lobbyMessage, 'Joining room...', 'success');
  } catch (err) {
    console.error(err);
    setMessage(lobbyMessage, err.message, 'error');
  }
});

// ------------------------
// Back / leave
// ------------------------
backToHomeBtn.addEventListener('click', () => {
  showView(homeView);
  setMessage(lobbyMessage, '');
});

leaveRoomBtn.addEventListener('click', () => {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }

  state.roomId = '';
  state.roomSlug = '';
  state.roomName = '';
  state.roomToken = '';
  state.currentUserId = '';
  state.currentRoomInfo = null;
  state.isAudioOn = true;
  state.isVideoOn = true;

  userList.innerHTML = '';
  chatMessages.innerHTML = '';
  typingIndicator.textContent = '';
  renderScores({});
  resetCanvas();
  clickerStatus.textContent = 'Not started';

  showView(homeView);
  setMessage(roomMessage, '');
});

// ------------------------
// Chat
// ------------------------
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !state.socket) return;

  state.socket.emit('chat-message', { text });
  chatInput.value = '';
  state.socket.emit('typing-stop');
});

chatInput.addEventListener('input', () => {
  if (!state.socket) return;

  state.socket.emit('typing-start');

  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    state.socket.emit('typing-stop');
  }, 1000);
});

// ------------------------
// Audio / video toggles
// ------------------------
toggleAudioBtn.addEventListener('click', () => {
  if (!state.socket) return;
  state.isAudioOn = !state.isAudioOn;
  state.socket.emit('toggle-audio', { isAudioOn: state.isAudioOn });
  toggleAudioBtn.textContent = state.isAudioOn ? 'Mute Audio' : 'Unmute Audio';
});

toggleVideoBtn.addEventListener('click', () => {
  if (!state.socket) return;
  state.isVideoOn = !state.isVideoOn;
  state.socket.emit('toggle-video', { isVideoOn: state.isVideoOn });
  toggleVideoBtn.textContent = state.isVideoOn ? 'Turn Off Video' : 'Turn On Video';
});

sendReactionBtn.addEventListener('click', () => {
  if (!state.socket) return;
  state.socket.emit('send-reaction', { emoji: '🔥' });
});

// ------------------------
// Canvas
// ------------------------
function getCanvasPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const scaleX = drawCanvas.width / rect.width;
  const scaleY = drawCanvas.height / rect.height;

  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

drawCanvas.addEventListener('pointerdown', (e) => {
  state.isDrawing = true;
  const pos = getCanvasPos(e);
  state.lastX = pos.x;
  state.lastY = pos.y;
});

drawCanvas.addEventListener('pointermove', (e) => {
  if (!state.isDrawing || !state.socket) return;

  const pos = getCanvasPos(e);

  const stroke = {
    fromX: state.lastX,
    fromY: state.lastY,
    toX: pos.x,
    toY: pos.y,
    color: '#000000',
    lineWidth: 2
  };

  drawStroke(stroke);
  state.socket.emit('canvas-draw', stroke);

  state.lastX = pos.x;
  state.lastY = pos.y;
});

['pointerup', 'pointerleave', 'pointercancel'].forEach(eventName => {
  drawCanvas.addEventListener(eventName, () => {
    state.isDrawing = false;
  });
});

clearCanvasBtn.addEventListener('click', () => {
  if (!state.socket) return;
  resetCanvas();
  state.socket.emit('canvas-clear');
});

// ------------------------
// Clicker
// ------------------------
startClickerBtn.addEventListener('click', () => {
  if (!state.socket) return;
  state.socket.emit('clicker-start');
});

clickerBtn.addEventListener('click', () => {
  if (!state.socket) return;
  state.socket.emit('clicker-click');
});

// ------------------------
// Init
// ------------------------
resetCanvas();
showView(homeView);
