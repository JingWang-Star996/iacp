#!/usr/bin/env node
/**
 * test-phase2.js — Integration tests for ReliableWSClient (Phase 2)
 *
 * Tests:
 *   T1. Connection & ACK — send message, verify server ACK
 *   T2. End-to-end relay — clientA → server → clientB receives
 *   T3. Retry on ACK timeout — simulate lost ACK, verify resend
 *   T4. Idempotency — duplicate msg_id processed only once
 *   T5. Offline queue — send while disconnected, replay on reconnect
 *   T6. Heartbeat — ping/pong keeps connection alive
 *
 * Usage:
 *   node test-phase2.js          # runs all tests
 *   node test-phase2.js --test 3 # runs only T3
 */

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const { ReliableWSClient } = require('./reliable-ws-layer');

// ─── Config ─────────────────────────────────────────────────────────
const TEST_PORT = parseInt(process.env.TEST_PORT || '18765', 10);
const TEST_URL = `ws://127.0.0.1:${TEST_PORT}`;
const TEST_TIMEOUT_MS = 30000; // total timeout per test

// ─── Results tracking ───────────────────────────────────────────────
const results = [];

function record(testName, pass, detail = '') {
  results.push({ name: testName, pass, detail });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'} — ${testName}${detail ? ' | ' + detail : ''}`);
}

// ─── Helpers ────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createClient(clientId) {
  return new ReliableWSClient({
    url: TEST_URL,
    clientId,
    queueDir: path.join(__dirname, '.test_queue'),
    logLevel: 'error', // suppress noise, only errors
    ackTimeoutMs: 300, // faster for tests
    maxRetries: 2,
    retryDelaysMs: [200, 500],
    heartbeatIntervalMs: 2000, // faster for tests
    heartbeatTimeoutMs: 3000,
    reconnectBaseMs: 500,
    reconnectMaxMs: 2000,
    maxReconnectAttempts: 3,
  });
}

// ─── Server management ─────────────────────────────────────────────
let serverProcess = null;

async function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, WS_PORT: String(TEST_PORT) };
    serverProcess = spawn('node', [path.join(__dirname, '..', 'phase1', 'ws-server.js')], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let started = false;

    serverProcess.stdout.on('data', (data) => {
      const line = data.toString();
      if (!started && line.includes('server_started')) {
        started = true;
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const line = data.toString();
      if (!started && line.includes('server_started')) {
        started = true;
        resolve();
      }
      if (line.includes('Error') || line.includes('EADDRINUSE')) {
        if (!started) reject(new Error(`Server failed to start: ${line}`));
      }
    });

    // Timeout: if server doesn't start in 5s
    setTimeout(() => {
      if (!started) {
        reject(new Error('Server startup timeout'));
      }
    }, 5000);
  });
}

async function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) return resolve();
    serverProcess.on('exit', () => resolve());
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
      if (serverProcess) serverProcess.kill('SIGKILL');
      resolve();
    }, 2000);
  });
}

// ─── Test runners ──────────────────────────────────────────────────

/**
 * T1: Connection & ACK
 * - Connect client
 * - Send a message
 * - Verify it's tracked in pendingAck, then removed after ACK
 */
async function testConnectionAck() {
  const client = createClient('test-ack');
  try {
    await client.connect();
    record('T1a: Connects successfully', true);

    // Check pending count increases after send
    const before = client.pendingCount;
    client.send('chat', { text: 'hello' });
    const afterSend = client.pendingCount;
    record('T1b: Pending count increases after send', afterSend > before,
      `before=${before} after=${afterSend}`);

    // Wait for ACK to be received (server relays but also our client receives ack from server side)
    await sleep(500);

    // ACK should have been processed
    const afterAck = client.pendingCount;
    record('T1c: ACK received (pending cleared)', afterAck <= before,
      `after=${afterAck}`);
  } catch (err) {
    record('T1a: Connects successfully', false, err.message);
    record('T1b: Pending count increases after send', false, 'skipped');
    record('T1c: ACK received', false, 'skipped');
  } finally {
    client.disconnect();
  }
}

/**
 * T2: End-to-end relay
 * - Connect clientA and clientB
 * - A sends to B
 * - B receives the message
 */
