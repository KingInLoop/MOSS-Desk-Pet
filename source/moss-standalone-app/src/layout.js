'use strict';

const PET_WIDTH = 192;
const PET_HEIGHT = 208;
const DEFAULT_SCALE = 0.75;
const SCALE_OPTIONS = Object.freeze([
  Object.freeze({ value: 0.55, label: '小' }),
  Object.freeze({ value: 0.65, label: '中' }),
  Object.freeze({ value: 0.75, label: '默认' }),
  Object.freeze({ value: 0.875, label: '大' }),
  Object.freeze({ value: 1, label: '特大' })
]);
const TASK_PANEL_WIDTH = 280;
const TASK_PANEL_GAP = 8;
const TASK_PANEL_HEIGHT = 232;
const DEFAULT_PANEL_PLACEMENT = Object.freeze({ horizontal: 'left', vertical: 'up' });

function petDimensions(scale) {
  return { width: Math.round(PET_WIDTH * scale), height: Math.round(PET_HEIGHT * scale) };
}

function windowDimensions(scale, detailsExpanded) {
  const pet = petDimensions(scale);
  return detailsExpanded
    ? { width: pet.width + TASK_PANEL_GAP + TASK_PANEL_WIDTH, height: Math.max(pet.height, TASK_PANEL_HEIGHT) }
    : pet;
}

function normalizePlacement(placement = DEFAULT_PANEL_PLACEMENT) {
  return {
    horizontal: placement.horizontal === 'right' ? 'right' : 'left',
    vertical: placement.vertical === 'down' ? 'down' : 'up'
  };
}

function petOffset(scale, detailsExpanded, placement) {
  if (!detailsExpanded) return { x: 0, y: 0 };
  const pet = petDimensions(scale);
  const window = windowDimensions(scale, true);
  const normalized = normalizePlacement(placement);
  return {
    x: normalized.horizontal === 'left' ? TASK_PANEL_WIDTH + TASK_PANEL_GAP : 0,
    y: normalized.vertical === 'up' ? window.height - pet.height : 0
  };
}

function petBoundsFromWindow(windowBounds, scale, detailsExpanded, placement) {
  const pet = petDimensions(scale);
  const offset = petOffset(scale, detailsExpanded, placement);
  return {
    x: windowBounds.x + offset.x,
    y: windowBounds.y + offset.y,
    width: pet.width,
    height: pet.height
  };
}

function choosePanelPlacement(petBounds, scale, workArea) {
  const pet = petDimensions(scale);
  const expanded = windowDimensions(scale, true);
  const horizontalExtra = expanded.width - pet.width;
  const verticalExtra = expanded.height - pet.height;
  const leftSpace = petBounds.x - workArea.x;
  const rightSpace = workArea.x + workArea.width - (petBounds.x + pet.width);
  const upSpace = petBounds.y - workArea.y;
  const downSpace = workArea.y + workArea.height - (petBounds.y + pet.height);

  return {
    horizontal: leftSpace >= horizontalExtra || leftSpace >= rightSpace ? 'left' : 'right',
    vertical: upSpace >= verticalExtra || upSpace >= downSpace ? 'up' : 'down'
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function windowForPetBounds(petBounds, scale, detailsExpanded, placement, workArea) {
  const dimensions = windowDimensions(scale, detailsExpanded);
  const offset = petOffset(scale, detailsExpanded, placement);
  return {
    x: clamp(petBounds.x - offset.x, workArea.x, workArea.x + workArea.width - dimensions.width),
    y: clamp(petBounds.y - offset.y, workArea.y, workArea.y + workArea.height - dimensions.height),
    width: dimensions.width,
    height: dimensions.height
  };
}

function reflowWindowBounds({
  current,
  previousScale,
  previousExpanded,
  previousPlacement,
  nextScale,
  nextExpanded,
  workArea
}) {
  const currentPet = petBoundsFromWindow(current, previousScale, previousExpanded, previousPlacement);
  const nextPetSize = petDimensions(nextScale);
  const desiredPet = {
    x: currentPet.x + currentPet.width - nextPetSize.width,
    y: currentPet.y + currentPet.height - nextPetSize.height,
    ...nextPetSize
  };
  const placement = nextExpanded
    ? choosePanelPlacement(desiredPet, nextScale, workArea)
    : normalizePlacement(previousPlacement);
  return {
    bounds: windowForPetBounds(desiredPet, nextScale, nextExpanded, placement, workArea),
    placement
  };
}

module.exports = {
  DEFAULT_PANEL_PLACEMENT,
  DEFAULT_SCALE,
  PET_HEIGHT,
  PET_WIDTH,
  SCALE_OPTIONS,
  choosePanelPlacement,
  petBoundsFromWindow,
  petDimensions,
  petOffset,
  reflowWindowBounds,
  windowDimensions,
  windowForPetBounds
};
