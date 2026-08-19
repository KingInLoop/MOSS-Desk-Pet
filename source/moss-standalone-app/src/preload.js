'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mossPet', {
  ready: () => ipcRenderer.send('renderer-ready'),
  onSettings: (callback) => ipcRenderer.on('settings', (_event, value) => callback(value)),
  onPetEvent: (callback) => ipcRenderer.on('pet-event', (_event, value) => callback(value)),
  onTaskSnapshot: (callback) => ipcRenderer.on('task-snapshot', (_event, value) => callback(value)),
  onUsageSnapshot: (callback) => ipcRenderer.on('usage-snapshot', (_event, value) => callback(value)),
  onPanelMode: (callback) => ipcRenderer.on('panel-mode', (_event, value) => callback(value)),
  onDetailsExpanded: (callback) => ipcRenderer.on('details-expanded', (_event, value) => callback(Boolean(value))),
  onPanelPlacement: (callback) => ipcRenderer.on('panel-placement', (_event, value) => callback(value)),
  onDirection: (callback) => ipcRenderer.on('look-direction', (_event, value) => callback(value)),
  toggleSkin: () => ipcRenderer.send('toggle-skin'),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  movePetBy: (deltaX, deltaY) => ipcRenderer.send('move-pet-by', { deltaX, deltaY }),
  setDetailsExpanded: (expanded) => ipcRenderer.send('set-details-expanded', Boolean(expanded)),
  setPanelMode: (mode) => ipcRenderer.send('set-panel-mode', mode),
  openTask: (taskId) => ipcRenderer.invoke('open-task', taskId),
  refreshUsage: () => ipcRenderer.send('refresh-usage')
});
