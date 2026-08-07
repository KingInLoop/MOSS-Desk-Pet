'use strict';

const fs = require('node:fs');
const { app, BrowserWindow, screen } = require('electron');
const {
  applyAlwaysOnTop,
  configureFullScreenVisibility,
  petWindowPlatformOptions
} = require('../src/window-level');

const readyPath = process.argv[2];

app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().bounds;
  const window = new BrowserWindow({
    width: 96,
    height: 96,
    x: area.x + area.width - 136,
    y: area.y + 40,
    frame: false,
    transparent: false,
    backgroundColor: '#ff00ff',
    alwaysOnTop: true,
    fullscreenable: false,
    show: false,
    ...petWindowPlatformOptions(process.platform)
  });
  configureFullScreenVisibility(window, process.platform);
  applyAlwaysOnTop(window, true, process.platform);
  window.loadURL('data:text/html,<body style="margin:0;background:%23ff00ff"></body>');
  window.once('ready-to-show', () => {
    window.showInactive();
    applyAlwaysOnTop(window, true, process.platform);
    if (readyPath) fs.writeFileSync(readyPath, 'ready');
  });
});
