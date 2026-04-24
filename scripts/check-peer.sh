#!/bin/bash
# check-peer.sh — Check if the peer Agent is alive
# Usage: ./check-peer.sh <webhook_url>
# Example: ./check-peer.sh http://127.0.0.1:8644/webhooks/agent-bus

set -e

if [ $# -lt 1 ]; then
    echo "Usage: $0 <webhook_url>"
    exit 1
fi

WEBHOOK_URL="$1"

RESPONSE=$(curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"sender":"healthcheck","message":"ping"}' \
  --connect-timeout 3 \
  --max-time 5)

if [ $? -eq 0 ]; then
    echo "✅ Peer is alive: $RESPONSE"
    exit 0
else
    echo "❌ Peer is unreachable"
    exit 1
fi
