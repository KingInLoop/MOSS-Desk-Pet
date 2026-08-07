'use strict';

const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const readyPath = process.argv[2];

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    backgroundColor: '#123456',
    show: false
  });
  window.loadURL('data:text/html,<body style="margin:0;background:%23123456"></body>');
  window.once('ready-to-show', () => {
    window.show();
    window.focus();
    app.focus({ steal: true });
    window.setFullScreen(true);
  });
  window.once('enter-full-screen', () => {
    if (readyPath) fs.writeFileSync(readyPath, 'ready');
  });
});
