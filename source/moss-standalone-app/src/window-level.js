'use strict';

const MAC_FULLSCREEN_LEVEL = 'screen-saver';
const MAC_FULLSCREEN_RELATIVE_LEVEL = 1;

function petWindowPlatformOptions(platform = process.platform) {
  return platform === 'darwin' ? { type: 'panel' } : {};
}

function configureFullScreenVisibility(window, platform = process.platform) {
  if (!window || window.isDestroyed?.()) return;
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: platform === 'darwin'
  });
}

function applyAlwaysOnTop(window, enabled, platform = process.platform) {
  if (!window || window.isDestroyed?.()) return;
  if (enabled && platform === 'darwin') {
    window.setAlwaysOnTop(true, MAC_FULLSCREEN_LEVEL, MAC_FULLSCREEN_RELATIVE_LEVEL);
    window.moveTop?.();
    return;
  }
  window.setAlwaysOnTop(Boolean(enabled));
}

module.exports = {
  MAC_FULLSCREEN_LEVEL,
  MAC_FULLSCREEN_RELATIVE_LEVEL,
  applyAlwaysOnTop,
  configureFullScreenVisibility,
  petWindowPlatformOptions
};
