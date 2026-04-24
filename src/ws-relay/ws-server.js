#!/usr/bin/env node
/**
 * ws-server.js — IACP WebSocket relay server
 *
 * A production-ready WebSocket bridge for AI assistant instances
 * to communicate peer-to-peer on a single host.
 *
 * Environment variables:
 *   IACP_HOST                    - Bind address (default: 127.0.0.1)
 *   IACP_WS_PORT                 - WebSocket port (default: 8765)
 *   IACP_CLIENT_IDS              - Comma-separated allowed client IDs (default: any)
 *   IACP_HEARTBEAT_INTERVAL_MS   - Ping interval in ms (default: 15000)
 *   IACP_HEARTBEAT_TIMEOUT_MS    - Pong timeout in ms (default: 10000)
 *   IACP_MAX_MESSAGE_BYTES       - Max message size in bytes (default: 1048576)
 *   IACP_LOG_FILE                - Log file path (default: stdout only)
 */

const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────
const HOST = process.env.IACP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IACP_WS_PORT || process.env.IACP_PORT || '8765', 10);
const HEARTBEAT_INTERVAL = parseInt(process.env.IACP_HEARTBEAT_INTERVAL_MS || '15000', 10);
const HEARTBEAT_TIMEOUT  = parseInt(process.env.IACP_HEARTBEAT_TIMEOUT_MS || '10000', 10);
const MAX_MESSAGE_BYTES  = parseInt(process.env.IACP_MAX_MESSAGE_BYTES || '1048576', 10);
const ALLOWED_CLIENTS    = process.env.IACP_CLIENT_IDS
  ? process.env.IACP_CLIENT_IDS.split(',').map(s => s.trim())
  : null; // null = allow any
const LOG_FILE = process.env.IACP_LOG_FILE || null;

// ── Structured logger ───────────────────────────────────────────────────────
function log(level, event, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
  if (LOG_FILE) {
    try {
      const dir = path.dirname(LOG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(LOG_FILE, line + '\n');
    } catch { /* ignore */ }
  }
}

// ── Client registry ─────────────────────────────────────────────────────────
const clients = new Map(); // clientId -> { ws, heartbeatTimer, pongTimer, connectedAt }

function broadcast(senderId, message) {
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  for (const [id, info] of clients) {
    if (id === senderId) continue;
    if (info.ws.readyState === 1 /* OPEN */) {
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
  if (ALLOWED_CLIENTS && !ALLOWED_CLIENTS.includes(clientId)) {
    log('warn', 'auth_denied', { clientId, allowed: ALLOWED_CLIENTS });
    cb(false, 403, 'Forbidden: client ID not in allowed list');
    return;
  }
  if (clients.has(clientId)) {
    log('warn', 'auth_duplicate', { clientId });
    cb(false, 409, 'Conflict: client already connected');
    return;
  }
  cb(true);
}

// ── Health endpoint ─────────────────────────────────────────────────────────
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const status = {
      status: 'ok',
      protocol: 'IACP',
      version: '1.0.0',
      uptime: Math.round(process.uptime()),
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

// ── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: healthServer,
  verifyClient,
  maxPayload: MAX_MESSAGE_BYTES,
});

wss.on('connection', (ws, req) => {
  const clientId = req.headers['x-client-id'];
  ws.isAlive = true;

  clients.set(clientId, {
    ws,
    heartbeatTimer: null,
    pongTimer: null,
    connectedAt: new Date().toISOString(),
  });

  log('info', 'client_connected', { clientId, ip: req.socket.remoteAddress });

  // Server heartbeat: ping clients, expect pong
  const hbTimer = setInterval(() => {
    if (ws.readyState !== 1) return;
    if (!ws.isAlive) {
      log('warn', 'heartbeat_timeout', { clientId });
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
    const info = clients.get(clientId);
    if (info) {
      info.pongTimer = setTimeout(() => {
        if (clients.has(clientId)) {
          log('warn', 'pong_timeout', { clientId });
          ws.terminate();
        }
      }, HEARTBEAT_TIMEOUT);
    }
  }, HEARTBEAT_INTERVAL);

  clients.get(clientId).heartbeatTimer = hbTimer;

  // Client pong response
  ws.on('pong', () => {
    ws.isAlive = true;
    const info = clients.get(clientId);
    if (info) clearTimeout(info.pongTimer);
  });

  // Client-initiated ping
  ws.on('ping', () => {
    ws.pong();
  });

  // Message handling
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log('warn', 'parse_error', { clientId, raw: raw.toString().slice(0, 200) });
      ws.send(JSON.stringify({ type: 'error', content: 'Invalid JSON' }));
      return;
    }

    // Enrich with server metadata
    msg._receivedAt = new Date().toISOString();
    msg._from = clientId;

    // Handle control messages locally
    if (msg.type === 'ack' || msg.type === 'pong' || msg.type === 'ping') {
      return;
    }

    // Relay to other clients
    broadcast(clientId, msg);

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
  wss.close(() => {
    healthServer.close(() => {
      log('info', 'server_stopped');
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Start ───────────────────────────────────────────────────────────────────
healthServer.listen(PORT, HOST, () => {
  log('info', 'server_started', {
    host: HOST,
    port: PORT,
    pid: process.pid,
    allowedClients: ALLOWED_CLIENTS || 'any',
    heartbeatInterval: HEARTBEAT_INTERVAL,
    maxMessageBytes: MAX_MESSAGE_BYTES,
  });
});

module.exports = { wss, healthServer, clients };
