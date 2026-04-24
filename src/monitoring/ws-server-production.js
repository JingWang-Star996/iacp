#!/usr/bin/env node
/**
 * ws-server-production.js — IACP Production Monitoring Server
 *
 * A production-ready WebSocket bridge for AI assistant instances
 * with Prometheus metrics, health checks, and structured logging.
 *
 * Environment variables:
 *   IACP_HOST                    - Bind address (default: 127.0.0.1)
 *   IACP_WS_PORT                 - WebSocket port (default: 8765)
 *   IACP_HEALTH_PORT             - HTTP health/metrics port (default: 8081)
 *   IACP_CLIENT_IDS              - Comma-separated allowed client IDs
 *   IACP_HEARTBEAT_INTERVAL_MS   - Ping interval (default: 15000)
 *   IACP_HEARTBEAT_TIMEOUT_MS    - Pong timeout (default: 10000)
 *   IACP_MAX_MESSAGE_BYTES       - Max message size (default: 1048576)
 *   IACP_LOG_FILE                - Log file path (default: /tmp/iacp/ws-server.log)
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ───────────────────────────────────────────────────────────────
const HOST = process.env.IACP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IACP_WS_PORT || process.env.IACP_PORT || '8765', 10);
const HEALTH_PORT = parseInt(process.env.IACP_HEALTH_PORT || '8081', 10);
const LOG_FILE = process.env.IACP_LOG_FILE || '/tmp/iacp/ws-server.log';
const VALID_CLIENT_IDS = (process.env.IACP_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const HEARTBEAT_INTERVAL = parseInt(process.env.IACP_HEARTBEAT_INTERVAL_MS || '15000', 10);
const HEARTBEAT_TIMEOUT = parseInt(process.env.IACP_HEARTBEAT_TIMEOUT_MS || '10000', 10);
const MAX_MESSAGE_SIZE = parseInt(process.env.IACP_MAX_MESSAGE_BYTES || '1048576', 10); // 1MB

// ─── Metrics Store ────────────────────────────────────────────────────────
const metrics = {
  ws_connections_total: 0,
  ws_messages_sent_total: 0,
  ws_messages_received_total: 0,
  ws_errors_total: 0,
  ws_message_latency_ms: [],          // rolling window of latencies
  _latency_window_size: 1000,
};

function recordLatency(ms) {
  metrics.ws_message_latency_ms.push(ms);
  if (metrics.ws_message_latency_ms.length > metrics._latency_window_size) {
    metrics.ws_message_latency_ms.shift();
  }
}

function getLatencyBuckets() {
  const data = metrics.ws_message_latency_ms;
  const buckets = [5, 10, 25, 50, 100, 250, 500, 1000];
  const result = {};
  let cumulative = 0;
  for (const b of buckets) {
    cumulative += data.filter(v => v <= b).length;
    result[`le${b}`] = cumulative;
  }
  result['le+Inf'] = data.length;
  result['sum'] = data.reduce((a, b) => a + b, 0);
  result['count'] = data.length;
  return result;
}

// ─── Logger ───────────────────────────────────────────────────────────────
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(level, msg, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    hostname: os.hostname(),
    pid: process.pid,
    ...meta,
  };
  const line = JSON.stringify(entry) + '\n';
  logStream.write(line);
  // Also write to stdout for journald capture
  process.stdout.write(line);
}

// ─── Client Registry ──────────────────────────────────────────────────────
const clients = new Map(); // client-id → { ws, alive, lastPong }

function getConnectedClientIds() {
  return Array.from(clients.keys());
}

// ─── HTTP Server (health + metrics) ───────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      protocol: 'IACP',
      version: '1.0.0',
      clients: getConnectedClientIds(),
      uptime: Math.floor(process.uptime()),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (url.pathname === '/metrics') {
    const buckets = getLatencyBuckets();
    const lines = [
      '# HELP ws_connections_total Current number of connected clients',
      '# TYPE ws_connections_total gauge',
      `ws_connections_total ${metrics.ws_connections_total}`,
      '',
      '# HELP ws_messages_sent_total Total messages sent by the bridge',
      '# TYPE ws_messages_sent_total counter',
      `ws_messages_sent_total ${metrics.ws_messages_sent_total}`,
      '',
      '# HELP ws_messages_received_total Total messages received by the bridge',
      '# TYPE ws_messages_received_total counter',
      `ws_messages_received_total ${metrics.ws_messages_received_total}`,
      '',
      '# HELP ws_errors_total Total errors encountered',
      '# TYPE ws_errors_total counter',
      `ws_errors_total ${metrics.ws_errors_total}`,
      '',
      '# HELP ws_message_latency_ms Message forwarding latency histogram',
      '# TYPE ws_message_latency_ms histogram',
      ...Object.entries(buckets).map(([k, v]) => `ws_message_latency_ms_bucket{le="${k}"} ${v}`),
      `ws_message_latency_ms_sum ${buckets.sum}`,
      `ws_message_latency_ms_count ${buckets.count}`,
      '',
    ];
    const body = lines.join('\n') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
    return;
  }

  // 404 for unknown paths
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found', paths: ['/health', '/metrics'] }));
});

// ─── WebSocket Server ─────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_MESSAGE_SIZE,
});

wss.on('connection', (ws, req) => {
  const clientId = req.headers['x-client-id'];

  // ── Auth ──
  if (!clientId || !VALID_CLIENT_IDS.includes(clientId)) {
    log('warn', 'Rejected unauthenticated client', { remote: req.socket.remoteAddress });
    ws.close(4001, 'Invalid or missing x-client-id header');
    metrics.ws_errors_total++;
    // Also terminate after a tick to ensure close frame is sent
    setTimeout(() => ws.terminate(), 100);
    return;
  }

  // ── Duplicate connection handling ──
  if (clients.has(clientId)) {
    log('info', 'Replacing existing client connection', { clientId });
    const old = clients.get(clientId);
    old.ws.terminate();
    clients.delete(clientId);
    metrics.ws_connections_total--;
  }

  // ── Register ──
  const client = { ws, alive: true, lastPong: Date.now() };
  clients.set(clientId, client);
  metrics.ws_connections_total++;
  log('info', 'Client connected', { clientId, totalClients: clients.size });

  // ── Heartbeat ping ──
  client._pingTimer = setInterval(() => {
    if (!client.alive) {
      log('warn', 'Client heartbeat timeout, closing', { clientId });
      ws.terminate();
      return;
    }
    client.alive = false;
    ws.ping();
  }, HEARTBEAT_INTERVAL);

  // ── Events ──
  ws.on('pong', () => {
    client.alive = true;
    client.lastPong = Date.now();
  });

  ws.on('message', (raw, isBinary) => {
    const receiveTime = Date.now();
    metrics.ws_messages_received_total++;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log('warn', 'Invalid JSON from client', { clientId });
      metrics.ws_errors_total++;
      return;
    }

    log('debug', 'Message received', { clientId, type: msg.type, id: msg.id });

    // ── ACK handling ──
    if (msg.type === 'ack') {
      const latency = receiveTime - (msg.ackedAt || msg.timestamp || receiveTime);
      recordLatency(Math.max(0, latency));
      return;
    }

    // ── Add receive timestamp for latency measurement ──
    msg._receivedAt = receiveTime;

    // ── Route to all other clients ──
    let forwarded = false;
    for (const [otherId, other] of clients) {
      if (otherId === clientId) continue;
      if (other && other.ws.readyState === 1 /* OPEN */) {
        const beforeSend = Date.now();
        other.ws.send(JSON.stringify(msg));
        metrics.ws_messages_sent_total++;
        const fwdLatency = Date.now() - beforeSend;
        log('info', 'Message forwarded', { from: clientId, to: otherId, fwdLatencyMs: fwdLatency });
        forwarded = true;
      }
    }
    if (!forwarded) {
      log('warn', 'No target clients connected, dropping message', { from: clientId });
      metrics.ws_errors_total++;
      const nack = { type: 'nack', id: msg.id, reason: 'no_targets_available' };
      ws.send(JSON.stringify(nack));
    }
  });

  ws.on('error', (err) => {
    log('error', 'WebSocket error', { clientId, error: err.message });
    metrics.ws_errors_total++;
  });

  ws.on('close', (code, reason) => {
    clearInterval(client._pingTimer);
    clients.delete(clientId);
    metrics.ws_connections_total--;
    log('info', 'Client disconnected', { clientId, code, reason: reason.toString() });
  });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  log('info', `Received ${signal}, shutting down gracefully`);

  // Close all WS connections
  for (const [id, c] of clients) {
    clearInterval(c._pingTimer);
    c.ws.close(1001, 'Server shutting down');
  }
  clients.clear();

  // Stop accepting new connections
  wss.close(() => {
    log('info', 'WebSocket server closed');
    httpServer.close(() => {
      log('info', 'HTTP server closed');
      logStream.end(() => {
        log('info', 'Log stream closed, exiting');
        process.exit(0);
      });
    });
  });

  // Force exit after timeout
  setTimeout(() => {
    log('error', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────────────────
// ─── Separate Health Server (optional, on different port) ──────────────────
if (HEALTH_PORT !== PORT) {
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        protocol: 'IACP',
        version: '1.0.0',
        clients: getConnectedClientIds(),
        uptime: Math.floor(process.uptime()),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else if (req.url === '/metrics') {
      res.writeHead(302, { 'Location': `http://${HOST}:${PORT}/metrics` });
      res.end();
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  healthServer.listen(HEALTH_PORT, HOST, () => {
    log('info', 'Health server listening', { host: HOST, port: HEALTH_PORT });
  });
}

// ─── Start ────────────────────────────────────────────────────────────────
httpServer.listen(PORT, HOST, () => {
  log('info', 'WS server listening', {
    host: HOST,
    port: PORT,
    clients: VALID_CLIENT_IDS.length ? VALID_CLIENT_IDS : 'any',
    heartbeatInterval: HEARTBEAT_INTERVAL,
    maxMessageSize: MAX_MESSAGE_SIZE,
  });
});

module.exports = { httpServer, wss, metrics, clients };
