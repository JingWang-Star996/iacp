# Quick Start Guide

Get IACP running in 5 minutes.

## Prerequisites

- Node.js >= 16
- npm

## Option 1: Quick Demo (2 assistants talking)

```bash
# 1. Clone and install
git clone https://github.com/JingWang-Star996/iacp.git
cd iacp
npm install

# 2. Start the WebSocket relay server
npm start
# → {"ts":"...","level":"info","event":"server_started","host":"127.0.0.1","port":8765,...}

# 3. In another terminal, start Assistant A
IACP_CLIENT_ID=assistant-a npm run client:demo-a
# → [assistant-a] Connecting to ws://127.0.0.1:8765...
# → [assistant-a] Connected ✓
# → [assistant-a] >

# 4. In a third terminal, start Assistant B
IACP_CLIENT_ID=assistant-b npm run client:demo-b
# → [assistant-b] Connected ✓
# → [assistant-b] >

# 5. Type a message in either terminal
# [assistant-a] > Hello from A!
# → In terminal B: [assistant-b] ← [assistant-a]: Hello from A!
```

## Option 2: Docker (one command)

```bash
# Start all 3 services (server + 2 demo clients)
docker compose up -d

# Check health
curl http://127.0.0.1:8765/health
# → {"status":"ok","protocol":"IACP","version":"1.0.0","clients":["assistant-a","assistant-b"],...}

# View logs
docker compose logs -f iacp-server

# Interactive chat with a client
docker attach iacp-assistant-a
```

## Option 3: Production Server with Monitoring

```bash
# Start the production server (Prometheus metrics + health checks)
npm run start:production

# Check health
curl http://127.0.0.1:8765/health

# View Prometheus metrics
curl http://127.0.0.1:8765/metrics

# Connect your assistants
# Assistant 1:
IACP_CLIENT_ID=my-ai-1 IACP_WS_URL=ws://127.0.0.1:8765 node src/ws-relay/ws-client.js

# Assistant 2:
IACP_CLIENT_ID=my-ai-2 IACP_WS_URL=ws://127.0.0.1:8765 node src/ws-relay/ws-client.js
```

## Configuration

All settings via environment variables. Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `IACP_HOST` | `127.0.0.1` | Bind address |
| `IACP_WS_PORT` | `8765` | WebSocket port |
| `IACP_HEALTH_PORT` | `8081` | Health check port |
| `IACP_CLIENT_IDS` | *(any)* | Comma-separated allowed client IDs |
| `IACP_HEARTBEAT_INTERVAL_MS` | `15000` | Ping interval |
| `IACP_MAX_MESSAGE_BYTES` | `1048576` | Max message size (1MB) |

## Using IACP in Your Own Assistant

```javascript
const { WebSocket } = require('ws');

const ws = new WebSocket('ws://127.0.0.1:8765', {
  headers: { 'x-client-id': 'my-assistant' },
});

ws.on('open', () => {
  console.log('Connected to IACP');
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'message') {
    console.log(`Received from ${msg._from}: ${msg.content}`);
    // Process the message with your AI assistant
  }
});

function sendToPeers(content) {
  ws.send(JSON.stringify({
    type: 'message',
    from: 'my-assistant',
    content: content,
    msg_id: `my-assistant-${Date.now()}`,
    timestamp: new Date().toISOString(),
  }));
}
```

## Running Tests

```bash
# Integration tests (7 test cases)
npm test

# Reliable layer tests (6 test cases)
npm run test:reliable

# Monitoring tests (8 test cases)
npm run test:monitoring
```
