'use strict';

const { app, BrowserWindow } = require('electron');
const { applyAlwaysOnTop, configureFullScreenVisibility } = require('../src/window-level');

const timeout = setTimeout(() => {
  console.error('Timed out checking the macOS fullscreen window level.');
  app.exit(1);
}, 8000);

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 96,
    height: 96,
    show: false,
    frame: false,
    transparent: true,
    fullscreenable: false
  });
  configureFullScreenVisibility(window, process.platform);
  applyAlwaysOnTop(window, true, process.platform);
  const valid = process.platform !== 'darwin'
    || (window.isAlwaysOnTop() && window.isVisibleOnAllWorkspaces());
  clearTimeout(timeout);
  console.log(valid ? 'MAC_FULLSCREEN_LEVEL_SMOKE_PASS' : 'MAC_FULLSCREEN_LEVEL_SMOKE_FAIL');
  app.exit(valid ? 0 : 1);
});
