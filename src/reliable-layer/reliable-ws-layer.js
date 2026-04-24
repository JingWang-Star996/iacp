#!/usr/bin/env node
/**
 * reliable-ws-layer.js — Reliable WebSocket Communication Layer
 *
 * Features:
 *   - ACK mechanism (500ms timeout)
 *   - Auto retry with exponential backoff + jitter (1s, 3s, 7s; max 3 retries)
 *   - Idempotency via LRU cache (1000 entries, 5min TTL)
 *   - Offline message queue (JSONL) with replay on reconnect
 *   - Application-level heartbeat (ping/pong every 15s, 10s timeout)
 *   - Auto reconnect with exponential backoff (1→2→4→8→16→max 30s)
 *   - Failure logging after max retries
 *
 * Usage:
 *   const { ReliableWSClient } = require('./reliable-ws-layer');
 *   const client = new ReliableWSClient({ url, clientId, ... });
 *   await client.connect();
 *   await client.send('chat', { text: 'hello' });
 *   client.onMessage((msg) => { ... });
 *   client.disconnect();
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Config ─────────────────────────────────────────────────────────
const DEFAULTS = {
  // ACK
  ackTimeoutMs: 500,

  // Retry
  maxRetries: 3,
  retryDelaysMs: [1000, 3000, 7000], // exponential backoff with jitter built in

  // Idempotency
  idempotencyCacheSize: 1000,
  idempotencyTtlMs: 5 * 60 * 1000, // 5 minutes
  idempotencyCleanupIntervalMs: 60 * 1000, // 1 minute

  // Heartbeat
  heartbeatIntervalMs: 15000,
  heartbeatTimeoutMs: 10000,

  // Reconnect
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  maxReconnectAttempts: 5,

  // Queue
  queueDir: '.',

  // Logging
  logLevel: 'info', // debug | info | warn | error
};

// ─── Helpers ────────────────────────────────────────────────────────
const ts = () => new Date().toISOString();
const jitter = (ms) => ms * (0.5 + Math.random()); // 50%-150% jitter

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function makeLogger(tag, level) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  return (lvl, msg, meta = {}) => {
    if (LOG_LEVELS[lvl] >= threshold) {
      console.log(JSON.stringify({ ts: ts(), level: lvl, component: tag, msg, ...meta }));
    }
  };
}

// ─── LRU Cache with TTL ─────────────────────────────────────────────
class LruTtlCache {
  constructor(maxSize, ttlMs, cleanupIntervalMs = 60000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.cleanupInterval = setInterval(() => this._evict(), cleanupIntervalMs);
    this.cleanupInterval.unref?.();
  }

  has(key) {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  set(key, value = true) {
    // If full, evict oldest
    if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
    this.map.set(key, { value, ts: Date.now() });
  }

  _evict() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now - entry.ts > this.ttlMs) {
        this.map.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
  }
}

// ─── Offline Queue ──────────────────────────────────────────────────
class OfflineQueue {
  constructor(filePath) {
    this.filePath = filePath;
    this._ensureFile();
  }

  _ensureFile() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '', 'utf8');
  }

  enqueue(msg) {
    fs.appendFileSync(this.filePath, JSON.stringify(msg) + '\n', 'utf8');
  }

  dequeueAll() {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split('\n').filter(Boolean);
    // Clear file
    fs.writeFileSync(this.filePath, '', 'utf8');
    return lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }

  size() {
    if (!fs.existsSync(this.filePath)) return 0;
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    return raw ? raw.split('\n').filter(Boolean).length : 0;
  }

  clear() {
    if (fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '', 'utf8');
  }
}

// ─── ReliableWSClient ───────────────────────────────────────────────
class ReliableWSClient {
  /**
   * @param {Object} opts
   * @param {string} opts.url - WebSocket server URL (ws://host:port)
   * @param {string} opts.clientId - Client identifier (hermes / openclaw)
   * @param {string} [opts.queueDir] - Directory for offline queue files
   * @param {string} [opts.logLevel] - debug|info|warn|error
   * @param {number} [opts.ackTimeoutMs] - ACK timeout in ms
   * @param {number} [opts.maxRetries] - Max retry attempts
   * @param {number[]} [opts.retryDelaysMs] - Retry delay array
   * @param {number} [opts.heartbeatIntervalMs] - Ping interval
   * @param {number} [opts.heartbeatTimeoutMs] - Pong timeout
   * @param {number} [opts.reconnectBaseMs] - Base reconnect delay
   * @param {number} [opts.reconnectMaxMs] - Max reconnect delay
   */
  constructor(opts) {
    this.url = opts.url;
    this.clientId = opts.clientId;
    this.config = { ...DEFAULTS, ...opts };

    this.log = makeLogger(`reliable-ws:${this.clientId}`, this.config.logLevel);

    // Internal state
    this._ws = null;
    this._connected = false;
    this._connecting = false;
    this._msgCallback = null;

    // ACK tracking: msg_id -> { msg, timer, retryCount, retryTimer }
    this._pendingAck = new Map();

    // Idempotency cache
    this._idempotency = new LruTtlCache(
      this.config.idempotencyCacheSize,
      this.config.idempotencyTtlMs,
      this.config.idempotencyCleanupIntervalMs
    );

    // Offline queue
    const queueFile = path.join(this.config.queueDir, `queue_${this.clientId}.jsonl`);
    this._queue = new OfflineQueue(queueFile);

    // Heartbeat
    this._hbTimer = null;
    this._hbTimeout = null;
    this._lastPong = 0;

    // Reconnect
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._shouldReconnect = true;

    // Message sequence counter
    this._seq = 0;
  }

  // ── Connection ───────────────────────────────────────────────────
  async connect() {
    if (this._connected || this._connecting) {
      this.log('warn', 'Already connected or connecting');
      return;
    }

    this._shouldReconnect = true;
    this._connecting = true;

    return new Promise((resolve, reject) => {
      try {
        this._ws = new WebSocket(this.url, {
          headers: { 'x-client-id': this.clientId },
          perMessageDeflate: false,
          handshakeTimeout: 10000,
        });

        this._ws.on('open', () => {
          this._connected = true;
          this._connecting = false;
          this._reconnectAttempts = 0;
          this.log('info', 'Connected', { url: this.url, clientId: this.clientId });

          // Start heartbeat
          this._startHeartbeat();

          // Replay offline queue
          this._replayQueue();

          resolve();
        });

        this._ws.on('error', (err) => {
          this.log('error', 'WebSocket error', { error: err.message });
          if (this._connecting) {
            this._connecting = false;
            reject(err);
          }
        });

        this._ws.on('close', (code, reason) => {
          this._connected = false;
          this._connecting = false;
          this._stopHeartbeat();
          this.log('warn', 'Disconnected', { code, reason: reason.toString() });

          // Mark pending messages for retry
          this._markPendingForRetry();

          // Auto reconnect
          if (this._shouldReconnect) {
            this._scheduleReconnect();
          }
        });

        this._ws.on('message', (raw) => {
          this._handleIncoming(raw.toString());
        });
      } catch (err) {
        this._connecting = false;
        reject(err);
      }
    });
  }

  disconnect() {
    this._shouldReconnect = false;
    this._stopHeartbeat();
    clearTimeout(this._reconnectTimer);

    // Clear pending ACK timers
    for (const [id, entry] of this._pendingAck) {
      clearTimeout(entry.timer);
      clearTimeout(entry.retryTimer);
    }
    this._pendingAck.clear();

    if (this._ws) {
      this._ws.close(1000, 'client disconnect');
      this._ws = null;
    }
    this._connected = false;
    this._idempotency.destroy();
    this.log('info', 'Disconnected (manual)');
  }

  // ── Send ─────────────────────────────────────────────────────────
  /**
   * Send a message. Returns msg_id.
   * @param {string} type - Message type
   * @param {Object} content - Message payload
   * @param {string} [to] - Target client (null = broadcast)
   * @returns {string} msg_id
   */
  send(type, content, to = null) {
    const msgId = crypto.randomUUID();
    const msg = {
      msg_id: msgId,
      type,
      content,
      from: this.clientId,
      to,
      seq: ++this._seq,
      ts: Date.now(),
      retry_count: 0,
    };

    if (this._connected) {
      this._sendRaw(msg);
    } else {
      // Queue for offline
      this._queue.enqueue(msg);
      this.log('info', 'Message queued (offline)', { msgId, type, queueSize: this._queue.size() });
      return msgId;
    }

    // Track for ACK (skip ACK tracking for ack/pong messages)
    if (type !== 'ack' && type !== 'pong' && type !== 'ping') {
      this._trackAck(msg);
    }

    return msgId;
  }

  _sendRaw(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  // ── ACK Tracking ─────────────────────────────────────────────────
  _trackAck(msg) {
    const entry = {
      msg,
      retryCount: 0,
      timer: null,
      retryTimer: null,
    };

    // ACK timeout timer
    entry.timer = setTimeout(() => {
      this._onAckTimeout(msg.msg_id);
    }, this.config.ackTimeoutMs);

    this._pendingAck.set(msg.msg_id, entry);
    this.log('debug', 'Tracking ACK', { msgId: msg.msg_id, type: msg.type });
  }

  _onAckTimeout(msgId) {
    const entry = this._pendingAck.get(msgId);
    if (!entry) return;

    clearTimeout(entry.timer);
    entry.retryCount++;

    if (entry.retryCount > this.config.maxRetries) {
      // Max retries exceeded
      this._pendingAck.delete(msgId);
      this._logFailure(entry.msg);
      this.log('error', 'Message failed (max retries)', { msgId, retries: entry.retryCount });
      return;
    }

    // Schedule retry
    const delay = this.config.retryDelaysMs[entry.retryCount - 1] ?? 7000;
    const jitteredDelay = jitter(delay);

    this.log('warn', 'ACK timeout, scheduling retry', { msgId, retryCount: entry.retryCount, delay: jitteredDelay });

    entry.retryTimer = setTimeout(() => {
      this._retryMessage(msgId);
    }, jitteredDelay);
  }

  _retryMessage(msgId) {
    const entry = this._pendingAck.get(msgId);
    if (!entry) return;

    entry.msg.retry_count = entry.retryCount;
    entry.msg.ts = Date.now();

    if (this._connected) {
      this._sendRaw(entry.msg);

      // Reset ACK timer
      entry.timer = setTimeout(() => {
        this._onAckTimeout(msgId);
      }, this.config.ackTimeoutMs);

      this.log('info', 'Message retried', { msgId, retryCount: entry.retryCount });
    } else {
      // Queue for retry when reconnected
      this._queue.enqueue(entry.msg);
      this.log('warn', 'Offline during retry, queued', { msgId });
    }
  }

  _acknowledge(msgId) {
    const entry = this._pendingAck.get(msgId);
    if (!entry) return;

    clearTimeout(entry.timer);
    clearTimeout(entry.retryTimer);
    this._pendingAck.delete(msgId);
    this.log('debug', 'ACK received', { msgId });
  }

  _markPendingForRetry() {
    // When disconnected, move pending messages to queue
    for (const [msgId, entry] of this._pendingAck) {
      clearTimeout(entry.timer);
      clearTimeout(entry.retryTimer);
      entry.msg.retry_count = entry.retryCount;
      this._queue.enqueue(entry.msg);
      this.log('info', 'Pending message moved to queue', { msgId });
    }
    this._pendingAck.clear();
  }

  // ── Incoming Message Handler ──────────────────────────────────────
  _handleIncoming(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log('warn', 'Invalid JSON', { raw: raw.slice(0, 120) });
      return;
    }

    // Handle ACK
    if (msg.type === 'ack') {
      this._acknowledge(msg.msg_id);
      return;
    }

    // Handle pong
    if (msg.type === 'pong') {
      this._lastPong = Date.now();
      clearTimeout(this._hbTimeout);
      this.log('debug', 'Pong received');
      return;
    }

    // Handle ping
    if (msg.type === 'ping') {
      this._sendRaw({ type: 'pong', ts: Date.now() });
      return;
    }

    // Handle server connected notification
    if (msg.type === 'connected') {
      this.log('info', 'Server acknowledged connection', { clients: msg.clients });
      return;
    }

    // Skip our own echoed messages (from server broadcast)
    if (msg.from === this.clientId) {
      this.log('debug', 'Skipping own echoed message', { msgId: msg.msg_id });
      return;
    }

    // Idempotency check
    if (msg.msg_id && this._idempotency.has(msg.msg_id)) {
      this.log('debug', 'Duplicate message, sending ACK only', { msgId: msg.msg_id });
      this._sendAck(msg.msg_id);
      return;
    }

    // Record for idempotency
    if (msg.msg_id) {
      this._idempotency.set(msg.msg_id);
    }

    // Send ACK
    this._sendAck(msg.msg_id);

    // Deliver to callback
    if (this._msgCallback) {
      try {
        this._msgCallback(msg);
      } catch (err) {
        this.log('error', 'Message callback error', { error: err.message });
      }
    }
  }

  _sendAck(msgId) {
    if (this._connected) {
      this._sendRaw({ type: 'ack', msg_id: msgId, status: 'received', from: this.clientId });
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────
  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastPong = Date.now();

    this._hbTimer = setInterval(() => {
      if (Date.now() - this._lastPong > this.config.heartbeatTimeoutMs) {
        this.log('warn', 'Heartbeat timeout, closing connection');
        this._shouldReconnect = true;
        if (this._ws) this._ws.close(4003, 'heartbeat timeout');
        return;
      }
      this._sendRaw({ type: 'ping', ts: Date.now() });
    }, this.config.heartbeatIntervalMs);

    this._hbTimer.unref?.();
  }

  _stopHeartbeat() {
    clearInterval(this._hbTimer);
    clearTimeout(this._hbTimeout);
  }

  // ── Reconnect ─────────────────────────────────────────────────────
  _scheduleReconnect() {
    this._reconnectAttempts++;

    if (this._reconnectAttempts > this.config.maxReconnectAttempts) {
      this.log('error', 'Max reconnect attempts reached', { attempts: this._reconnectAttempts });
      return;
    }

    const delay = Math.min(
      this.config.reconnectBaseMs * Math.pow(2, this._reconnectAttempts - 1),
      this.config.reconnectMaxMs
    );
    const jitteredDelay = jitter(delay);

    this.log('info', 'Scheduling reconnect', { attempt: this._reconnectAttempts, delay: jitteredDelay });

    if (this._reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.log('error', '⚠️ CRITICAL: Repeated reconnect failures, triggering alert', { attempts: this._reconnectAttempts });
    }

    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.log('error', 'Reconnect failed', { error: err.message });
      });
    }, jitteredDelay);
  }

  // ── Queue Replay ──────────────────────────────────────────────────
  _replayQueue() {
    const queued = this._queue.dequeueAll();
    if (queued.length === 0) return;

    this.log('info', 'Replaying offline queue', { count: queued.length });

    for (const msg of queued) {
      msg.retry_count = (msg.retry_count || 0) + 1;
      msg.ts = Date.now();
      this._sendRaw(msg);

      // Track ACK for business messages
      if (msg.type !== 'ack' && msg.type !== 'pong' && msg.type !== 'ping') {
        this._trackAck(msg);
      }
    }
  }

  // ── Failure Log ───────────────────────────────────────────────────
  _logFailure(msg) {
    const logFile = path.join(this.config.queueDir, `failed_${this.clientId}.jsonl`);
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify({ ...msg, failed_at: ts() }) + '\n', 'utf8');
    this.log('error', 'Message logged to failure file', { file: logFile, msgId: msg.msg_id });
  }

  // ── Message Callback ──────────────────────────────────────────────
  onMessage(callback) {
    this._msgCallback = callback;
  }

  // ── Status ────────────────────────────────────────────────────────
  get isConnected() {
    return this._connected;
  }

  get pendingCount() {
    return this._pendingAck.size;
  }

  get queueSize() {
    return this._queue.size();
  }

  get reconnectAttempts() {
    return this._reconnectAttempts;
  }
}

module.exports = { ReliableWSClient, LruTtlCache, OfflineQueue };
