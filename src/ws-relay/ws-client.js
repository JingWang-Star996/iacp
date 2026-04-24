#!/usr/bin/env node
/**
 * ws-client.js — Production WebSocket client for OpenClaw ↔ Hermes
 *
 * Features:
 *   - Auto-reconnect with exponential backoff (1s → 2s → 4s → 8s → 16s → 30s max)
 *   - Heartbeat: send ping every 25s, expect pong within 10s
 *   - Send queue: buffer messages when disconnected, flush on reconnect
 *   - Connection state machine: DISCONNECTED → CONNECTING → CONNECTED → RECONNECTING
 *   - Structured JSON logs to stderr
 */

const WebSocket = require('ws');

// ─── Config ────────────────────────────────────────────────
const SERVER_URL  = process.env.WS_URL || 'ws://127.0.0.1:8765';
const CLIENT_ID   = process.env.CLIENT_ID || 'openclaw';
const HEARTBEAT_MS      = 25_000;  // send ping every 25s
const HEARTBEAT_TIMEOUT = 10_000;  // pong must arrive within 10s
const RECONNECT_MIN_MS  = 1_000;
const RECONNECT_MAX_MS  = 30_000;
const QUEUE_MAX         = 500;     // max buffered messages

// ─── State Machine ─────────────────────────────────────────
const State = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING:   'CONNECTING',
  CONNECTED:    'CONNECTED',
  RECONNECTING: 'RECONNECTING',
};

class WsClient {
  constructor() {
    this.state = State.DISCONNECTED;
    this.ws = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.pongTimeout    = null;
    this.sendQueue = [];
    this.messageCount = { sent: 0, received: 0 };

    this._log('info', 'Client created', { clientId: CLIENT_ID, server: SERVER_URL });
    this._setState(State.DISCONNECTED);
    this.connect();
  }

  // ─── Logging ──────────────────────────────────────────
  _ts() { return new Date().toISOString(); }

  _log(level, msg, meta = {}) {
    console.error(JSON.stringify({
      ts: this._ts(), level, component: 'ws-client', msg, clientId: CLIENT_ID, ...meta
    }));
  }

  // ─── State ────────────────────────────────────────────
  _setState(s) {
    this.state = s;
    this._log('debug', 'State change', { state: s });
  }

  // ─── Connection ───────────────────────────────────────
  connect() {
    if (this.state === State.CONNECTING || this.state === State.CONNECTED) return;

    this._setState(this.state === State.DISCONNECTED ? State.CONNECTING : State.RECONNECTING);
    this._log('info', 'Connecting...', { url: SERVER_URL });

    this.ws = new WebSocket(SERVER_URL, {
      headers: { 'x-client-id': CLIENT_ID },
      perMessageDeflate: false,
    });

    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('close', (code, reason) => this._onClose(code, reason));
    this.ws.on('error', (err) => this._onError(err));
  }

  _onOpen() {
    this._setState(State.CONNECTED);
    this.reconnectDelay = RECONNECT_MIN_MS;
    this._startHeartbeat();
    this._flushQueue();
    this._log('info', 'Connected');
    if (this.onConnected) this.onConnected();
  }

  _onClose(code, reason) {
    this._stopHeartbeat();
    this._setState(State.RECONNECTING);
    this._log('warn', 'Disconnected', { code, reason: reason.toString() });
    if (this.onDisconnected) this.onDisconnected({ code, reason: reason.toString() });
    this._scheduleReconnect();
  }

  _onError(err) {
    this._log('error', 'Socket error', { error: err.message });
  }

  // ─── Reconnect (exponential backoff) ──────────────────
  _scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = this.reconnectDelay;
    this._log('info', 'Reconnect scheduled', { delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this.connect();
    }, delay);
  }

  // ─── Heartbeat ────────────────────────────────────────
  _startHeartbeat() {
    this._stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        this._log('debug', 'Ping sent');

        // Pong timeout
        this.pongTimeout = setTimeout(() => {
          this._log('warn', 'Pong timeout, forcing reconnect');
          if (this.ws) this.ws.close(4002, 'pong timeout');
        }, HEARTBEAT_TIMEOUT);
      }
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.pongTimeout)    { clearTimeout(this.pongTimeout);    this.pongTimeout = null; }
  }

  // ─── Message handling ─────────────────────────────────
  _onMessage(raw) {
    this.messageCount.received++;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this._log('warn', 'Invalid JSON', { raw: raw.toString().slice(0, 120) });
      return;
    }

    // Handle pong
    if (msg.type === 'pong') {
      if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null; }
      return;
    }

    if (msg.type === 'ping') {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
      return;
    }

    if (msg.type === 'connected') {
      this._log('info', 'Server ACK', { clients: msg.clients });
    }

    if (this.onMessage) this.onMessage(msg);
  }

  // ─── Send ─────────────────────────────────────────────
  send(msg) {
    if (this.state === State.CONNECTED && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const envelope = { ...msg, ts: this._ts(), sentAt: Date.now() };
      this.ws.send(JSON.stringify(envelope));
      this.messageCount.sent++;
      return true;
    }

    // Queue
    if (this.sendQueue.length < QUEUE_MAX) {
      this.sendQueue.push({ ...msg, queuedAt: Date.now() });
      this._log('debug', 'Message queued', { queueSize: this.sendQueue.length });
    } else {
      this._log('warn', 'Send queue full, dropping message');
    }
    return false;
  }

  _flushQueue() {
    if (this.sendQueue.length === 0) return;

    this._log('info', 'Flushing send queue', { count: this.sendQueue.length });
    const batch = this.sendQueue.splice(0);
    for (const msg of batch) {
      this.send(msg);
    }
  }

  // ─── Close ────────────────────────────────────────────
  close() {
    this._stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) this.ws.close(1000, 'client shutdown');
    this._setState(State.DISCONNECTED);
  }
}

// ─── CLI mode ──────────────────────────────────────────────
if (require.main === module) {
  const client = new WsClient();

  client.onMessage = (msg) => {
    console.log(JSON.stringify({ direction: 'in', ...msg }));
  };

  process.on('SIGINT', () => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'info', component: 'ws-client', msg: 'Shutting down' }));
    client.close();
    setTimeout(() => process.exit(0), 500);
  });

  // Expose for test scripts
  globalThis._wsClient = client;
}

module.exports = { WsClient, State };
