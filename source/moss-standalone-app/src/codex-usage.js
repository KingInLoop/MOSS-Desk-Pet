'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveCodexHome } = require('./codex-monitor');

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function sevenDaySeries(buckets = [], now = new Date()) {
  const totals = new Map();
  for (const bucket of buckets) {
    const key = dateKey(bucket?.startDate || bucket?.date);
    const tokens = Number(bucket?.tokens);
    if (key && Number.isFinite(tokens)) totals.set(key, (totals.get(key) || 0) + Math.max(0, tokens));
  }
  const result = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cursor.setUTCDate(cursor.getUTCDate() - 6);
  for (let index = 0; index < 7; index += 1) {
    const key = dateKey(cursor);
    result.push({ date: key, tokens: Math.round(totals.get(key) || 0) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '额度';
  if (minutes <= 24 * 60) return minutes === 24 * 60 ? '每日额度' : `${Math.round(minutes / 60)} 小时额度`;
  if (minutes >= 7 * 24 * 60 && minutes < 8 * 24 * 60) return '每周额度';
  return `${Math.round(minutes / (24 * 60))} 天额度`;
}

function normalizeLimits(rateLimits = {}) {
  const buckets = rateLimits.rateLimitsByLimitId || rateLimits.rate_limits_by_limit_id || {};
  const entries = Object.entries(buckets);
  if (!entries.length && (rateLimits.primary || rateLimits.secondary)) entries.push(['codex', rateLimits]);
  const limits = [];
  for (const [id, bucket] of entries) {
    for (const [slot, value] of [['primary', bucket?.primary], ['secondary', bucket?.secondary]]) {
      if (!value) continue;
      const used = Math.max(0, Math.min(100, Number(value.usedPercent ?? value.used_percent) || 0));
      const duration = Number(value.windowDurationMins ?? value.window_duration_mins);
      const name = bucket.limitName || bucket.limit_name || (id === 'codex' ? 'Codex' : id);
      limits.push({
        id: `${id}:${slot}`,
        name,
        label: `${name} · ${windowLabel(duration)}`,
        usedPercent: used,
        remainingPercent: Math.max(0, 100 - used),
        windowDurationMins: Number.isFinite(duration) ? duration : null,
        resetsAt: Number(value.resetsAt ?? value.resets_at) || null
      });
    }
  }
  return limits.sort((left, right) => {
    const leftRank = left.id.startsWith('codex:') ? 0 : 1;
    const rightRank = right.id.startsWith('codex:') ? 0 : 1;
    return leftRank - rightRank || (right.windowDurationMins || 0) - (left.windowDurationMins || 0);
  });
}

function normalizeUsage(rateLimits, usage, now = new Date()) {
  const limits = normalizeLimits(rateLimits);
  const firstBucket = Object.values(rateLimits?.rateLimitsByLimitId || rateLimits?.rate_limits_by_limit_id || {})[0];
  const planType = rateLimits?.planType || rateLimits?.plan_type || firstBucket?.planType || firstBucket?.plan_type || usage?.planType || usage?.plan_type || null;
  const dailyBuckets = usage?.dailyUsageBuckets || usage?.daily_usage_buckets || [];
  return {
    status: limits.length ? 'ok' : 'unavailable', source: 'app-server', updatedAt: now.toISOString(), planType,
    limits, dailyUsage: sevenDaySeries(dailyBuckets, now),
    message: limits.length ? null : '当前登录方式未提供套餐额度'
  };
}

function executableCandidates(environment = process.env, platform = process.platform, home = os.homedir()) {
  const explicit = [environment.CODEX_CLI_PATH, environment.CODEX_PATH].filter(Boolean);
  const names = platform === 'win32' ? ['codex.exe', 'codex'] : ['codex'];
  const common = platform === 'darwin' ? [
    '/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex',
    path.join(home, 'Applications/ChatGPT.app/Contents/Resources/codex'), path.join(home, 'Applications/Codex.app/Contents/Resources/codex')
  ] : platform === 'win32' ? [
    path.join(environment.LOCALAPPDATA || '', 'Programs', 'ChatGPT', 'resources', 'codex.exe'),
    path.join(environment.LOCALAPPDATA || '', 'Programs', 'Codex', 'resources', 'codex.exe')
  ] : [];
  return [...new Set([...explicit, ...common, ...names].filter(Boolean))];
}

function resolveExecutable() {
  for (const candidate of executableCandidates()) {
    if (!candidate.includes(path.sep) || fs.existsSync(candidate)) return candidate;
  }
  const extensionRoots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions')
  ];
  for (const root of extensionRoots) {
    try {
      const extensions = fs.readdirSync(root).filter((name) => /openai|chatgpt|codex/i.test(name)).sort().reverse();
      for (const extension of extensions) {
        const base = path.join(root, extension);
        const matches = [];
        walkExecutables(base, 0, matches);
        if (matches.length) return matches[0];
      }
    } catch { /* VS Code or its Codex extension is not installed here. */ }
  }
  return null;
}

function walkExecutables(directory, depth, output) {
  if (depth > 4 || output.length) return;
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walkExecutables(target, depth + 1, output);
    else if (entry.isFile() && /^codex(?:\.exe)?$/i.test(entry.name)) { output.push(target); return; }
  }
}

function appServerRead(executable, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const responses = new Map();
    let buffer = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve({ rateLimits: responses.get(2), usage: responses.get(3) });
    };
    const timer = setTimeout(() => finish(new Error('读取额度超时')), timeoutMs);
    child.once('error', (error) => finish(error));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
            child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: {} })}\n`);
            child.stdin.write(`${JSON.stringify({ id: 3, method: 'account/usage/read', params: {} })}\n`);
          } else if (message.id === 2 || message.id === 3) {
            if (message.error) return finish(new Error(message.error.message || 'Codex 额度服务不可用'));
            responses.set(message.id, message.result || {});
            if (responses.has(2) && responses.has(3)) finish();
          }
        } catch { /* Ignore non-JSON diagnostics. */ }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'moss-desk-pet', version: '1.3.8' }, capabilities: {} } })}\n`);
  });
}

