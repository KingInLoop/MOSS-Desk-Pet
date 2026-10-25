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
  const single = rateLimits.rateLimits || rateLimits.rate_limits;
  const buckets = rateLimits.rateLimitsByLimitId || rateLimits.rate_limits_by_limit_id || {};
  const entries = Object.entries(buckets);
  if (!entries.length && (single?.primary || single?.secondary)) entries.push([single.limitId || single.limit_id || 'codex', single]);
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

function unavailableProvider(id, name, message, dailyUsage = sevenDaySeries([], new Date())) {
  return { id, name, status: 'unavailable', source: 'local', updatedAt: new Date().toISOString(), planType: null, limits: [], balances: [], dailyUsage, message };
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
      else resolve({ rateLimits: responses.get(2), usage: responses.get(3) || {} });
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
          } else if (message.id === 2) {
            if (message.error) return finish(new Error(message.error.message || 'Codex 额度服务不可用'));
            responses.set(2, message.result || {});
            if (responses.has(3)) finish();
          } else if (message.id === 3) {
            responses.set(3, message.error ? {} : (message.result || {}));
            if (responses.has(2)) finish();
          }
        } catch { /* Ignore non-JSON diagnostics. */ }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'moss_desk_pet', title: 'MOSS Desk Pet', version: '1.4.0' }, capabilities: {} } })}\n`);
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
      return { id: 'codex', name: 'ChatGPT / Codex', balances: [], ...normalizeUsage(rateLimits, usage, now) };
    } catch (error) {
      return { ...unavailableProvider('codex', 'ChatGPT / Codex', `官方额度暂不可用：${error.message}`, localDailyUsage(now)), updatedAt: now.toISOString() };
    }
  }
  return { ...unavailableProvider('codex', 'ChatGPT / Codex', '未找到 Codex 客户端或命令行程序', localDailyUsage(now)), updatedAt: now.toISOString() };
}

function findNestedRateLimits(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 7) return null;
  const direct = value.rate_limits || value.rateLimits;
  if (direct?.five_hour || direct?.fiveHour || direct?.seven_day || direct?.sevenDay) return direct;
  for (const child of Object.values(value)) {
    const found = findNestedRateLimits(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function claudeLimits(raw = {}) {
  const output = [];
  for (const [id, label, duration] of [['five_hour', 'Claude · 5 小时额度', 300], ['seven_day', 'Claude · 每周额度', 10080]]) {
    const camel = id === 'five_hour' ? 'fiveHour' : 'sevenDay';
    const value = raw[id] || raw[camel];
    if (!value) continue;
    const used = Math.max(0, Math.min(100, Number(value.used_percentage ?? value.usedPercent) || 0));
    output.push({ id: `claude:${id}`, name: 'Claude', label, usedPercent: used, remainingPercent: 100 - used, windowDurationMins: duration, resetsAt: Number(value.resets_at ?? value.resetsAt) || null });
  }
  return output;
}

function recentStructuredFiles(root, depth = 0, output = []) {
  if (depth > 5 || output.length > 1200) return output;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) recentStructuredFiles(target, depth + 1, output);
    else if (entry.isFile() && /\.(json|jsonl)$/i.test(entry.name)) {
      try {
        const stat = fs.statSync(target);
        if (stat.size <= 2 * 1024 * 1024) output.push({ target, mtimeMs: stat.mtimeMs });
      } catch { /* File may disappear while a client updates it. */ }
    }
  }
  return output;
}

function readClaudeRateLimits(home = os.homedir()) {
  const explicit = process.env.CLAUDE_USAGE_SNAPSHOT;
  const roots = [explicit, path.join(home, '.claude', 'moss-usage.json')].filter(Boolean);
  const discovered = recentStructuredFiles(path.join(home, '.claude')).sort((a, b) => b.mtimeMs - a.mtimeMs).map((item) => item.target);
  for (const file of [...roots, ...discovered]) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const candidates = file.endsWith('.jsonl') ? content.trim().split('\n').reverse().slice(0, 80) : [content];
      for (const candidate of candidates) {
        const found = findNestedRateLimits(JSON.parse(candidate));
        if (found) return found;
      }
    } catch { /* Ignore partial live files and unrelated JSON. */ }
  }
  return null;
}

function localClaudeDaily(now = new Date()) {
  const buckets = [];
  for (const { target } of recentStructuredFiles(path.join(os.homedir(), '.claude', 'projects'))) {
    if (!target.endsWith('.jsonl')) continue;
    try {
      for (const line of fs.readFileSync(target, 'utf8').split('\n')) {
        if (!line.includes('usage')) continue;
        const record = JSON.parse(line);
        const usage = record?.message?.usage || record?.usage;
        const tokens = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
          .reduce((sum, key) => sum + (Number(usage?.[key]) || 0), 0);
        if (tokens > 0) buckets.push({ startDate: record.timestamp, tokens });
      }
    } catch { /* Ignore live transcript tails. */ }
  }
  return sevenDaySeries(buckets, now);
}

async function readClaudeUsage(now = new Date()) {
  const limits = claudeLimits(readClaudeRateLimits() || {});
  return {
    id: 'claude', name: 'Claude', status: limits.length ? 'ok' : 'unavailable', source: limits.length ? 'claude-statusline' : 'local',
    updatedAt: now.toISOString(), planType: null, limits, balances: [], dailyUsage: localClaudeDaily(now),
    message: limits.length ? '来自 Claude 官方状态栏的最近额度快照' : 'Claude 桌面端暂无公开额度接口；可读取 Claude Code 官方状态栏快照'
  };
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function deepSeekCredential(home = os.homedir()) {
  const file = path.join(process.env.DSH_HOME || path.join(home, '.dsh'), '.credentials.yaml');
  let inRecord = false;
  let token = null;
  let issuer = null;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^  deepseek-account-platform\/default:\s*$/.test(line)) { inRecord = true; continue; }
      if (inRecord && /^  \S/.test(line)) break;
      if (!inRecord) continue;
      const match = /^\s{6}(token|issuer):\s*(.+?)\s*$/.exec(line);
      if (match?.[1] === 'token') token = parseYamlScalar(match[2]);
      if (match?.[1] === 'issuer') issuer = parseYamlScalar(match[2]);
    }
  } catch { return null; }
  try {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') return null;
  } catch { return null; }
  return token && issuer ? { token, issuer: issuer.replace(/\/$/, '') } : null;
}

function deepSeekDaily(now = new Date()) {
  const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'session_projcache', 'sessions');
  const buckets = [];
  let files = [];
  try { files = fs.readdirSync(root).filter((name) => name.endsWith('.json')); } catch { return sevenDaySeries([], now); }
  for (const name of files) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))?.record;
      const totals = record?.rows?.tokenUsage?.val?.totals || {};
      const tokens = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, key) => sum + (Number(totals[key]) || 0), 0);
      if (tokens > 0) buckets.push({ startDate: new Date(Number(record?.identity?.createdAt) || 0), tokens });
    } catch { /* Ignore sessions being compacted. */ }
  }
  return sevenDaySeries(buckets, now);
}

async function readDeepSeekUsage(now = new Date()) {
  const credential = deepSeekCredential();
  const fallback = unavailableProvider('deepseek', 'DeepSeek Harness', '未找到 DeepSeek Harness 登录信息', deepSeekDaily(now));
  if (!credential) return { ...fallback, updatedAt: now.toISOString() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${credential.issuer}/api/v0/users/get_user_summary`, {
      headers: { 'x-dsh-auth-token': credential.token, 'x-client-platform': process.platform === 'win32' ? 'desktop-win' : 'desktop-mac', 'x-client-version': '1.4.0', 'x-client-locale': 'zh_CN' },
      redirect: 'error', signal: controller.signal
    });
    if (!response.ok) throw new Error(response.status === 401 ? '登录已过期' : `服务返回 ${response.status}`);
    const envelope = await response.json();
    const data = envelope?.code === 0 && envelope?.data?.biz_code === 0 ? envelope.data.biz_data : null;
    if (!data) throw new Error('余额响应格式不兼容');
    const currencies = new Map();
    for (const [kind, rows] of [['normal', data.normal_wallets], ['bonus', data.bonus_wallets]]) {
      for (const row of Array.isArray(rows) ? rows : []) {
        const current = currencies.get(row.currency) || { currency: row.currency, normal: 0, bonus: 0 };
        current[kind] += Number(row.balance) || 0;
        currencies.set(row.currency, current);
      }
    }
    const balances = [...currencies.values()].map((item) => ({ ...item, total: item.normal + item.bonus }));
    return { id: 'deepseek', name: 'DeepSeek Harness', status: balances.length ? 'ok' : 'unavailable', source: 'deepseek-account', updatedAt: now.toISOString(), planType: null, limits: [], balances, dailyUsage: deepSeekDaily(now), message: balances.length ? '来自 DeepSeek Harness 官方账户余额' : '账户未返回余额' };
  } catch (error) {
    return { ...fallback, updatedAt: now.toISOString(), message: `DeepSeek 余额暂不可用：${error.name === 'AbortError' ? '读取超时' : error.message}` };
  } finally { clearTimeout(timer); }
}

async function readAllUsage(now = new Date()) {
  const providers = await Promise.all([readCodexUsage(now), readClaudeUsage(now), readDeepSeekUsage(now)]);
  const primary = providers[0];
  return { ...primary, providers };
}

class CodexUsageMonitor {
  constructor(callback, intervalMs = REFRESH_INTERVAL_MS) { this.callback = callback; this.intervalMs = intervalMs; this.timer = null; this.refreshing = null; }
  start() { this.refresh(); this.timer = setInterval(() => this.refresh(), this.intervalMs); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = readAllUsage().then((snapshot) => { this.callback(snapshot); return snapshot; }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}

module.exports = { CodexUsageMonitor, claudeLimits, executableCandidates, normalizeLimits, normalizeUsage, readAllUsage, readClaudeUsage, readCodexUsage, readDeepSeekUsage, sevenDaySeries, windowLabel };
