'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DEFAULT_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const DEFAULT_COMPLETED_RETENTION_MS = 5 * 60 * 1000;
const MAX_RECENT_COMPLETED = 20;
const MAX_INITIAL_BYTES = 2 * 1024 * 1024;

function classifyTaskError(error) {
  if (!error) return null;
  const diagnostic = [error.message, error.codex_error_info, error.code, error.type]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/network|connection|connect|disconnect|stream|socket|timeout|timed out|dns|tls|offline|fetch failed|request failed/.test(diagnostic)) return 'network';
  if (/unauthor|forbidden|authentication|credential|api key/.test(diagnostic)) return 'authentication';
  if (/rate limit|too many requests|quota/.test(diagnostic)) return 'rate-limit';
  if (/service unavailable|server error|internal error|bad gateway|gateway timeout|\b5\d\d\b/.test(diagnostic)) return 'service';
  return 'unknown';
}

function resolveCodexHome(environment = process.env, homeDirectory = os.homedir()) {
  if (environment.CODEX_HOME) return path.resolve(environment.CODEX_HOME);
  return path.join(homeDirectory, '.codex');
}

function classifyOriginator(originator) {
  if (typeof originator !== 'string') return 'ignored';
  const normalized = originator.toLowerCase();
  if (normalized.includes('desktop')) return 'desktop';
  if (normalized.includes('vscode')) return 'vscode';
  return 'codex';
}

function extractCodexEvent(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'session_meta') {
    const isSubagent = Boolean(
      record.payload?.source &&
      typeof record.payload.source === 'object' &&
      record.payload.source.subagent
    );
    return {
      kind: 'session-meta',
      source: isSubagent ? 'ignored' : classifyOriginator(record.payload?.originator),
      originator: typeof record.payload?.originator === 'string' ? record.payload.originator : null,
      sessionId: record.payload?.id || record.payload?.session_id || null,
      cwd: typeof record.payload?.cwd === 'string' ? record.payload.cwd : null,
      timestamp: record.timestamp || null
    };
  }
  if (record.type !== 'event_msg') return null;
  const type = record.payload?.type;
  if (!['task_started', 'task_complete', 'turn_aborted', 'task_cancelled'].includes(type)) return null;
  if (type === 'task_complete' && record.payload?.error) {
    return {
      kind: 'task-interrupted',
      turnId: record.payload?.turn_id || null,
      interruptionKind: classifyTaskError(record.payload.error),
      timestamp: record.timestamp || null
    };
  }
  if (type === 'turn_aborted' || type === 'task_cancelled') {
    return {
      kind: 'task-cancelled',
      turnId: record.payload?.turn_id || null,
      interruptionKind: 'cancelled',
      timestamp: record.timestamp || null
    };
  }
  return {
    kind: type.replaceAll('_', '-'),
    turnId: record.payload?.turn_id || null,
    timestamp: record.timestamp || null
  };
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readSessionIdentity(filePath, fileSize) {
  const length = Math.min(fileSize, 64 * 1024);
  if (length <= 0) return { source: 'codex', ignored: false, sessionId: null, cwd: null };
  let descriptor;
  try {
    const buffer = Buffer.alloc(length);
    descriptor = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.includes('session_meta')) continue;
      const event = extractCodexEvent(JSON.parse(line));
      if (event?.kind === 'session-meta') {
        return {
          source: event.source,
          ignored: event.source === 'ignored',
          sessionId: event.sessionId,
          cwd: event.cwd
        };
      }
    }
  } catch {
    // Fall back to an ordinary Codex session when the header is incomplete.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return { source: 'codex', ignored: false, sessionId: null, cwd: null };
}

class ThreadTitleIndex {
  constructor(codexHome) {
    this.databasePath = path.join(codexHome, 'state_5.sqlite');
    this.database = null;
    this.statement = null;
  }

