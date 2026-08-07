'use strict';

(function exposeAnimationConfig(root, factory) {
  const config = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
  if (root) root.MossAnimationConfig = config;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const cell = (row, column) => Object.freeze({ row, column });

  // Curated exclusively from the approved Codex-native MOSS frames. Rows 7-10
  // contain the inconsistent turntable renders and must never reach the UI.
  const STATES = Object.freeze({
    idle: Object.freeze({
      fps: 3.2,
      cells: Object.freeze([cell(0, 0), cell(0, 1), cell(0, 2), cell(0, 1), cell(0, 4), cell(0, 5)])
    }),
    completed: Object.freeze({
      fps: 5,
      cells: Object.freeze([cell(3, 0), cell(3, 1), cell(3, 2), cell(3, 1), cell(3, 3), cell(3, 0)])
    }),
    failed: Object.freeze({
      fps: 4.5,
      cells: Object.freeze([cell(5, 0), cell(5, 1), cell(5, 2), cell(5, 3), cell(5, 4), cell(5, 5), cell(5, 6), cell(5, 7)])
    }),
    waiting: Object.freeze({
      fps: 3.8,
      cells: Object.freeze([cell(6, 0), cell(6, 1), cell(6, 2), cell(6, 1), cell(6, 0), cell(6, 3), cell(6, 4), cell(6, 5), cell(6, 3), cell(6, 0)])
    }),
    running: Object.freeze({
      fps: 4.8,
      cells: Object.freeze([cell(6, 0), cell(6, 1), cell(6, 2), cell(6, 1), cell(6, 3), cell(6, 4), cell(6, 5), cell(6, 3)])
    }),
    review: Object.freeze({
      fps: 3.8,
      cells: Object.freeze([cell(3, 0), cell(3, 1), cell(3, 2), cell(3, 1), cell(3, 0), cell(3, 3)])
    })
  });

  // Sixteen cursor sectors reuse subtle lift, dip, and yaw poses. The fixed
  // right-hand suspension arm stays attached in every selected source cell.
  const LOOK_CELLS = Object.freeze([
    cell(6, 1), cell(6, 2), cell(3, 1), cell(3, 2),
    cell(3, 2), cell(6, 3), cell(6, 4), cell(6, 4),
    cell(6, 4), cell(6, 4), cell(6, 5), cell(3, 1),
    cell(3, 1), cell(6, 5), cell(6, 1), cell(6, 1)
  ]);

  function stateCell(stateName, frameIndex) {
    const state = STATES[stateName] || STATES.idle;
    return state.cells[frameIndex % state.cells.length];
  }

  function lookCell(directionIndex) {
    const index = ((Number(directionIndex) % 16) + 16) % 16;
    return LOOK_CELLS[index];
  }

  return Object.freeze({ STATES, LOOK_CELLS, stateCell, lookCell });
}));
