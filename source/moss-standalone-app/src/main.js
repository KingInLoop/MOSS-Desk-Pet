'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  Tray
} = require('electron');
const { CodexSessionMonitor } = require('./codex-monitor');
const { readSettings, writeSettings } = require('./settings');
const { resolveTrayIconMode, usesSystemTemplateIcon } = require('./tray-icons');
const {
  applyAlwaysOnTop,
  configureFullScreenVisibility,
  petWindowPlatformOptions
} = require('./window-level');
const {
  DEFAULT_PANEL_PLACEMENT,
  SCALE_OPTIONS,
  petBoundsFromWindow,
  petDimensions: calculatePetDimensions,
  reflowWindowBounds,
  windowDimensions
} = require('./layout');

let petWindow;
let tray;
let monitor;
let settings;
let cursorTimer;
let detailsExpanded = false;
let panelPlacement = { ...DEFAULT_PANEL_PLACEMENT };
let status = { activeCount: 0, source: null, tasks: [] };

const SOURCE_LABELS = {
  desktop: 'Codex 桌面端',
  vscode: 'VS Code Codex',
  codex: 'Codex'
};

function petDimensions() {
  return calculatePetDimensions(settings.scale);
}

function resizePetWindow(previousScale = settings.scale, previousExpanded = detailsExpanded) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const current = petWindow.getBounds();
  const area = screen.getDisplayMatching(current).workArea;
  const layout = reflowWindowBounds({
    current,
    previousScale,
    previousExpanded,
    previousPlacement: panelPlacement,
    nextScale: settings.scale,
    nextExpanded: detailsExpanded,
    workArea: area
  });
  panelPlacement = layout.placement;
  petWindow.setBounds(layout.bounds, false);
  petWindow.webContents.send('panel-placement', panelPlacement);
}

function createPetWindow() {
  const dimensions = windowDimensions(settings.scale, detailsExpanded);
  const area = screen.getPrimaryDisplay().workArea;
  petWindow = new BrowserWindow({
    ...dimensions,
    x: area.x + area.width - dimensions.width - 24,
    y: area.y + area.height - dimensions.height - 24,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    fullscreenable: false,
    show: false,
    backgroundColor: '#00000000',
    ...petWindowPlatformOptions(),
    ...(process.platform === 'win32' ? { icon: resolvedTrayIconPath() } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  configureFullScreenVisibility(petWindow);
  applyAlwaysOnTop(petWindow, settings.alwaysOnTop);
  petWindow.loadFile(path.join(__dirname, 'index.html'));
  petWindow.once('ready-to-show', () => {
    petWindow.showInactive();
    applyAlwaysOnTop(petWindow, settings.alwaysOnTop);
    if (process.env.MOSS_CAPTURE_TOP_EXPANSION === '1') {
      const pet = petDimensions();
      petWindow.setPosition(area.x + area.width - pet.width - 24, area.y, false);
      setDetailsExpanded(true);
    }
    if (process.env.MOSS_CAPTURE_SCALE_SEQUENCE) {
      const sequence = process.env.MOSS_CAPTURE_SCALE_SEQUENCE
        .split(',')
        .map(Number)
        .filter((scale) => SCALE_OPTIONS.some((option) => option.value === scale));
      sequence.forEach((scale, index) => {
        setTimeout(() => {
          settings = { ...settings, scale };
          resizePetWindow();
          petWindow?.webContents.send('settings', settings);
        }, 180 + index * 280);
      });
    }
    // Optional deterministic renderer capture for development and CI visual QA.
    if (process.env.MOSS_CAPTURE_PATH) {
      const delay = Number(process.env.MOSS_CAPTURE_DELAY_MS || 900);
      setTimeout(async () => {
        const screenshot = await petWindow.webContents.capturePage();
        fs.writeFileSync(process.env.MOSS_CAPTURE_PATH, screenshot.toPNG());
        if (process.env.MOSS_CAPTURE_AND_EXIT === '1') {
          app.isQuitting = true;
          app.quit();
        }
      }, delay);
    }
  });
  petWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      petWindow.hide();
    }
  });
  petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  petWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  petWindow.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });
}

function saveAndApply(next) {
  const previousScale = settings.scale;
  settings = writeSettings(app.getPath('userData'), { ...settings, ...next });
  if (Object.prototype.hasOwnProperty.call(next, 'alwaysOnTop')) {
    applyAlwaysOnTop(petWindow, settings.alwaysOnTop);
  }
  if (Object.prototype.hasOwnProperty.call(next, 'scale')) resizePetWindow(previousScale, detailsExpanded);
  if (next.launchAtLogin !== undefined && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, openAsHidden: true });
  }
  petWindow?.webContents.send('settings', settings);
  if (Object.prototype.hasOwnProperty.call(next, 'trayIconMode')) refreshTrayIcon();
  rebuildTrayMenu();
}

function checkedMenu(label, checked, click) {
  return { label, type: 'checkbox', checked, click };
}

