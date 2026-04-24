# IACP — Inter-Assistant Communication Protocol

> A lightweight protocol and production-grade infrastructure for multiple AI assistant instances to discover and communicate with each other on a single host.

[中文](#iacp---多助手通信协议) | [日本語](#iacp---アシスタント間通信プロトコル)

---

## What is IACP?

When you run multiple AI assistants (like OpenClaw, Hermes, or others) on the same machine, they're completely isolated — each has its own gateway, memory, skills, and autonomous capabilities. There's no built-in way for them to talk to each other.

**IACP solves this.** It provides both a protocol specification **and** a production-grade communication infrastructure, including:

- **WebSocket relay server** — Custom-built WS bridge with client authentication, heartbeat, message routing, and auto-reconnect
- **Reliable communication layer** — ACK confirmation, exponential backoff retry, LRU deduplication, offline queue (JSONL), auto-replay on reconnect
- **Production monitoring** — Prometheus metrics, health check endpoints, latency histograms, structured logging, logrotate, systemd integration, real-time dashboard
- **Zero-downtime cutover** — Dual-write bridge, automatic rollback, historical data migration, phased cutover plan
- **Context isolation** — Four-domain architecture (SESSION / CHANNEL / MESSAGE_STREAM / WORKING_MEMORY) to prevent cross-contamination between assistants

IACP is a **protocol + reference implementation**. It's not middleware, not a bus, not a product feature — it's an open specification that any AI assistant framework can adopt.

## Architecture

IACP consists of 6 layers, from the protocol spec at the top to the infrastructure at the bottom:

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

### Communication Modes

| Mode | Mechanism | Latency | Use Case |
|------|-----------|---------|----------|
| **Direct Webhook** | HTTP POST to peer's webhook | <1s | Task delegation, needs ack |
| **Shared Channel @mention** | IM group chat with @ | Async | Simple notification |
| **WebSocket Relay** | Custom WS bridge with ACK/retry | ~2-5ms | High-reliability, real-time |
| **Agent Proxy** | HTTP POST to peer's proxy port | <1s | Synchronous call |

### Message Format (IACP Protocol)

```json
{
  "type": "message",
  "from": "assistant-a",
  "content": "Query the latest status",
  "msg_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-04-24T20:00:00Z"
}
```

Server enriches messages with `_from` (authenticated client ID) and `_receivedAt` (server timestamp).

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

### Option 1: 3-line demo (Node.js)

```bash
git clone https://github.com/JingWang-Star996/iacp.git && cd iacp && npm install
npm start                                    # Start WS relay server
IACP_CLIENT_ID=assistant-a npm run client:demo-a   # Start assistant A (new terminal)
IACP_CLIENT_ID=assistant-b npm run client:demo-b   # Start assistant B (new terminal)
```

### Option 2: Docker (one command)

```bash
docker compose up -d
curl http://127.0.0.1:8765/health
```

For detailed setup instructions, see [QUICKSTART.md](QUICKSTART.md).

### Prerequisites

- Node.js >= 16
- npm (for Option 1)
- Docker (for Option 2, optional)
- Each assistant has its own webhook endpoint (for HTTP mode)
- A shared IM group chat (Feishu, Slack, etc.) — optional, for @mention mode

### Send a Message

```bash
# Start the server first: npm start

# From Assistant A (terminal 1)
IACP_CLIENT_ID=assistant-a npm run client:demo-a
# Type a message: "Hello from A!"

# From Assistant B (terminal 2)
IACP_CLIENT_ID=assistant-b npm run client:demo-b
# See: [assistant-b] ← [assistant-a]: Hello from A!
```

### Check Server Health

```bash
curl http://127.0.0.1:8765/health
# → {"status":"ok","protocol":"IACP","version":"1.0.0","clients":["assistant-a","assistant-b"],...}

# Prometheus metrics
curl http://127.0.0.1:8765/metrics
```

## Project Structure

```
iacp/
├── README.md                    # Multi-language documentation
├── ARCHITECTURE.md              # Protocol specification
├── src/
│   ├── ws-relay/                # L1: WebSocket relay server + clients
│   ├── reliable-layer/          # L2: ACK, retry, dedup, offline queue
│   ├── monitoring/              # L3: Prometheus metrics, health checks, dashboard
│   └── cutover/                 # L4: Dual-write bridge, zero-downtime switch
├── scripts/
│   ├── send-to-peer.sh          # Send message to peer
│   └── check-peer.sh            # Peer health check
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

| Layer | Implementation |
|-------|---------------|
| **L1: WS Relay** | `src/ws-relay/ws-server.js` — Custom WS bridge with auth, heartbeat, routing |
| **L2: Reliable Layer** | `src/reliable-layer/reliable-ws-layer.js` — ACK, retry, dedup, offline queue, replay |
| **L3: Monitoring** | `src/monitoring/ws-server-production.js` — Prometheus metrics, health endpoints, dashboard |
| **L4: Cutover** | `src/cutover/dual-write-bridge.js`, `switch-to-ws.sh`, `rollback-to-file.sh` |
| **L5: Context Isolation** | Message classifier + routing rules + 4-domain architecture |
| **L6: Protocol** | Message format + routing spec (this repo) |

### Performance Benchmarks

| Metric | Target | Actual |
|--------|--------|--------|
| Message latency | < 50ms | ~2-5ms |
| Reconnect time | < 2s (first) | ~1s |
| Memory usage | < 50MB | ~20MB |
| ACK timeout | 500ms | ✅ |
| Retry policy | Exponential backoff (1s→3s→7s) | ✅ |
| Offline queue | JSONL file buffer + auto-replay | ✅ |
| Deduplication | LRU cache (1000 entries, 5min TTL) | ✅ |

## Why Not a Message Broker?

Running a central message broker (RabbitMQ, Redis Pub/Sub, etc.) for 2-3 agents on a single host is overkill. IACP takes a different approach:

- **No middleware** — Assistants communicate directly or via a lightweight WS bridge
- **No discovery service** — Webhook URLs are configured statically
- **No protocol overhead** — Plain JSON over HTTP/WS
- **Context isolation** — Each assistant maintains its own conversation boundaries
- **Self-contained** — All infrastructure is built from scratch, no external dependencies

## Security

- All communication via `127.0.0.1` loopback only
- Client authentication via `x-client-id` header
- Message classifier prevents spam/injection
- Routing defaults to private delivery (safe-first)
- Sensitive outputs never leak to public channels

## License

MIT — see [LICENSE](LICENSE) file.

---

## IACP — 多助手通信协议

### 什么是 IACP？

当你在同一台机器上运行多个 AI 助手（如 OpenClaw、Hermes 等）时，它们是完全隔离的——每个都有自己的 Gateway、记忆系统、技能和自主能力。它们之间没有内置的通信方式。

**IACP 解决了这个问题。** 它不仅定义了协议规范，还提供了**生产级的通信基础设施**，包括：

- **WebSocket 中继服务器** — 自研 WS 桥，支持客户端认证、心跳、消息路由、自动重连
- **可靠通信层** — ACK 确认、指数退避重试、LRU 去重、离线队列(JSONL)、断线自动重放
- **生产级监控** — Prometheus 指标、健康检查端点、延迟直方图、结构化日志、systemd 集成、实时 Dashboard
- **零停机切换** — 双写桥接器、自动回滚、历史数据迁移、阶段化切换方案
- **上下文隔离** — 四域隔离架构(SESSION / CHANNEL / MESSAGE_STREAM / WORKING_MEMORY)，防止跨助手污染

IACP 是一个 **协议 + 参考实现**。它不是中间件，不是消息总线，不是产品功能——它是任何 AI 助手框架都可以采用的开放规范。

### 架构

IACP 由 6 层组成，从顶部的协议规范到底层的基础设施：

```
┌─────────────────────────────────────────────────────┐
│ L6: 协议层 (IACP Spec)                               │
│   消息格式、路由规则、传输层解耦                        │
├─────────────────────────────────────────────────────┤
│ L5: 上下文隔离                                       │
│   消息分类器、四域隔离架构、工作记忆生命周期             │
├─────────────────────────────────────────────────────┤
│ L4: 生产切换                                         │
│   双写桥接器、零停机切换、自动回滚、数据迁移             │
├─────────────────────────────────────────────────────┤
│ L3: 监控与运维                                       │
│   Prometheus 指标、健康检查、延迟直方图、日志、Dashboard│
├─────────────────────────────────────────────────────┤
│ L2: 可靠通信层                                       │
│   ACK(500ms)、指数退避重试、LRU去重、离线队列、自动重放 │
├─────────────────────────────────────────────────────┤
│ L1: WebSocket 中继                                   │
│   自研 WS 服务器、客户端认证、心跳、消息路由、自动重连   │
└─────────────────────────────────────────────────────┘
```

### 通信模式

| 模式 | 机制 | 延迟 | 适用场景 |
|------|------|------|----------|
| **直接 Webhook** | HTTP POST 到对方 webhook | <1s | 任务委派，需要确认 |
| **群聊 @提及** | IM 群聊中 @ 对方 | 异步 | 简单通知 |
| **WebSocket 中继** | 自研 WS 桥 + ACK/重试 | ~2-5ms | 高可靠、实时通信 |
| **Agent Proxy** | HTTP POST 到对方代理端口 | <1s | 同步调用 |

### 快速开始

**方式 1：Node.js 快速体验**

```bash
git clone https://github.com/JingWang-Star996/iacp.git && cd iacp && npm install
npm start                                              # 启动 WS 中继服务器
IACP_CLIENT_ID=助手A npm run client:demo-a             # 启动助手 A（新终端）
IACP_CLIENT_ID=助手B npm run client:demo-b             # 启动助手 B（新终端）
```

**方式 2：Docker 一键启动**

```bash
docker compose up -d
curl http://127.0.0.1:8765/health
```

详细教程见 [QUICKSTART.md](QUICKSTART.md)。

### 源代码

IACP 全部 6 层的完整生产级实现已包含在本仓库的 `src/` 目录下：

| 层级 | 实现 |
|------|------|
| **L1: WS 中继** | `src/ws-relay/ws-server.js` — 自研 WS 桥，认证/心跳/路由 |
| **L2: 可靠层** | `src/reliable-layer/reliable-ws-layer.js` — ACK/重试/去重/离线队列/重放 |
| **L3: 监控** | `src/monitoring/ws-server-production.js` — Prometheus/健康检查/Dashboard |
| **L4: 切换** | `src/cutover/dual-write-bridge.js` / `switch-to-ws.sh` / `rollback-to-file.sh` |
| **L5: 隔离** | 消息分类器 + 路由规则 + 四域架构 |
| **L6: 协议** | 消息格式 + 路由规范（本仓库） |

### 性能指标

| 指标 | 目标 | 实测 |
|------|------|------|
| 消息延迟 | < 50ms | ~2-5ms |
| 重连时间 | < 2s | ~1s |
| 内存占用 | < 50MB | ~20MB |

---

## IACP — アシスタント間通信プロトコル

### IACP とは？

同じマシン上で複数の AI アシスタント（OpenClaw、Hermes など）を実行している場合、それぞれは完全に隔離されています — 独自の Gateway、メモリ、スキル、自律機能を持ちます。それらの間で通信するための組み込み方法はありません。

**IACP はこれを解決します。** プロトコル仕様 **と** 本番グレードの通信インフラの両方を提供します：

- **WebSocket リレーサーバー** — 独自の WS ブリッジ、クライアント認証、ハートビート、メッセージルーティング、自動再接続
- **信頼できる通信層** — ACK 確認、指数バックオフリトライ、LRU 重複排除、オフラインキュー(JSONL)、再接続時の自動リプレイ
- **本番モニタリング** — Prometheus メトリクス、ヘルスチェックエンドポイント、レイテンシヒストグラム、構造化ログ、systemd 統合、リアルタイムダッシュボード
- **ゼロダウンタイム切替** — 二重書きブリッジ、自動ロールバック、履歴データ移行、段階的切替計画
- **コンテキスト分離** — 4 ドメイン分離アーキテクチャ（SESSION / CHANNEL / MESSAGE_STREAM / WORKING_MEMORY）

IACP は **プロトコル + リファレンス実装** です。ミドルウェアでもメッセージバスでも製品機能でもありません — あらゆる AI アシスタントフレームワークが採用できるオープン仕様です。

### アーキテクチャ

IACP は 6 つのレイヤーで構成されています：

```
┌─────────────────────────────────────────────────────┐
│ L6: プロトコル層 (IACP Spec)                          │
│   メッセージ形式、ルーティングルール                   │
├─────────────────────────────────────────────────────┤
│ L5: コンテキスト分離                                   │
│   メッセージ分類器、4ドメイン分離、ワーキングメモリ     │
├─────────────────────────────────────────────────────┤
│ L4: 本番切替                                         │
│   二重書きブリッジ、ゼロダウンタイム切替、自動ロールバック│
├─────────────────────────────────────────────────────┤
│ L3: モニタリング・運用                                │
│   Prometheus、ヘルスチェック、レイテンシ、ダッシュボード │
├─────────────────────────────────────────────────────┤
│ L2: 信頼通信層                                        │
│   ACK(500ms)、指数バックオフ、LRU重複排除、オフラインキュー│
├─────────────────────────────────────────────────────┤
│ L1: WebSocket リレー                                  │
│   独自WSサーバー、クライアント認証、ハートビート、自動再接続│
└─────────────────────────────────────────────────────┘
```

### 通信モード

| モード | 仕組み | レイテンシ | ユースケース |
|--------|--------|-----------|-------------|
| **直接Webhook** | 相手WebhookにHTTP POST | <1秒 | タスク委任、確認が必要 |
| **@ メンション** | 共有グループチャット | 非同期 | 簡易通知 |
| **WebSocket リレー** | 独自WSブリッジ + ACK/リトライ | ~2-5ms | 高信頼、リアルタイム |
| **Agent Proxy** | 相手エージェントプロキシにHTTP POST | <1秒 | 同期呼び出し |

### クイックスタート

**方法 1：Node.js で体験**

```bash
git clone https://github.com/JingWang-Star996/iacp.git && cd iacp && npm install
npm start                                                    # WSリレーサーバー起動
IACP_CLIENT_ID=assistant-a npm run client:demo-a             # アシスタントA起動
IACP_CLIENT_ID=assistant-b npm run client:demo-b             # アシスタントB起動
```

**方法 2：Docker でワンコマンド**

```bash
docker compose up -d
curl http://127.0.0.1:8765/health
```

詳細は [QUICKSTART.md](QUICKSTART.md) を参照。
