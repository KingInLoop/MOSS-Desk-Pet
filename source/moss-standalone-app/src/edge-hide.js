'use strict';

const EDGE_THRESHOLD = 14;
const EDGE_PEEK = 22;

function nearestEdge(bounds, workArea, threshold = EDGE_THRESHOLD) {
  const distances = [
    ['left', Math.abs(bounds.x - workArea.x)],
    ['right', Math.abs(workArea.x + workArea.width - (bounds.x + bounds.width))],
    ['top', Math.abs(bounds.y - workArea.y)],
    ['bottom', Math.abs(workArea.y + workArea.height - (bounds.y + bounds.height))]
  ].sort((left, right) => left[1] - right[1]);
  return distances[0][1] <= threshold ? distances[0][0] : null;
}

function snappedBounds(bounds, workArea, edge) {
  const next = { ...bounds };
  if (edge === 'left') next.x = workArea.x;
  if (edge === 'right') next.x = workArea.x + workArea.width - bounds.width;
  if (edge === 'top') next.y = workArea.y;
  if (edge === 'bottom') next.y = workArea.y + workArea.height - bounds.height;
  next.x = Math.max(workArea.x, Math.min(next.x, workArea.x + workArea.width - bounds.width));
  next.y = Math.max(workArea.y, Math.min(next.y, workArea.y + workArea.height - bounds.height));
  return next;
}

function hiddenBounds(bounds, workArea, edge, peek = EDGE_PEEK) {
  const next = { ...bounds };
  if (edge === 'left') next.x = workArea.x - bounds.width + peek;
  if (edge === 'right') next.x = workArea.x + workArea.width - peek;
  if (edge === 'top') next.y = workArea.y - bounds.height + peek;
  if (edge === 'bottom') next.y = workArea.y + workArea.height - peek;
  return next;
}

function containsPoint(bounds, point) {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width
    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

module.exports = { EDGE_PEEK, EDGE_THRESHOLD, containsPoint, hiddenBounds, nearestEdge, snappedBounds };
