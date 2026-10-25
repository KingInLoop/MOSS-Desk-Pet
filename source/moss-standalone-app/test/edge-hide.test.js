'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hiddenBounds, nearestEdge, snappedBounds } = require('../src/edge-hide');

const area = { x: 0, y: 0, width: 1000, height: 700 };

test('detects only windows deliberately placed at a screen edge', () => {
  assert.equal(nearestEdge({ x: 8, y: 100, width: 140, height: 150 }, area), 'left');
  assert.equal(nearestEdge({ x: 840, y: 100, width: 140, height: 150 }, area), null);
  assert.equal(nearestEdge({ x: 860, y: 100, width: 140, height: 150 }, area), 'right');
});

test('keeps a visible strip and restores to the exact anchor', () => {
  const snapped = snappedBounds({ x: 5, y: 100, width: 140, height: 150 }, area, 'left');
  assert.equal(snapped.x, 0);
  assert.equal(hiddenBounds(snapped, area, 'left').x, -118);
});
