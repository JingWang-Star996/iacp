# Phase 2: Reliable WebSocket Communication Layer

## Overview

Production-grade reliable communication layer built on top of WebSocket, providing:

| Feature | Description |
|---------|-------------|
| **ACK** | 500ms ACK timeout per message, auto-retry on timeout |
| **Retry** | Exponential backoff + jitter: 1s → 3s → 7s, max 3 retries |
| **Idempotency** | LRU cache (1000 entries, 5min TTL), deduplicates by msg_id |
| **Offline Queue** | JSONL file buffer, auto-replay on reconnect |
| **Heartbeat** | App-layer ping/pong every 15s, 10s timeout → reconnect |
| **Reconnect** | Exponential backoff: 1s → 2s → 4s → 8s → 16s → max 30s |

## File Structure

```
phase2/
├── reliable-ws-layer.js   # Core reliable communication module
├── hermes-client-v2.js    # Hermes-side client demo
├── openclaw-client-v2.js  # OpenClaw-side client demo
├── test-phase2.js         # Integration tests (6 test cases)
└── README.md              # This file
```

## Prerequisites

```bash
npm install ws
```

## Quick Start

### 1. Start the WS Relay Server (Phase 1)

```bash
cd ../phase1
node ws-server.js
```

### 2. Start Clients

```bash
# Terminal 1: Hermes
node hermes-client-v2.js

# Terminal 2: OpenClaw
node openclaw-client-v2.js
```

### 3. Run Tests

```bash
node test-phase2.js
```

## API Reference

### `ReliableWSClient`

```js
const { ReliableWSClient } = require('./reliable-ws-layer');

const client = new ReliableWSClient({
  url: 'ws://127.0.0.1:8765',  // WS server URL
  clientId: 'hermes',            // Client identifier
  queueDir: '.',                 // Directory for queue/failure files
  logLevel: 'info',              // debug | info | warn | error

  // Optional overrides:
  ackTimeoutMs: 500,             // ACK timeout
  maxRetries: 3,                 // Max retry attempts
  retryDelaysMs: [1000, 3000, 7000], // Retry delays
  heartbeatIntervalMs: 15000,    // Ping interval
  heartbeatTimeoutMs: 10000,     // Pong timeout
  reconnectBaseMs: 1000,         // Base reconnect delay
  reconnectMaxMs: 30000,         // Max reconnect delay
  maxReconnectAttempts: 5,       // Max reconnect attempts
});

// Connect
await client.connect();

// Send message
const msgId = client.send('chat', { text: 'hello' }, 'openclaw');

// Receive messages
client.onMessage((msg) => {
  console.log(msg.type, msg.content);
});

// Disconnect
client.disconnect();

// Status
client.isConnected;       // boolean
client.pendingCount;      // number of un-ACKed messages
client.queueSize;         // number of queued offline messages
client.reconnectAttempts; // reconnect attempt count
```

### Message Format

```json
{
  "msg_id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "chat",
  "content": { "text": "hello" },
  "from": "hermes",
  "to": "openclaw",
  "seq": 1,
  "ts": 1713456000000,
  "retry_count": 0
}
```

### ACK Format

```json
{
  "type": "ack",
  "msg_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "received"
}
```

## Queue Files

- `queue_hermes.jsonl` — Hermes offline message buffer
- `queue_openclaw.jsonl` — OpenClaw offline message buffer
- `failed_hermes.jsonl` — Hermes permanently failed messages
- `failed_openclaw.jsonl` — OpenClaw permanently failed messages

Queue files are in JSONL format (one JSON object per line).

## Test Results

Run `node test-phase2.js` to see 6 integration tests:

1. **ACK Flow** — Verifies ACK round-trip
2. **Retry Mechanism** — Verifies retry with backoff and failure logging
3. **Idempotency** — Verifies duplicate messages are deduplicated
4. **Offline Queue + Replay** — Verifies queue and replay on reconnect
5. **Heartbeat** — Verifies ping/pong cycle
6. **Reconnect** — Verifies auto-reconnect with exponential backoff

## Architecture

```
┌──────────────┐     WS      ┌──────────────┐     WS      ┌──────────────┐
│   Hermes     │ ◄─────────► │ WS Server    │ ◄─────────► │  OpenClaw    │
│  Client V2   │  reliable   │  (Phase 1)   │  reliable   │  Client V2   │
└──────────────┘   layer     └──────────────┘   layer     └──────────────┘
     │                                                        │
     ├── ACK/retry/idempotency ───────────────────────────────┤
     ├── Offline queue (JSONL) ───────────────────────────────┤
     └── Heartbeat + reconnect ───────────────────────────────┘
```

## Migration from Phase 1

Phase 1 clients use raw WebSocket. Phase 2 wraps it with `ReliableWSClient`:

```diff
- const WebSocket = require('ws');
- const ws = new WebSocket(url);
- ws.send(JSON.stringify(msg));
+ const { ReliableWSClient } = require('./reliable-ws-layer');
+ const client = new ReliableWSClient({ url, clientId });
+ await client.connect();
+ client.send(type, content);
```

No changes needed on the server side — the reliable layer is purely client-side.
