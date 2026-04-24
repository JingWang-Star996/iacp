#!/usr/bin/env node
/**
 * Integration Test — OpenClaw ↔ Hermes WebSocket Phase 1
 *
 * Starts a server in-process, connects 2 clients, verifies:
 *  1. Connection with x-client-id authentication
 *  2. Message routing (A→B, B→A)
 *  3. Round-trip latency < 10ms
 *  4. ACK delivery
 *  5. Disconnect + reconnect
 *  6. Heartbeat ping/pong
 *
 * Usage:  node test-ws.js
 */

const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = 18765; // Use non-standard port to avoid conflicts
const HOST = '127.0.0.1';
const SERVER_URL = `ws://${HOST}:${PORT}`;

// ── Test harness ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];
const PORT_PATH = path.join(__dirname, 'test-port.txt');

function assert(condition, testName) {
  if (condition) {
    passed++;
    results.push({ status: 'PASS', name: testName });
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    results.push({ status: 'FAIL', name: testName });
    console.log(`  ❌ ${testName}`);
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Wait until a client receives a message (with timeout)
function waitForMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`)), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(raw.toString())); } catch { resolve(raw.toString()); }
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────
function createClient(clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL, {
      headers: { 'x-client-id': clientId },
      handshakeTimeout: 5000
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// ── Tests ───────────────────────────────────────────────────────────
async function runTests() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  WebSocket Integration Test — Phase 1');
  console.log('═══════════════════════════════════════════════════════\n');

  // Save port info
  fs.writeFileSync(PORT_PATH, `${PORT}\n`);

  // ── Start server in-process ──
  console.log('[SETUP] Starting WebSocket server...');
  const wss = new WebSocketServer({ host: HOST, port: PORT });
  console.log(`  Server listening on ${SERVER_URL}\n`);

  const clients = new Map();

  wss.on('connection', (ws, req) => {
    const id = (req.headers['x-client-id'] || 'anonymous').toLowerCase();

    // Reject duplicates
    if (clients.has(id)) {
      const old = clients.get(id);
      old.ws.terminate();
      clients.delete(id);
    }

    const entry = { ws, alive: true };
    clients.set(id, entry);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'pong') { entry.alive = true; return; }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() })); entry.alive = true; return; }
      if (!msg.msg_id) msg.msg_id = randomUUID();
      const others = Array.from(clients.keys()).filter(k => k !== id);
      for (const oid of others) {
        const t = clients.get(oid);
        if (t && t.ws.readyState === WebSocket.OPEN) {
          try { t.ws.send(JSON.stringify(msg)); } catch {}
        }
      }
      ws.send(JSON.stringify({ type: 'ack', msg_id: msg.msg_id, status: 'delivered', delivered_to: others }));
    });

    ws.on('close', () => { clients.delete(id); });
    ws.on('pong', () => { entry.alive = true; });

    // Server-side ping every 3s for tests
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        if (!entry.alive) { ws.terminate(); return; }
        entry.alive = false;
        ws.ping();
      }
    }, 3000);
    ws.on('close', () => clearInterval(timer));

    ws.send(JSON.stringify({ type: 'welcome', client_id: id, connected_clients: Array.from(clients.keys()) }));
  });

  // ── Test 1: Connection with x-client-id ──
  console.log('\n[TEST 1] Connection with x-client-id header');
  const clientA = await createClient('openclaw');
  const welcomeA = await waitForMessage(clientA);
  assert(welcomeA.type === 'welcome', 'Client A receives welcome message');
  assert(welcomeA.client_id === 'openclaw', 'Server recognizes client_id=openclaw');
  assert(Array.isArray(welcomeA.connected_clients), 'connected_clients is an array');

  const clientB = await createClient('hermes');
  const welcomeB = await waitForMessage(clientB);
  assert(welcomeB.client_id === 'hermes', 'Server recognizes client_id=hermes');
  await sleep(100);

  // ── Test 2: Message routing A → B ──
  console.log('\n[TEST 2] Message routing A → B');
  sendJson(clientA, { type: 'text', from: 'openclaw', content: 'Hello Hermes!', msg_id: 'msg-001' });
  const routed = await waitForMessage(clientB);
  assert(routed.type === 'text', 'Client B receives text message');
  assert(routed.content === 'Hello Hermes!', 'Message content preserved');
  assert(routed.from === 'openclaw', 'Sender identity preserved');

  // ── Test 3: Message routing B → A ──
  console.log('\n[TEST 3] Message routing B → A');
  sendJson(clientB, { type: 'text', from: 'hermes', content: 'Hello OpenClaw!', msg_id: 'msg-002' });
  const routedBack = await waitForMessage(clientA);
  assert(routedBack.type === 'text', 'Client A receives text message');
  assert(routedBack.content === 'Hello OpenClaw!', 'Message content preserved');

  // ── Test 4: Latency < 10ms ──
  console.log('\n[TEST 4] Message latency < 10ms');
  const latencies = [];
  for (let i = 0; i < 10; i++) {
    sendJson(clientA, { type: 'text', from: 'openclaw', content: `latency-${i}`, msg_id: `lat-${i}` });
    const t0 = Date.now();
    await waitForMessage(clientB);
    latencies.push(Date.now() - t0);
  }
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const maxLatency = Math.max(...latencies);
  console.log(`  Latencies: ${latencies.join(', ')}ms`);
  console.log(`  Avg: ${avgLatency.toFixed(1)}ms, Max: ${maxLatency}ms`);
  assert(maxLatency < 10, `Max latency ${maxLatency}ms < 10ms threshold`);
  assert(avgLatency < 5, `Avg latency ${avgLatency.toFixed(1)}ms < 5ms`);

  // ── Test 5: ACK delivery ──
  console.log('\n[TEST 5] ACK delivery');
  sendJson(clientA, { type: 'text', from: 'openclaw', content: 'ACK test', msg_id: 'msg-ack' });
  // Client A should get ack (from server), Client B should get message
  let gotAck = false, gotMsg = false;
  for (let i = 0; i < 3; i++) {
    const m = await waitForMessage(clientA, 2000);
    if (m.type === 'ack' && m.msg_id === 'msg-ack') gotAck = true;
    if (m.type === 'text') gotMsg = true;
  }
  assert(gotAck, 'Sender receives ACK with matching msg_id');

  // ── Test 6: Reconnect after disconnect ──
  console.log('\n[TEST 6] Disconnect + reconnect');
  clientB.close();
  await sleep(300);
  assert(!clients.has('hermes'), 'Server drops hermes after disconnect');

  // Reconnect
  const clientB2 = await createClient('hermes');
  const welcomeB2 = await waitForMessage(clientB2);
  assert(welcomeB2.type === 'welcome', 'Reconnected client receives welcome');
  assert(welcomeB2.client_id === 'hermes', 'Reconnected client identity preserved');

  // Verify communication still works after reconnect
  sendJson(clientA, { type: 'text', from: 'openclaw', content: 'After reconnect', msg_id: 'msg-reconn' });
  const postReconn = await waitForMessage(clientB2);
  assert(postReconn.content === 'After reconnect', 'Routing works after reconnect');

  // ── Test 7: Heartbeat ping/pong ──
  console.log('\n[TEST 7] Heartbeat ping/pong');
  // Server pings every 3s; wait for a ping from server
  let gotServerPing = false;
  const pingPromise = new Promise((resolve) => {
    clientA.once('ping', () => {
      gotServerPing = true;
      resolve();
    });
  });
  // Wait up to 5s for server ping
  try {
    await Promise.race([pingPromise, sleep(5000)]);
  } catch {}
  assert(gotServerPing, 'Client receives server-side ping');

  // ── Test 8: Duplicate client ID → old connection dropped ──
  console.log('\n[TEST 8] Duplicate client ID handling');
  let wasTerminated = false;
  clientB2.on('close', () => { wasTerminated = true; });
  const clientB3 = await createClient('hermes');
  await sleep(500);
  assert(wasTerminated, 'Old hermes connection terminated on duplicate');

  const welcomeB3 = await waitForMessage(clientB3);
  assert(welcomeB3.type === 'welcome', 'New hermes connection accepted');

  // ── Test 9: Multiple message types ──
  console.log('\n[TEST 9] Multiple message types');
  const testTypes = [
    { type: 'text', content: 'text msg' },
    { type: 'command', content: 'ls -la' },
    { type: 'status', content: 'running' },
  ];
  for (const tt of testTypes) {
    sendJson(clientA, { ...tt, from: 'openclaw', msg_id: randomUUID() });
    const m = await waitForMessage(clientB3);
    assert(m.type === tt.type, `${tt.type} message routed correctly`);
    assert(m.content === tt.content, `${tt.type} content preserved`);
  }

  // ── Cleanup ──
  console.log('\n[CLEANUP] Closing connections...');
  clientA.close();
  clientB3.close();
  await sleep(200);
  wss.close();
  fs.unlinkSync(PORT_PATH);

  // ── Report ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Test Report');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Total: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
  console.log('═══════════════════════════════════════════════════════\n');

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    console.log(`  ${icon} ${r.name}`);
  }

  if (failed === 0) {
    console.log('\n🎉 ALL TESTS PASSED!\n');
    process.exit(0);
  } else {
    console.log(`\n⚠️  ${failed} TEST(S) FAILED\n`);
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
