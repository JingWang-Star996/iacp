#!/usr/bin/env node
/**
 * openclaw-client-v2.js — OpenClaw-side WebSocket client (Phase 2)
 *
 * Usage:
 *   node openclaw-client-v2.js
 *
 * Connects to the WS relay server and demonstrates:
 *   - Reliable message sending with ACK
 *   - Receiving messages from Hermes
 *   - Automatic retry and idempotency
 */

const { ReliableWSClient } = require('./reliable-ws-layer');

const URL = process.env.WS_URL || 'ws://127.0.0.1:8765';
const CLIENT_ID = 'openclaw';

async function main() {
  console.log(`[OpenClaw] Starting client → ${URL}`);

  const client = new ReliableWSClient({
    url: URL,
    clientId: CLIENT_ID,
    queueDir: __dirname,
    logLevel: 'info',
  });

  // Message handler
  client.onMessage((msg) => {
    console.log(`[OpenClaw] ← ${msg.type} from ${msg.from}:`, JSON.stringify(msg.content));

    // Auto-reply to chat messages
    if (msg.type === 'chat') {
      const reply = {
        text: `Echo from OpenClaw: "${msg.content.text}"`,
        reply_to: msg.msg_id,
      };
      client.send('chat', reply, msg.from);
      console.log(`[OpenClaw] → Replied to ${msg.from}`);
    }
  });

  try {
    await client.connect();
    console.log('[OpenClaw] Connected ✓');

    // Demo: send a greeting to Hermes
    client.send('chat', { text: 'Hello from OpenClaw! Phase 2 reliable mode.' }, 'hermes');

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('[OpenClaw] Shutting down...');
      client.disconnect();
      process.exit(0);
    });
  } catch (err) {
    console.error('[OpenClaw] Failed to connect:', err.message);
    process.exit(1);
  }
}

main();
