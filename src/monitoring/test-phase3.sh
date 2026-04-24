#!/usr/bin/env bash
# test-phase3.sh — Integration tests for WS Bridge (Phase 3)
#
# Usage: bash test-phase3.sh
#
# Tests:
#   1. Kill any existing server
#   2. Start ws-server-production.js in background
#   3. Test /health endpoint
#   4. Test /metrics endpoint
#   5. Test WebSocket connection + message routing
#   6. Test graceful shutdown (SIGTERM)
#   7. Output PASS/FAIL report

set -uo pipefail

# ─── Config ───────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_JS="$SCRIPT_DIR/ws-server-production.js"
NODE_BIN="/home/z3129119/.nvm/versions/node/v24.14.0/bin/node"
HOST="127.0.0.1"
PORT="8765"
SERVER_PID=""

# ─── Colors ───────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
TEST_RESULTS=()

pass() {
  echo -e "${GREEN}  PASS${NC} $1"
  TEST_RESULTS+=("PASS: $1")
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "${RED}  FAIL${NC} $1"
  TEST_RESULTS+=("FAIL: $1")
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "\n${YELLOW}→${NC} Cleaning up server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ─── Header ───────────────────────────────────────────────────────────────
echo "========================================"
echo "  WS Bridge Phase 3 — Integration Tests"
echo "========================================"
echo ""

# ─── Pre-check ────────────────────────────────────────────────────────────
if [ ! -f "$SERVER_JS" ]; then
  echo -e "${RED}ERROR: $SERVER_JS not found${NC}"
  exit 1
fi

# ─── Step 1: Kill existing server ────────────────────────────────────────
echo -e "${BOLD}[Test 1] Clean up existing server${NC}"
EXISTING=$(pgrep -f "ws-server-production.js" 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo -e "  Found existing server(s): $EXISTING — killing..."
  for pid in $EXISTING; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  # Force kill if still alive
  for pid in $EXISTING; do
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 1
  pass "Previous server instances terminated"
else
  pass "No existing server found (clean state)"
fi

# ─── Step 2: Start server ────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[Test 2] Start WS server${NC}"
"$NODE_BIN" "$SERVER_JS" &>/dev/null &
SERVER_PID=$!
echo -e "  → Server started with PID $SERVER_PID"

info "Waiting 2s for server initialization..."
sleep 2

if kill -0 "$SERVER_PID" 2>/dev/null; then
  pass "Server process running (PID $SERVER_PID)"
else
  fail "Server process died immediately"
  echo "  Check logs: journalctl or stdout/stderr"
  exit 1
fi

# ─── Step 3: Test /health endpoint ───────────────────────────────────────
echo ""
echo -e "${BOLD}[Test 3] /health endpoint${NC}"

# Test HTTP 200
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://$HOST:$PORT/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  pass "/health returns HTTP 200"
else
  fail "/health returns HTTP $HTTP_CODE (expected 200)"
fi

# Test JSON body structure
BODY=$(curl -s "http://$HOST:$PORT/health" 2>/dev/null || echo "")
if echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'status' in d; assert d['status']=='ok'; assert 'clients' in d; assert 'uptime' in d" 2>/dev/null; then
  pass "/health returns valid JSON with status, clients, uptime"
else
  fail "/health JSON structure invalid: $BODY"
fi

# Test uptime > 0
UPTIME=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('uptime',0))" 2>/dev/null || echo "0")
if [ "$UPTIME" -gt 0 ] 2>/dev/null; then
  pass "/health reports uptime > 0 (${UPTIME}s)"
else
  fail "/health reports uptime = $UPTIME"
fi

# ─── Step 4: Test /metrics endpoint ──────────────────────────────────────
echo ""
echo -e "${BOLD}[Test 4] /metrics endpoint${NC}"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://$HOST:$PORT/metrics" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  pass "/metrics returns HTTP 200"
else
  fail "/metrics returns HTTP $HTTP_CODE (expected 200)"
fi

METRICS_BODY=$(curl -s "http://$HOST:$PORT/metrics" 2>/dev/null || echo "")
if echo "$METRICS_BODY" | grep -q "ws_connections_total"; then
  pass "/metrics contains ws_connections_total"
else
  fail "/metrics missing ws_connections_total"
fi

if echo "$METRICS_BODY" | grep -q "ws_messages_sent_total"; then
  pass "/metrics contains ws_messages_sent_total"
else
  fail "/metrics missing ws_messages_sent_total"
fi

if echo "$METRICS_BODY" | grep -q "ws_message_latency_ms"; then
  pass "/metrics contains ws_message_latency_ms histogram"
else
  fail "/metrics missing ws_message_latency_ms histogram"
fi

# ─── Step 5: Test WebSocket connection + message routing ─────────────────
echo ""
echo -e "${BOLD}[Test 5] WebSocket connection + message routing${NC}"

# Use a Node.js script to test WS: connect two clients, send message, verify routing
WS_TEST_RESULT=$(node -e '
const WebSocket = require("ws");

const ws1 = new WebSocket("ws://127.0.0.1:8765", {
  headers: { "x-client-id": "hermes" }
});
const ws2 = new WebSocket("ws://127.0.0.1:8765", {
  headers: { "x-client-id": "openclaw" }
});

let received = null;
let errors = [];

ws1.on("error", (e) => errors.push("hermes: " + e.message));
ws2.on("error", (e) => errors.push("openclaw: " + e.message));

ws2.on("message", (data) => {
  received = JSON.parse(data.toString());
});

ws1.on("open", () => {
  const msg = { type: "chat", id: "test-msg-1", from: "hermes", body: "hello" };
  ws1.send(JSON.stringify(msg));
  setTimeout(() => {
    // Check health to see both clients connected
    const http = require("http");
    http.get("http://127.0.0.1:8765/health", (res) => {
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => {
        const h = JSON.parse(body);
        if (!h.clients.includes("hermes")) errors.push("hermes not in connected clients");
        if (!h.clients.includes("openclaw")) errors.push("openclaw not in connected clients");
        ws1.close();
        ws2.close();
        setTimeout(() => {
          if (errors.length > 0) {
            console.log("FAIL:" + errors.join(";"));
          } else if (received && received.type === "chat" && received.body === "hello") {
            console.log("OK");
          } else {
            console.log("FAIL:message not routed correctly, received=" + JSON.stringify(received));
          }
        }, 500);
      });
    });
  }, 1000);
});
' 2>/dev/null)

if [ "$WS_TEST_RESULT" = "OK" ]; then
  pass "Two clients connected, message routed hermes → openclaw"
else
  fail "WebSocket test failed: $WS_TEST_RESULT"
fi

# ─── Step 6: Test graceful shutdown ──────────────────────────────────────
echo ""
echo -e "${BOLD}[Test 6] Graceful shutdown (SIGTERM)${NC}"

SHUTDOWN_START=$(date +%s%N)
kill -TERM "$SERVER_PID" 2>/dev/null

# Wait for process to exit (max 12s)
EXITED=false
for i in $(seq 1 12); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    EXITED=true
    break
  fi
  sleep 1
done

if [ "$EXITED" = true ]; then
  SHUTDOWN_END=$(date +%s%N)
  DURATION_MS=$(( (SHUTDOWN_END - SHUTDOWN_START) / 1000000 ))
  pass "Server exited gracefully on SIGTERM (${DURATION_MS}ms)"
else
  fail "Server did not exit within 12s after SIGTERM"
  kill -9 "$SERVER_PID" 2>/dev/null || true
fi

SERVER_PID=""  # Clear so cleanup doesn't try again

# ─── Step 7: Test 404 for unknown paths ──────────────────────────────────
echo ""
echo -e "${BOLD}[Test 7] Unknown path returns 404${NC}"

# Quick restart for this test
"$NODE_BIN" "$SERVER_JS" &>/dev/null &
SERVER_PID=$!
sleep 2

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://$HOST:$PORT/unknown" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "404" ]; then
  pass "/unknown returns HTTP 404"
else
  fail "/unknown returns HTTP $HTTP_CODE (expected 404)"
fi

# ─── Report ──────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo -e "  ${BOLD}Test Report${NC}"
echo "========================================"
echo ""
for r in "${TEST_RESULTS[@]}"; do
  if [[ "$r" == PASS* ]]; then
    echo -e "  ${GREEN}$r${NC}"
  else
    echo -e "  ${RED}$r${NC}"
  fi
done
echo ""
echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}  ${RED}Failed: $FAIL_COUNT${NC}"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}INTEGRATION TESTS FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}ALL TESTS PASSED${NC}"
  exit 0
fi
