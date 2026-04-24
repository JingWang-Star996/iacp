#!/usr/bin/env bash
###############################################################################
# rollback-to-file.sh — 一键回滚到文件通道
#
# 步骤：
#   1. 停止 WS client
#   2. 恢复旧文件轮询
#   3. 恢复配置
#   4. 验证文件通道正常
#
# 用法：
#   bash rollback-to-file.sh [options]
#
# Options:
#   --latest-backup <dir>  指定备份目录（默认使用最新备份）
#   --skip-verify          跳过验证步骤
###############################################################################
set -euo pipefail

# ─── 颜色 ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC}  $*"; }

# ─── 配置 ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/backups"
LOG_FILE="${SCRIPT_DIR}/rollback-to-file.log"
HERMES_DAEMON_SERVICE="${HERMES_DAEMON_SERVICE:-hermes-ws-client}"
FILE_POLL_DAEMON="${FILE_POLL_DAEMON:-hermes-file-poll}"
FILE_CHANNEL_PATH="${FILE_CHANNEL_PATH:-/tmp/hermes-openclaw-chat/openclaw_to_hermes.json}"
SKIP_VERIFY=false

LATEST_BACKUP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest-backup) LATEST_BACKUP="$2"; shift 2 ;;
    --skip-verify)   SKIP_VERIFY=true; shift ;;
    *)               log_error "未知参数: $1"; exit 1 ;;
  esac
done

exec > >(tee -a "${LOG_FILE}") 2>&1

log_info "========================================="
log_info "  回滚到文件通道"
log_info "========================================="
log_info ""

# ─── 找到最新备份 ───────────────────────────────────────────────────────────
find_latest_backup() {
  if [[ -n "${LATEST_BACKUP}" ]]; then
    echo "${LATEST_BACKUP}"
    return
  fi

  if [[ -d "${BACKUP_DIR}" ]]; then
    local latest
    latest=$(ls -dt "${BACKUP_DIR}"/*/ 2>/dev/null | head -1)
    if [[ -n "${latest}" ]]; then
      echo "${latest}"
      return
    fi
  fi

  echo ""
}

# ─── 回滚步骤 ───────────────────────────────────────────────────────────────

step_stop_ws() {
  log_step "Step 1/4: 停止 WS client"

  # 停止 dual-write-bridge
  if [[ -f "${SCRIPT_DIR}/.ws-bridge.pid" ]]; then
    local pid
    pid=$(cat "${SCRIPT_DIR}/.ws-bridge.pid")
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}"
      sleep 1
      if kill -0 "${pid}" 2>/dev/null; then
        kill -9 "${pid}" 2>/dev/null || true
      fi
      log_info "✅ dual-write-bridge (PID: ${pid}) 已停止"
    fi
    rm -f "${SCRIPT_DIR}/.ws-bridge.pid"
  fi

  # 停止 systemd service
  if systemctl is-active --quiet "${HERMES_DAEMON_SERVICE}" 2>/dev/null; then
    systemctl stop "${HERMES_DAEMON_SERVICE}"
    log_info "✅ ${HERMES_DAEMON_SERVICE} 已停止"
  else
    log_info "✅ ${HERMES_DAEMON_SERVICE} 未运行"
  fi
}

step_restore_file_poll() {
  log_step "Step 2/4: 恢复旧文件轮询"

  # 确保文件通道目录存在
  mkdir -p "$(dirname "${FILE_CHANNEL_PATH}")"

  # 创建初始文件
  if [[ ! -f "${FILE_CHANNEL_PATH}" ]]; then
    echo '{"type":"init","channel":"file","timestamp":'$(date +%s%N | cut -b1-13)'}' > "${FILE_CHANNEL_PATH}"
    log_info "✅ 文件通道初始化完成"
  fi

  # 启动文件轮询 daemon
  if systemctl list-unit-files "${FILE_POLL_DAEMON}.service" &>/dev/null; then
    systemctl start "${FILE_POLL_DAEMON}"
    sleep 1
    if systemctl is-active --quiet "${FILE_POLL_DAEMON}" 2>/dev/null; then
      log_info "✅ 文件轮询 daemon 已启动"
    else
      log_error "文件轮询 daemon 启动失败"
      exit 1
    fi
  else
    log_warn "⚠️ 文件轮询 daemon service 不存在，需手动启动"
  fi
}

step_restore_config() {
  log_step "Step 3/4: 恢复配置"

  local backup
  backup=$(find_latest_backup)

  if [[ -z "${backup}" ]]; then
    log_warn "⚠️ 未找到备份目录，跳过配置恢复"
    log_warn "   请手动检查以下配置:"
    log_warn "   - DUAL_WRITE=false"
    log_warn "   - 通道模式: file"
    return 0
  fi

  log_info "使用备份: ${backup}"

  # 恢复 daemon 配置
  if [[ -f "${backup}${HERMES_DAEMON_SERVICE}.service" ]]; then
    cp "${backup}${HERMES_DAEMON_SERVICE}.service" "/etc/systemd/system/${HERMES_DAEMON_SERVICE}.service"
    systemctl daemon-reload
    log_info "✅ Daemon 配置已恢复"
  fi

  # 恢复环境配置
  if [[ -f "${backup}.env.production.bak" ]]; then
    cp "${backup}.env.production.bak" "${SCRIPT_DIR}/.env.production"
    log_info "✅ 环境配置已恢复"
  fi

  # 更新通道状态
  echo "file" > "${SCRIPT_DIR}/channel_state"
  log_info "✅ 通道状态已更新为: file"
}

step_verify() {
  if [[ "${SKIP_VERIFY}" == "true" ]]; then
    log_warn "跳过验证步骤"
    return 0
  fi

  log_step "Step 4/4: 验证文件通道正常"

  # 检查文件轮询 daemon
  if systemctl is-active --quiet "${FILE_POLL_DAEMON}" 2>/dev/null; then
    log_info "✅ 文件轮询 daemon 正在运行"
  else
    log_warn "⚠️ 文件轮询 daemon 未运行"
  fi

  # 检查文件通道可写
  local test_ts
  test_ts=$(date +%s%N | cut -b1-13)
  echo "{\"type\":\"verify\",\"timestamp\":${test_ts}}" > "${FILE_CHANNEL_PATH}"
  sleep 0.5

  if [[ -f "${FILE_CHANNEL_PATH}" ]]; then
    local content
    content=$(cat "${FILE_CHANNEL_PATH}")
    if echo "${content}" | grep -q '"timestamp"' 2>/dev/null; then
      log_info "✅ 文件通道写入验证通过"
    else
      log_warn "⚠️ 文件通道内容异常"
    fi
  fi

  # 确认 WS client 已停止
  if ! curl -sf --connect-timeout 3 http://127.0.0.1:8081/health >/dev/null 2>&1; then
    log_info "✅ WS client 已确认停止"
  else
    log_warn "⚠️ WS client 仍在运行，建议手动停止"
  fi
}

# ─── 主流程 ─────────────────────────────────────────────────────────────────

main() {
  step_stop_ws
  step_restore_file_poll
  step_restore_config
  step_verify

  echo ""
  log_info "========================================="
  log_info "  ✅ 回滚完成！"
  log_info "========================================="
  log_info "当前通道: 文件通道"
  log_info "日志文件: ${LOG_FILE}"
  log_info "========================================="
}

main "$@"
