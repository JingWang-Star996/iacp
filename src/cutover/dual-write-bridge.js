#!/usr/bin/env node
/**
 * dual-write-bridge.js — 双写过渡桥接器
 *
 * 职责：
 * 1. 同时向旧文件通道和新 WS 通道发送消息
 * 2. 验证 WS 通道消息送达后，自动关闭文件通道
 * 3. WS 断线时自动切回文件通道
 * 4. 环境变量 DUAL_WRITE=true 控制是否启用双写
 *
 * 用法：
 *   DUAL_WRITE=true node dual-write-bridge.js
 *   DUAL_WRITE=false node dual-write-bridge.js   # 仅 WS 模式
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');

// ─── 配置 ───────────────────────────────────────────────

const CONFIG = {
  fileChannelPath: process.env.FILE_CHANNEL_PATH
    || '/tmp/hermes-openclaw-chat/openclaw_to_hermes.json',
  wsUrl: process.env.WS_SERVER_URL
    || 'ws://127.0.0.1:8765',
  clientId: process.env.WS_CLIENT_ID
    || 'hermes',
  reconnectMaxInterval: parseInt(process.env.WS_RECONNECT_MAX_INTERVAL || '30', 10),
  heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '25', 10),
  ackTimeout: parseInt(process.env.WS_ACK_TIMEOUT || '500', 10),
  maxRetries: parseInt(process.env.WS_MAX_RETRIES || '3', 10),
  dualWrite: process.env.DUAL_WRITE === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
};

// ─── 状态 ───────────────────────────────────────────────

let ws = null;
let wsConnected = false;
let wsVerified = false;         // WS 通道已验证消息送达
let wsRetryCount = 0;
let heartbeatTimer = null;
let fileChannelActive = true;   // 初始文件通道可用
let fileChannelVerifiedCount = 0; // 文件通道发送计数
let consecutiveWsSuccess = 0;   // WS 连续成功次数（达到阈值后关闭文件通道）
let reconnectTimer = null;

const WS_VERIFICATION_THRESHOLD = 5;  // 连续成功 5 次后关闭文件通道

// ─── 日志 ───────────────────────────────────────────────

function log(level, msg, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] >= levels[CONFIG.logLevel]) {
    const ts = new Date().toISOString();
    console.error(`[${ts}] [${level.toUpperCase()}] ${msg}`, ...args);
  }
}

// ─── 文件通道 ──────────────────────────────────────────

function writeFileChannel(message) {
  const dir = path.dirname(CONFIG.fileChannelPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload = {
    ...message,
    _channel: 'file',
    _writtenAt: Date.now(),
  };

  try {
    fs.writeFileSync(CONFIG.fileChannelPath, JSON.stringify(payload), 'utf8');
    log('debug', '📁 文件通道发送成功', { messageId: message.id });
    return true;
  } catch (err) {
    log('error', '📁 文件通道写入失败:', err.message);
    return false;
  }
}

// ─── WS 通道 ───────────────────────────────────────────

function createWsConnection() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return; // 已有活跃连接
  }

  log('info', `🔌 正在连接 WS: ${CONFIG.wsUrl}`);
  ws = new WebSocket(CONFIG.wsUrl, {
    handshakeTimeout: 10000,
  });

  ws.on('open', () => {
    log('info', '✅ WS 连接已建立');
    wsConnected = true;
    wsRetryCount = 0;
    consecutiveWsSuccess = 0;

    // 发送注册消息
    const registerMsg = JSON.stringify({
      type: 'register',
      clientId: CONFIG.clientId,
      timestamp: Date.now(),
    });
    ws.send(registerMsg);
    log('debug', '📤 已发送注册消息');

    startHeartbeat();
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ack' || msg.type === 'pong') {
        consecutiveWsSuccess++;
        if (!wsVerified && consecutiveWsSuccess >= WS_VERIFICATION_THRESHOLD) {
          wsVerified = true;
          log('info', '🎯 WS 通道已验证，连续成功', consecutiveWsSuccess, '次');
        }
        log('debug', '📥 收到 WS 响应:', msg.type);
      }
      if (msg.type === 'message') {
        // 转发收到的消息到文件通道（兼容旧端）
        if (CONFIG.dualWrite && fileChannelActive) {
          writeFileChannel(msg);
        }
        log('debug', '📥 收到 WS 消息', { id: msg.id });
      }
    } catch (err) {
      log('warn', '⚠️ WS 消息解析失败:', err.message);
    }
  });

  ws.on('error', (err) => {
    log('error', '❌ WS 错误:', err.message);
  });

  ws.on('close', (code, reason) => {
    log('warn', `🔌 WS 连接关闭 (code=${code}, reason=${reason || 'none'})`);
    wsConnected = false;
    wsVerified = false;
    consecutiveWsSuccess = 0;
    stopHeartbeat();

    // 自动回退到文件通道
    if (fileChannelActive) {
      log('warn', '🔄 自动回退到文件通道');
    } else {
      log('warn', '⚠️ 文件通道不可用，无法回退！');
    }

    scheduleReconnect();
  });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      log('debug', '💓 心跳已发送');
    }
  }, CONFIG.heartbeatInterval * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  if (wsRetryCount >= CONFIG.maxRetries) {
    log('error', `❌ WS 重试次数已达上限 (${CONFIG.maxRetries})，停止重连`);
    log('warn', '🔄 保持文件通道模式');
    return;
  }

  const delay = Math.min(
    CONFIG.reconnectMaxInterval * 1000,
    Math.pow(2, wsRetryCount) * 1000 + Math.random() * 1000
  );
  wsRetryCount++;

  log('info', `🔄 ${delay / 1000}s 后尝试第 ${wsRetryCount} 次重连...`);
  reconnectTimer = setTimeout(() => {
    createWsConnection();
  }, delay);
}

// ─── 发送接口 ──────────────────────────────────────────

/**
 * 发送消息。根据配置自动选择通道：
 * - DUAL_WRITE=true: 同时写入文件通道 + WS 通道
 * - WS 不可用时：仅写入文件通道
 */
