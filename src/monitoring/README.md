# Phase 3: 监控与运维 — Hermes ↔ OpenClaw WebSocket Bridge

## 概述

Phase 3 为 WebSocket 通信层提供生产级监控与运维能力，包括：

- **健康检查** — `/health` 端点，返回连接状态和运行时间
- **Prometheus 指标** — `/metrics` 端点，暴露连接数、消息计数、延迟直方图等
- **多客户端管理** — 基于 `x-client-id` 请求头认证和路由
- **心跳检测** — 自动 ping/pong，超时断开
- **结构化日志** — JSON 格式日志，支持日志轮转
- **systemd 集成** — 自动重启、优雅关闭
- **监控 Dashboard** — 纯前端网页，实时显示状态

## 文件清单

| 文件 | 说明 |
|------|------|
| `ws-server-production.js` | WebSocket 桥接服务器（Node.js + ws） |
| `ws-server.service` | systemd 服务配置 |
| `health-check.sh` | 健康检查脚本（适合 cron） |
| `ws-server-logrotate.conf` | logrotate 配置 |
| `monitor.html` | 前端监控 Dashboard |
| `deploy-phase3.sh` | 一键部署脚本 |
| `test-phase3.sh` | 集成测试脚本 |

## 快速开始

### 1. 安装依赖

```bash
cd phase3/
npm install ws
```

### 2. 部署（systemd）

```bash
chmod +x deploy-phase3.sh
./deploy-phase3.sh
```

### 3. 手动启动（开发/调试）

```bash
node ws-server-production.js
```

### 4. 验证

```bash
# 健康检查
curl http://127.0.0.1:8765/health
# → {"status":"ok","clients":[],"uptime":5}

# Prometheus 指标
curl http://127.0.0.1:8765/metrics
```

## 客户端连接

客户端连接时必须携带 `x-client-id` 请求头：

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:8765', {
  headers: { 'x-client-id': 'hermes' }  // 或 'openclaw'
});
```

支持的 client-id：`hermes`、`openclaw`

## 消息路由

服务器自动在 hermes 和 openclaw 之间双向转发消息。发送到 `hermes` 的消息会被转发给 `openclaw`，反之亦然。

## HTTP API

### GET /health

```json
{
  "status": "ok",
  "clients": ["hermes", "openclaw"],
  "uptime": 123
}
```

### GET /metrics

Prometheus 格式指标：

```
# HELP ws_connections_total Current number of connected clients
# TYPE ws_connections_total gauge
ws_connections_total 2

# HELP ws_messages_sent_total Total messages sent by the bridge
# TYPE ws_messages_sent_total counter
ws_messages_sent_total 42

# HELP ws_messages_received_total Total messages received by the bridge
# TYPE ws_messages_received_total counter
ws_messages_received_total 42

# HELP ws_errors_total Total errors encountered
# TYPE ws_errors_total counter
ws_errors_total 0

# HELP ws_message_latency_ms Message forwarding latency histogram
# TYPE ws_message_latency_ms histogram
ws_message_latency_ms_bucket{le="5"} 10
ws_message_latency_ms_bucket{le="10"} 25
...
ws_message_latency_ms_sum 1250.5
ws_message_latency_ms_count 100
```

## 监控 Dashboard

用浏览器打开 `monitor.html`（需要通过代理或同域访问 API），或直接用静态服务器：

```bash
# 方式 1：将 monitor.html 放到 ws-server 同目录，通过 HTTP 访问
# 方式 2：独立打开（需要手动修改 API_BASE 指向 ws-server 地址）
python3 -m http.server 8080 &
# 然后浏览器访问 http://localhost:8080/monitor.html
```

## 运维操作

### 日志位置

- 应用日志：`/tmp/hermes-openclaw-chat/ws-server.log`
- stdout：`/tmp/hermes-openclaw-chat/ws-server-stdout.log`
- stderr：`/tmp/hermes-openclaw-chat/ws-server-stderr.log`

### 日志轮转

```bash
sudo cp ws-server-logrotate.conf /etc/logrotate.d/ws-server
```

### 健康检查（cron）

```bash
# 添加到 crontab: */1 * * * * /path/to/health-check.sh
chmod +x health-check.sh
(crontab -l 2>/dev/null; echo "*/1 * * * * /path/to/health-check.sh >> /tmp/hermes-openclaw-chat/health-check.log 2>&1") | crontab -
```

### 查看服务状态

```bash
sudo systemctl status ws-server-bridge
sudo journalctl -u ws-server-bridge -f
```

### 重启服务

```bash
sudo systemctl restart ws-server-bridge
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WS_HOST` | `127.0.0.1` | 监听地址 |
| `WS_PORT` | `8765` | 监听端口 |
| `WS_LOG_FILE` | `/tmp/hermes-openclaw-chat/ws-server.log` | 日志路径 |
| `WS_CLIENT_IDS` | `hermes,openclaw` | 允许的客户端 ID（逗号分隔） |
| `WS_HEARTBEAT_MS` | `30000` | 心跳间隔（毫秒） |
| `WS_HEARTBEAT_TIMEOUT_MS` | `10000` | 心跳超时（毫秒） |
| `WS_MAX_MESSAGE_BYTES` | `1048576` | 最大消息大小（字节） |

## 测试

```bash
chmod +x test-phase3.sh
./test-phase3.sh
```

运行 8 项集成测试：
1. 服务器启动
2. `/health` 端点
3. `/metrics` 端点
4. 客户端认证
5. 双向消息路由
6. 指标递增
7. 优雅关闭（SIGTERM）
8. 未知路径 404

## 安全

- 仅绑定 127.0.0.1，不接受外部连接
- 请求头认证（x-client-id）
- systemd 安全加固（NoNewPrivileges, ProtectSystem）
- 最大消息大小限制（默认 1MB）
