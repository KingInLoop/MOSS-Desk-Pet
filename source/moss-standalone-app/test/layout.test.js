'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCALE_OPTIONS,
  petBoundsFromWindow,
  petDimensions,
  reflowWindowBounds,
  windowDimensions
} = require('../src/layout');

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

test('largest v1.2 size equals the old minimum size', () => {
  assert.deepEqual(petDimensions(SCALE_OPTIONS.at(-1).value), { width: 192, height: 208 });
  assert.deepEqual(SCALE_OPTIONS.map(({ value }) => value), [0.55, 0.65, 0.75, 0.875, 1]);
});

test('shrinking applies immediately while preserving the pet lower-right anchor', () => {
  const result = reflowWindowBounds({
    current: { x: 100, y: 100, width: 336, height: 364 },
    previousScale: 1.75,
    previousExpanded: false,
    previousPlacement: { horizontal: 'left', vertical: 'up' },
    nextScale: 0.55,
    nextExpanded: false,
    workArea
  });
  assert.deepEqual(result.bounds, { x: 330, y: 350, width: 106, height: 114 });
});

test('expanded task details add a fixed panel without stretching the pet', () => {
  assert.deepEqual(windowDimensions(0.75, true), { width: 432, height: 304 });
  assert.deepEqual(petDimensions(0.75), { width: 144, height: 156 });
});

test('pet at top expands downward without changing its screen position', () => {
  const original = { x: 1500, y: 0, width: 144, height: 156 };
  const result = reflowWindowBounds({
    current: original,
    previousScale: 0.75,
    previousExpanded: false,
    previousPlacement: { horizontal: 'left', vertical: 'up' },
    nextScale: 0.75,
    nextExpanded: true,
    workArea
  });
  assert.equal(result.placement.vertical, 'down');
  assert.deepEqual(petBoundsFromWindow(result.bounds, 0.75, true, result.placement), original);
});

test('pet at bottom expands upward without changing its screen position', () => {
  const original = { x: 1500, y: 924, width: 144, height: 156 };
  const result = reflowWindowBounds({
    current: original,
    previousScale: 0.75,
    previousExpanded: false,
    previousPlacement: { horizontal: 'left', vertical: 'down' },
    nextScale: 0.75,
    nextExpanded: true,
    workArea
  });
  assert.equal(result.placement.vertical, 'up');
  assert.deepEqual(petBoundsFromWindow(result.bounds, 0.75, true, result.placement), original);
});

test('pet at left edge puts panel on the right and collapses back in place', () => {
  const original = { x: 0, y: 400, width: 144, height: 156 };
  const expanded = reflowWindowBounds({
    current: original,
    previousScale: 0.75,
    previousExpanded: false,
    previousPlacement: { horizontal: 'left', vertical: 'up' },
    nextScale: 0.75,
    nextExpanded: true,
    workArea
  });
  assert.equal(expanded.placement.horizontal, 'right');
  assert.deepEqual(petBoundsFromWindow(expanded.bounds, 0.75, true, expanded.placement), original);

  const collapsed = reflowWindowBounds({
    current: expanded.bounds,
    previousScale: 0.75,
    previousExpanded: true,
    previousPlacement: expanded.placement,
    nextScale: 0.75,
    nextExpanded: false,
    workArea
  });
  assert.deepEqual(collapsed.bounds, original);
});
