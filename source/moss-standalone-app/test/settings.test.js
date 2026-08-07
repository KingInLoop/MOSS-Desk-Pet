'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, normalizeSettings } = require('../src/settings');

test('normalizes invalid settings to safe defaults', () => {
  const result = normalizeSettings({ skin: 'pink', eyeColor: 'orange', scale: 99, trayIconMode: 'neon' });
  assert.equal(result.skin, DEFAULT_SETTINGS.skin);
  assert.equal(result.eyeColor, DEFAULT_SETTINGS.eyeColor);
  assert.equal(result.scale, DEFAULT_SETTINGS.scale);
  assert.equal(result.trayIconMode, 'auto');
});

test('accepts supported visual settings', () => {
  const result = normalizeSettings({ skin: 'light', eyeColor: 'cyan', scale: 0.875, notifications: false, trayIconMode: 'light' });
  assert.equal(result.skin, 'light');
  assert.equal(result.eyeColor, 'cyan');
  assert.equal(result.scale, 0.875);
  assert.equal(result.notifications, false);
  assert.equal(result.trayIconMode, 'light');
});
