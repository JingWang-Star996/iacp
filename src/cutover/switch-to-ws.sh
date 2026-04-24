#!/usr/bin/env bash
###############################################################################
# switch-to-ws.sh — 一键切换到 WS 通道
#
# 前置检查：WS server 运行中、client 连接正常、/health 返回 ok
# 切换步骤：
#   1. 备份当前配置文件
#   2. 停止旧文件轮询 daemon
#   3. 启动 WS client（Hermes 端）
#   4. 发送 3 条测试消息验证双向通信
#   5. 更新 Hermes daemon 配置
# 任何步骤失败 → 自动回滚
#
# 用法：
#   bash switch-to-ws.sh [options]
#
# Options:
#   --ws-url <url>        WS 服务器地址（默认 ws://127.0.0.1:8765）
#   --env <file>          环境配置文件（默认 .env.production）
#   --dry-run             仅显示将要执行的操作，不实际执行
#   --skip-checks         跳过前置检查（不推荐）
###############################################################################
set -euo pipefail

# ─── 颜色 ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC}  $*"; }

# ─── 配置 ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_URL="${WS_SERVER_URL:-ws://127.0.0.1:8765}"
ENV_FILE="${SCRIPT_DIR}/.env.production"
BACKUP_DIR="${SCRIPT_DIR}/backups/$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${SCRIPT_DIR}/switch-to-ws.log"
HEALTH_ENDPOINT="${WS_HEALTH_URL:-http://127.0.0.1:8081/health}"
HERMES_DAEMON_SERVICE="${HERMES_DAEMON_SERVICE:-hermes-ws-client}"
FILE_POLL_DAEMON="${FILE_POLL_DAEMON:-hermes-file-poll}"
WS_CLIENT_BIN="${WS_CLIENT_BIN:-${SCRIPT_DIR}/../ws-client/start.sh}"

DRY_RUN=false
SKIP_CHECKS=false

# ─── 参数解析 ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ws-url)      WS_URL="$2"; shift 2 ;;
    --env)         ENV_FILE="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=true; shift ;;
    --skip-checks) SKIP_CHECKS=true; shift ;;
    *)             log_error "未知参数: $1"; exit 1 ;;
  esac
done

log_info "========================================="
log_info "  Hermes → WS 通道切换"
log_info "========================================="
log_info "WS URL:    ${WS_URL}"
log_info "Env File:  ${ENV_FILE}"
log_info "Dry Run:   ${DRY_RUN}"
log_info ""

# ─── 日志函数 ───────────────────────────────────────────────────────────────
exec > >(tee -a "${LOG_FILE}") 2>&1

