#!/usr/bin/env bash
# health-check.sh — Check WS bridge health, suitable for cron (*/1 * * * *)
# Exit 0 = healthy, 1 = unhealthy

set -euo pipefail

HEALTH_URL="http://127.0.0.1:8765/health"
LOG_FILE="/tmp/hermes-openclaw-chat/ws-server.log"
MAX_LOG_SIZE=$((50 * 1024 * 1024))  # 50MB
WARNINGS=()
HEALTHY=true

# 1. Check if the WS server process is running
if ! pgrep -f "ws-server-production.js" > /dev/null 2>&1; then
  WARNINGS+=("WS server process is NOT running")
  HEALTHY=false
fi

# 2. Check /health endpoint
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
  WARNINGS+=("/health returned HTTP $HTTP_CODE (expected 200)")
  HEALTHY=false
else
  # Check if clients are connected
  CLIENTS=$(curl -s "$HEALTH_URL" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(','.join(d.get('clients',[])))" 2>/dev/null || echo "")
  if [ -z "$CLIENTS" ]; then
    WARNINGS+=("/health returned no connected clients")
    # Not necessarily unhealthy — clients may reconnect
  fi
fi

# 3. Check log file size
if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt "$MAX_LOG_SIZE" ]; then
    WARNINGS+=("Log file exceeds 50MB (current: $((LOG_SIZE / 1024 / 1024))MB)")
    HEALTHY=false
  fi
fi

# Output result
TIMESTAMP=$(date -Iseconds)
if [ "$HEALTHY" = true ]; then
  echo "[$TIMESTAMP] HEALTH_CHECK: OK"
  exit 0
else
  echo "[$TIMESTAMP] HEALTH_CHECK: FAILED"
  for w in "${WARNINGS[@]}"; do
    echo "  - $w"
  done
  exit 1
fi