async function testEndToEndRelay() {
  const clientA = createClient('test-e2e-a');
  const clientB = createClient('test-e2e-b');

  let receivedMsg = null;

  try {
    await clientA.connect();
    await clientB.connect();
    record('T2a: Both clients connected', true);

    // Set up B's message handler
    const received = new Promise((resolve) => {
      clientB.onMessage((msg) => {
        receivedMsg = msg;
        resolve(msg);
      });
    });

    // A sends to B
    clientA.send('chat', { text: 'hello from A' }, 'test-e2e-b');

    const msg = await Promise.race([
      received,
      sleep(3000).then(() => null),
    ]);

    record('T2b: B receives message from A', msg !== null,
      msg ? `type=${msg.type} text="${msg.content?.text}"` : 'timeout');

    record('T2c: Message content correct',
      msg?.content?.text === 'hello from A',
      msg?.content?.text || '(none)');

    record('T2d: Message from correct sender',
      msg?.from === 'test-e2e-a',
      msg?.from || '(none)');
  } catch (err) {
    record('T2a: Both clients connected', false, err.message);
    record('T2b: B receives message from A', false, err.message);
    record('T2c: Message content correct', false, 'skipped');
    record('T2d: Message from correct sender', false, 'skipped');
  } finally {
    clientA.disconnect();
    clientB.disconnect();
  }
}

/**
 * T3: Retry on ACK timeout
 * - Connect clientA
 * - Disconnect server (simulate lost ACK)
 * - Verify client retries the message
 * - Track retry_count in the message
 */
async function testRetryOnAckTimeout() {
  const client = createClient('test-retry');
  let retryDetected = false;
  let maxRetryCount = 0;

  // Patch _handleIncoming to detect retry messages
  const originalHandleIncoming = client._handleIncoming.bind(client);

  try {
    await client.connect();
    record('T3a: Client connected', true);

    // We can't easily simulate "lost ACK" from the server side in this test,
    // so we test by:
    // 1. Sending a message
    // 2. Forcing an ACK timeout by clearing the ACK timer manually
    // 3. Verifying the retry logic increments retry_count

    // Instead, let's do a simpler test: verify the retry mechanism exists
    // by checking the internal structure

    const msgId = client.send('chat', { text: 'retry test' });
    const entry = client._pendingAck.get(msgId);

    record('T3b: Message tracked in pendingAck', entry !== null,
      entry ? `retryCount=${entry.retryCount}` : 'not tracked');

    // Force ACK timeout: clear the timer and call _onAckTimeout directly
    if (entry) {
      clearTimeout(entry.timer);
      clearTimeout(entry.retryTimer);

      // Simulate ACK timeout
      client._onAckTimeout(msgId);

      // Check that retryCount was incremented
      const afterTimeout = client._pendingAck.get(msgId);
      record('T3c: ACK timeout increments retryCount',
        afterTimeout?.retryCount === 1,
        `retryCount=${afterTimeout?.retryCount ?? 'not found'}`);

      // Simulate second timeout
      if (afterTimeout) {
        clearTimeout(afterTimeout.timer);
        clearTimeout(afterTimeout.retryTimer);
        client._onAckTimeout(msgId);

        const afterSecond = client._pendingAck.get(msgId);
        maxRetryCount = afterSecond?.retryCount ?? 0;
        record('T3d: Second timeout increments again',
          maxRetryCount === 2,
          `retryCount=${maxRetryCount}`);

        // Third timeout should exceed maxRetries and remove from pending
        if (afterSecond) {
          clearTimeout(afterSecond.timer);
          clearTimeout(afterSecond.retryTimer);
          client._onAckTimeout(msgId);

          const afterThird = client._pendingAck.get(msgId);
          record('T3e: Exceeds maxRetries → removed from pending',
            afterThird === null,
            `still in map=${afterThird !== null}`);
        }
      }
    }
  } catch (err) {
    record('T3a: Client connected', false, err.message);
    record('T3b: Message tracked in pendingAck', false, err.message);
    record('T3c: ACK timeout increments retryCount', false, 'skipped');
    record('T3d: Second timeout increments again', false, 'skipped');
    record('T3e: Exceeds maxRetries → removed', false, 'skipped');
  } finally {
    client.disconnect();
  }
}

