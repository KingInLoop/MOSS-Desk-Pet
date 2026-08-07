'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAC_FULLSCREEN_LEVEL,
  MAC_FULLSCREEN_RELATIVE_LEVEL,
  applyAlwaysOnTop,
  configureFullScreenVisibility,
  petWindowPlatformOptions
} = require('../src/window-level');

function fakeWindow() {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    setVisibleOnAllWorkspaces: (...args) => calls.push(['spaces', ...args]),
    setAlwaysOnTop: (...args) => calls.push(['top', ...args]),
    moveTop: () => calls.push(['moveTop'])
  };
}

test('macOS pet is visible on fullscreen Spaces', () => {
  const window = fakeWindow();
  configureFullScreenVisibility(window, 'darwin');
  assert.deepEqual(window.calls, [['spaces', true, { visibleOnFullScreen: true }]]);
});

test('macOS pet uses the native panel type required above fullscreen apps', () => {
  assert.deepEqual(petWindowPlatformOptions('darwin'), { type: 'panel' });
  assert.deepEqual(petWindowPlatformOptions('win32'), {});
});

test('macOS always-on-top uses the fullscreen-safe level', () => {
  const window = fakeWindow();
  applyAlwaysOnTop(window, true, 'darwin');
  assert.deepEqual(window.calls, [
    ['top', true, MAC_FULLSCREEN_LEVEL, MAC_FULLSCREEN_RELATIVE_LEVEL],
    ['moveTop']
  ]);
  assert.equal(MAC_FULLSCREEN_LEVEL, 'screen-saver');
  assert.equal(MAC_FULLSCREEN_RELATIVE_LEVEL, 1);
});

test('disabling always-on-top resets the native level', () => {
  const window = fakeWindow();
  applyAlwaysOnTop(window, false, 'darwin');
  assert.deepEqual(window.calls, [['top', false]]);
});

test('other platforms retain the normal always-on-top behavior', () => {
  const window = fakeWindow();
  configureFullScreenVisibility(window, 'win32');
  applyAlwaysOnTop(window, true, 'win32');
  assert.deepEqual(window.calls, [
    ['spaces', true, { visibleOnFullScreen: false }],
    ['top', true]
  ]);
});
