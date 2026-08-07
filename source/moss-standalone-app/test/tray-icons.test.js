'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTrayIconMode,
  resolveTrayIconMode,
  usesSystemTemplateIcon
} = require('../src/tray-icons');

test('automatic tray icon keeps contrast with the system background', () => {
  assert.equal(resolveTrayIconMode('auto', true), 'light');
  assert.equal(resolveTrayIconMode('auto', false), 'dark');
});

test('manual tray icon choice overrides the system appearance', () => {
  assert.equal(resolveTrayIconMode('light', false), 'light');
  assert.equal(resolveTrayIconMode('dark', true), 'dark');
  assert.equal(normalizeTrayIconMode('unsupported'), 'auto');
});

test('macOS delegates menu bar coloring to the system template mechanism', () => {
  assert.equal(usesSystemTemplateIcon('darwin'), true);
  assert.equal(usesSystemTemplateIcon('win32'), false);
});