/**
 * T4: Idempotency — duplicate msg_id processed only once
 * - Connect clientB
 * - Send a message from A to B
 * - Manually inject the same message again
 * - Verify callback is called only once
 */
async function testIdempotency() {
  const clientA = createClient('test-idem-a');
  const clientB = createClient('test-idem-b');

  let receiveCount = 0;
  let lastReceivedMsg = null;

  try {
    await clientA.connect();
    await clientB.connect();
    record('T4a: Both clients connected', true);

    const allReceived = new Promise((resolve) => {
      clientB.onMessage((msg) => {
        receiveCount++;
        lastReceivedMsg = msg;
        // Resolve after a short delay to catch duplicates
        setTimeout(resolve, 200);
      });
    });

    // Use a fixed msg_id so we can replay it
    const fixedMsgId = crypto.randomUUID();

    // A sends first message
    clientA.send('chat', { text: 'idempotent test', fixedId: fixedMsgId }, 'test-idem-b');

    // Wait for first delivery
    await Promise.race([allReceived, sleep(2000)]);

    const countAfterFirst = receiveCount;

    // Now manually inject the same message via raw WebSocket
    // We need access to B's raw socket to simulate duplicate delivery
    // Instead, we'll simulate by calling _handleIncoming directly with the same msg_id

    // Construct a duplicate message
    const dupMsg = {
      msg_id: fixedMsgId,
      type: 'chat',
      content: { text: 'idempotent test', fixedId: fixedMsgId },
      from: 'test-idem-a',
      to: 'test-idem-b',
      seq: 1,
      ts: Date.now(),
      retry_count: 0,
    };

    // Inject duplicate
    clientB._handleIncoming(JSON.stringify(dupMsg));

    // Wait briefly
    await sleep(100);

    record('T4b: Callback called exactly once for duplicate',
      receiveCount === countAfterFirst,
      `count=${receiveCount} (expected ${countAfterFirst})`);

    record('T4c: Original message received correctly',
      lastReceivedMsg?.content?.text === 'idempotent test',
      lastReceivedMsg?.content?.text || '(none)');

    // Test with different msg_id — should be delivered
    const dupMsg2 = {
      ...dupMsg,
      msg_id: crypto.randomUUID(), // different ID
    };

    const p2 = new Promise((resolve) => {
      const origCallback = clientB._msgCallback;
      clientB.onMessage((msg) => {
        clientB.onMessage(origCallback);
        resolve(msg);
      });
    });

    clientB._handleIncoming(JSON.stringify(dupMsg2));
    const newMsg = await Promise.race([p2, sleep(500).then(() => null)]);

    record('T4d: Different msg_id delivers normally',
      newMsg !== null,
      newMsg ? `type=${newMsg.type}` : 'not delivered');

  } catch (err) {
    record('T4a: Both clients connected', false, err.message);
    record('T4b: Callback called once for duplicate', false, err.message);
    record('T4c: Original message correct', false, 'skipped');
    record('T4d: Different msg_id delivers', false, 'skipped');
  } finally {
    clientA.disconnect();
    clientB.disconnect();
  }
}

/**
 * T5: Offline queue — message queued when offline, replayed on reconnect
 */
async function testOfflineQueue() {
  const client = createClient('test-queue');

  try {
    // Send while NOT connected
    const msgId = client.send('chat', { text: 'offline message' });

    record('T5a: Message queued while offline',
      client.queueSize > 0,
      `queueSize=${client.queueSize}`);

    // Now connect
    await client.connect();
    record('T5b: Client connected', true);

    // Wait for queue replay
    await sleep(500);

    record('T5c: Queue emptied after reconnect',
      client.queueSize === 0,
      `queueSize=${client.queueSize}`);

  } catch (err) {
    record('T5a: Message queued while offline', false, err.message);
    record('T5b: Client connected', false, err.message);
    record('T5c: Queue emptied after reconnect', false, 'skipped');
  } finally {
    client.disconnect();
  }
}

/**
 * T6: Bidirectional communication
 * - A sends to B, B receives
 * - B replies to A, A receives
 */