  titleFor(sessionId) {
    if (!sessionId || !safeStat(this.databasePath)) return null;
    try {
      if (!this.database) {
        const { DatabaseSync } = require('node:sqlite');
        this.database = new DatabaseSync(this.databasePath, { readOnly: true });
        this.statement = this.database.prepare(
          "SELECT COALESCE(NULLIF(name, ''), NULLIF(title, ''), '') AS title FROM threads WHERE id = ? LIMIT 1"
        );
      }
      const row = this.statement.get(sessionId);
      return typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : null;
    } catch {
      return null;
    }
  }

  close() {
    try {
      this.database?.close();
    } catch {
      // The app is already exiting; there is nothing useful to recover here.
    }
    this.database = null;
    this.statement = null;
  }
}

function walkJsonl(directory, depth = 0, output = []) {
  if (depth > 4) return output;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkJsonl(entryPath, depth + 1, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(entryPath);
  }
  return output;
}

class CodexSessionMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexHome = options.codexHome || resolveCodexHome();
    this.sessionsRoot = path.join(this.codexHome, 'sessions');
    this.pollInterval = options.pollInterval || 900;
    this.lookbackMs = options.lookbackMs || DEFAULT_LOOKBACK_MS;
    this.completedRetentionMs = options.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS;
    this.now = options.now || Date.now;
    this.fileStates = new Map();
    this.activeTurns = new Map();
    this.recentCompleted = new Map();
    this.timer = null;
    this.startedAt = 0;
    this.lastSource = null;
    this.titleIndex = options.titleIndex || new ThreadTitleIndex(this.codexHome);
  }

  start() {
    if (this.timer) return;
    this.startedAt = Date.now();
    this._scan(true);
    this.timer = setInterval(() => this._scan(false), this.pollInterval);
    this.emit('ready', this.snapshot());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.titleIndex?.close?.();
  }

  snapshot() {
    this._pruneRecentCompleted();
    const activeTasks = [...this.activeTurns.values()].map((task) => this._publicTask(task));
    const activeIds = new Set(activeTasks.map((task) => task.id));
    const completedTasks = [...this.recentCompleted.values()]
      .filter(({ task }) => !activeIds.has(this._taskId(task)))
      .sort((left, right) => right.completedAtMs - left.completedAtMs)
      .slice(0, MAX_RECENT_COMPLETED)
      .map(({ task, completedAt }) => this._publicTask(task, 'completed', completedAt));
    return {
      activeCount: this.activeTurns.size,
      source: this.lastSource,
      tasks: [...activeTasks, ...completedTasks],
      recentRetentionMs: this.completedRetentionMs,
      codexHome: this.codexHome,
      sessionsRoot: this.sessionsRoot
    };
  }

  _taskId(task) {
    return task.sessionId || task.turnId || path.basename(task.filePath, '.jsonl');
  }

  _publicTask(task, status = 'running', completedAt = null) {
    const workspace = task.cwd ? path.basename(task.cwd) : null;
    const resolvedTitle = this.titleIndex?.titleFor?.(task.sessionId) || workspace || '未命名对话';
    return {
      id: this._taskId(task),
      turnId: task.turnId || null,
      title: resolvedTitle.replace(/\s+/g, ' ').trim().slice(0, 96),
      workspace,
      cwd: task.cwd || null,
      source: task.source,
      startedAt: task.startedAt || null,
      status,
      completedAt
    };
  }

  _pruneRecentCompleted() {
    const cutoff = this.now() - this.completedRetentionMs;
    for (const [key, completed] of this.recentCompleted) {
      if (completed.completedAtMs < cutoff) this.recentCompleted.delete(key);
    }
  }

  _rememberCompleted(turnKey, task, timestamp) {
    const parsed = Date.parse(timestamp || '');
    const completedAtMs = Number.isFinite(parsed) ? parsed : this.now();
    if (completedAtMs < this.now() - this.completedRetentionMs) return null;
    const completedAt = new Date(completedAtMs).toISOString();
    this.recentCompleted.set(turnKey, { task, completedAt, completedAtMs });
    this._pruneRecentCompleted();
    return completedAt;
  }

  _recentFiles() {
    const cutoff = Date.now() - this.lookbackMs;
    return walkJsonl(this.sessionsRoot).filter((filePath) => {
      const stat = safeStat(filePath);
      return stat && stat.mtimeMs >= cutoff;
    });
  }

  _scan(initializing) {
    for (const filePath of this._recentFiles()) this._readFile(filePath, initializing);
  }

  _readFile(filePath, initializing) {
    const stat = safeStat(filePath);
    if (!stat) return;

    let state = this.fileStates.get(filePath);
    if (!state) {
      const start = Math.max(0, stat.size - MAX_INITIAL_BYTES);
      const identity = readSessionIdentity(filePath, stat.size);
      state = { offset: start, remainder: '', ...identity, initialized: false };
      this.fileStates.set(filePath, state);
    }
    if (stat.size < state.offset) {
      state.offset = 0;
      state.remainder = '';
    }
    if (stat.size === state.offset) return;

    const length = stat.size - state.offset;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    let descriptor;
    try {
      descriptor = fs.openSync(filePath, 'r');
      bytesRead = fs.readSync(descriptor, buffer, 0, length, state.offset);
    } catch {
      return;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    state.offset += bytesRead;

    let text = state.remainder + buffer.subarray(0, bytesRead).toString('utf8');
    if (!state.initialized && state.offset - bytesRead > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const lines = text.split('\n');
    state.remainder = lines.pop() || '';

    // Files discovered after startup are new Codex sessions, so their lifecycle
    // events should be emitted on the first read. The startup scan itself stays
    // silent and only reconstructs an already-running task count.
    const shouldEmit = !initializing;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!/(session_meta|task_started|task_complete|turn_aborted|task_cancelled)/.test(line)) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      this._consumeRecord(filePath, state, extractCodexEvent(record), shouldEmit);
    }
    state.initialized = true;
  }

  _consumeRecord(filePath, state, event, shouldEmit) {
    if (!event) return;
    if (event.kind === 'session-meta') {
      state.source = event.source;
      state.ignored = event.source === 'ignored';
      state.sessionId = event.sessionId;
      state.cwd = event.cwd;
      return;
    }
    if (state.ignored) return;

    const turnKey = `${filePath}:${event.turnId || 'latest'}`;
    this.lastSource = state.source;
    if (event.kind === 'task-started') {
      const task = {
        source: state.source,
        filePath,
        sessionId: state.sessionId,
        cwd: state.cwd,
        turnId: event.turnId,
        startedAt: event.timestamp || new Date(this.now()).toISOString()
      };
      const taskId = this._taskId(task);
      for (const [key, completed] of this.recentCompleted) {
        if (this._taskId(completed.task) === taskId) this.recentCompleted.delete(key);
      }
      this.activeTurns.set(turnKey, task);
      if (shouldEmit) this.emit('task-started', { ...event, ...this.snapshot(), task: this._publicTask(task) });
    } else if (event.kind === 'task-complete') {
      const task = this.activeTurns.get(turnKey);
      this.activeTurns.delete(turnKey);
      const completedAt = task ? this._rememberCompleted(turnKey, task, event.timestamp) : null;
      if (shouldEmit) this.emit('task-complete', { ...event, ...this.snapshot(), source: state.source, task: task ? this._publicTask(task, 'completed', completedAt) : null });
    } else if (event.kind === 'task-interrupted') {
      const task = this.activeTurns.get(turnKey);
      this.activeTurns.delete(turnKey);
      if (shouldEmit) this.emit('task-interrupted', { ...event, ...this.snapshot(), source: state.source, task: task ? this._publicTask(task) : null });
    } else {
      const task = this.activeTurns.get(turnKey);
      this.activeTurns.delete(turnKey);
      if (shouldEmit) this.emit('task-cancelled', { ...event, ...this.snapshot(), source: state.source, task: task ? this._publicTask(task) : null });
    }
    if (shouldEmit) this.emit('state', this.snapshot());
  }
}

module.exports = {
  CodexSessionMonitor,
  DEFAULT_COMPLETED_RETENTION_MS,
  classifyOriginator,
  classifyTaskError,
  extractCodexEvent,
  resolveCodexHome,
  ThreadTitleIndex
};
