#!/usr/bin/env node
/**
 * ws-server.js — WebSocket relay server for OpenClaw ↔ Hermes
 *
 * Listens on 127.0.0.1:8765
 * Authenticates clients via x-client-id header
 * Routes messages between connected clients
 * Implements heartbeat detection (ping/pong)
 */

const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────
const HOST = process.env.WS_HOST || '127.0.0.1';
const PORT = parseInt(process.env.WS_PORT || '8765', 10);
const HEARTBEAT_INTERVAL = 30_000;   // server-side ping every 30s
const HEARTBEAT_TIMEOUT   = 10_000;  // kill connection if no pong within 10s
const LOG_FILE = path.join(__dirname, 'server.log.jsonl');

// ── Structured logger ───────────────────────────────────────────────────────
function log(level, event, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...extra,
  };
  const line = JSON.stringify(entry);
  // always stdout
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
  // also append to log file
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}

// ── Client registry ─────────────────────────────────────────────────────────
const clients = new Map(); // clientId -> { ws, heartbeatTimer, pongTimer, connectedAt }

function broadcast(senderId, message) {
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  for (const [id, info] of clients) {
    if (id === senderId) continue;
    if (info.ws.readyState === WebSocket.OPEN) {
      info.ws.send(data);
    }
  }
}

function removeClient(clientId) {
  const info = clients.get(clientId);
  if (!info) return;
  clearInterval(info.heartbeatTimer);
  clearTimeout(info.pongTimer);
  clients.delete(clientId);
  log('info', 'client_disconnected', { clientId });
}

// ── HTTP upgrade verification ───────────────────────────────────────────────
function verifyClient(info, cb) {
  const clientId = info.req.headers['x-client-id'];
  if (!clientId) {
    log('warn', 'auth_rejected', { reason: 'missing x-client-id header', ip: info.req.socket.remoteAddress });
    cb(false, 401, 'Unauthorized: missing x-client-id');
    return;
  }
  if (clients.has(clientId)) {
    log('warn', 'auth_duplicate', { clientId });
    cb(false, 409, 'Conflict: client already connected');
    return;
  }
  cb(true);
}

// ── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocket.Server({
  host: HOST,
  port: PORT,
  verifyClient,
  // use an existing http server so we can add a health endpoint if needed
});

// ── Health endpoint on same port ────────────────────────────────────────────
// We'll create a standalone HTTP server and pass it to ws
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const status = {
      status: 'ok',
      uptime: process.uptime(),
      clients: Array.from(clients.keys()),
      clientCount: clients.size,
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const wssOnHttp = new WebSocket.Server({
  server: healthServer,
  verifyClient,
});

wssOnHttp.on('connection', (ws, req) => {
  const clientId = req.headers['x-client-id'];
  ws.isAlive = true;

  clients.set(clientId, {
    ws,
    heartbeatTimer: null,
    pongTimer: null,
    connectedAt: new Date().toISOString(),
  });

  log('info', 'client_connected', { clientId, ip: req.socket.remoteAddress });

  // heartbeat: send server ping, expect pong
  const hbTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!ws.isAlive) {
      log('warn', 'heartbeat_timeout', { clientId });
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
    // if no pong within timeout, kill
    clients.get(clientId).pongTimer = setTimeout(() => {
      if (clients.has(clientId)) {
        log('warn', 'pong_timeout', { clientId });
        ws.terminate();
      }
    }, HEARTBEAT_TIMEOUT);
  }, HEARTBEAT_INTERVAL);

  clients.get(clientId).heartbeatTimer = hbTimer;

  // client pong
  ws.on('pong', () => {
    ws.isAlive = true;
    const info = clients.get(clientId);
    if (info) clearTimeout(info.pongTimer);
  });

  // client heartbeat ping (from client side)
  ws.on('ping', () => {
    ws.pong();
  });

  // message handling
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log('warn', 'parse_error', { clientId, raw: raw.toString().slice(0, 200) });
      ws.send(JSON.stringify({ type: 'error', content: 'Invalid JSON' }));
      return;
    }

    // enrich message with server-side metadata
    msg._receivedAt = new Date().toISOString();
    msg._from = clientId;

    // handle control messages locally
    if (msg.type === 'ack' || msg.type === 'pong' || msg.type === 'ping') {
      return;
    }

    // relay to other clients
    broadcast(clientId, msg);

    // log
    log('info', 'message_routed', {
      clientId,
      msgType: msg.type,
      msgId: msg.msg_id || '(none)',
    });
  });

  ws.on('close', () => removeClient(clientId));
  ws.on('error', (err) => {
    log('error', 'client_error', { clientId, error: err.message });
    removeClient(clientId);
  });
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown(signal) {
  log('info', 'server_shutdown', { signal });
  for (const [id] of clients) removeClient(id);
  wssOnHttp.close(() => {
    healthServer.close(() => {
      log('info', 'server_stopped');
      process.exit(0);
    });
  });
  // force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Start ───────────────────────────────────────────────────────────────────
healthServer.listen(PORT, HOST, () => {
  log('info', 'server_started', { host: HOST, port: PORT, pid: process.pid });
});

module.exports = { wss: wssOnHttp, healthServer, clients };
