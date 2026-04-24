# Phase 4: 生产切换方案

Hermes ↔ OpenClaw WebSocket 通信升级 — 生产环境切换计划

## 概述

本方案描述如何从旧版**文件通道**安全切换到新版 **WebSocket 通道**，全程支持回滚。

核心策略：**双写过渡 → 观察验证 → 切读 → 切写 → 关闭旧通道**，每阶段都有明确的验证检查点和回滚触发条件。

---

## 架构对比

| | 旧通道（V1） | 新通道（V2） |
|---|---|---|
| 传输方式 | 文件轮询（JSON） | WebSocket 长连接 |
| 延迟 | 100-500ms | <10ms |
| 可靠性 | 依赖文件系统 | ACK + 重试 + 离线队列 |
| 监控 | 无 | /health + Prometheus |
| 运维 | 手动检查文件 | systemd 管理 + 自动重启 |

---

## 切换步骤

### 阶段 0: 准备（T-1 天）

**目标**：确保所有组件就绪，环境配置正确。

```
□ 1. 确认 WS Server（Phase 3）已部署并运行
     → curl http://127.0.0.1:8765/health
     → 返回 {"status":"ok","uptime":...}

□ 2. 确认 .env.production 配置正确
     → cat phase4/.env.production
     → 检查 WS_SERVER_URL、端口、超时等参数

□ 3. 执行历史数据迁移（dry-run）
     → cd phase4 && node migrate-v1-to-v2.js
     → 确认无报错，记录消息总数

□ 4. 备份当前系统状态
     → 记录当前通道: cat channel_state
     → 备份文件通道: cp /tmp/hermes-openclaw-chat/*.json /backup/
     → 备份 systemd 服务配置
```

### 阶段 1: 启用双写模式（T+0, 00:00）

**目标**：同时向文件通道和 WS 通道发送消息，验证 WS 通道可用性。

```bash
# 启用双写
export DUAL_WRITE=true
node phase4/dual-write-bridge.js &

# 验证双写生效
curl http://127.0.0.1:8081/health
# → 返回 "dualWrite": true, "wsConnected": true
```

**验证检查点**：
- [ ] dual-write-bridge 进程正常运行
- [ ] WS 连接已建立（wsConnected = true）
- [ ] 文件通道仍在写入（检查 /tmp/hermes-openclaw-chat/ 文件更新时间）
- [ ] /health 端点返回 200
- [ ] 发送 3 条测试消息，两端均收到

**观察时长**：30 分钟

**回滚触发条件**：
- WS 连接失败率 > 50%
- 文件通道写入失败
- dual-write-bridge 崩溃且 3 次重连失败

### 阶段 2: 观察期（T+0, 00:30 ~ T+0, 02:00）

**目标**：在双写模式下观察稳定性，积累 WS 通道成功数据。

**监控指标**：
```
□ WS 连接稳定性（无断连或断连 < 3 次）
□ 消息送达率 ≥ 99.9%
□ 端到端延迟 P99 < 200ms
□ dual-write-bridge 内存稳定（无泄漏）
□ 文件通道仍正常工作
```

**健康检查（每 5 分钟）**：
```bash
curl -s http://127.0.0.1:8081/health | python3 -m json.tool
# 关注: status, wsConnected, wsVerified, dualWrite
```

**回滚触发条件**：
- WS 延迟 P99 持续 > 500ms（健康检查阈值）
- 消息丢失 > 0.1%
- WS 断连后无法自动重连

### 阶段 3: 切读（T+0, 02:00）

**目标**：将读取端切换到 WS 通道，写入仍保持双写。

```bash
# 切换通道状态
echo "ws-read" > phase4/channel_state

# 验证读路径
# 1. 从 Hermes 发送消息 → OpenClaw 通过 WS 收到
# 2. 从 OpenClaw 发送消息 → Hermes 通过 WS 收到
```

**验证检查点**：
- [ ] 双向消息通过 WS 正常收发
- [ ] 文件通道仅作为备份（不再主动读取）
- [ ] 消息无乱序、无重复（ACK 机制验证）
- [ ] 延迟 < 50ms

**回滚触发条件**：
- WS 读取端出现消息乱序
- 消息重复率 > 1%
- WS 断连 > 2 分钟

### 阶段 4: 切写（T+0, 02:30）

**目标**：关闭双写，完全切换到 WS 通道。

