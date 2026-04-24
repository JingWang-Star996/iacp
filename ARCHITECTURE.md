# IACP Architecture Specification

## Protocol Overview

**IACP (Inter-Assistant Communication Protocol)** is a lightweight protocol for multiple AI assistant instances running on the same host to discover and communicate with each other.

### Design Principles

1. **No middleware** — Assistants communicate directly, peer-to-peer
2. **Plain HTTP/JSON** — No protocol overhead, easy to implement
3. **Context isolation** — Each assistant maintains independent conversation boundaries
4. **Safe-first routing** — Uncertain messages default to private delivery

## Communication Modes

### Mode 1: Direct Webhook

```
Assistant A ──HTTP POST──► Assistant B Webhook
  POST /webhooks/agent-bus
  {"sender": "AssistantA", "message": "..."}
```

- **Latency**: < 1s
- **Reliability**: High (synchronous HTTP response)
- **Use case**: Task delegation, needs confirmation of receipt

### Mode 2: Shared Channel @mention

```
Assistant B ──IM Message──► Shared Group Chat ──► Assistant A (via @)
  "@AssistantA please do X"
```

- **Latency**: Depends on polling interval
- **Reliability**: Medium (async, depends on IM availability)
- **Use case**: Simple notifications, async requests

### Mode 3: Agent Proxy

```
Assistant B ──HTTP POST──► Assistant A Proxy ──► Assistant A Gateway
  POST /agent
  {"sender": "AssistantB", "message": "..."}
```

- **Latency**: < 1s
- **Reliability**: High (synchronous, may queue if busy)
- **Use case**: Synchronous calls, waiting for response

## Message Format

```json
{
  "sender": "string — name of the sending assistant",
  "message": "string — the message content",
  "timestamp": "optional ISO 8601 timestamp",
  "reply_to": "optional message ID for threading"
}
```

## Message Classification

IACP uses **deterministic regex patterns** (not LLM) for message classification:

| Category | Patterns | Behavior |
|----------|----------|----------|
| **TASK** | `^帮我.*`, `^处理.*`, `^创建.*` | Triggers execution |
| **REPORT** | `.*(今天\|今日).*(做了\|完成\|进度)` | Log only, no spawn |
| **CHATTER** | `^(好的\|收到\|谢谢\|👍)$`, `^.{1,5}$` | Ignore or lightweight reply |

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

## Channel Isolation

- Messages from different `channel_id` do NOT cross-process
- Each channel maintains independent context
- Cron tasks run in isolated channel domains
- Private DM takes priority over group chat

## Security

- All communication via `127.0.0.1` loopback only
- Message classifier prevents spam/injection
- Routing defaults to private (safe-first)
- Sensitive outputs never leak to public channels
