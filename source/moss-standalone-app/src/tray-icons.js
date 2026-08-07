'use strict';

const TRAY_ICON_MODES = Object.freeze(['auto', 'light', 'dark']);

function normalizeTrayIconMode(value) {
  return TRAY_ICON_MODES.includes(value) ? value : 'auto';
}

function resolveTrayIconMode(mode, systemUsesDarkColors) {
  const normalized = normalizeTrayIconMode(mode);
  if (normalized !== 'auto') return normalized;
  return systemUsesDarkColors ? 'light' : 'dark';
}

function usesSystemTemplateIcon(platform) {
  return platform === 'darwin';
}

module.exports = {
  TRAY_ICON_MODES,
  normalizeTrayIconMode,
  resolveTrayIconMode,
  usesSystemTemplateIcon
};
