'use strict';

const canvas = document.getElementById('sprite');
const context = canvas.getContext('2d', { alpha: true });
const statusLight = document.getElementById('status');
const toast = document.getElementById('toast');
const pet = document.getElementById('pet');
const shell = document.getElementById('app-shell');
const taskToggle = document.getElementById('task-toggle');
const taskCount = document.getElementById('task-count');
const taskPanel = document.getElementById('task-panel');
const taskList = document.getElementById('task-list');
const panelSummary = document.getElementById('panel-summary');
const panelClose = document.getElementById('panel-close');

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const SOURCE_LABELS = { desktop: 'Codex 桌面端', vscode: 'VS Code Codex', codex: 'Codex' };
const { STATES, stateCell, lookCell } = window.MossAnimationConfig;

let settings = { skin: 'dark', eyeColor: 'default', scale: 0.75, showStatusBadge: true };
let image = new Image();
let imageReady = false;
let currentState = 'idle';
let frameIndex = 0;
let lastFrameAt = 0;
let transitionTimer;
let toastTimer;
let lookDirection = null;
let detailsOpen = false;
let taskSnapshot = { activeCount: 0, tasks: [] };
let dragPointerId = null;
let dragStarted = false;
let dragOrigin = null;
let dragLastPoint = null;
let dragEndedAt = Number.NEGATIVE_INFINITY;

const DRAG_THRESHOLD = 4;

context.imageSmoothingEnabled = true;
context.imageSmoothingQuality = 'high';

function atlasPath() {
  return `../assets/pets/${settings.skin}/${settings.eyeColor}.webp`;
}

function loadAtlas() {
  imageReady = false;
  const nextImage = new Image();
  nextImage.onload = () => {
    image = nextImage;
    imageReady = true;
    frameIndex = 0;
    drawFrame();
  };
  nextImage.src = atlasPath();
}

function drawCell(row, column) {
  context.clearRect(0, 0, CELL_WIDTH, CELL_HEIGHT);
  if (!imageReady) return;
  context.drawImage(
    image,
    column * CELL_WIDTH,
    row * CELL_HEIGHT,
    CELL_WIDTH,
    CELL_HEIGHT,
    0,
    0,
    CELL_WIDTH,
    CELL_HEIGHT
  );
}

function drawFrame() {
  if (currentState === 'idle' && lookDirection !== null) {
    const selected = lookCell(lookDirection);
    drawCell(selected.row, selected.column);
    return;
  }
  const selected = stateCell(currentState, frameIndex);
  drawCell(selected.row, selected.column);
}

function animationLoop(now) {
  const state = STATES[currentState] || STATES.idle;
  if (now - lastFrameAt >= 1000 / state.fps) {
    frameIndex = (frameIndex + 1) % state.cells.length;
    lastFrameAt = now;
    drawFrame();
  }
  requestAnimationFrame(animationLoop);
}

function updateStatus(type) {
  statusLight.className = settings.showStatusBadge ? type : 'hidden';
}

function showToast(message, duration = 3200) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), duration);
}

function setState(type, event = {}) {
  clearTimeout(transitionTimer);
  const animationState = ['interrupted', 'cancelled'].includes(type) ? 'failed' : type;
  currentState = STATES[animationState] ? animationState : 'idle';
  frameIndex = 0;
  lookDirection = currentState === 'idle' ? lookDirection : null;
  updateStatus(currentState);
  if (type === 'completed') {
    showToast(`${SOURCE_LABELS[event.source] || 'Codex'} · 任务完成`);
    transitionTimer = setTimeout(() => {
      if ((event.activeCount || 0) > 0) setState('running', event);
      else {
        currentState = 'review';
        frameIndex = 0;
        updateStatus('completed');
        transitionTimer = setTimeout(() => setState('idle'), 1800);
      }
    }, 4200);
  } else if (type === 'interrupted') {
    const reasons = {
      network: '网络异常中断', authentication: '认证异常中断',
      'rate-limit': '限流异常中断', service: '服务异常中断', unknown: '任务异常中断'
    };
    showToast(`${SOURCE_LABELS[event.source] || 'Codex'} · ${reasons[event.interruptionKind] || reasons.unknown}`);
    transitionTimer = setTimeout(() => setState(event.activeCount > 0 ? 'running' : 'idle'), 5200);
  } else if (type === 'cancelled' || type === 'failed') {
    showToast(`${SOURCE_LABELS[event.source] || 'Codex'} · 任务已取消`);
    transitionTimer = setTimeout(() => setState(event.activeCount > 0 ? 'running' : 'idle'), 4500);
  } else if (type === 'running') {
    showToast(`${SOURCE_LABELS[event.source] || 'Codex'} · 正在执行`, 1600);
  }
  drawFrame();
}

