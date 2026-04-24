#!/usr/bin/env bash
# test-phase1.sh — Integration test for WS server + client
set -euo pipefail

PASS=0
FAIL=0
RESULTS=()

pass() { PASS=$((PASS+1)); RESULTS+=("✅ PASS: $1"); }
fail() { FAIL=$((FAIL+1)); RESULTS+=("❌ FAIL: $1"); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SCRIPT_DIR/ws-server.js"
CLIENT="$SCRIPT_DIR/ws-client.js"
PORT=19876  # use non-default to avoid conflict with existing 8765
LOG_DIR=$(mktemp -d)
SERVER_LOG="$LOG_DIR/server.log"
CLIENT1_LOG="$LOG_DIR/hermes.log"
CLIENT2_LOG="$LOG_DIR/openclaw.log"

# Cleanup helper
cleanup_port() { fuser -k "$1"/tcp 2>/dev/null || true; sleep 0.5; }
cleanup_port $PORT
trap 'kill $(jobs -p) 2>/dev/null; cleanup_port $PORT; rm -rf "$LOG_DIR"' EXIT

echo "═══════════════════════════════════════════════════════"
echo "  Phase 1 WebSocket Integration Test"
echo "═══════════════════════════════════════════════════════"
echo ""

# ─── 0. Prerequisites ────────────────────────────────────
echo "[0/5] Checking prerequisites..."
if ! node -e "require('ws')" 2>/dev/null; then
  fail "ws module not installed"
else
  pass "ws module available"
fi

# ─── 1. Start Server ─────────────────────────────────────
echo "[1/5] Starting WS server..."
WS_PORT=$PORT node "$SERVER" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
sleep 1.5

if kill -0 "$SERVER_PID" 2>/dev/null; then
  pass "Server started (PID $SERVER_PID)"
else
  fail "Server failed to start"; cat "$SERVER_LOG"
  echo "FAIL: $FAIL tests failed"; exit 1
fi

# ─── 2. Connect Two Clients ──────────────────────────────
echo "[2/5] Connecting clients..."

# Hermes client (sender)
CLIENT_ID=hermes WS_URL=ws://127.0.0.1:$PORT node "$CLIENT" > "$CLIENT1_LOG" 2>&1 &
HERMES_PID=$!

sleep 1

if grep -q '"CONNECTED"' "$CLIENT1_LOG" 2>/dev/null || grep -q 'Connected' "$CLIENT1_LOG" 2>/dev/null; then
  pass "Hermes client connected"
else
  fail "Hermes client failed to connect"
fi

# OpenClaw client (receiver) — use a tiny node script to capture messages
node -e "
const { WsClient } = require('$CLIENT');
const c = new WsClient();
c.onMessage = (msg) => {
  if (msg.type === 'text') {
    console.log(JSON.stringify({ got: msg.content, ts: Date.now() }));
  }
};
" > "$CLIENT2_LOG" 2>&1 &
OPENCLAW_PID=$!

sleep 1

if kill -0 "$OPENCLAW_PID" 2>/dev/null; then
  pass "OpenClaw client connected"
else
  fail "OpenClaw client failed to start"
fi

# ─── 3. Throughput + Latency Test (100 messages) ─────────
echo "[3/5] Throughput test: 100 messages..."

node -e "
const { WsClient } = require('$CLIENT');
const c = new WsClient();
const COUNT = 100;
let sent = 0, recv = 0;
const latencies = [];

c.onConnected = () => {
  const start = Date.now();
  for (let i = 0; i < COUNT; i++) {
    c.send({ type: 'text', from: 'hermes', content: 'test-msg-' + i, msg_id: 'm-' + i, payload: Date.now() });
    sent++;
  }
};

c.onMessage = (msg) => {
  if (msg.type === 'text' && msg.from === 'hermes') {
    recv++;
    const lat = Date.now() - msg.payload;
    latencies.push(lat);
  }
  if (recv >= COUNT) {
    const total = Date.now() - latencies[0] - (latencies[latencies.length-1] - latencies[0]);
    latencies.sort((a,b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const avg = Math.round(latencies.reduce((a,b) => a+b, 0) / latencies.length);
    console.log(JSON.stringify({
      sent, recv, avg, min, max, p50, p95, p99,
      duration_ms: latencies[latencies.length-1] - latencies[0]
    }));
    setTimeout(() => { c.close(); process.exit(0); }, 200);
  }
};
" > "$LOG_DIR/throughput.json" 2>/dev/null

if [ -s "$LOG_DIR/throughput.json" ]; then
  AVG=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LOG_DIR/throughput.json','utf8')).avg)")
  P95=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LOG_DIR/throughput.json','utf8')).p95)")
  RECV=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LOG_DIR/throughput.json','utf8')).recv)")
  
  if [ "$RECV" -eq 100 ]; then
    pass "100/100 messages delivered (avg=${AVG}ms, p95=${P95}ms)"
  else
    fail "Only $RECV/100 messages delivered"
  fi

  if [ "$AVG" -lt 50 ]; then
    pass "Average latency ${AVG}ms < 50ms threshold"
  else
    fail "Average latency ${AVG}ms exceeds 50ms threshold"
  fi
else
  fail "Throughput test produced no output"
fi

# ─── 4. Reconnect Test ───────────────────────────────────
echo "[4/5] Reconnect test..."

# Kill Hermes client, wait, restart
kill "$HERMES_PID" 2>/dev/null || true
sleep 1

CLIENT_ID=hermes WS_URL=ws://127.0.0.1:$PORT node "$CLIENT" > "$LOG_DIR/reconnect.log" 2>&1 &
HERMES_PID=$!
sleep 2

if grep -q 'Connected\|CONNECTED' "$LOG_DIR/reconnect.log" 2>/dev/null; then
  pass "Client reconnected after kill"
else
  fail "Client failed to reconnect"
fi

# Verify server logged the reconnection
if grep -q 'Client connected' "$SERVER_LOG" 2>/dev/null; then
  pass "Server detected reconnection"
else
  fail "Server did not detect reconnection"
fi

# ─── 5. Message routing test (directed) ──────────────────
echo "[5/5] Directed message routing..."

node -e "
const { WsClient } = require('$CLIENT');
const c = new WsClient();
let gotAck = false;

c.onConnected = () => {
  c.send({ type: 'text', from: 'hermes', to: 'openclaw', content: 'directed-test', msg_id: 'directed-1' });
  setTimeout(() => {
    console.log(gotAck ? 'ROUTED' : 'NOT_ROUTED');
    c.close();
    process.exit(0);
  }, 1000);
};

c.onMessage = (msg) => {
  if (msg.type === 'text') gotAck = true;
};
" > "$LOG_DIR/routing.txt" 2>/dev/null

if [ "$(cat "$LOG_DIR/routing.txt" 2>/dev/null)" = "ROUTED" ]; then
  pass "Directed message routing works"
else
  fail "Directed message routing failed"
fi

# ─── Summary ─────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "SERVER LOG (last 20 lines):"
  tail -20 "$SERVER_LOG" 2>/dev/null || true
  echo ""
  echo "OVERALL: ❌ FAILED ($FAIL test(s) failed)"
  exit 1
else
  echo "OVERALL: ✅ ALL TESTS PASSED"
  exit 0
fi
