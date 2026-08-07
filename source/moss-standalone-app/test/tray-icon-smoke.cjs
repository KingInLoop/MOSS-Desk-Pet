'use strict';

const path = require('node:path');
const { app, nativeImage } = require('electron');

app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '..', 'assets', 'icons', 'tray-macos-Template.png')
  );
  icon.setTemplateImage(true);
  const scaleFactors = icon.getScaleFactors();
  const valid = !icon.isEmpty()
    && icon.isTemplateImage()
    && scaleFactors.includes(1)
    && scaleFactors.includes(2);
  console.log(valid
    ? `TRAY_ICON_SMOKE_PASS scales=${scaleFactors.join(',')}`
    : `TRAY_ICON_SMOKE_FAIL scales=${scaleFactors.join(',')}`);
  app.exit(valid ? 0 : 1);
});
