# 🚀 NEXUS Platform — Deployment Guide

## Project Structure

```
nexus-realtime-platform/
├── server.js            # Express + Socket.io signaling server
├── package.json         # Dependencies & start scripts
├── render.yaml          # Render.com Blueprint (IaC)
├── .env                 # Environment variables (local only)
├── .gitignore
├── DEPLOY.md
└── public/              # Static frontend assets
    ├── index.html       # SPA with all screens
    ├── style.css        # Glassmorphism dark theme
    └── client.js        # Three.js + Socket.io + WebRTC + Games
```

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Create .env file (already included)
# PORT=3000, NODE_ENV=development

# 3. Start the server
npm start
# Or with auto-reload:
npm run dev

# 4. Open http://localhost:3000
```

## Deploying to Render.com

### Option A: Blueprint (Recommended)
1. Push this project to a GitHub/GitLab repository.
2. Go to [Render Dashboard](https://dashboard.render.com/).
3. Click **"New" → "Blueprint"**.
4. Connect your repo — Render reads `render.yaml` automatically.
5. Click **"Apply"** and your service deploys.

### Option B: Manual Setup
1. Go to [Render Dashboard](https://dashboard.render.com/).
2. Click **"New" → "Web Service"**.
3. Connect your GitHub repository.
4. Configure:
   - **Name**: `nexus-platform`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (or Starter for always-on)
5. Go to **"Environment"** tab and add:

| Key        | Value        |
|------------|--------------|
| `NODE_ENV` | `production` |
| `PORT`     | `10000`      |

> Render automatically assigns PORT=10000. The server reads `process.env.PORT`.

6. Click **"Create Web Service"**. Done!

## Environment Variables on Render Dashboard

Navigate to your service → **Environment** tab:

| Variable            | Description                              | Required |
|---------------------|------------------------------------------|----------|
| `PORT`              | Server port (Render uses 10000)          | Auto     |
| `NODE_ENV`          | Set to `production`                      | Yes      |
| `STUN_URL`          | Custom STUN server (optional)            | No       |
| `TURN_URL`          | TURN server URL for NAT traversal        | No       |
| `TURN_USERNAME`     | TURN server username                     | No       |
| `TURN_CREDENTIAL`   | TURN server credential                   | No       |
| `MAX_ROOMS`         | Max concurrent rooms (default: 100)      | No       |
| `MAX_USERS_PER_ROOM`| Max users per room (default: 12)         | No       |

## Socket.io Client Connection (No Hardcoded URLs)

The client connects to the **production origin automatically**:

```javascript
// In client.js — this works for ANY deployment:
const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
});
```

When you call `io()` with NO URL argument, Socket.io automatically connects
to `window.location.origin` — which is your Render domain
(e.g., `https://nexus-platform.onrender.com`).

**No hardcoded `localhost` anywhere.** This is production-safe by design.

## WebRTC TURN Servers (Production)

For reliable peer-to-peer connections behind corporate firewalls/NATs,
configure a TURN server. Free options:
- [Open Relay](https://www.metered.ca/tools/openrelay/)
- [Twilio TURN](https://www.twilio.com/docs/stun-turn)
- [Xirsys](https://xirsys.com/)

## Architecture Overview

```
Browser A ←→ Socket.io ←→ Server ←→ Socket.io ←→ Browser B
    ↕                                                  ↕
    └──────────── WebRTC (P2P Video/Audio) ────────────┘
```

- **Socket.io**: Signaling, chat, game sync, presence
- **WebRTC**: Peer-to-peer video/audio (no media through server)
- **Express**: Static file serving, REST API for room management
- **Three.js**: 3D WebGL animated background on landing page
```
