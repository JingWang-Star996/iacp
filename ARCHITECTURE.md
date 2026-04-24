# IACP Architecture Specification

## Protocol Overview

**IACP (Inter-Assistant Communication Protocol)** is a lightweight protocol for multiple AI assistant instances running on the same host to discover and communicate with each other.

### Design Principles

1. **No middleware** — Assistants communicate directly, peer-to-peer
2. **Plain HTTP/JSON** — No protocol overhead, easy to implement
3. **Context isolation** — Each assistant maintains independent conversation boundaries
4. **Safe-first routing** — Uncertain messages default to private delivery

## Architecture: 6 Layers

```
┌─────────────────────────────────────────────────────┐
│ L6: Protocol Layer (IACP Spec)                       │
│   Message format, routing rules, transport-agnostic  │
├─────────────────────────────────────────────────────┤
│ L5: Context Isolation                                │
│   Message classifier, 4-domain architecture,         │
│   working memory lifecycle                           │
├─────────────────────────────────────────────────────┤
│ L4: Production Cutover                               │
│   Dual-write bridge, zero-downtime switch,           │
│   automatic rollback, data migration                 │
├─────────────────────────────────────────────────────┤
│ L3: Monitoring & Operations                          │
│   Prometheus metrics, health checks, latency         │
│   histograms, structured logging, systemd, dashboard │
├─────────────────────────────────────────────────────┤
│ L2: Reliable Communication Layer                     │
│   ACK (500ms), retry with exponential backoff,       │
│   LRU dedup (1000 entries), offline queue, replay    │
├─────────────────────────────────────────────────────┤
│ L1: WebSocket Relay                                  │
│   Custom WS server, client auth (x-client-id),       │
│   heartbeat (15s), message routing, auto-reconnect   │
└─────────────────────────────────────────────────────┘
```

### L1: WebSocket Relay

Custom-built WebSocket bridge server with:
- Client authentication via `x-client-id` header
- Bidirectional message routing between assistants
- Heartbeat detection (ping/pong, configurable interval)
- Auto-reconnect with exponential backoff
- Duplicate connection rejection
- Structured logging (JSONL)
- Health check endpoint (`/health`)
- Graceful shutdown (SIGTERM/SIGINT)

**Performance**: ~2-5ms message latency, ~1s reconnect time, ~20MB memory usage.

### L2: Reliable Communication Layer

Wraps raw WebSocket with production-grade reliability:

| Feature | Description |
|---------|-------------|
| **ACK** | 500ms ACK timeout per message, auto-retry on timeout |
| **Retry** | Exponential backoff + jitter: 1s → 3s → 7s, max 3 retries |
| **Idempotency** | LRU cache (1000 entries, 5min TTL), deduplicates by msg_id |
| **Offline Queue** | JSONL file buffer, auto-replay on reconnect |
| **Heartbeat** | App-layer ping/pong every 15s, 10s timeout → reconnect |
| **Reconnect** | Exponential backoff: 1s → 2s → 4s → 8s → 16s → max 30s |

### L3: Monitoring & Operations

Production-grade monitoring capabilities:
- Prometheus metrics endpoint (`/metrics`) — connection count, message counters, latency histograms
- Health check endpoint (`/health`) — connection status, uptime
- Structured logging with logrotate
- systemd integration — auto-restart, graceful shutdown
- Real-time monitoring dashboard (pure frontend)

### L4: Production Cutover

Zero-downtime migration from legacy file-based communication to WebSocket:
- **Dual-write bridge** — simultaneously writes to file + WS during transition
- **Phased cutover** — 5 stages (prepare → dual-write → observe → switch-read → switch-write)
- **Automatic rollback** — triggers on WS latency > 500ms, disconnect > 2min, or message loss > 0.1%
- **Historical data migration** — converts legacy file messages to WS v2 format
- **Health check** — real-time status monitoring during cutover

### L5: Context Isolation

Prevents cross-contamination between assistant conversations:

```
┌─────────────────────────────────────────────┐
│              Main Context Window             │
│                                              │
│  ┌─ SESSION Domain ────────────────────┐    │
│  │  Session-level: core task, identity  │    │
│  │  Isolated from: chat logs, history   │    │
│  └──────────────────────────────────────┘    │
│  ┌─ CHANNEL Domain ────────────────────┐    │
│  │  Per-channel context, no crossover   │    │
│  │  Between: group A / group B / DM     │    │
│  └──────────────────────────────────────┘    │
│  ┌─ MESSAGE_STREAM Domain ─────────────┐    │
│  │  Classified message streams          │    │
│  │  TASK vs REPORT vs CHATTER           │    │
│  └──────────────────────────────────────┘    │
│  ┌─ WORKING_MEMORY Domain ─────────────┐    │
│  │  Task-level short-term memory        │    │
│  │  Cleared after task completion       │    │
│  └──────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

**Message Classifier**: Deterministic regex patterns (not LLM) for classification:
- **TASK**: `^帮我.*`, `^处理.*`, `^创建.*` → triggers execution
- **REPORT**: `.*(今天|今日).*(做了|完成|进度)` → log only
- **CHATTER**: `^(好的|收到|谢谢|👍)$`, `^.{1,5}$` → ignore or lightweight reply

### L6: Protocol Layer

The IACP protocol itself — transport-agnostic message format and routing rules.

**Message Format**:
```json
{
  "sender": "string — name of the sending assistant",
  "message": "string — the message content",
  "msg_id": "optional UUID for deduplication",
  "seq": "optional sequence number",
  "timestamp": "optional ISO 8601 timestamp",
  "to": "optional target assistant name",
  "reply_to": "optional message ID for threading"
}
```

## Routing Rules

Output routing is determined at send time, not at receipt time:

| Source | Task Type | Route To |
|--------|-----------|----------|
| Private DM | Any | Original sender |
| Group Chat | Diagnosis/Analysis | **Admin (private)** |
| Group Chat | Daily Report | **Admin (private)** |
| Peer Assistant | Task delegation | Original sender |
| **Default** | Uncertain | **Admin (private)** |

## Working Memory Lifecycle

```
Task Start:
  1. Clear previous working_memory
  2. Write task: {task_id, goal, constraints, deadline}
  3. Write state: {agent_id, status, output_route}

Task Execution:
  4. Append: {step, result, next_action}

Task Complete:
  5. Write result: {output, route_to, delivered: false}
  6. Route output based on route_to
  7. Mark delivered: true
  8. Clear working_memory
```

## Security

- All communication via `127.0.0.1` loopback only
- Client authentication via `x-client-id` header
- Message classifier prevents spam/injection
- Routing defaults to private (safe-first)
- Sensitive outputs never leak to public channels
