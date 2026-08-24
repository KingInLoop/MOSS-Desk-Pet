'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexSessionMonitor, classifyOriginator, classifyTaskError, extractCodexEvent, resolveCodexHome } = require('../src/codex-monitor');

test('resolves the default and overridden Codex home', () => {
  assert.equal(resolveCodexHome({}, '/Users/example'), path.join('/Users/example', '.codex'));
  assert.equal(resolveCodexHome({ CODEX_HOME: '/tmp/custom-codex' }, '/Users/example'), path.resolve('/tmp/custom-codex'));
});

test('classifies desktop, VS Code, CLI, and subagent origins', () => {
  assert.equal(classifyOriginator('Codex Desktop'), 'desktop');
  assert.equal(classifyOriginator('codex_vscode'), 'vscode');
  assert.equal(classifyOriginator('codex_cli'), 'codex');
  assert.equal(classifyOriginator({ subagent: true }), 'ignored');
});

test('extracts only lifecycle metadata and never message content', () => {
  assert.deepEqual(extractCodexEvent({
    timestamp: '2026-08-05T00:00:00Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1', message: 'private prompt' }
  }), {
    kind: 'task-started',
    turnId: 'turn-1',
    timestamp: '2026-08-05T00:00:00Z'
  });
  assert.equal(extractCodexEvent({ type: 'event_msg', payload: { type: 'user_message', message: 'private' } }), null);
});

test('extracts completion and cancellation events', () => {
  assert.equal(extractCodexEvent({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'x' } }).kind, 'task-complete');
  assert.equal(extractCodexEvent({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'x' } }).kind, 'task-cancelled');
});

test('classifies network failures without retaining the raw error message', () => {
  assert.equal(classifyTaskError({ message: 'stream disconnected while fetching response' }), 'network');
  assert.equal(classifyTaskError({ message: 'too many requests' }), 'rate-limit');
  const event = extractCodexEvent({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'x', error: { message: 'connection reset with private details' } }
  });
  assert.deepEqual(event, { kind: 'task-interrupted', turnId: 'x', interruptionKind: 'network', timestamp: null });
  assert.equal(JSON.stringify(event).includes('private details'), false);
});

test('reconstructs main-surface activity and ignores subagent sessions', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-monitor-'));
  const sessions = path.join(tempRoot, 'sessions', '2026', '08', '05');
  fs.mkdirSync(sessions, { recursive: true });
  const mainFile = path.join(sessions, 'main.jsonl');
  const subagentFile = path.join(sessions, 'subagent.jsonl');
  fs.writeFileSync(mainFile, [
    JSON.stringify({ type: 'session_meta', payload: { originator: 'codex_vscode', id: 'thread-main', cwd: '/workspace/moss' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'main-turn' } }),
    ''
  ].join('\n'));
  fs.writeFileSync(subagentFile, [
    JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex Desktop', source: { subagent: { depth: 1 } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } }),
    ''
  ].join('\n'));

  const monitor = new CodexSessionMonitor({
    codexHome: tempRoot,
    titleIndex: { titleFor: (id) => id === 'thread-main' ? 'MOSS 多任务面板' : null, close() {} }
  });
  monitor.start();
  assert.equal(monitor.snapshot().activeCount, 1);
  assert.equal([...monitor.activeTurns.values()][0].source, 'vscode');
  assert.equal(monitor.snapshot().tasks[0].title, 'MOSS 多任务面板');
  assert.equal(monitor.snapshot().tasks[0].workspace, 'moss');
  assert.equal(monitor.snapshot().tasks[0].cwd, '/workspace/moss');
  monitor.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('emits abnormal interruption separately from user cancellation', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-monitor-errors-'));
  const sessions = path.join(tempRoot, 'sessions', '2026', '08', '06');
  fs.mkdirSync(sessions, { recursive: true });
  const sessionFile = path.join(sessions, 'errors.jsonl');
  const monitor = new CodexSessionMonitor({ codexHome: tempRoot });
  const events = [];
  monitor.on('task-interrupted', (event) => events.push([event.kind, event.interruptionKind]));
  monitor.on('task-cancelled', (event) => events.push([event.kind, event.interruptionKind]));
  monitor.start();

  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex Desktop' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'network-turn' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'network-turn', error: { message: 'network connection lost' } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'cancel-turn' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'cancel-turn', reason: 'interrupted' } }),
    ''
  ].join('\n'));
  monitor._scan(false);

  assert.deepEqual(events, [['task-interrupted', 'network'], ['task-cancelled', 'cancelled']]);
  monitor.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('emits start and completion for a session created after the watcher starts', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-monitor-live-'));
  const sessions = path.join(tempRoot, 'sessions', '2026', '08', '05');
  fs.mkdirSync(sessions, { recursive: true });
  let now = Date.parse('2026-08-20T06:00:00Z');
  const monitor = new CodexSessionMonitor({ codexHome: tempRoot, now: () => now });
  const events = [];
  monitor.on('task-started', (event) => events.push(event.kind));
  monitor.on('task-complete', (event) => events.push(event.kind));
  monitor.start();

  const sessionFile = path.join(sessions, 'live.jsonl');
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex Desktop', source: 'vscode' } }),
    JSON.stringify({ timestamp: '2026-08-20T05:58:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'live-turn' } }),
    ''
  ].join('\n'));
  monitor._scan(false);
  fs.appendFileSync(sessionFile, `${JSON.stringify({ timestamp: '2026-08-20T06:00:00Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'live-turn' } })}\n`);
  monitor._scan(false);

  assert.deepEqual(events, ['task-started', 'task-complete']);
  assert.equal(monitor.snapshot().activeCount, 0);
  assert.equal(monitor.snapshot().tasks.length, 1);
  assert.equal(monitor.snapshot().tasks[0].status, 'completed');
  assert.equal(monitor.snapshot().tasks[0].completedAt, '2026-08-20T06:00:00.000Z');
  assert.equal(monitor.snapshot().recentRetentionMs, 5 * 60 * 1000);
  now += 5 * 60 * 1000 + 1;
  assert.equal(monitor.snapshot().tasks.length, 0);
  monitor.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