function settingsMenuItems() {
  const colors = [
    ['default', 'MOSS 红'], ['cyan', '氦青'], ['blue', '导航蓝'],
    ['amber', '警告琥珀'], ['violet', '量子紫'], ['green', '系统绿']
  ];
  const sizes = SCALE_OPTIONS.map(({ value, label }) => [value, label]);
  const trayIconItems = process.platform === 'win32'
    ? [{
        label: '任务栏图标', submenu: [
          checkedMenu('自动（推荐）', settings.trayIconMode === 'auto', () => saveAndApply({ trayIconMode: 'auto' })),
          checkedMenu('浅色图标（适合深色背景）', settings.trayIconMode === 'light', () => saveAndApply({ trayIconMode: 'light' })),
          checkedMenu('深色图标（适合浅色背景）', settings.trayIconMode === 'dark', () => saveAndApply({ trayIconMode: 'dark' }))
        ]
      }]
    : [];
  return [
    {
      label: '皮肤', submenu: [
        checkedMenu('暗黑枪灰', settings.skin === 'dark', () => saveAndApply({ skin: 'dark' })),
        checkedMenu('明亮白色', settings.skin === 'light', () => saveAndApply({ skin: 'light' }))
      ]
    },
    {
      label: '镜头颜色', submenu: colors.map(([value, label]) =>
        checkedMenu(label, settings.eyeColor === value, () => saveAndApply({ eyeColor: value })))
    },
    {
      label: '显示大小', submenu: sizes.map(([value, label]) =>
        checkedMenu(label, settings.scale === value, () => saveAndApply({ scale: value })))
    },
    ...trayIconItems,
    { type: 'separator' },
    checkedMenu('始终置顶', settings.alwaysOnTop, () => saveAndApply({ alwaysOnTop: !settings.alwaysOnTop })),
    checkedMenu('任务状态通知', settings.notifications, () => saveAndApply({ notifications: !settings.notifications })),
    checkedMenu('显示状态灯', settings.showStatusBadge, () => saveAndApply({ showStatusBadge: !settings.showStatusBadge })),
    checkedMenu('登录时启动', settings.launchAtLogin, () => saveAndApply({ launchAtLogin: !settings.launchAtLogin }))
  ];
}

function statusMenuLabel() {
  const statusLabel = status.activeCount > 0
    ? `正在执行 ${status.activeCount} 个任务 · ${SOURCE_LABELS[status.source] || 'Codex'}`
    : '正在监听 Codex 任务';
  return statusLabel;
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusMenuLabel(), enabled: false },
    { type: 'separator' },
    { label: petWindow?.isVisible() ? '隐藏 MOSS' : '显示 MOSS', click: () => petWindow?.isVisible() ? petWindow.hide() : petWindow.showInactive() },
    { label: `查看运行任务（${status.activeCount || 0}）`, click: () => setDetailsExpanded(true) },
    ...settingsMenuItems(),
    { type: 'separator' },
    { label: '退出 MOSS', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

function showPetContextMenu() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: statusMenuLabel(), enabled: false },
    { type: 'separator' },
    { label: detailsExpanded ? '收起运行任务' : `查看运行任务（${status.activeCount || 0}）`, click: () => setDetailsExpanded(!detailsExpanded) },
    ...settingsMenuItems(),
    { type: 'separator' },
    { label: '隐藏 MOSS', click: () => petWindow.hide() },
    { label: '退出 MOSS', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  menu.popup({ window: petWindow });
}

function effectiveTrayIconMode() {
  return resolveTrayIconMode(settings.trayIconMode, nativeTheme.shouldUseDarkColors);
}

function resolvedTrayIconPath() {
  return path.join(app.getAppPath(), 'assets', 'icons', `tray-${effectiveTrayIconMode()}.png`);
}

function trayIconImage() {
  if (usesSystemTemplateIcon(process.platform)) {
    const templatePath = path.join(app.getAppPath(), 'assets', 'icons', 'tray-macos-Template.png');
    const template = nativeImage.createFromPath(templatePath);
    template.setTemplateImage(true);
    return template;
  }
  const requested = nativeImage.createFromPath(resolvedTrayIconPath());
  const source = requested.isEmpty()
    ? nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icons', 'app.png'))
    : requested;
  return source.resize({ width: 20, height: 20, quality: 'best' });
}

function refreshTrayIcon() {
  const image = trayIconImage();
  tray?.setImage(image);
  if (process.platform === 'win32' && petWindow && !petWindow.isDestroyed()) {
    petWindow.setIcon(image);
  }
}

function createTray() {
  const image = trayIconImage();
  tray = new Tray(image);
  tray.setToolTip('MOSS Desk Pet');
  tray.on('double-click', () => petWindow?.isVisible() ? petWindow.hide() : petWindow.showInactive());
  rebuildTrayMenu();
}

function showNotification(title, body) {
  if (!settings.notifications || !Notification.isSupported()) return;
  new Notification({
    title,
    body,
    silent: false
  }).show();
}

function notifyCompletion(event) {
  const taskName = event.task?.title ? `“${event.task.title}”` : '任务';
  showNotification('MOSS：任务完成', `${SOURCE_LABELS[event.source] || 'Codex'} 的${taskName}已正常完成。`);
}