function walkJsonl(directory, depth = 0, output = []) {
  if (depth > 5) return output;
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walkJsonl(target, depth + 1, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(target);
  }
  return output;
}

function localDailyUsage(now = new Date()) {
  const cutoff = now.getTime() - 8 * 24 * 60 * 60 * 1000;
  const buckets = [];
  for (const file of walkJsonl(path.join(resolveCodexHome(), 'sessions'))) {
    try {
      if (fs.statSync(file).mtimeMs < cutoff) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('token_count')) continue;
        const record = JSON.parse(line);
        const tokens = Number(record?.payload?.info?.last_token_usage?.total_tokens);
        if (record?.type === 'event_msg' && record.payload?.type === 'token_count' && tokens > 0) {
          buckets.push({ startDate: record.timestamp, tokens });
        }
      }
    } catch { /* Live JSONL files can end in a partial line. */ }
  }
  return sevenDaySeries(buckets, now);
}

async function readCodexUsage(now = new Date()) {
  const executable = resolveExecutable();
  if (executable) {
    try {
      const { rateLimits, usage } = await appServerRead(executable);
      return normalizeUsage(rateLimits, usage, now);
    } catch (error) {
      return { status: 'unavailable', source: 'local', updatedAt: now.toISOString(), planType: null, limits: [], dailyUsage: localDailyUsage(now), message: `官方额度暂不可用：${error.message}` };
    }
  }
  return { status: 'unavailable', source: 'local', updatedAt: now.toISOString(), planType: null, limits: [], dailyUsage: localDailyUsage(now), message: '未找到 Codex 客户端或命令行程序' };
}

class CodexUsageMonitor {
  constructor(callback, intervalMs = REFRESH_INTERVAL_MS) { this.callback = callback; this.intervalMs = intervalMs; this.timer = null; this.refreshing = null; }
  start() { this.refresh(); this.timer = setInterval(() => this.refresh(), this.intervalMs); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = readCodexUsage().then((snapshot) => { this.callback(snapshot); return snapshot; }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}

module.exports = { CodexUsageMonitor, executableCandidates, normalizeLimits, normalizeUsage, readCodexUsage, sevenDaySeries, windowLabel };
