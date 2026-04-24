#!/bin/bash
# send-to-peer.sh — Send a message to another Agent via webhook
# Usage: ./send-to-peer.sh <webhook_url> <message>
# Example: ./send-to-peer.sh http://127.0.0.1:8644/webhooks/agent-bus "Hello!"

set -e

if [ $# -lt 2 ]; then
    echo "Usage: $0 <webhook_url> <message>"
    echo "Example: $0 http://127.0.0.1:8644/webhooks/agent-bus \"Hello, peer!\""
    exit 1
fi

WEBHOOK_URL="$1"
MESSAGE="$2"
SENDER="${3:-AgentA}"

RESPONSE=$(curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{\"sender\":\"$SENDER\",\"message\":\"$MESSAGE\"}")

echo "$RESPONSE"
