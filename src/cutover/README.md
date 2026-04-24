# Phase 4: 生产切换 — Hermes ↔ OpenClaw WS 升级

OpenClaw ↔ Hermes WebSocket 通信升级最终阶段：从文件通道平滑切换到 WebSocket 通道。

## 目标

| 目标 | 说明 |
|---|---|
| **零停机切换** | 通过双写过渡，确保切换期间消息不丢失 |
| **可回滚** | 任何阶段异常均可一键回滚到文件通道 |
| **可观测** | 健康检查端点 + 日志，随时掌握通道状态 |
| **历史数据迁移** | 将旧版文件消息转换为 WS v2 格式 |

## 架构

```
切换前（文件通道）                    切换后（WS 通道）
┌──────────┐          ┌──────────┐
│  Hermes  │ ─文件─►  │ OpenClaw │
│          │ ◄─文件── │          │
└──────────┘          └──────────┘

切换中（双写模式）                     切换完成
┌──────────┐     文件 + WS     ┌──────────┐
│  Hermes  │ ◄─────────────► │ OpenClaw │
│          │   (双写桥接器)     │          │
└──────────┘                  └──────────┘
                                ↓
                          ┌──────────┐
                          │  Hermes  │ ◄────WS────► │ OpenClaw │
                          └──────────┘              └──────────┘
                          （纯 WS，文件通道已关闭）
```

## 文件清单

| 文件 | 大小 | 说明 |
|---|---|---|
| `dual-write-bridge.js` | 10KB | 双写过渡桥接器，同时向文件+WS发送消息 |
| `switch-to-ws.sh` | 12KB | 一键切换到 WS 通道（含自动回滚） |
| `rollback-to-file.sh` | 7KB | 一键回滚到文件通道 |
| `migrate-v1-to-v2.js` | 10KB | 历史数据迁移脚本（文件 → WS v2） |
| `config.json` | 1.5KB | 生产切换配置（WS地址、超时、重试等） |
| `.env.production` | 2KB | 生产环境变量配置 |
| `cutover-plan.md` | 4.6KB | 详细切换方案（阶段/检查点/风险） |
| `README.md` | — | 本文件 |

## 前置依赖

- Phase 1: WS 基础通信（ws-server、ws-client）
- Phase 2: 可靠通信层（ACK、重试、离线队列）
- Phase 3: 监控与运维（健康检查、Prometheus、systemd）
- Node.js >= 16
- `ws` npm 包

```bash
cd projects/hermes-ws-upgrade
npm install ws
```

---

## 快速部署

### 1. 环境配置

```bash
cd phase4/

# 检查配置
cat .env.production

# 根据需要修改（WS Server 地址、端口等）
# WS_SERVER_URL=ws://127.0.0.1:8765
# DUAL_WRITE=false
```

### 2. 历史数据迁移（dry-run）

```bash
# 先 dry-run 查看统计
node migrate-v1-to-v2.js

# 确认无误后执行实际迁移
node migrate-v1-to-v2.js --apply

# 查看迁移结果
cat migrated-messages-v2.jsonl | wc -l
```

### 3. 启动双写桥接器

```bash
# 启用双写模式
export $(cat .env.production | grep -v '^#' | xargs)
DUAL_WRITE=true node dual-write-bridge.js &

# 检查状态
curl http://127.0.0.1:8081/health
# → {"status":"ws","wsConnected":true,"dualWrite":true,...}
```

### 4. 观察 30 分钟

```bash
# 每 5 分钟检查一次
watch -n 300 'curl -s http://127.0.0.1:8081/health'
```

### 5. 切换到 WS

```bash
# 使用一键切换脚本
bash switch-to-ws.sh

# 或使用 dry-run 预览
bash switch-to-ws.sh --dry-run
```

---

## 切换流程

完整切换分为 5 个阶段，详见 [`cutover-plan.md`](./cutover-plan.md)：

| 阶段 | 时间 | 操作 | 关键验证 |
|---|---|---|---|
| **0. 准备** | T-1 天 | 环境检查、dry-run 迁移、备份 | /health 返回 ok |
| **1. 双写** | T+00:00 | 启用 dual-write-bridge | wsConnected=true |
| **2. 观察** | T+00:30 | 监控 30 分钟 | 延迟 < 200ms |
| **3. 切读** | T+02:00 | 读路径切到 WS | 双向通信正常 |
| **4. 切写** | T+02:30 | 关闭双写，纯 WS | switch-to-ws.sh 完成 |
| **5. 收尾** | T+24h | 关闭文件通道、归档 | 24h 零故障 |