function sendMessage(message) {
  const msgWithMeta = {
    ...message,
    _sentAt: Date.now(),
    _bridge: 'dual-write-v1',
  };

  let fileResult = false;
  let wsResult = false;

  // 文件通道写入
  if (CONFIG.dualWrite || !wsConnected) {
    fileResult = writeFileChannel(msgWithMeta);
    if (fileResult) {
      fileChannelVerifiedCount++;
    }
  }

  // WS 通道发送
  if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msgWithMeta));
      wsResult = true;
      log('debug', '📡 WS 通道发送成功', { messageId: message.id });
    } catch (err) {
      log('error', '📡 WS 通道发送失败:', err.message);
      wsResult = false;
    }
  }

  // 自动关闭文件通道条件：WS 已验证 + 双写模式 + 连续成功达到阈值
  if (CONFIG.dualWrite && wsVerified && consecutiveWsSuccess >= WS_VERIFICATION_THRESHOLD) {
    log('info', '🔒 WS 通道稳定，自动关闭文件通道写入');
    CONFIG.dualWrite = false;
  }

  return { file: fileResult, ws: wsResult };
}

// ─── 健康检查 ──────────────────────────────────────────

function getHealth() {
  return {
    status: wsConnected ? 'ws' : (fileChannelActive ? 'file' : 'degraded'),
    wsConnected,
    wsVerified,
    dualWrite: CONFIG.dualWrite,
    fileChannelActive,
    wsRetries: wsRetryCount,
    fileWrites: fileChannelVerifiedCount,
    uptime: process.uptime(),
  };
}

// ─── HTTP 健康端点（可选） ─────────────────────────────

function startHealthServer(port = 8081) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      const health = getHealth();
      const statusOk = health.status !== 'degraded';
      res.writeHead(statusOk ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
    } else if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...getHealth(),
        config: {
          wsUrl: CONFIG.wsUrl,
          clientId: CONFIG.clientId,
          dualWrite: CONFIG.dualWrite,
        },
      }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    log('info', `🩺 健康检查端点已启动: http://0.0.0.0:${port}/health`);
  });

  return server;
}

// ─── 优雅退出 ──────────────────────────────────────────

function gracefulShutdown() {
  log('info', '🛑 收到退出信号，正在关闭...');
  stopHeartbeat();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    ws.close(1000, 'Bridge shutdown');
  }
  process.exit(0);
}

// ─── 启动 ──────────────────────────────────────────────

function main() {
  log('info', '🚀 dual-write-bridge 启动', {
    dualWrite: CONFIG.dualWrite,
    wsUrl: CONFIG.wsUrl,
    fileChannel: CONFIG.fileChannelPath,
  });

  // 创建 WS 连接
  createWsConnection();

  // 启动健康检查端点
  const healthPort = parseInt(process.env.HEALTH_PORT || '8081', 10);
  startHealthServer(healthPort);

  // 优雅退出
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

// 导出供外部使用
module.exports = { sendMessage, getHealth, CONFIG };

// 直接运行时启动
if (require.main === module) {
  main();
}
