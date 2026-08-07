'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATES, LOOK_CELLS, stateCell, lookCell } = require('../src/animation-config');

test('runtime animations use only approved native-style rows', () => {
  const cells = Object.values(STATES).flatMap((state) => state.cells).concat(LOOK_CELLS);
  assert.ok(cells.length > 0);
  assert.ok(cells.every(({ row, column }) => [0, 3, 5, 6].includes(row) && column >= 0 && column < 8));
  assert.ok(cells.every(({ row }) => ![4, 7, 8, 9, 10].includes(row)));
});

test('animation selection loops safely', () => {
  assert.deepEqual(stateCell('running', STATES.running.cells.length), STATES.running.cells[0]);
  assert.deepEqual(stateCell('unknown', 0), STATES.idle.cells[0]);
  assert.deepEqual(lookCell(16), LOOK_CELLS[0]);
  assert.deepEqual(lookCell(-1), LOOK_CELLS[15]);
});
