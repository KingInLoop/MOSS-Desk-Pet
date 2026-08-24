'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('pet surface is not a native Windows title-bar drag region', () => {
  const styles = read('src/styles.css');
  const syncUi = read('tauri-windows/sync-ui.mjs');
  assert.match(styles, /#pet\s*\{[\s\S]*-webkit-app-region:\s*no-drag/);
  assert.doesNotMatch(syncUi, /data-tauri-drag-region/);
});

test('right click is routed to the MOSS menu in both shells', () => {
  const renderer = read('src/renderer.js');
  const preload = read('src/preload.js');
  const bridge = read('tauri-windows/tauri-bridge.js');
  assert.match(renderer, /addEventListener\('contextmenu'/);
  assert.match(renderer, /window\.mossPet\.showContextMenu\(\)/);
  assert.match(preload, /ipcRenderer\.send\('show-context-menu'\)/);
  assert.match(bridge, /invoke\('show_context_menu'\)/);
});

test('manual pet dragging accepts only left-button movement after a threshold', () => {
  const renderer = read('src/renderer.js');
  assert.match(renderer, /event\.button !== 0/);
  assert.match(renderer, /DRAG_THRESHOLD = 4/);
  assert.match(renderer, /window\.mossPet\.movePetBy\(deltaX, deltaY\)/);
  assert.match(renderer, /addEventListener\('dblclick'/);
  assert.match(renderer, /event\.preventDefault\(\)/);
});

test('pet body opens usage without a separate quota button and can be disabled', () => {
  const html = read('src/index.html');
  const renderer = read('src/renderer.js');
  const settings = read('src/settings.js');
  assert.doesNotMatch(html, /id="usage-toggle"/);
  assert.match(renderer, /!settings\.clickPetForUsage/);
  assert.match(renderer, /setPanelMode\('usage', true\)/);
  assert.match(settings, /clickPetForUsage:\s*true/);
});

test('running and recently completed tasks are clickable and routed through each native shell', () => {
  const renderer = read('src/renderer.js');
  const preload = read('src/preload.js');
  const bridge = read('tauri-windows/tauri-bridge.js');
  assert.match(renderer, /window\.mossPet\.openTask\(task\.id\)/);
  assert.match(preload, /ipcRenderer\.invoke\('open-task'/);
  assert.match(bridge, /invoke\('open_task'/);
  assert.match(renderer, /task\.status === 'completed'/);
  assert.match(renderer, /recentRetentionMs/);
  assert.match(renderer, /最近完成/);
});
