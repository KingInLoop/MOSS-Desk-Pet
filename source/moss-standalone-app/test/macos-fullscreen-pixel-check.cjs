'use strict';

const { app, nativeImage } = require('electron');

const screenshotPath = process.argv[2];

app.whenReady().then(() => {
  const image = nativeImage.createFromPath(screenshotPath);
  const bitmap = image.toBitmap();
  let magentaPixels = 0;
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    if (red > 240 && green < 20 && blue > 240) magentaPixels += 1;
  }
  const valid = magentaPixels >= 5000;
  console.log(`MAC_FULLSCREEN_PANEL_PIXELS=${magentaPixels}`);
  console.log(valid ? 'MAC_FULLSCREEN_INTEGRATION_PASS' : 'MAC_FULLSCREEN_INTEGRATION_FAIL');
  app.exit(valid ? 0 : 1);
});
