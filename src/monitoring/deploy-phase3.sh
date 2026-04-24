#!/usr/bin/env bash
# deploy-phase3.sh — One-click deploy for WS Bridge (Phase 3)
#
# Usage: bash deploy-phase3.sh
#
# Performs:
#   1. Check Node.js installed
#   2. Check /tmp/hermes-openclaw-chat directory exists
#   3. Install systemd service
#   4. Start the service
#   5. Wait 3s, check /health endpoint
#   6. Report success/failure

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo -e "${GREEN}✓${NC} $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo -e "${RED}✗${NC} $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
info() { echo -e "${YELLOW}→${NC} $1"; }

echo "========================================"
echo "  WS Bridge Phase 3 — Deploy Script"
echo "========================================"
echo ""

# ─── Step 1: Check Node.js ───────────────────────────────────────────────
info "Checking Node.js..."
NODE_BIN="/home/z3129119/.nvm/versions/node/v24.14.0/bin/node"
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version)
  pass "Node.js found: $NODE_VERSION ($(which node))"
elif [ -x "$NODE_BIN" ]; then
  NODE_VERSION=$("$NODE_BIN" --version)
  pass "Node.js found: $NODE_VERSION ($NODE_BIN)"
else
  fail "Node.js is not installed or not in PATH"
  echo "  Install via nvm or package manager, then re-run."
  exit 1
fi

# ─── Step 2: Check working directory ─────────────────────────────────────
info "Checking working directory..."
WORK_DIR="/tmp/hermes-openclaw-chat"
if [ -d "$WORK_DIR" ]; then
  pass "Directory $WORK_DIR exists"
else
  info "Creating $WORK_DIR ..."
  mkdir -p "$WORK_DIR"
  pass "Directory $WORK_DIR created"
fi

# ─── Step 3: Install systemd service ─────────────────────────────────────
info "Installing systemd service..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/ws-server.service"

if [ ! -f "$SERVICE_FILE" ]; then
  fail "ws-server.service not found in $SCRIPT_DIR"
  exit 1
fi

# Copy to systemd directory (needs sudo)
SYSTEMD_DIR="/etc/systemd/system"
if [ -w "$SYSTEMD_DIR" ]; then
  sudo cp "$SERVICE_FILE" "$SYSTEMD_DIR/ws-server.service"
  pass "Service file copied to $SYSTEMD_DIR/"
else
  info "Need sudo to install service..."
  if sudo cp "$SERVICE_FILE" "$SYSTEMD_DIR/ws-server.service" 2>/dev/null; then
    pass "Service file copied to $SYSTEMD_DIR/"
  else
    fail "Failed to copy service file (permission denied?)"
    echo "  Try: sudo bash $0"
    exit 1
  fi
fi

# Reload systemd
sudo systemctl daemon-reload
pass "systemd daemon reloaded"

# ─── Step 4: Start service ───────────────────────────────────────────────
info "Starting ws-server service..."

# Stop first if already running (idempotent)
sudo systemctl stop ws-server 2>/dev/null || true

sudo systemctl start ws-server
pass "ws-server service started"

# Enable on boot
sudo systemctl enable ws-server 2>/dev/null && pass "ws-server enabled on boot" || info "enable skipped (may not be needed)"

# ─── Step 5: Health check ────────────────────────────────────────────────
info "Waiting 3s for server to initialize..."
sleep 3

info "Checking /health endpoint..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8765/health 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  HEALTH_BODY=$(curl -s http://127.0.0.1:8765/health 2>/dev/null || echo "{}")
  pass "Health check passed (HTTP $HTTP_CODE): $HEALTH_BODY"
else
  fail "Health check failed (HTTP $HTTP_CODE)"
  info "Check logs: journalctl -u ws-server --no-pager -n 20"
fi

# Also check service status
SVC_STATUS=$(systemctl is-active ws-server 2>/dev/null || echo "unknown")
if [ "$SVC_STATUS" = "active" ]; then
  pass "systemd status: active"
else
  fail "systemd status: $SVC_STATUS"
fi

# ─── Summary ─────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  Deploy Summary"
echo "========================================"
echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "  ${RED}Failed: $FAIL_COUNT${NC}"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}DEPLOY FAILED${NC} — check the errors above."
  echo "  Debug: sudo journalctl -u ws-server --no-pager -n 50"
  exit 1
else
  echo -e "${GREEN}DEPLOY SUCCESSFUL${NC}"
  exit 0
fi
