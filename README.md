# IACP — Inter-Assistant Communication Protocol

> A lightweight protocol for multiple AI assistant instances to discover and communicate with each other on a single host.

[中文](#iacp---多助手通信协议) | [日本語](#iacp---アシスタント間通信プロトコル)

---

## What is IACP?

When you run multiple AI assistants (like OpenClaw, Hermes, or others) on the same machine, they're completely isolated — each has its own gateway, memory, skills, and autonomous capabilities. There's no built-in way for them to talk to each other.

**IACP solves this.** It defines a simple protocol for local AI assistant instances to:

- **Discover** peers on the same host
- **Send messages** peer-to-peer (no central broker)
- **Classify incoming messages** (task vs. report vs. chatter)
- **Route responses** to the correct channel (private or group)
- **Isolate context** so one assistant's conversation doesn't pollute another's

IACP is a **protocol + reference implementation**. It's not middleware, not a bus, not a product feature — it's an open specification that any AI assistant framework can adopt.

## Architecture

```
┌──────────────┐    IACP/HTTP POST    ┌──────────────┐
│   OpenClaw   │ ───────────────────► │    Hermes    │
│  Gateway     │  webhook/agent-bus   │  Gateway     │
│  :18789      │                      │  :8644       │
└──────┬───────┘                      └──────┬───────┘
       │                                      │
       └────── Shared IM Channel (Feishu) ────┘
```

### Communication Modes

| Mode | Mechanism | Latency | Use Case |
|------|-----------|---------|----------|
| **Direct Webhook** | HTTP POST to peer's webhook | <1s | Task delegation, needs ack |
| **Shared Channel @mention** | IM group chat with @ | Async | Simple notification |
| **Agent Proxy** | HTTP POST to peer's proxy port | <1s | Synchronous call |

### Message Classification (deterministic, regex-based)

```json
{
  "TASK": "Triggers execution — patterns like '帮我...', '处理...'",
  "REPORT": "Log only — patterns like '今天做了...', '进度...'",
  "CHATTER": "Ignore/lightweight — patterns like '好的', '收到'"
}
```

### Routing Rules

| Source | Task Type | Route To |
|--------|-----------|----------|
| Private DM | Any | Original sender |
| Group Chat | Diagnosis/Analysis | **Admin (private)** |
| Group Chat | Daily Report | **Admin (private)** |
| Peer Agent | Task delegation | Original sender |
| **Default** | Uncertain | **Admin (private)** |

## Quick Start

### Prerequisites

- Multiple AI assistant instances running on the same host
- Each assistant has its own webhook endpoint
- A shared IM group chat (Feishu, Slack, etc.)

### Send a Message

```bash
curl -X POST http://127.0.0.1:8644/webhooks/agent-bus \
  -H "Content-Type: application/json" \
  -d '{"sender":"OpenClaw","message":"你好，Hermes！"}'
```

### Check Peer Health

```bash
curl -X POST http://127.0.0.1:8644/webhooks/agent-bus \
  -H "Content-Type: application/json" \
  -d '{"sender":"healthcheck","message":"ping"}'
```

## Project Structure

```
iacp/
├── README.md              # Multi-language documentation
├── ARCHITECTURE.md        # Protocol specification
├── scripts/
│   ├── send-to-peer.sh    # Send message to peer
│   └── check-peer.sh      # Peer health check
├── config/
│   ├── message-classifier.json  # Message classification rules
│   └── routing-rules.json       # Output routing decision table
├── examples/
│   ├── openclaw-config.yaml     # OpenClaw integration example
│   └── hermes-config.yaml       # Hermes integration example
└── docs/
    ├── working-memory-lifecycle.md  # Task-level memory lifecycle
    └── channel-domains.md           # Channel isolation rules
```

## Why Not a Message Broker?

Running a central message broker (RabbitMQ, Redis Pub/Sub, etc.) for 2-3 agents on a single host is overkill. IACP takes a different approach:

- **No middleware** — agents talk directly to each other
- **No discovery service** — webhook URLs are configured statically
- **No protocol overhead** — plain JSON over HTTP
- **Context isolation** — each assistant maintains its own conversation boundaries

## Security

- All communication via `127.0.0.1` loopback only
- Message classifier prevents spam/injection attacks
- Routing defaults to private delivery (safe-first)
- Sensitive outputs never leak to public channels

## License

MIT — see [LICENSE](LICENSE) file.

---

## IACP — 多助手通信协议

### 什么是 IACP？

当你在同一台机器上运行多个 AI 助手（如 OpenClaw、Hermes 等）时，它们是完全隔离的——每个都有自己的 Gateway、记忆系统、技能和自主能力。它们之间没有内置的通信方式。

**IACP 解决了这个问题。** 它定义了一个轻量级协议，让本地 AI 助手实例能够：

- **发现** 同一主机上的对等节点
- **点对点发送消息**（无需中心代理）
- **分类接收的消息**（任务 / 汇报 / 闲聊）
- **路由回复** 到正确的渠道（私聊或群聊）
- **隔离上下文** 防止一个助手的对话污染另一个

IACP 是一个 **协议 + 参考实现**。它不是中间件，不是消息总线，不是产品功能——它是任何 AI 助手框架都可以采用的开放规范。

### 架构

```
┌──────────────┐    IACP/HTTP POST    ┌──────────────┐
│   OpenClaw   │ ───────────────────► │    Hermes    │
│  Gateway     │  webhook/agent-bus   │  Gateway     │
│  :18789      │                      │  :8644       │
└──────┬───────┘                      └──────┬───────┘
       │                                      │
       └────── 共享 IM 群聊 (飞书) ─────────────┘
```

### 通信模式

| 模式 | 机制 | 延迟 | 适用场景 |
|------|------|------|----------|
| **直接 Webhook** | HTTP POST 到对方 webhook | <1s | 任务委派，需要确认 |
| **群聊 @提及** | IM 群聊中 @ 对方 | 异步 | 简单通知 |
| **Agent Proxy** | HTTP POST 到对方代理端口 | <1s | 同步调用 |

### 快速开始

```bash
curl -X POST http://127.0.0.1:8644/webhooks/agent-bus \
  -H "Content-Type: application/json" \
  -d '{"sender":"OpenClaw","message":"你好，Hermes！"}'
```

---

## IACP — アシスタント間通信プロトコル

### IACP とは？

同じマシン上で複数の AI アシスタント（OpenClaw、Hermes など）を実行している場合、それぞれは完全に隔離されています — 独自の Gateway、メモリ、スキル、自律機能を持ちます。それらの間で通信するための組み込み方法はありません。

**IACP はこれを解決します。** ローカルの AI アシスタントインスタンスが以下を行えるようにする軽量プロトコルを定義します：

- 同じホスト上の**ピアの発見**
- **ピアツーピアのメッセージ送信**（中央ブローカー不要）
- **受信メッセージの分類**（タスク / レポート / チャット）
- **正しいチャネルへのルーティング**（プライベートまたはグループ）
- **コンテキストの分離**（あるアシスタントの会話が他を汚染しないように）

IACP は **プロトコル + リファレンス実装** です。ミドルウェアでもメッセージバスでも製品機能でもありません — あらゆる AI アシスタントフレームワークが採用できるオープン仕様です。

### アーキテクチャ

```
┌──────────────┐    IACP/HTTP POST    ┌──────────────┐
│   OpenClaw   │ ───────────────────► │    Hermes    │
│  Gateway     │  webhook/agent-bus   │  Gateway     │
│  :18789      │                      │  :8644       │
└──────┬───────┘                      └──────┬───────┘
       │                                      │
       └────── 共有 IM グループチャット ────────┘
```

### クイックスタート

```bash
curl -X POST http://127.0.0.1:8644/webhooks/agent-bus \
  -H "Content-Type: application/json" \
  -d '{"sender":"OpenClaw","message":"こんにちは、Hermes！"}'
```
