#!/usr/bin/env node
/**
 * migrate-v1-to-v2.js — 历史数据迁移脚本（文件通道 → WS v2 格式）
 *
 * 功能：
 * 1. 读取旧版文件通道的所有历史消息（JSON / JSONL 格式）
 * 2. 转换为 WS v2 格式（含 seq、ack、timestamp 等元数据）
 * 3. 输出迁移报告（总数/成功/失败/耗时）
 * 4. 支持 --dry-run 模式（只统计，不写入）
 *
 * v1 格式（文件通道）：
 *   { "type": "...", "from": "...", "content": "...", "msg_id": "...", "timestamp": "..." }
 *   或 JSONL：每行一条消息
 *
 * v2 格式（WS）：
 *   { "type": "...", "from": "...", "content": "...",
 *     "msg_id": "...", "seq": <number>,
 *     "timestamp": <ms>, "createdAt": <ms>,
 *     "_channel": "ws-v2", "_bridge": "migrate-v1-to-v2" }
 *
 * 用法：
 *   node migrate-v1-to-v2.js                          # dry-run 模式
 *   node migrate-v1-to-v2.js --apply                  # 实际写入
 *   node migrate-v1-to-v2.js --source /path/to/dir    # 自定义源目录
 *   node migrate-v1-to-v2.js --apply --seq-start 100  # 从 seq=100 开始
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── 默认配置 ─────────────────────────────────────────────

const DEFAULT_SOURCE_DIR = '/tmp/hermes-openclaw-chat';
const DEFAULT_SOURCE_FILE = 'openclaw_to_hermes.json';
const DEFAULT_OUTPUT_FILE = './migrated-messages-v2.jsonl';

// ─── 参数解析 ─────────────────────────────────────────────

function parseArgs() {
  const args = {
    dryRun: true,
    sourceDir: DEFAULT_SOURCE_DIR,
    sourceFile: DEFAULT_SOURCE_FILE,
    outputFile: DEFAULT_OUTPUT_FILE,
    seqStart: 1,
    batchSize: 500,
    verbose: false,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    switch (arg) {
      case '--apply':
        args.dryRun = false;
        break;
      case '--source':
        args.sourceDir = process.argv[++i] || DEFAULT_SOURCE_DIR;
        break;
      case '--output':
        args.outputFile = process.argv[++i] || DEFAULT_OUTPUT_FILE;
        break;
      case '--seq-start':
        args.seqStart = parseInt(process.argv[++i] || '1', 10);
        break;
      case '--batch-size':
        args.batchSize = parseInt(process.argv[++i] || '500', 10);
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`⚠️  未知参数: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  return args;
}

function printHelp() {
  console.log(`
用法: node migrate-v1-to-v2.js [options]

Options:
  --apply              实际执行迁移（默认 dry-run）
  --source <dir>       源目录（默认: ${DEFAULT_SOURCE_DIR}）
  --output <file>      输出文件（默认: ${DEFAULT_OUTPUT_FILE}）
  --seq-start <n>      起始序列号（默认: 1）
  --batch-size <n>     批量处理大小（默认: 500）
  --verbose            详细日志输出
  --help, -h           显示帮助
`);
}

// ─── 日志 ─────────────────────────────────────────────────

function log(msg, ...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${msg}`, ...args);
}

function logVerbose(msg, ...args) {
  if (parseArgs().verbose) {
    log(`  ${msg}`, ...args);
  }
}

// ─── 消息读取 ─────────────────────────────────────────────

/**
 * 读取源目录中的所有消息文件。
 * 支持两种格式：
 * 1. JSONL（每行一条消息）
 * 2. 单个 JSON 文件
 */
