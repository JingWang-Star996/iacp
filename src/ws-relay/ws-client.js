#!/usr/bin/env node
/**
 * ws-client.js — Generic IACP WebSocket client
 *
 * Usage:
 *   IACP_CLIENT_ID=my-assistant IACP_WS_URL=ws://127.0.0.1:8765 node ws-client.js
 *
 * Connects to the IACP WebSocket relay server and provides
 * an interactive CLI for sending/receiving messages.
 */

const { WebSocket } = require('ws');

const CLIENT_ID = process.env.IACP_CLIENT_ID || process.env.IACP_CLIENT || 'assistant';
const WS_URL = process.env.IACP_WS_URL || 'ws://127.0.0.1:8765';
const RECONNECT_BASE = parseInt(process.env.IACP_RECONNECT_BASE_MS || '1000', 10);
const RECONNECT_MAX = parseInt(process.env.IACP_RECONNECT_MAX_MS || '30000', 10);

let reconnectAttempts = 0;
let ws;

function connect() {
  console.log(`[${CLIENT_ID}] Connecting to ${WS_URL}...`);

  ws = new WebSocket(WS_URL, {
    headers: { 'x-client-id': CLIENT_ID },
  });

  ws.on('open', () => {
    reconnectAttempts = 0;
    console.log(`[${CLIENT_ID}] Connected ✓`);
    readline.prompt();
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    // Skip control messages
    if (msg.type === 'ping' || msg.type === 'pong' || msg.type === 'ack') return;
    const from = msg._from || msg.from || 'unknown';
    console.log(`\n[${CLIENT_ID}] ← [${from}]: ${msg.content || msg.message || JSON.stringify(msg)}`);
    readline.prompt();
  });

  ws.on('close', (code, reason) => {
    console.log(`\n[${CLIENT_ID}] Disconnected (code: ${code})`);
    reconnect();
  });

  ws.on('error', (err) => {
    console.error(`[${CLIENT_ID}] Error: ${err.message}`);
  });
}

function reconnect() {
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempts), RECONNECT_MAX);
  const jitter = Math.random() * 1000;
  reconnectAttempts++;
  console.log(`[${CLIENT_ID}] Reconnecting in ${Math.round(delay + jitter)}ms (attempt ${reconnectAttempts})...`);
  setTimeout(connect, delay + jitter);
}

// ── Interactive CLI ──────────────────────────────────────────────────────────
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `[${CLIENT_ID}] > `,
});

rl.on('line', (line) => {
  const input = line.trim();
  if (!input || !ws || ws.readyState !== 1) return;

  const msg = {
    type: 'message',
    from: CLIENT_ID,
    content: input,
    msg_id: `${CLIENT_ID}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };

  ws.send(JSON.stringify(msg));
  rl.prompt();
});

rl.on('close', () => {
  console.log(`[${CLIENT_ID}] Goodbye`);
  if (ws) ws.close();
  process.exit(0);
});

// ── Start ───────────────────────────────────────────────────────────────────
connect();
