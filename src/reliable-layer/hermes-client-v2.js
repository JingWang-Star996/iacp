#!/usr/bin/env node
/**
 * hermes-client-v2.js — Hermes-side WebSocket client (Phase 2)
 *
 * Usage:
 *   node hermes-client-v2.js
 *
 * Connects to the WS relay server and demonstrates:
 *   - Reliable message sending with ACK
 *   - Receiving messages from OpenClaw
 *   - Automatic retry and idempotency
 */

const { ReliableWSClient } = require('./reliable-ws-layer');

const URL = process.env.WS_URL || 'ws://127.0.0.1:8765';
const CLIENT_ID = 'hermes';

async function main() {
  console.log(`[Hermes] Starting client → ${URL}`);

  const client = new ReliableWSClient({
    url: URL,
    clientId: CLIENT_ID,
    queueDir: __dirname,
    logLevel: 'info',
  });

  // Message handler
  client.onMessage((msg) => {
    console.log(`[Hermes] ← ${msg.type} from ${msg.from}:`, JSON.stringify(msg.content));
  });

  try {
    await client.connect();
    console.log('[Hermes] Connected ✓');

    // Demo: send a greeting to OpenClaw
    client.send('chat', { text: 'Hello from Hermes! Phase 2 reliable mode.' }, 'openclaw');

    // Demo: send periodic test messages
    let counter = 0;
    const testInterval = setInterval(() => {
      counter++;
      client.send('ping-app', { counter, ts: Date.now() }, 'openclaw');
      if (counter >= 3) clearInterval(testInterval);
    }, 2000);

    // Graceful shutdown on Ctrl+C
    process.on('SIGINT', () => {
      console.log('[Hermes] Shutting down...');
      clearInterval(testInterval);
      client.disconnect();
      process.exit(0);
    });
  } catch (err) {
    console.error('[Hermes] Failed to connect:', err.message);
    process.exit(1);
  }
}

main();