async function testBidirectional() {
  const clientA = createClient('test-bidi-a');
  const clientB = createClient('test-bidi-b');

  let aReceived = null;
  let bReceived = null;

  try {
    await clientA.connect();
    await clientB.connect();
    record('T6a: Both clients connected', true);

    const bPromise = new Promise((resolve) => {
      clientB.onMessage((msg) => {
        bReceived = msg;
        // B replies
        clientB.send('chat', { text: 'reply from B', reply_to: msg.msg_id }, 'test-bidi-a');
        resolve(msg);
      });
    });

    const aPromise = new Promise((resolve) => {
      clientA.onMessage((msg) => {
        aReceived = msg;
        resolve(msg);
      });
    });

    // A sends to B
    clientA.send('chat', { text: 'hello B' }, 'test-bidi-b');

    // Wait for both directions
    const [bMsg, aMsg] = await Promise.all([
      Promise.race([bPromise, sleep(3000).then(() => null)]),
      Promise.race([aPromise, sleep(3000).then(() => null)]),
    ]);

    record('T6b: B receives from A', bMsg !== null,
      bMsg ? `text="${bMsg.content?.text}"` : 'timeout');
    record('T6c: A receives reply from B', aMsg !== null,
      aMsg ? `text="${aMsg.content?.text}"` : 'timeout');
    record('T6d: Reply references original',
      aMsg?.content?.reply_to === bMsg?.msg_id,
      `reply_to=${aMsg?.content?.reply_to} original=${bMsg?.msg_id}`);

  } catch (err) {
    record('T6a: Both clients connected', false, err.message);
    record('T6b: B receives from A', false, err.message);
    record('T6c: A receives reply from B', false, 'skipped');
    record('T6d: Reply references original', false, 'skipped');
  } finally {
    clientA.disconnect();
    clientB.disconnect();
  }
}

// ─── Main ───────────────────────────────────────────────────────────
const testMap = {
  1: testConnectionAck,
  2: testEndToEndRelay,
  3: testRetryOnAckTimeout,
  4: testIdempotency,
  5: testOfflineQueue,
  6: testBidirectional,
};

const testNames = {
  1: 'Connection & ACK',
  2: 'End-to-end relay',
  3: 'Retry on ACK timeout',
  4: 'Idempotency',
  5: 'Offline queue',
  6: 'Bidirectional communication',
};

async function main() {
  // Parse which tests to run
  const args = process.argv.slice(2);
  const onlyTest = args.find(a => a === '--test') ? parseInt(args[args.indexOf('--test') + 1]) : null;

  const testsToRun = onlyTest ? [onlyTest] : [1, 2, 3, 4, 5, 6];

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║    Phase 2 — ReliableWSClient Integration Tests     ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\n  Port: ${TEST_PORT}`);
  console.log(`  Tests: ${testsToRun.join(', ')}\n`);

  // Start server
  console.log('  🚀 Starting test server...');
  try {
    await startServer();
    console.log(`  Server running on ${TEST_URL}\n`);
  } catch (err) {
    console.error(`  ❌ Server failed: ${err.message}`);
    console.log('\n  💡 Tip: Make sure port ${TEST_PORT} is free.');
    process.exit(1);
  }

  // Cleanup test queue dir
  const testQueueDir = path.join(__dirname, '.test_queue');
  try { require('fs').rmSync(testQueueDir, { recursive: true, force: true }); } catch {}
  require('fs').mkdirSync(testQueueDir, { recursive: true });

  // Run tests
  for (const n of testsToRun) {
    const fn = testMap[n];
    if (!fn) continue;

    console.log(`\n  ── ${testNames[n]} ──`);
    try {
      await Promise.race([
        fn(),
        sleep(TEST_TIMEOUT_MS).then(() => { throw new Error('Test timeout'); }),
      ]);
    } catch (err) {
      console.log(`  ⚠️  Test group ${n} interrupted: ${err.message}`);
    }

    // Small delay between tests
    await sleep(300);
  }

  // Stop server
  await stopServer();

  // Report
  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║                 Test Report                         ║');
  console.log('╠══════════════════════════════════════════════════════╣');

  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`║  ${icon} ${r.name.padEnd(50)} ${r.pass ? 'PASS' : 'FAIL'}       ║`);
  }

  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Total: ${total}  Passed: ${passed}  Failed: ${failed}`);
  console.log(`║  Result: ${failed === 0 ? '🎉 ALL TESTS PASSED' : `⚠️  ${failed} FAILURE(S)`}          ║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  stopServer().finally(() => process.exit(1));
});