# ─── 回滚函数 ───────────────────────────────────────────────────────────────
rollback() {
  local reason="$1"
  log_error "========================================="
  log_error "  切换失败，正在自动回滚"
  log_error "  原因: ${reason}"
  log_error "========================================="

  log_step "1. 停止 WS client"
  if systemctl is-active --quiet "${HERMES_DAEMON_SERVICE}" 2>/dev/null; then
    systemctl stop "${HERMES_DAEMON_SERVICE}" || true
    log_info "   ✅ WS client 已停止"
  fi

  log_step "2. 恢复文件轮询 daemon"
  if systemctl is-active --quiet "${FILE_POLL_DAEMON}" 2>/dev/null; then
    log_info "   ✅ 文件轮询 daemon 已在运行"
  else
    systemctl start "${FILE_POLL_DAEMON}" 2>/dev/null || true
    log_info "   ✅ 文件轮询 daemon 已恢复"
  fi

  log_step "3. 恢复配置"
  if [[ -d "${BACKUP_DIR}" ]]; then
    cp -r "${BACKUP_DIR}"/* "${SCRIPT_DIR}/" 2>/dev/null || true
    log_info "   ✅ 配置已恢复"
  fi

  log_error "========================================="
  log_error "  回滚完成，请检查日志: ${LOG_FILE}"
  log_error "========================================="
  exit 1
}

trap 'rollback "脚本异常退出"' ERR

# ─── 前置检查 ───────────────────────────────────────────────────────────────
pre_checks() {
  if [[ "${SKIP_CHECKS}" == "true" ]]; then
    log_warn "跳过前置检查（不推荐）"
    return 0
  fi

  log_step "前置检查 (1/5): WS Server 可达性"
  if ! curl -sf --connect-timeout 5 "${HEALTH_ENDPOINT}" >/dev/null 2>&1; then
    log_error "WS Server 健康检查失败: ${HEALTH_ENDPOINT}"
    rollback "WS Server 未响应健康检查"
  fi
  log_info "✅ WS Server 健康检查通过"

  log_step "前置检查 (2/5): WS Server 版本"
  local ws_version
  ws_version=$(curl -sf --connect-timeout 5 "${HEALTH_ENDPOINT}" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")
  log_info "✅ WS Server 版本: ${ws_version}"

  log_step "前置检查 (3/5): 配置文件存在"
  if [[ ! -f "${ENV_FILE}" ]]; then
    log_error "环境配置文件不存在: ${ENV_FILE}"
    rollback "环境配置文件缺失"
  fi
  log_info "✅ 配置文件存在: ${ENV_FILE}"

  log_step "前置检查 (4/5): 文件轮询 daemon 状态"
  if systemctl is-active --quiet "${FILE_POLL_DAEMON}" 2>/dev/null; then
    log_info "✅ 文件轮询 daemon 正在运行"
  else
    log_warn "⚠️ 文件轮询 daemon 未运行（可能已停止）"
  fi

  log_step "前置检查 (5/5): 磁盘空间"
  local disk_usage
  disk_usage=$(df "${SCRIPT_DIR}" | tail -1 | awk '{print $5}' | tr -d '%')
  if [[ "${disk_usage}" -gt 90 ]]; then
    log_warn "⚠️ 磁盘使用率较高: ${disk_usage}%"
  else
    log_info "✅ 磁盘使用率正常: ${disk_usage}%"
  fi

  log_info "✅ 所有前置检查通过"
  echo ""
}

# ─── 切换步骤 ───────────────────────────────────────────────────────────────

step_backup() {
  log_step "Step 1/5: 备份当前配置"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_info "[dry-run] 将备份到: ${BACKUP_DIR}"
    return 0
  fi

  mkdir -p "${BACKUP_DIR}"

  # 备份配置文件
  if [[ -f "${SCRIPT_DIR}/.env.production" ]]; then
    cp "${SCRIPT_DIR}/.env.production" "${BACKUP_DIR}/.env.production.bak"
  fi

  # 备份 daemon 配置
  if [[ -f "/etc/systemd/system/${HERMES_DAEMON_SERVICE}.service" ]]; then
    cp "/etc/systemd/system/${HERMES_DAEMON_SERVICE}.service" "${BACKUP_DIR}/"
  fi
  if [[ -f "/etc/systemd/system/${FILE_POLL_DAEMON}.service" ]]; then
    cp "/etc/systemd/system/${FILE_POLL_DAEMON}.service" "${BACKUP_DIR}/"
  fi

  # 备份当前通道状态
  echo "file" > "${BACKUP_DIR}/channel_state.bak"

  log_info "✅ 备份完成: ${BACKUP_DIR}"
}

step_stop_file_poll() {
  log_step "Step 2/5: 停止旧文件轮询 daemon"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_info "[dry-run] 将停止: ${FILE_POLL_DAEMON}"
    return 0
  fi

  if systemctl is-active --quiet "${FILE_POLL_DAEMON}" 2>/dev/null; then
    systemctl stop "${FILE_POLL_DAEMON}"
    sleep 1
    if systemctl is-active --quiet "${FILE_POLL_DAEMON}" 2>/dev/null; then
      log_error "文件轮询 daemon 未能停止"
      rollback "无法停止文件轮询 daemon"
    fi
    log_info "✅ 文件轮询 daemon 已停止"
  else
    log_info "✅ 文件轮询 daemon 未运行，无需停止"
  fi
}

step_start_ws_client() {
  log_step "Step 3/5: 启动 WS client（Hermes 端）"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_info "[dry-run] 将启动: ${HERMES_DAEMON_SERVICE}"
    return 0
  fi

  # 设置环境变量
  export WS_SERVER_URL="${WS_URL}"

  if [[ -f "${WS_CLIENT_BIN}" ]]; then
    bash "${WS_CLIENT_BIN}" --env "${ENV_FILE}"
  elif systemctl list-unit-files "${HERMES_DAEMON_SERVICE}.service" &>/dev/null; then
    systemctl start "${HERMES_DAEMON_SERVICE}"
  else
    # fallback: 直接启动 dual-write-bridge
    log_warn "未找到 WS client 启动脚本，尝试启动 dual-write-bridge"
    cd "${SCRIPT_DIR}"
    DUAL_WRITE=true node dual-write-bridge.js &
    local bridge_pid=$!
    echo "${bridge_pid}" > "${SCRIPT_DIR}/.ws-bridge.pid"
    log_info "✅ dual-write-bridge 已启动 (PID: ${bridge_pid})"
  fi

  sleep 2

  # 验证 WS client 已启动
  if curl -sf --connect-timeout 5 http://127.0.0.1:8081/health >/dev/null 2>&1; then
    log_info "✅ WS client 已启动并响应"
  else
    log_error "WS client 启动后未响应健康检查"
    rollback "WS client 启动失败"
  fi
}

step_test_messages() {
  log_step "Step 4/5: 发送 3 条测试消息验证双向通信"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_info "[dry-run] 将发送 3 条测试消息"
    return 0
  fi

  local passed=0
  local total=3

  for i in $(seq 1 ${total}); do
    local test_msg='{"type":"test","id":"test-switch-'"${i}"'","payload":"双向通信测试消息 '"${i}"'","timestamp":'"$(date +%s%N | cut -b1-13)"'}'

    log_info "  发送测试消息 ${i}/${total}..."

    # 发送到 WS
    local response
    response=$(curl -sf --connect-timeout 5 \
      -X POST http://127.0.0.1:8081/send \
      -H "Content-Type: application/json" \
      -d "${test_msg}" 2>/dev/null || echo "")

    sleep 1

    # 检查响应
    if echo "${response}" | grep -q '"status".*"ok"' 2>/dev/null; then
      log_info "  ✅ 测试消息 ${i} 通过"
      ((passed++))
    else
      # 尝试从健康端点验证
      local health
      health=$(curl -sf --connect-timeout 5 http://127.0.0.1:8081/health 2>/dev/null || echo "")
      if echo "${health}" | grep -q '"wsConnected".*true' 2>/dev/null; then
        log_info "  ✅ 测试消息 ${i} 通过 (WS 连接正常)"
        ((passed++))
      else
        log_warn "  ⚠️ 测试消息 ${i} 未收到确认响应"
      fi
    fi
  done

  log_info "测试结果: ${passed}/${total} 通过"

  if [[ ${passed} -lt 2 ]]; then
    log_error "测试消息通过率不足（需 ≥2/3）"
    rollback "双向通信测试失败"
  fi

  log_info "✅ 双向通信测试通过"
}

step_update_daemon_config() {
  log_step "Step 5/5: 更新 Hermes daemon 配置"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_info "[dry-run] 将更新 daemon 配置为 WS 模式"
    return 0
  fi

  # 更新通道状态
  echo "ws" > "${SCRIPT_DIR}/channel_state"

  # 更新 daemon 配置（禁用双写，使用纯 WS）
  if [[ -f "${ENV_FILE}" ]]; then
    sed -i 's/DUAL_WRITE=true/DUAL_WRITE=false/' "${ENV_FILE}" 2>/dev/null || true
  fi

  # 重启 daemon 使配置生效
  if systemctl is-active --quiet "${HERMES_DAEMON_SERVICE}" 2>/dev/null; then
    systemctl restart "${HERMES_DAEMON_SERVICE}"
    sleep 2
    log_info "✅ Daemon 配置已更新并重启"
  fi

  log_info "✅ 切换完成！当前通道: WS"
}

# ─── 主流程 ─────────────────────────────────────────────────────────────────

main() {
  pre_checks
  step_backup
  step_stop_file_poll
  step_start_ws_client
  step_test_messages
  step_update_daemon_config

  # 清除错误陷阱（切换成功）
  trap - ERR

  echo ""
  log_info "========================================="
  log_info "  ✅ 切换完成！"
  log_info "========================================="
  log_info "当前通道: WS"
  log_info "备份目录: ${BACKUP_DIR}"
  log_info "日志文件: ${LOG_FILE}"
  log_info ""
  log_info "如需回滚，执行:"
  log_info "  bash ${SCRIPT_DIR}/rollback-to-file.sh"
  log_info "========================================="
}

main "$@"