function readSourceMessages(sourceDir, sourceFile) {
  const messages = [];
  const sourcePath = path.join(sourceDir, sourceFile);

  if (!fs.existsSync(sourceDir)) {
    log(`⚠️  源目录不存在: ${sourceDir}`);
    return messages;
  }

  // 尝试读取指定文件
  if (fs.existsSync(sourcePath)) {
    const content = fs.readFileSync(sourcePath, 'utf8').trim();
    if (!content) return messages;

    // 尝试 JSONL 格式（每行一条 JSON）
    const lines = content.split('\n').filter(l => l.trim());
    let parsedAsJsonl = false;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line.trim());
        messages.push(msg);
        parsedAsJsonl = true;
      } catch (e) {
        // 如果不是 JSONL，尝试整体解析为 JSON
        if (!parsedAsJsonl && lines.length === 1) {
          try {
            const msg = JSON.parse(content);
            // 如果是数组
            if (Array.isArray(msg)) {
              messages.push(...msg);
            } else {
              messages.push(msg);
            }
            parsedAsJsonl = true;
          } catch (e2) {
            log(`⚠️  解析失败: ${sourcePath}`, e2.message);
          }
        }
        break;
      }
    }

    if (parsedAsJsonl) {
      log(`📂 从 ${sourcePath} 读取 ${messages.length} 条消息`);
      return messages;
    }
  }

  // 扫描目录下所有 JSON 文件
  log(`📂 扫描目录: ${sourceDir}`);
  const files = fs.readdirSync(sourceDir)
    .filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
    .sort();

  for (const file of files) {
    const filePath = path.join(sourceDir, file);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) continue;

    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line.trim()));
      } catch (e) {
        log(`⚠️  跳过无效行 (${file}): ${e.message}`);
      }
    }
  }

  log(`📂 共读取 ${messages.length} 条消息（${files.length} 个文件）`);
  return messages;
}

// ─── 消息转换 ─────────────────────────────────────────────

/**
 * 将 v1 消息转换为 WS v2 格式。
 */
function convertToV2(msg, seq) {
  // 解析时间戳
  let createdAt = Date.now();
  if (msg.timestamp) {
    if (typeof msg.timestamp === 'number') {
      createdAt = msg.timestamp;
    } else if (typeof msg.timestamp === 'string') {
      const parsed = Date.parse(msg.timestamp);
      if (!isNaN(parsed)) createdAt = parsed;
    }
  }

  const v2Msg = {
    // 保留原始字段
    type: msg.type || 'text',
    from: msg.from || 'unknown',
    content: msg.content || '',
    msg_id: msg.msg_id || msg.messageId || msg.id || `migrated-${Date.now()}-${seq}`,

    // v2 新增字段
    seq: seq,
    timestamp: createdAt,
    createdAt: createdAt,

    // 通道元数据
    _channel: 'ws-v2',
    _bridge: 'migrate-v1-to-v2',
    _migrated: true,
    _migratedAt: Date.now(),
  };

  // 保留其他自定义字段
  for (const [key, value] of Object.entries(msg)) {
    if (!v2Msg.hasOwnProperty(key)) {
      v2Msg[key] = value;
    }
  }

  return v2Msg;
}

// ─── 迁移执行 ─────────────────────────────────────────────

