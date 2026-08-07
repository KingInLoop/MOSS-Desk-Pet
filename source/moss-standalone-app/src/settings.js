'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SCALE, SCALE_OPTIONS } = require('./layout');
const { normalizeTrayIconMode } = require('./tray-icons');

const DEFAULT_SETTINGS = Object.freeze({
  skin: 'dark',
  eyeColor: 'default',
  scale: DEFAULT_SCALE,
  alwaysOnTop: true,
  notifications: true,
  launchAtLogin: false,
  showStatusBadge: true,
  trayIconMode: 'auto'
});

function normalizeSettings(value = {}) {
  const skin = ['dark', 'light'].includes(value.skin) ? value.skin : DEFAULT_SETTINGS.skin;
  const eyeColor = ['default', 'cyan', 'blue', 'amber', 'violet', 'green'].includes(value.eyeColor)
    ? value.eyeColor
    : DEFAULT_SETTINGS.eyeColor;
  const scale = SCALE_OPTIONS.some((option) => option.value === Number(value.scale))
    ? Number(value.scale)
    : DEFAULT_SETTINGS.scale;
  return {
    skin,
    eyeColor,
    scale,
    alwaysOnTop: value.alwaysOnTop ?? DEFAULT_SETTINGS.alwaysOnTop,
    notifications: value.notifications ?? DEFAULT_SETTINGS.notifications,
    launchAtLogin: value.launchAtLogin ?? DEFAULT_SETTINGS.launchAtLogin,
    showStatusBadge: value.showStatusBadge ?? DEFAULT_SETTINGS.showStatusBadge,
    trayIconMode: normalizeTrayIconMode(value.trayIconMode)
  };
}

function readSettings(userDataPath) {
  const settingsPath = path.join(userDataPath, 'settings.json');
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(userDataPath, settings) {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'settings.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

module.exports = { DEFAULT_SETTINGS, normalizeSettings, readSettings, writeSettings };
