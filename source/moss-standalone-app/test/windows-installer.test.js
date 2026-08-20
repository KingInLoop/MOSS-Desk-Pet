'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('Windows installer preserves the registered install location and closes old shells', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'tauri-windows/src-tauri/tauri.conf.json'), 'utf8'));
  const hooks = fs.readFileSync(path.join(root, 'tauri-windows/src-tauri/windows/installer-hooks.nsh'), 'utf8');
  const nsis = config.bundle.windows.nsis;

  assert.equal(config.productName, 'MOSS Desk Pet Tauri');
  assert.equal(config.identifier, 'com.moss.deskpet.tauri');
  assert.equal(nsis.installMode, 'currentUser');
  assert.equal(nsis.installerHooks, './windows/installer-hooks.nsh');
  assert.deepEqual(nsis.languages, ['SimpChinese', 'English']);
  assert.match(hooks, /NSIS_HOOK_PREINSTALL/);
  assert.match(hooks, /CheckIfAppIsRunning "MOSS-Desk-Pet\.exe"/);
});