function runMigration(args) {
  const startTime = Date.now();

  log('═══════════════════════════════════════');
  log('  Hermes 消息迁移 v1 → v2');
  log('═══════════════════════════════════════');
  log(`模式:      ${args.dryRun ? '🔍 Dry Run（仅统计）' : '🚀 实际迁移'}`);
  log(`源目录:    ${args.sourceDir}`);
  log(`输出文件:  ${args.outputFile}`);
  log(`起始序列:  ${args.seqStart}`);
  log('');

  // 1. 读取源消息
  log('📥 步骤 1/3: 读取历史消息...');
  const sourceMessages = readSourceMessages(args.sourceDir, args.sourceFile);

  if (sourceMessages.length === 0) {
    log('⚠️  没有找到历史消息，迁移结束');
    printReport({ total: 0, success: 0, failed: 0, errors: [], duration: Date.now() - startTime });
    return;
  }

  // 2. 转换消息
  log('🔄 步骤 2/3: 转换为 WS v2 格式...');
  const converted = [];
  const errors = [];
  let seq = args.seqStart;

  for (let i = 0; i < sourceMessages.length; i++) {
    const msg = sourceMessages[i];
    try {
      const v2Msg = convertToV2(msg, seq);
      converted.push(v2Msg);
      seq++;

      if (args.verbose && (i + 1) % 100 === 0) {
        log(`  已转换 ${i + 1}/${sourceMessages.length} 条`);
      }
    } catch (err) {
      errors.push({
        index: i,
        msgId: msg.msg_id || msg.messageId || msg.id || `unknown-${i}`,
        error: err.message,
      });
      log(`⚠️  转换失败 [${i}]: ${err.message}`);
    }
  }

  log(`✅ 转换完成: ${converted.length} 成功, ${errors.length} 失败`);

  // 3. 写入输出（非 dry-run）
  if (!args.dryRun) {
    log('💾 步骤 3/3: 写入迁移结果...');

    const outputDir = path.dirname(args.outputFile);
    if (outputDir && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 以 JSONL 格式写入
    const lines = converted.map(m => JSON.stringify(m));
    fs.writeFileSync(args.outputFile, lines.join('\n') + '\n', 'utf8');

    log(`✅ 已写入 ${converted.length} 条消息到 ${args.outputFile}`);

    // 同时写入一个 summary JSON
    const summaryPath = args.outputFile.replace(/\.jsonl$/, '-summary.json');
    const summary = {
      migratedAt: new Date().toISOString(),
      totalSource: sourceMessages.length,
      totalConverted: converted.length,
      totalErrors: errors.length,
      seqRange: { start: args.seqStart, end: seq - 1 },
      outputFile: args.outputFile,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    log(`✅ 摘要已写入 ${summaryPath}`);
  } else {
    log('💾 [dry-run] 跳过写入步骤');
  }

  // 打印报告
  const duration = Date.now() - startTime;
  printReport({
    total: sourceMessages.length,
    success: converted.length,
    failed: errors.length,
    errors,
    duration,
    outputLines: args.dryRun ? 0 : lines.length,
  });
}

// ─── 报告 ─────────────────────────────────────────────────

function printReport(report) {
  const { total, success, failed, errors, duration } = report;

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  迁移报告');
  console.log('═══════════════════════════════════════');
  console.log(`  总消息数:    ${total}`);
  console.log(`  成功转换:    ${success}`);
  console.log(`  转换失败:    ${failed}`);
  console.log(`  成功率:      ${total > 0 ? ((success / total) * 100).toFixed(1) : 0}%`);
  console.log(`  总耗时:      ${duration}ms (${(duration / 1000).toFixed(2)}s)`);
  if (total > 0) {
    console.log(`  吞吐:        ${((success / (duration / 1000))).toFixed(0)} 条/秒`);
  }
  console.log('═══════════════════════════════════════');

  if (errors.length > 0 && errors.length <= 20) {
    console.log('');
    console.log('失败详情:');
    for (const err of errors) {
      console.log(`  [${err.index}] msgId=${err.msgId}: ${err.error}`);
    }
  } else if (errors.length > 20) {
    console.log(`\n失败详情（显示前 20 条，共 ${errors.length} 条）:`);
    for (const err of errors.slice(0, 20)) {
      console.log(`  [${err.index}] msgId=${err.msgId}: ${err.error}`);
    }
  }

  if (failed > 0) {
    console.log('');
    console.log('⚠️  存在失败消息，建议检查后重新迁移');
    process.exit(1);
  } else if (total === 0) {
    console.log('');
    console.log('ℹ️  没有可迁移的消息');
  } else {
    console.log('');
    console.log('✅ 迁移完成！');
  }
}

// ─── 入口 ─────────────────────────────────────────────────

const args = parseArgs();
runMigration(args);
