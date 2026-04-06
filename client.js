/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         NEXUS — Client-Side Application Controller           ║
 * ║  Three.js · Socket.io · WebRTC · Chat · Mini-Games · SPA    ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════
// SECTION 1: THREE.JS — Dynamic 3D WebGL Background
// ═══════════════════════════════════════════════════════════════
const ThreeBackground = (() => {
  let scene, camera, renderer, particles, mouseX = 0, mouseY = 0;
  let geometryParticles, clock;
  const PARTICLE_COUNT = 2000;

  function init() {
    const canvas = document.getElementById('bg-canvas');
    if (!canvas || typeof THREE === 'undefined') return;

    clock = new THREE.Clock();
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 50;

    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);

    // Particle system
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);

    const palette = [
      new THREE.Color(0x6c63ff), // purple
      new THREE.Color(0x00f5ff), // cyan
      new THREE.Color(0xff4b6e), // pink
      new THREE.Color(0x00d68f), // green
    ];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 120;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 120;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 80;

      const color = palette[Math.floor(Math.random() * palette.length)];
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;

      sizes[i] = Math.random() * 2 + 0.5;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
      size: 1.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    particles = new THREE.Points(geometry, material);
    scene.add(particles);
    geometryParticles = geometry;

    // Wireframe sphere as center accent
    const sphereGeo = new THREE.IcosahedronGeometry(12, 2);
    const wireframe = new THREE.WireframeGeometry(sphereGeo);
    const line = new THREE.LineSegments(wireframe, new THREE.LineBasicMaterial({
      color: 0x6c63ff,
      transparent: true,
      opacity: 0.08,
    }));
    scene.add(line);

    // Torus knot as secondary accent
    const torusGeo = new THREE.TorusKnotGeometry(8, 0.4, 100, 16);
    const torusMat = new THREE.MeshBasicMaterial({
      color: 0x00f5ff,
      wireframe: true,
      transparent: true,
      opacity: 0.06,
    });
    const torus = new THREE.Mesh(torusGeo, torusMat);
    scene.add(torus);

    // Mouse interaction
    document.addEventListener('mousemove', (e) => {
      mouseX = (e.clientX / window.innerWidth) * 2 - 1;
      mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
    });

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Animation loop
    function animate() {
      requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();

      // Rotate particles
      particles.rotation.y = elapsed * 0.03;
      particles.rotation.x = elapsed * 0.01;

      // Mouse follow
      camera.position.x += (mouseX * 5 - camera.position.x) * 0.02;
      camera.position.y += (mouseY * 5 - camera.position.y) * 0.02;
      camera.lookAt(scene.position);

      // Pulse sphere
      line.rotation.y = elapsed * 0.1;
      line.rotation.x = elapsed * 0.05;

      // Rotate torus
      torus.rotation.y = elapsed * 0.08;
      torus.rotation.z = elapsed * 0.04;

      // Animate individual particles with wave
      const positions = geometryParticles.attributes.position.array;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const ix = i * 3;
        positions[ix + 1] += Math.sin(elapsed + positions[ix]) * 0.003;
      }
      geometryParticles.attributes.position.needsUpdate = true;

      renderer.render(scene, camera);
    }

    animate();
  }

  return { init };
})();


