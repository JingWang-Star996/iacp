#!/usr/bin/env node
/**
 * test-integration.js — Integration test for WS server + 2 clients
 *
 * Tests:
 * 1. Server starts and accepts connections
 * 2. Two clients connect simultaneously
 * 3. Message relay (hermes → openclaw, openclaw → hermes)
 * 4. Latency test (< 50ms)
 * 5. Disconnect + reconnect
 * 6. Auth rejection (missing header)
 */

const WebSocket = require('ws');
const http = require('http');
const assert = require('assert');

const HOST = '127.0.0.1';
const PORT = 8765 + Math.floor(Math.random() * 9000); // random port to avoid conflicts
const WS_URL = `ws://${HOST}:${PORT}`;

let server = null;
let healthServer = null;
let passed = 0;
let failed = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────
function pass(name) {
  passed++;
  console.log(`  ✅ PASS: ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  ❌ FAIL: ${name} — ${err.message || err}`);
}

function timeout(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function makeClient(clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: { 'x-client-id': clientId },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('close', () => {});
  });
}

function waitForMessage(ws, filterFn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for message after ${timeoutMs}ms`)), timeoutMs);
    const handler = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (filterFn(msg)) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ── Import server module ────────────────────────────────────────────────────
// We require the server module which starts listening on the configured port
// But we need to override the port. The server reads WS_PORT env.
process.env.WS_PORT = String(PORT);
process.env.WS_HOST = HOST;

// ── Tests ───────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n🧪 Integration Tests (port ${PORT})\n`);

  // ── Test 0: Server starts ────────────────────────────────────────────────
  console.log('Test 0: Server startup');
  try {
    const serverModule = require('./ws-server.js');
    server = serverModule.wss;
    healthServer = serverModule.healthServer;
    await timeout(200);

    // check health endpoint
    const resp = await fetch(`http://${HOST}:${PORT}/health`);
    const health = await resp.json();
    assert.strictEqual(health.status, 'ok', 'health check should return ok');
    pass('Server started and health endpoint works');
  } catch (e) {
    fail('Server startup', e);
    process.exit(1);
  }

  // ── Test 1: Two clients connect ──────────────────────────────────────────
  console.log('\nTest 1: Two clients connect');
  let hermes, openclaw;
  try {
    hermes = await makeClient('hermes');
    openclaw = await makeClient('openclaw');
    assert.ok(hermes.readyState === WebSocket.OPEN, 'hermes should be connected');
    assert.ok(openclaw.readyState === WebSocket.OPEN, 'openclaw should be connected');
    pass('Both clients connected successfully');
    await timeout(200);
  } catch (e) {
    fail('Client connection', e);
    cleanup();
    process.exit(1);
  }

  // ── Test 2: Message relay hermes → openclaw ──────────────────────────────
  console.log('\nTest 2: Message relay (hermes → openclaw)');
  try {
    const msg = JSON.stringify({
      type: 'text',
      from: 'hermes',
      content: 'Hello from Hermes! 🚀',
      msg_id: 'test-1',
      timestamp: new Date().toISOString(),
    });
    hermes.send(msg);

    const received = await waitForMessage(openclaw, (m) => m.from === 'hermes' && m.content === 'Hello from Hermes! 🚀');
    assert.strictEqual(received.content, 'Hello from Hermes! 🚀');
    pass('hermes → openclaw message relayed');
  } catch (e) {
    fail('Message relay hermes→openclaw', e);
  }

  // ── Test 3: Message relay openclaw → hermes ──────────────────────────────
  console.log('\nTest 3: Message relay (openclaw → hermes)');
  try {
    const msg = JSON.stringify({
      type: 'text',
      from: 'openclaw',
      content: 'Hello from OpenClaw! 🤖',
      msg_id: 'test-2',
      timestamp: new Date().toISOString(),
    });
    openclaw.send(msg);

    const received = await waitForMessage(hermes, (m) => m.from === 'openclaw' && m.content === 'Hello from OpenClaw! 🤖');
    assert.strictEqual(received.content, 'Hello from OpenClaw! 🤖');
    pass('openclaw → hermes message relayed');
  } catch (e) {
    fail('Message relay openclaw→hermes', e);
  }

  // ── Test 4: Latency test ─────────────────────────────────────────────────
  console.log('\nTest 4: Latency test (< 50ms)');
  try {
    const latencies = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      openclaw.send(JSON.stringify({
        type: 'text',
        from: 'openclaw',
        content: `ping-${i}`,
        msg_id: `latency-${i}`,
        timestamp: new Date().toISOString(),
      }));
      await waitForMessage(hermes, (m) => m.content === `ping-${i}`);
      latencies.push(Date.now() - t0);
    }

    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const max = Math.max(...latencies);
    const min = Math.min(...latencies);
    console.log(`    Latency: avg=${avg.toFixed(1)}ms min=${min}ms max=${max}ms`);
    assert.ok(avg < 50, `average latency ${avg.toFixed(1)}ms should be < 50ms`);
    pass(`Latency OK (avg ${avg.toFixed(1)}ms < 50ms)`);
  } catch (e) {
    fail('Latency test', e);
  }

  // ── Test 5: Disconnect + reconnect ───────────────────────────────────────
  console.log('\nTest 5: Disconnect + reconnect');
  try {
    // kill hermes
    hermes.terminate();
    await timeout(500);

    // reconnect
    hermes = await makeClient('hermes');
    assert.ok(hermes.readyState === WebSocket.OPEN, 'hermes should be reconnected');

    // send message to verify
    hermes.send(JSON.stringify({
      type: 'text',
      from: 'hermes',
      content: 'reconnected',
      msg_id: 'test-reconnect',
      timestamp: new Date().toISOString(),
    }));
    const received = await waitForMessage(openclaw, (m) => m.content === 'reconnected');
    assert.strictEqual(received.content, 'reconnected');
    pass('Disconnect + reconnect works');
  } catch (e) {
    fail('Reconnect test', e);
  }

  // ── Test 6: Auth rejection ───────────────────────────────────────────────
  console.log('\nTest 6: Auth rejection (no x-client-id)');
  try {
    const badWs = new WebSocket(WS_URL);
    const result = await new Promise((resolve) => {
      badWs.on('error', (err) => resolve({ error: true }));
      badWs.on('open', () => resolve({ error: false }));
      badWs.on('close', (code) => resolve({ code }));
      setTimeout(() => resolve({ timeout: true }), 3000);
    });

    assert.ok(result.error || result.code === 401 || result.code === 1002, `should reject without x-client-id, got ${JSON.stringify(result)}`);
    pass('Auth rejection works (no x-client-id → rejected)');
    badWs.terminate();
  } catch (e) {
    fail('Auth rejection', e);
  }

  // ── Test 7: Duplicate client rejection ───────────────────────────────────
  console.log('\nTest 7: Duplicate client rejection');
  try {
    const dupWs = new WebSocket(WS_URL, { headers: { 'x-client-id': 'hermes' } });
    const result = await new Promise((resolve) => {
      dupWs.on('error', (err) => resolve({ error: true }));
      dupWs.on('open', () => resolve({ error: false }));
      dupWs.on('close', (code) => resolve({ code }));
      setTimeout(() => resolve({ timeout: true }), 3000);
    });

    assert.ok(result.error || result.code === 409 || result.code === 1002, `should reject duplicate client, got ${JSON.stringify(result)}`);
    pass('Duplicate client rejected');
    dupWs.terminate();
  } catch (e) {
    fail('Duplicate client rejection', e);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  hermes?.terminate();
  openclaw?.terminate();

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

function cleanup() {
  if (server) server.close();
  if (healthServer) healthServer.close();
}

run().catch((e) => {
  console.error('Test runner crashed:', e);
  cleanup();
  process.exit(1);
});