```bash
# 关闭双写模式
export DUAL_WRITE=false

# 或修改 .env.production
sed -i 's/DUAL_WRITE=true/DUAL_WRITE=false/' phase4/.env.production

# 使用一键切换脚本（推荐）
bash phase4/switch-to-ws.sh

# 验证
curl http://127.0.0.1:8081/health
# → "status": "ws", "dualWrite": false
```

**验证检查点**：
- [ ] WS 通道独立工作（无文件通道依赖）
- [ ] 文件轮询 daemon 已停止（switch-to-ws.sh 自动处理）
- [ ] 发送 3 条测试消息，全部通过
- [ ] 通道状态: `cat phase4/channel_state` → "ws"

**回滚触发条件**：
- WS 通道发送失败
- 无法连接 WS Server
- 任何功能异常

### 阶段 5: 关闭旧通道（T+1 天）

**目标**：确认 WS 通道稳定运行 24 小时后，清理旧文件通道。

```bash
# 确认运行状态
systemctl status hermes-ws-client
curl http://127.0.0.1:8081/health

# 保留旧文件通道数据（不删除，仅归档）
mkdir -p /backup/hermes-file-channel-$(date +%Y%m%d)
cp /tmp/hermes-openclaw-chat/*.json /backup/hermes-file-channel-$(date +%Y%m%d)/

# 停止文件轮询 daemon
systemctl disable hermes-file-poll
systemctl stop hermes-file-poll
```

**验证检查点**：
- [ ] WS 通道 24 小时零故障
- [ ] 旧文件数据已归档
- [ ] 监控告警已配置（Phase 3）

---

## 时间线

```
T-1 天   准备阶段：环境检查、dry-run 迁移、备份
T+00:00  阶段 1：启用双写模式
T+00:30  阶段 2：观察期开始
T+02:00  阶段 3：切读（读路径切到 WS）
T+02:30  阶段 4：切写（关闭双写，纯 WS）
T+24:00  阶段 5：关闭旧通道（归档文件、停止 daemon）
```

总切换窗口：**约 2.5 小时**（不含观察期和归档）

---

## 回滚方案

### 自动回滚

`switch-to-ws.sh` 内置自动回滚机制：任何步骤失败时自动触发 `rollback()` 函数：
1. 停止 WS client
2. 恢复文件轮询 daemon
3. 恢复备份配置

### 手动回滚

```bash
# 一键回滚
bash phase4/rollback-to-file.sh

# 指定备份目录回滚
bash phase4/rollback-to-file.sh --latest-backup phase4/backups/20260418_220000/
```

### 回滚触发条件

| 条件 | 严重程度 | 动作 |
|---|---|---|
| WS 延迟 P99 > 500ms | 高 | 告警 + 准备回滚 |
| WS 断连 > 2 分钟 | 高 | 自动回滚 |
| 消息丢失 > 0.1% | 高 | 自动回滚 |
| dual-write-bridge 崩溃且 3 次重连失败 | 高 | 自动回滚 |
| WS Server 不可达 | 紧急 | 立即回滚 |
| 任何功能异常 | 中 | 评估后手动回滚 |

---

## 风险清单

| # | 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|---|
| R1 | WS Server 升级后不兼容 | 低 | 高 | 切换前在预发环境完整测试 |
| R2 | 双写模式消息重复 | 中 | 低 | v2 格式含 msg_id，客户端去重 |
| R3 | 网络闪断导致 WS 断连 | 中 | 中 | 自动重连 + 指数退避 + 文件通道兜底 |
| R4 | 历史消息迁移丢失 | 低 | 高 | dry-run 验证 + 源数据不删除 |
| R5 | systemd 服务启动失败 | 低 | 高 | 保留手动启动 fallback |
| R6 | 磁盘空间不足 | 低 | 中 | 前置检查磁盘使用率 |
| R7 | 回滚脚本执行失败 | 极低 | 高 | 回滚前验证备份完整性 |

---

## 前置检查清单

执行 `switch-to-ws.sh` 前，脚本自动检查以下项目：

1. ✅ WS Server 可达性（/health 端点）
2. ✅ WS Server 版本
3. ✅ 配置文件存在（.env.production）
4. ✅ 文件轮询 daemon 状态
5. ✅ 磁盘空间（> 90% 告警）

如需跳过前置检查（不推荐）：
```bash
bash phase4/switch-to-ws.sh --skip-checks
```

---

## 变更审批

| 角色 | 姓名 | 状态 |
|---|---|---|
| 申请人 | _待填_ | ⬜ |
| 审批人 | _待填_ | ⬜ |
| 执行人 | _待填_ | ⬜ |
| 复核人 | _待填_ | ⬜ |