// ═══════════════════════════════════════════════════════════════
// SECTION 2: APPLICATION STATE & SOCKET CONNECTION
// ═══════════════════════════════════════════════════════════════
const App = (() => {
  // ── State ──
  const state = {
    socket: null,
    roomId: null,
    roomSlug: null,
    joinCode: null,
    username: null,
    userId: null,
    token: null,

    // WebRTC
    localStream: null,
    screenStream: null,
    peers: new Map(),        // socketId → RTCPeerConnection
    remoteStreams: new Map(), // socketId → MediaStream

    // Media
    isAudioOn: true,
    isVideoOn: true,
    isScreenSharing: false,

    // UI
    sidebarOpen: true,
    gamesPanelOpen: false,
    currentGame: 'drawing',
    unreadMessages: 0,

    // Drawing
    isDrawing: false,
    isEraser: false,
    drawColor: '#00f5ff',
    drawSize: 3,
    drawCtx: null,

    // Clicker
    clickerActive: false,
    myClicks: 0,
    clickerTimer: null,
  };

  // ── ICE Server Configuration ──
  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ]
  };

  // ── Socket Connection ──
  // PRODUCTION: Socket.io auto-connects to the origin (no hardcoded URLs)
  function connectSocket() {
    if (state.socket) return;

    state.socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    // ── Socket Event Handlers ──
    state.socket.on('connect', () => {
      console.log('[Socket] Connected:', state.socket.id);
    });

    state.socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      showToast('Connection lost. Attempting to reconnect...', 'warning');
    });

    state.socket.on('reconnect', () => {
      showToast('Reconnected!', 'success');
      // Re-join room if we were in one
      if (state.roomId && state.token) {
        state.socket.emit('join-room', {
          roomId: state.roomId,
          token: state.token,
          username: state.username
        });
      }
    });

    state.socket.on('error-message', ({ message }) => {
      showToast(message, 'error');
    });

    state.socket.on('server-shutdown', ({ message }) => {
      showToast(message, 'warning');
    });

    // ── Room Events ──
    state.socket.on('room-joined', (data) => {
      state.userId = data.userId;
      handleRoomJoined(data);
    });

    state.socket.on('user-joined', ({ user, userCount }) => {
      showToast(`${user.username} joined the room`, 'info');
      updateUserCount(userCount);
      addSystemMessage(`${user.username} joined`);
      createPeerConnection(user.socketId, true);
    });

    state.socket.on('user-left', ({ socketId, username, userCount }) => {
      showToast(`${username} left the room`, 'info');
      updateUserCount(userCount);
      addSystemMessage(`${username} left`);
      removePeer(socketId);
    });

    // ── WebRTC Signaling ──
    state.socket.on('webrtc-offer', async ({ offer, from }) => {
      const pc = createPeerConnection(from, false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      state.socket.emit('webrtc-answer', { answer, to: from });
    });

    state.socket.on('webrtc-answer', async ({ answer, from }) => {
      const pc = state.peers.get(from);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    state.socket.on('webrtc-ice-candidate', async ({ candidate, from }) => {
      const pc = state.peers.get(from);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('[ICE] Error adding candidate:', e);
        }
      }
    });

    // ── Media Toggles ──
    state.socket.on('user-toggle-audio', ({ socketId, isAudioOn }) => {
      updateRemoteMediaIndicator(socketId, 'audio', isAudioOn);
    });

    state.socket.on('user-toggle-video', ({ socketId, isVideoOn }) => {
      updateRemoteMediaIndicator(socketId, 'video', isVideoOn);
    });

    // ── Chat ──
    state.socket.on('chat-message', (message) => {
      appendChatMessage(message);
    });

    state.socket.on('typing-start', ({ username }) => {
      showTypingIndicator(username);
    });

    state.socket.on('typing-stop', () => {
      hideTypingIndicator();
    });

    // ── Reactions ──
    state.socket.on('reaction', ({ emoji, username, socketId }) => {
      showFloatingReaction(emoji);
    });

    // ── Drawing Board ──
    state.socket.on('canvas-draw', (strokeData) => {
      drawRemoteStroke(strokeData);
    });

    state.socket.on('canvas-clear', () => {
      clearLocalCanvas();
    });

    // ── Clicker Game ──
    state.socket.on('clicker-started', ({ endsAt, scores, startedBy }) => {
      startClickerGame(endsAt, scores, startedBy);
    });

    state.socket.on('clicker-update', ({ scores }) => {
      updateClickerScores(scores);
    });

    state.socket.on('clicker-ended', ({ scores, winner }) => {
      endClickerGame(scores, winner);
    });
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 3: SCREEN MANAGEMENT & NAVIGATION
  // ═══════════════════════════════════════════════════════════
  function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');

    // Handle URL for room screens
    if (screenId === 'landing-screen') {
      history.pushState(null, '', '/');
    }
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 4: ROOM CREATION & JOINING
  // ═══════════════════════════════════════════════════════════
  async function createRoom(e) {
    e.preventDefault();
    const btn = document.getElementById('create-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating...';

    const username = document.getElementById('create-username').value.trim();
    const name = document.getElementById('create-room-name').value.trim();
    const password = document.getElementById('create-password').value;

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password, username })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      state.roomId = data.roomId;
      state.roomSlug = data.slug;
      state.joinCode = data.joinCode;
      state.username = username;

      // Show result with room info
      const resultDiv = document.getElementById('create-result');
      resultDiv.classList.remove('hidden');
      resultDiv.innerHTML = `
        <div class="result-item"><span>Room Slug:</span> <code>${data.slug}</code></div>
        <div class="result-item"><span>Join Code:</span> <code>${data.joinCode}</code></div>
        <div style="margin-top: 12px;">
          <button class="btn btn-primary btn-block" onclick="App.enterCreatedRoom('${password}')">
            <i class="fas fa-door-open"></i> Enter Room Now
          </button>
        </div>
      `;

      showToast('Room created successfully!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-rocket"></i> Launch Room';
    }
  }

  async function enterCreatedRoom(password) {
    try {
      const res = await fetch(`/api/rooms/${state.roomId}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      state.token = data.token;
      connectSocket();
      await initLocalMedia();

      state.socket.emit('join-room', {
        roomId: state.roomId,
        token: state.token,
        username: state.username
      });
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function joinRoom(e) {
    e.preventDefault();
    const btn = document.getElementById('join-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Finding...';

    const username = document.getElementById('join-username').value.trim();
    const codeOrSlug = document.getElementById('join-code').value.trim();

    try {
      // Determine if input is a code or slug
      const isCode = codeOrSlug.length <= 6 && /^[A-Z0-9]+$/i.test(codeOrSlug);
      const query = isCode
        ? `code=${encodeURIComponent(codeOrSlug.toUpperCase())}`
        : `slug=${encodeURIComponent(codeOrSlug)}`;

      const res = await fetch(`/api/rooms/lookup?${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      state.roomId = data.roomId;
      state.username = username;

      // Show lobby screen
      document.getElementById('lobby-room-name').textContent = data.name;
      document.getElementById('lobby-user-count').textContent = data.userCount;

      showScreen('lobby-screen');
      showToast(`Found room: ${data.name}`, 'info');
    } catch (err) {
      const errDiv = document.getElementById('join-error');
      errDiv.classList.remove('hidden');
      errDiv.textContent = err.message;
      setTimeout(() => errDiv.classList.add('hidden'), 5000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-search"></i> Find Room';
    }
  }

  async function validateLobby(e) {
    e.preventDefault();
    const btn = document.getElementById('lobby-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Validating...';

    const password = document.getElementById('lobby-password').value;

    try {
      const res = await fetch(`/api/rooms/${state.roomId}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      state.token = data.token;
      connectSocket();
      await initLocalMedia();

      state.socket.emit('join-room', {
        roomId: state.roomId,
        token: state.token,
        username: state.username
      });
    } catch (err) {
      const errDiv = document.getElementById('lobby-error');
      errDiv.classList.remove('hidden');
      errDiv.textContent = err.message;
      setTimeout(() => errDiv.classList.add('hidden'), 5000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-unlock"></i> Enter Room';
    }
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 5: WebRTC — LOCAL MEDIA & PEER CONNECTIONS
  // ═══════════════════════════════════════════════════════════
  async function initLocalMedia() {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const localVideo = document.getElementById('local-video');
      localVideo.srcObject = state.localStream;
    } catch (err) {
      console.warn('[Media] Camera/mic not available, continuing without:', err.message);
      showToast('Camera/mic not available. You can still chat!', 'warning');
      // Create a dummy stream so we can at least participate
      state.localStream = new MediaStream();
      state.isAudioOn = false;
      state.isVideoOn = false;
    }
  }

  function createPeerConnection(remoteSocketId, isInitiator) {
    if (state.peers.has(remoteSocketId)) {
      return state.peers.get(remoteSocketId);
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    state.peers.set(remoteSocketId, pc);

    // Add local tracks to the connection
    if (state.localStream) {
      state.localStream.getTracks().forEach(track => {
        pc.addTrack(track, state.localStream);
      });
    }

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        state.socket.emit('webrtc-ice-candidate', {
          candidate: event.candidate,
          to: remoteSocketId
        });
      }
    };

    // Remote stream
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) {
        state.remoteStreams.set(remoteSocketId, remoteStream);
        addRemoteVideo(remoteSocketId, remoteStream);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ${remoteSocketId} ICE: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        // Attempt to restart ICE
        pc.restartIce?.();
      }
    };

    // If we're the initiator, create and send offer
    if (isInitiator) {
      pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      })
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        state.socket.emit('webrtc-offer', {
          offer: pc.localDescription,
          to: remoteSocketId
        });
      })
      .catch(err => console.error('[WebRTC] Offer error:', err));
    }

    return pc;
  }

  function removePeer(socketId) {
    const pc = state.peers.get(socketId);
    if (pc) {
      pc.close();
      state.peers.delete(socketId);
    }
    state.remoteStreams.delete(socketId);
    removeRemoteVideo(socketId);
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 6: ROOM UI — Video Grid, Controls, Chat
  // ═══════════════════════════════════════════════════════════
  function handleRoomJoined(data) {
    const { room, messages, canvas, clickerGame } = data;

    state.roomSlug = room.slug;
    state.joinCode = room.joinCode;

    // Update UI
    document.getElementById('room-title').textContent = room.name;
    document.getElementById('room-slug-display').textContent = room.slug;
    document.getElementById('local-name').textContent = `${state.username} (You)`;
    updateUserCount(room.userCount);

    // Update URL
    history.pushState(null, '', `/room/${room.slug}`);

    // Load existing messages
    messages.forEach(msg => appendChatMessage(msg, false));

    // Restore canvas
    if (canvas && canvas.strokes) {
      canvas.strokes.forEach(stroke => drawRemoteStroke(stroke));
    }

    // Restore clicker game state
    if (clickerGame && clickerGame.isActive) {
      startClickerGame(clickerGame.endsAt, clickerGame.scores, null);
    }

    // Show room screen
    showScreen('room-screen');
    showToast(`Welcome to ${room.name}!`, 'success');

    // Initialize drawing canvas
    initDrawingCanvas();

    // Create peer connections for existing users
    room.users.forEach(user => {
      if (user.socketId !== state.socket.id) {
        createPeerConnection(user.socketId, true);
      }
    });

    updateVideoGridLayout();
  }

  function addRemoteVideo(socketId, stream) {
    // Don't duplicate
    if (document.getElementById(`tile-${socketId}`)) {
      const existingVideo = document.querySelector(`#tile-${socketId} video`);
      if (existingVideo) existingVideo.srcObject = stream;
      return;
    }

    const grid = document.getElementById('video-grid');
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${socketId}`;
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="video-overlay">
        <span class="video-name" id="name-${socketId}">Participant</span>
        <div class="video-indicators">
          <span class="indicator" id="mic-${socketId}"><i class="fas fa-microphone"></i></span>
          <span class="indicator" id="cam-${socketId}"><i class="fas fa-video"></i></span>
        </div>
      </div>
      <div class="video-avatar hidden" id="avatar-${socketId}">
        <i class="fas fa-user"></i>
      </div>
    `;

    tile.querySelector('video').srcObject = stream;
    grid.appendChild(tile);
    updateVideoGridLayout();
  }

  function removeRemoteVideo(socketId) {
    const tile = document.getElementById(`tile-${socketId}`);
    if (tile) {
      tile.remove();
      updateVideoGridLayout();
    }
  }

  function updateVideoGridLayout() {
    const grid = document.getElementById('video-grid');
    const count = grid.children.length;
    grid.setAttribute('data-count', Math.min(count, 6));
  }

  function updateRemoteMediaIndicator(socketId, type, isOn) {
    if (type === 'audio') {
      const indicator = document.getElementById(`mic-${socketId}`);
      if (indicator) {
        indicator.classList.toggle('muted', !isOn);
        indicator.innerHTML = isOn
          ? '<i class="fas fa-microphone"></i>'
          : '<i class="fas fa-microphone-slash"></i>';
      }
    } else {
      const indicator = document.getElementById(`cam-${socketId}`);
      const avatar = document.getElementById(`avatar-${socketId}`);
      if (indicator) {
        indicator.classList.toggle('muted', !isOn);
        indicator.innerHTML = isOn
          ? '<i class="fas fa-video"></i>'
          : '<i class="fas fa-video-slash"></i>';
      }
      if (avatar) {
        avatar.classList.toggle('hidden', isOn);
      }
    }
  }

  function updateUserCount(count) {
    const el = document.getElementById('room-user-count');
    if (el) el.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 7: MEDIA CONTROLS
  // ═══════════════════════════════════════════════════════════
  function toggleAudio() {
    if (!state.localStream) return;
    state.isAudioOn = !state.isAudioOn;

    state.localStream.getAudioTracks().forEach(track => {
      track.enabled = state.isAudioOn;
    });

    const btn = document.getElementById('btn-mic');
    btn.classList.toggle('muted', !state.isAudioOn);
    btn.querySelector('i').className = state.isAudioOn
      ? 'fas fa-microphone' : 'fas fa-microphone-slash';

    const localMic = document.getElementById('local-mic-indicator');
    localMic.classList.toggle('muted', !state.isAudioOn);
    localMic.innerHTML = state.isAudioOn
      ? '<i class="fas fa-microphone"></i>'
      : '<i class="fas fa-microphone-slash"></i>';

    state.socket.emit('toggle-audio', { isAudioOn: state.isAudioOn });
  }

  function toggleVideo() {
    if (!state.localStream) return;
    state.isVideoOn = !state.isVideoOn;

    state.localStream.getVideoTracks().forEach(track => {
      track.enabled = state.isVideoOn;
    });

    const btn = document.getElementById('btn-cam');
    btn.classList.toggle('muted', !state.isVideoOn);
    btn.querySelector('i').className = state.isVideoOn
      ? 'fas fa-video' : 'fas fa-video-slash';

    const localCam = document.getElementById('local-cam-indicator');
    localCam.classList.toggle('muted', !state.isVideoOn);

    const localAvatar = document.getElementById('local-avatar');
    localAvatar.classList.toggle('hidden', state.isVideoOn);

    state.socket.emit('toggle-video', { isVideoOn: state.isVideoOn });
  }

  async function toggleScreenShare() {
    const btn = document.getElementById('btn-screen');

    if (!state.isScreenSharing) {
      try {
        state.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always' },
          audio: false
        });

        const screenTrack = state.screenStream.getVideoTracks()[0];

        // Replace video track in all peer connections
        state.peers.forEach((pc) => {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        });

        // Show screen in local tile
        document.getElementById('local-video').srcObject = state.screenStream;

        screenTrack.onended = () => {
          stopScreenShare();
        };

        state.isScreenSharing = true;
        btn.classList.add('active');
        state.socket.emit('screen-share-started');
        showToast('Screen sharing started', 'info');
      } catch (err) {
        console.log('[Screen] Share cancelled');
      }
    } else {
      stopScreenShare();
    }
  }

  function stopScreenShare() {
    if (state.screenStream) {
      state.screenStream.getTracks().forEach(t => t.stop());
    }

    // Restore camera video
    if (state.localStream) {
      const videoTrack = state.localStream.getVideoTracks()[0];
      state.peers.forEach((pc) => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender && videoTrack) sender.replaceTrack(videoTrack);
      });
      document.getElementById('local-video').srcObject = state.localStream;
    }

    state.isScreenSharing = false;
    document.getElementById('btn-screen').classList.remove('active');
    state.socket.emit('screen-share-stopped');
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 8: TEXT CHAT
  // ═══════════════════════════════════════════════════════════
  function sendMessage(e) {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !state.socket) return;

    state.socket.emit('chat-message', { text });
    input.value = '';
    state.socket.emit('typing-stop');
  }

  function appendChatMessage(message, scroll = true) {
    const container = document.getElementById('messages-container');
    const welcome = container.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const isOwn = message.username === state.username;
    const time = new Date(message.timestamp).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit'
    });

    const div = document.createElement('div');
    div.className = `message ${isOwn ? 'own' : ''}`;
    div.innerHTML = `
      <div class="message-header">
        <span class="message-author">${isOwn ? 'You' : message.username}</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-text">${message.text}</div>
    `;

    container.appendChild(div);
    if (scroll) container.scrollTop = container.scrollHeight;

    // Update unread badge
    if (!state.sidebarOpen && !isOwn) {
      state.unreadMessages++;
      const badge = document.getElementById('chat-badge');
      badge.textContent = state.unreadMessages;
      badge.classList.remove('hidden');
    }
  }

  function addSystemMessage(text) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = 'message system';
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  let typingTimeout = null;
  function setupChatInput() {
    const input = document.getElementById('chat-input');
    if (!input) return;

    input.addEventListener('input', () => {
      if (!state.socket) return;
      state.socket.emit('typing-start');
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        state.socket.emit('typing-stop');
      }, 2000);
    });
  }

  function showTypingIndicator(username) {
    const indicator = document.getElementById('typing-indicator');
    document.getElementById('typing-user').textContent = username;
    indicator.classList.remove('hidden');
  }

  function hideTypingIndicator() {
    document.getElementById('typing-indicator').classList.add('hidden');
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 9: SIDEBAR & PANELS
  // ═══════════════════════════════════════════════════════════
  function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    document.getElementById('chat-sidebar').classList.toggle('collapsed', !state.sidebarOpen);
    document.getElementById('btn-toggle-sidebar').classList.toggle('active', state.sidebarOpen);

    if (state.sidebarOpen) {
      state.unreadMessages = 0;
      document.getElementById('chat-badge').classList.add('hidden');
    }

    // Close games panel if opening chat
    if (state.sidebarOpen && state.gamesPanelOpen) {
      state.gamesPanelOpen = false;
      document.getElementById('games-panel').classList.add('collapsed');
      document.getElementById('btn-toggle-games').classList.remove('active');
    }
  }

  function toggleGamesPanel() {
    state.gamesPanelOpen = !state.gamesPanelOpen;
    document.getElementById('games-panel').classList.toggle('collapsed', !state.gamesPanelOpen);
    document.getElementById('btn-toggle-games').classList.toggle('active', state.gamesPanelOpen);

    // Close chat if opening games
    if (state.gamesPanelOpen && state.sidebarOpen) {
      state.sidebarOpen = false;
      document.getElementById('chat-sidebar').classList.add('collapsed');
      document.getElementById('btn-toggle-sidebar').classList.remove('active');
    }

    // Resize canvas when panel opens
    if (state.gamesPanelOpen) {
      setTimeout(resizeDrawingCanvas, 100);
    }
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 10: DRAWING BOARD (Boredom Killer #1)
  // ═══════════════════════════════════════════════════════════
  function initDrawingCanvas() {
    const canvas = document.getElementById('drawing-canvas');
    if (!canvas) return;

    state.drawCtx = canvas.getContext('2d');
    resizeDrawingCanvas();

    // Color and size inputs
    document.getElementById('draw-color').addEventListener('input', (e) => {
      state.drawColor = e.target.value;
      state.isEraser = false;
      document.getElementById('btn-eraser').classList.remove('active');
    });

    document.getElementById('draw-size').addEventListener('input', (e) => {
      state.drawSize = parseInt(e.target.value);
    });

    // Mouse events
    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDraw);
    canvas.addEventListener('mouseleave', stopDraw);

    // Touch events
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      startDraw({ offsetX: touch.clientX - rect.left, offsetY: touch.clientY - rect.top });
    });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      draw({ offsetX: touch.clientX - rect.left, offsetY: touch.clientY - rect.top });
    });
    canvas.addEventListener('touchend', stopDraw);
  }

  function resizeDrawingCanvas() {
    const canvas = document.getElementById('drawing-canvas');
    if (!canvas) return;
    const parent = canvas.parentElement;
    canvas.width = parent.clientWidth - 32;
    canvas.height = 350;
  }

  let lastX, lastY;
  function startDraw(e) {
    state.isDrawing = true;
    lastX = e.offsetX;
    lastY = e.offsetY;
  }

  function draw(e) {
    if (!state.isDrawing || !state.drawCtx) return;

    const canvas = document.getElementById('drawing-canvas');
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;

    const x = e.offsetX * scaleX;
    const y = e.offsetY * scaleY;
    const prevX = lastX * scaleX;
    const prevY = lastY * scaleY;

    const strokeData = {
      x, y, prevX, prevY,
      color: state.isEraser ? '#1a1a2e' : state.drawColor,
      size: state.isEraser ? state.drawSize * 3 : state.drawSize,
      w: canvas.width,
      h: canvas.height
    };

    drawStroke(strokeData);
    state.socket?.emit('canvas-draw', strokeData);

    lastX = e.offsetX;
    lastY = e.offsetY;
  }

  function stopDraw() {
    state.isDrawing = false;
  }

  function drawStroke(data) {
    const ctx = state.drawCtx;
    if (!ctx) return;

    const canvas = document.getElementById('drawing-canvas');
    const scaleX = canvas.width / data.w;
    const scaleY = canvas.height / data.h;

    ctx.beginPath();
    ctx.moveTo(data.prevX * scaleX, data.prevY * scaleY);
    ctx.lineTo(data.x * scaleX, data.y * scaleY);
    ctx.strokeStyle = data.color;
    ctx.lineWidth = data.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawRemoteStroke(strokeData) {
    drawStroke(strokeData);
  }

  function clearCanvas() {
    clearLocalCanvas();
    state.socket?.emit('canvas-clear');
  }

  function clearLocalCanvas() {
    const canvas = document.getElementById('drawing-canvas');
    if (!canvas || !state.drawCtx) return;
    state.drawCtx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function toggleEraser() {
    state.isEraser = !state.isEraser;
    document.getElementById('btn-eraser').classList.toggle('active', state.isEraser);
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 11: CLICKER GAME (Boredom Killer #2)
  // ═══════════════════════════════════════════════════════════
  function startClicker() {
    if (!state.socket) return;
    state.socket.emit('clicker-start');
  }

  function startClickerGame(endsAt, scores, startedBy) {
    state.clickerActive = true;
    state.myClicks = 0;

    const btn = document.getElementById('clicker-btn');
    const startBtn = document.getElementById('clicker-start-btn');
    const timerEl = document.getElementById('clicker-timer');
    const countEl = document.getElementById('clicker-count');
    const resultEl = document.getElementById('clicker-result');

    btn.disabled = false;
    startBtn.disabled = true;
    resultEl.classList.add('hidden');
    countEl.textContent = '0';

    if (startedBy) {
      showToast(`${startedBy} started a Clicker Battle!`, 'info');
    }

    updateClickerScores(scores);

    // Timer countdown
    const endTime = new Date(endsAt).getTime();
    clearInterval(state.clickerTimer);
    state.clickerTimer = setInterval(() => {
      const remaining = Math.max(0, endTime - Date.now());
      const secs = Math.floor(remaining / 1000);
      const ms = Math.floor((remaining % 1000) / 10);
      timerEl.textContent = `${String(secs).padStart(2, '0')}:${String(ms).padStart(2, '0')}`;

      if (remaining <= 0) {
        clearInterval(state.clickerTimer);
        timerEl.textContent = '00:00';
        btn.disabled = true;
        state.clickerActive = false;
      }
    }, 50);
  }

  function clickerClick() {
    if (!state.clickerActive || !state.socket) return;
    state.myClicks++;
    document.getElementById('clicker-count').textContent = state.myClicks;

    // Haptic feedback if available
    navigator.vibrate?.(10);

    state.socket.emit('clicker-click');
  }

  function updateClickerScores(scores) {
    const container = document.getElementById('clicker-scores');
    if (!container) return;

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    container.innerHTML = sorted.map(([name, score], i) => `
      <div class="score-entry ${i === 0 ? 'winner' : ''}">
        <span class="score-name">${i === 0 ? '👑 ' : ''}${name}</span>
        <span class="score-value">${score}</span>
      </div>
    `).join('');
  }

  function endClickerGame(scores, winner) {
    state.clickerActive = false;
    clearInterval(state.clickerTimer);

    const btn = document.getElementById('clicker-btn');
    const startBtn = document.getElementById('clicker-start-btn');
    const resultEl = document.getElementById('clicker-result');

    btn.disabled = true;
    startBtn.disabled = false;

    updateClickerScores(scores);

    if (winner) {
      resultEl.classList.remove('hidden');
      resultEl.innerHTML = `🏆 <strong>${winner.username}</strong> wins with ${winner.score} clicks!`;
      showToast(`${winner.username} won the Clicker Battle! (${winner.score} clicks)`, 'success');
    }
  }

  function switchGameTab(game) {
    state.currentGame = game;
    document.querySelectorAll('.game-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`tab-${game}`).classList.add('active');

    document.getElementById('game-drawing').classList.toggle('hidden', game !== 'drawing');
    document.getElementById('game-clicker').classList.toggle('hidden', game !== 'clicker');

    if (game === 'drawing') {
      setTimeout(resizeDrawingCanvas, 100);
    }
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 12: REACTIONS & UTILITIES
  // ═══════════════════════════════════════════════════════════
  function sendReaction(emoji) {
    if (!state.socket) return;
    state.socket.emit('send-reaction', { emoji });
    showFloatingReaction(emoji);
  }

  function showFloatingReaction(emoji) {
    const overlay = document.getElementById('reaction-overlay');
    const el = document.createElement('span');
    el.className = 'floating-reaction';
    el.textContent = emoji;
    el.style.left = `${Math.random() * 80 + 10}%`;
    el.style.bottom = '20%';
    overlay.appendChild(el);

    setTimeout(() => el.remove(), 3000);
  }

  function copyJoinCode() {
    const text = `Join Code: ${state.joinCode}\nSlug: ${state.roomSlug}\nURL: ${window.location.origin}/room/${state.roomSlug}`;
    navigator.clipboard.writeText(text).then(() => {
      showToast('Room info copied to clipboard!', 'success');
    }).catch(() => {
      showToast('Failed to copy', 'error');
    });
  }

  function leaveRoom() {
    if (!confirm('Are you sure you want to leave?')) return;

    // Clean up WebRTC
    state.peers.forEach((pc, id) => {
      pc.close();
    });
    state.peers.clear();
    state.remoteStreams.clear();

    if (state.localStream) {
      state.localStream.getTracks().forEach(t => t.stop());
    }
    if (state.screenStream) {
      state.screenStream.getTracks().forEach(t => t.stop());
    }

    state.socket?.disconnect();
    state.socket = null;
    state.roomId = null;
    state.token = null;

    // Clean up video grid
    const grid = document.getElementById('video-grid');
    grid.querySelectorAll('.video-tile:not(.local-tile)').forEach(t => t.remove());

    // Reset chat
    const msgs = document.getElementById('messages-container');
    msgs.innerHTML = '<div class="chat-welcome"><i class="fas fa-hand-sparkles"></i><p>Welcome! Messages appear here.</p></div>';

    showScreen('landing-screen');
    showToast('You left the room', 'info');
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 13: TOAST NOTIFICATION SYSTEM
  // ═══════════════════════════════════════════════════════════
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const icons = {
      info: 'fas fa-info-circle',
      success: 'fas fa-check-circle',
      error: 'fas fa-exclamation-circle',
      warning: 'fas fa-exclamation-triangle',
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="${icons[type]}"></i> ${message}`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }


  // ═══════════════════════════════════════════════════════════
  // SECTION 14: URL-BASED ROUTING & INITIALIZATION
  // ═══════════════════════════════════════════════════════════
  function handleRouting() {
    const path = window.location.pathname;
    const match = path.match(/^\/room\/(.+)/);

    if (match) {
      const slug = match[1];
      // Auto-populate join form and navigate
      document.getElementById('join-code').value = slug;
      showScreen('join-screen');
    }
  }

  function init() {
    // Initialize Three.js background
    ThreeBackground.init();

    // Setup chat input listener
    setupChatInput();

    // Handle URL routing
    handleRouting();

    // Browser back/forward navigation
    window.addEventListener('popstate', handleRouting);

    // Warn before leaving room
    window.addEventListener('beforeunload', (e) => {
      if (state.roomId) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Initialize games panel as collapsed
    document.getElementById('games-panel').classList.add('collapsed');

    console.log('%c NEXUS Platform Loaded ', 'background: linear-gradient(135deg, #6c63ff, #00f5ff); color: white; padding: 8px 16px; border-radius: 4px; font-weight: bold;');
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════
  return {
    init,
    showScreen,
    createRoom,
    enterCreatedRoom,
    joinRoom,
    validateLobby,
    toggleAudio,
    toggleVideo,
    toggleScreenShare,
    sendMessage,
    toggleSidebar,
    toggleGamesPanel,
    switchGameTab,
    clearCanvas,
    toggleEraser,
    startClicker,
    clickerClick,
    sendReaction,
    copyJoinCode,
    leaveRoom,
    showToast,
  };
})();

// ── Bootstrap ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', App.init);
