#!/usr/bin/env node
/**
 * ws-client-openclaw.js — OpenClaw WebSocket client
 *
 * Mirrors the Hermes client with same protocol, different client ID.
 * Auto-connect with exponential backoff
 * Heartbeat keep-alive
 * Message send/receive
 * Local logging
 *
 * Usage: node ws-client-openclaw.js [ws_url]
 *   ws_url defaults to ws://127.0.0.1:8765
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const WS_URL = process.argv[2] || process.env.WS_URL || 'ws://127.0.0.1:8765';
const CLIENT_ID = 'openclaw';
const CLIENT_PING_INTERVAL = 30_000;
const RECONNECT_BASE = 1000;
const RECONNECT_MAX  = 30_000;
const RECONNECT_JITTER = 0.3;
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'openclaw.log.jsonl');

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), client: CLIENT_ID, ...entry });
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}

// ── Message helpers ─────────────────────────────────────────────────────────
let msgCounter = 0;
function makeMsg(content, type = 'text') {
  msgCounter++;
  return {
    type,
    from: CLIENT_ID,
    content,
    msg_id: `${CLIENT_ID}-${Date.now()}-${msgCounter}`,
    timestamp: new Date().toISOString(),
  };
}

// ── Connection manager ──────────────────────────────────────────────────────
let ws = null;
let pingTimer = null;
let reconnectAttempt = 0;

function connect() {
  const headers = { 'x-client-id': CLIENT_ID };
  ws = new WebSocket(WS_URL, { headers });

  ws.on('open', () => {
    reconnectAttempt = 0;
    log({ level: 'info', event: 'connected', url: WS_URL });

    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        log({ level: 'debug', event: 'ping_sent' });
      }
    }, CLIENT_PING_INTERVAL);

    ws.send(JSON.stringify(makeMsg('OpenClaw client connected ✅', 'text')));
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log({ level: 'warn', event: 'parse_error', raw: raw.toString().slice(0, 200) });
      return;
    }

    if (msg.from === CLIENT_ID) return;

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      return;
    }

    if (msg.type === 'text') {
      const ack = JSON.stringify({ type: 'ack', msg_id: msg.msg_id || 'unknown', status: 'received' });
      ws.send(ack);
    }

    log({ level: 'info', event: 'message_received', msgType: msg.type, from: msg.from, msgId: msg.msg_id });

    handleMessage(msg);
  });

  ws.on('close', (code, reason) => {
    log({ level: 'warn', event: 'disconnected', code, reason: reason.toString() });
    clearInterval(pingTimer);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log({ level: 'error', event: 'error', message: err.message });
  });
}

function scheduleReconnect() {
  reconnectAttempt++;
  const backoff = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempt - 1), RECONNECT_MAX);
  const jitter = backoff * RECONNECT_JITTER * (Math.random() - 0.5) * 2;
  const delay = Math.max(500, backoff + jitter);

  log({ level: 'info', event: 'reconnect_scheduled', attempt: reconnectAttempt, delayMs: Math.round(delay) });
  setTimeout(connect, delay);
}

// ── Message handler (override / extend as needed) ───────────────────────────
function handleMessage(msg) {
  log({ level: 'info', event: 'message_processed', content: msg.content });
}

// ── Public API ──────────────────────────────────────────────────────────────
function send(content, type = 'text') {
  const msg = makeMsg(content, type);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    log({ level: 'info', event: 'message_sent', msgId: msg.msg_id });
    return msg.msg_id;
  }
  log({ level: 'warn', event: 'send_failed', reason: 'not_connected' });
  return null;
}

// ── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown(signal) {
  log({ level: 'info', event: 'shutdown', signal });
  clearInterval(pingTimer);
  if (ws) ws.close();
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Start ───────────────────────────────────────────────────────────────────
log({ level: 'info', event: 'client_starting', url: WS_URL });
connect();

// export for testing
module.exports = { connect, send, handleMessage, WS_URL, CLIENT_ID };