---

## 回滚流程

### 一键回滚

```bash
bash rollback-to-file.sh
```

回滚脚本自动执行：
1. 停止 WS client / dual-write-bridge
2. 恢复文件轮询 daemon
3. 从备份恢复配置
4. 验证文件通道正常

### 指定备份回滚

```bash
bash rollback-to-file.sh --latest-backup phase4/backups/20260418_220000/
```

### 回滚触发条件

| 条件 | 动作 |
|---|---|
| WS 延迟 > 500ms | 告警 + 准备回滚 |
| WS 断连 > 2 分钟 | 自动回滚 |
| 消息丢失 > 0.1% | 自动回滚 |
| switch-to-ws.sh 任何步骤失败 | 自动回滚 |

---

## 配置说明

### `.env.production`

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WS_SERVER_URL` | `ws://127.0.0.1:8765` | WS Server 地址 |
| `WS_CLIENT_ID` | `hermes` | 客户端标识 |
| `WS_RECONNECT_MAX_INTERVAL` | `30` | 最大重连间隔（秒） |
| `WS_HEARTBEAT_INTERVAL` | `25` | 心跳间隔（秒） |
| `WS_ACK_TIMEOUT` | `500` | ACK 超时（毫秒） |
| `WS_MAX_RETRIES` | `3` | 最大重试次数 |
| `DUAL_WRITE` | `false` | 双写模式开关 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `HEALTH_PORT` | `8081` | 健康检查端口 |
| `FILE_CHANNEL_PATH` | `/tmp/hermes-openclaw-chat/...` | 旧文件通道路径 |

### `config.json`

与 `.env.production` 对应的结构化配置，供脚本和程序读取。关键字段：

- `ws.server_url` — WS Server 地址
- `health_check.alert_threshold_ms` — 延迟告警阈值（默认 200ms）
- `health_check.rollback_threshold_ms` — 自动回滚阈值（默认 500ms）
- `dual_write.enabled` — 双写模式开关

---

## 健康检查

```bash
# 基本健康
curl http://127.0.0.1:8081/health
# → {"status":"ws","wsConnected":true,"wsVerified":false,"dualWrite":true,...}

# 详细状态
curl http://127.0.0.1:8081/status
# → 包含 config 信息

# status 字段含义：
#   "ws"       = WS 通道正常
#   "file"     = 文件通道兜底中
#   "degraded" = 两个通道都不可用（需立即处理）
```

---

## 常见问题

### Q1: dual-write-bridge 启动后 wsConnected 一直为 false？

检查 WS Server 是否运行：
```bash
curl http://127.0.0.1:8765/health
```
如果 WS Server 未启动，先启动 Phase 3 的服务器：
```bash
cd ../phase3
node ws-server-production.js &
```

### Q2: 切换后消息延迟高？

1. 检查网络：`ping 127.0.0.1`
2. 检查 WS Server 负载：`curl http://127.0.0.1:8765/metrics`
3. 检查 dual-write-bridge 日志：`cat switch-to-ws.log`
4. 如果延迟持续 > 500ms，触发回滚

### Q3: 回滚后发现消息丢失？

1. 检查备份目录：`ls phase4/backups/`
2. 检查文件通道：`cat /tmp/hermes-openclaw-chat/openclaw_to_hermes.json`
3. 如果文件通道有数据但轮询未读取，手动触发轮询
4. 运行迁移脚本恢复：`node migrate-v1-to-v2.js --apply`

### Q4: switch-to-ws.sh 执行失败？

1. 查看日志：`cat phase4/switch-to-ws.log`
2. 检查前置条件：`bash switch-to-ws.sh --dry-run`
3. 脚本会自动回滚，检查回滚日志：`cat phase4/rollback-to-file.log`

### Q5: 历史消息迁移很慢？

使用 `--batch-size` 调整批量大小：
```bash
node migrate-v1-to-v2.js --apply --batch-size 1000 --verbose
```

### Q6: 如何在 systemd 中管理？

```bash
# 注册 WS client 服务
sudo cp ../phase3/ws-server.service /etc/systemd/system/hermes-ws-client.service
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-ws-client

# 查看状态
sudo systemctl status hermes-ws-client
sudo journalctl -u hermes-ws-client -f
```

---

## 相关文档

- [Phase 1: WebSocket 基础通信](../phase1/README.md)
- [Phase 2: 可靠通信层](../phase2/README.md)
- [Phase 3: 监控与运维](../phase3/README.md)
- [详细切换方案](./cutover-plan.md)
