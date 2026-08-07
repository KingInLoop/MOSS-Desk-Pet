'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu } = require('electron');

const timeout = setTimeout(() => {
  console.error('Timed out waiting for the custom pet context-menu request.');
  app.exit(1);
}, 8000);

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 192,
    height: 208,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.on('ipc-message', async (_event, channel) => {
    if (channel !== 'show-context-menu') return;
    const menu = Menu.buildFromTemplate([
      { label: '皮肤', submenu: [{ label: '暗黑枪灰', type: 'checkbox' }, { label: '明亮白色', type: 'checkbox' }] },
      { label: '镜头颜色', submenu: [{ label: 'MOSS 红', type: 'checkbox' }] },
      { label: '显示大小', submenu: [{ label: '默认', type: 'checkbox' }] }
    ]);
    const region = await window.webContents.executeJavaScript(
      "getComputedStyle(document.getElementById('pet')).getPropertyValue('-webkit-app-region')"
    );
    const valid = region === 'no-drag'
      && menu.items.length === 3
      && menu.items.every((item) => item.submenu?.items.length > 0);
    clearTimeout(timeout);
    console.log(valid ? 'CONTEXT_MENU_SMOKE_PASS' : 'CONTEXT_MENU_SMOKE_FAIL');
    app.exit(valid ? 0 : 1);
  });

  window.webContents.once('did-finish-load', () => {
    window.webContents.sendInputEvent({ type: 'mouseDown', x: 96, y: 104, button: 'right', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 96, y: 104, button: 'right', clickCount: 1 });
  });
  window.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
});