function notifyInterruption(event) {
  const reasons = {
    network: '网络连接异常', authentication: '身份认证异常',
    'rate-limit': '请求频率受限', service: 'Codex 服务异常', unknown: '未知运行异常'
  };
  const taskName = event.task?.title ? `“${event.task.title}”` : '任务';
  showNotification('MOSS：任务异常中断', `${taskName}因${reasons[event.interruptionKind] || reasons.unknown}而中断。`);
}

function uiSnapshot(snapshot = status) {
  return {
    activeCount: snapshot.activeCount || 0,
    source: snapshot.source || null,
    tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : []
  };
}

function sendTaskSnapshot() {
  petWindow?.webContents.send('task-snapshot', uiSnapshot());
}

function setDetailsExpanded(next) {
  const previousExpanded = detailsExpanded;
  detailsExpanded = Boolean(next);
  resizePetWindow(settings.scale, previousExpanded);
  petWindow?.webContents.send('details-expanded', detailsExpanded);
  rebuildTrayMenu();
}

function wireMonitor() {
  monitor = new CodexSessionMonitor();
  monitor.on('ready', (snapshot) => {
    status = snapshot;
    petWindow?.webContents.send('pet-event', { type: snapshot.activeCount > 0 ? 'running' : 'idle', ...uiSnapshot(snapshot) });
    sendTaskSnapshot();
    rebuildTrayMenu();
  });
  monitor.on('task-started', (event) => {
    status = monitor.snapshot();
    petWindow?.webContents.send('pet-event', { ...event, ...uiSnapshot(), type: 'running' });
    sendTaskSnapshot();
    rebuildTrayMenu();
  });
  monitor.on('task-complete', (event) => {
    status = monitor.snapshot();
    petWindow?.webContents.send('pet-event', { ...event, ...uiSnapshot(), type: 'completed' });
    sendTaskSnapshot();
    notifyCompletion(event);
    rebuildTrayMenu();
  });
  monitor.on('task-interrupted', (event) => {
    status = monitor.snapshot();
    petWindow?.webContents.send('pet-event', { ...event, ...uiSnapshot(), type: 'interrupted' });
    sendTaskSnapshot();
    notifyInterruption(event);
    rebuildTrayMenu();
  });
  monitor.on('task-cancelled', (event) => {
    status = monitor.snapshot();
    petWindow?.webContents.send('pet-event', { ...event, ...uiSnapshot(), type: 'cancelled' });
    sendTaskSnapshot();
    rebuildTrayMenu();
  });
  monitor.start();
}

function startCursorTracking() {
  cursorTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    const pet = petBoundsFromWindow(bounds, settings.scale, detailsExpanded, panelPlacement);
    const center = {
      x: pet.x + pet.width / 2,
      y: pet.y + pet.height / 2
    };
    const dx = cursor.x - center.x;
    const dy = cursor.y - center.y;
    const distance = Math.hypot(dx, dy);
    const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    petWindow.webContents.send('look-direction', {
      index: Math.round(degrees / 22.5) % 16,
      engaged: distance < 760
    });
  }, 180);
}

ipcMain.on('renderer-ready', () => {
  petWindow?.webContents.send('settings', settings);
  petWindow?.webContents.send('pet-event', { type: status.activeCount > 0 ? 'running' : 'idle', ...uiSnapshot() });
  petWindow?.webContents.send('details-expanded', detailsExpanded);
  petWindow?.webContents.send('panel-placement', panelPlacement);
  sendTaskSnapshot();
});
ipcMain.on('toggle-skin', () => saveAndApply({ skin: settings.skin === 'dark' ? 'light' : 'dark' }));
ipcMain.on('show-context-menu', (event) => {
  if (event.sender === petWindow?.webContents) showPetContextMenu();
});
ipcMain.on('move-pet-by', (event, delta = {}) => {
  if (event.sender !== petWindow?.webContents || !petWindow || petWindow.isDestroyed()) return;
  const deltaX = Number(delta.deltaX);
  const deltaY = Number(delta.deltaY);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
  const [x, y] = petWindow.getPosition();
  petWindow.setPosition(
    x + Math.max(-500, Math.min(500, Math.round(deltaX))),
    y + Math.max(-500, Math.min(500, Math.round(deltaY))),
    false
  );
});
ipcMain.on('set-details-expanded', (_event, expanded) => setDetailsExpanded(expanded));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    petWindow?.show();
    petWindow?.focus();
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.moss.deskpet');
    settings = readSettings(app.getPath('userData'));
    if (process.env.MOSS_CAPTURE_EXPANDED === '1') detailsExpanded = true;
    createPetWindow();
    createTray();
    nativeTheme.on('updated', () => {
      if (!usesSystemTemplateIcon(process.platform) && settings.trayIconMode === 'auto') refreshTrayIcon();
    });
    wireMonitor();
    startCursorTracking();
  });
}

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => {
  monitor?.stop();
  if (cursorTimer) clearInterval(cursorTimer);
});
app.on('window-all-closed', () => {});