function setDetailsOpen(next, notifyMain = true) {
  detailsOpen = Boolean(next);
  shell.classList.toggle('details-open', detailsOpen);
  taskPanel.setAttribute('aria-hidden', String(!detailsOpen));
  taskToggle.setAttribute('aria-expanded', String(detailsOpen));
  if (notifyMain) window.mossPet.setDetailsExpanded(detailsOpen);
}

function elapsedLabel(startedAt) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt || Date.now())) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function renderTasks() {
  const tasks = Array.isArray(taskSnapshot.tasks) ? taskSnapshot.tasks : [];
  taskCount.textContent = String(tasks.length);
  panelSummary.textContent = `${tasks.length} 个对话`;
  taskList.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'task-empty';
    empty.textContent = '当前没有正在运行的任务';
    taskList.append(empty);
    return;
  }
  for (const task of tasks) {
    const item = document.createElement('article');
    item.className = 'task-item';
    const dot = document.createElement('span');
    dot.className = 'task-dot';
    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = task.title || '未命名对话';
    title.title = title.textContent;
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const source = SOURCE_LABELS[task.source] || 'Codex';
    meta.textContent = `${source} · 运行中 ${elapsedLabel(task.startedAt)}`;
    body.append(title, meta);
    item.append(dot, body);
    taskList.append(item);
  }
}

window.mossPet.onSettings((next) => {
  const atlasChanged = next.skin !== settings.skin || next.eyeColor !== settings.eyeColor;
  settings = next;
  document.documentElement.style.setProperty('--pet-width', `${Math.round(CELL_WIDTH * settings.scale)}px`);
  document.documentElement.style.setProperty('--pet-height', `${Math.round(CELL_HEIGHT * settings.scale)}px`);
  updateStatus(currentState);
  if (atlasChanged) loadAtlas();
});
window.mossPet.onPetEvent((event) => setState(event.type, event));
window.mossPet.onTaskSnapshot((snapshot) => {
  taskSnapshot = snapshot;
  renderTasks();
});
window.mossPet.onDetailsExpanded((expanded) => setDetailsOpen(expanded, false));
window.mossPet.onPanelPlacement((placement = {}) => {
  shell.classList.toggle('panel-right', placement.horizontal === 'right');
  shell.classList.toggle('panel-down', placement.vertical === 'down');
});
window.mossPet.onDirection((event) => {
  lookDirection = event.engaged ? event.index : null;
  if (currentState === 'idle') drawFrame();
});

function pointFromEvent(event) {
  return { x: event.screenX, y: event.screenY };
}

function resetDrag(event) {
  if (dragPointerId === null || (event && event.pointerId !== dragPointerId)) return;
  if (dragStarted) dragEndedAt = performance.now();
  if (pet.hasPointerCapture?.(dragPointerId)) pet.releasePointerCapture(dragPointerId);
  pet.classList.remove('dragging');
  dragPointerId = null;
  dragStarted = false;
  dragOrigin = null;
  dragLastPoint = null;
}

pet.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  dragPointerId = event.pointerId;
  dragOrigin = pointFromEvent(event);
  dragLastPoint = dragOrigin;
  pet.setPointerCapture?.(event.pointerId);
  event.preventDefault();
});

pet.addEventListener('pointermove', (event) => {
  if (event.pointerId !== dragPointerId) return;
  if ((event.buttons & 1) === 0) {
    resetDrag(event);
    return;
  }
  const point = pointFromEvent(event);
  if (!dragStarted && Math.hypot(point.x - dragOrigin.x, point.y - dragOrigin.y) < DRAG_THRESHOLD) return;
  if (!dragStarted) {
    dragStarted = true;
    pet.classList.add('dragging');
  }
  const deltaX = point.x - dragLastPoint.x;
  const deltaY = point.y - dragLastPoint.y;
  dragLastPoint = point;
  if (deltaX || deltaY) window.mossPet.movePetBy(deltaX, deltaY);
  event.preventDefault();
});

pet.addEventListener('pointerup', resetDrag);
pet.addEventListener('pointercancel', resetDrag);

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  event.stopPropagation();
  resetDrag();
  window.mossPet.showContextMenu();
});

pet.addEventListener('dblclick', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (performance.now() - dragEndedAt < 320) return;
  window.mossPet.toggleSkin();
});
taskToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  setDetailsOpen(!detailsOpen);
});
panelClose.addEventListener('click', () => setDetailsOpen(false));
setInterval(() => { if (detailsOpen) renderTasks(); }, 1000);
renderTasks();
loadAtlas();
window.mossPet.ready();
requestAnimationFrame(animationLoop);
