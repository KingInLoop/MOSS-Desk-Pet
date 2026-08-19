'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const subscriptions = [];
let dragMoveQueue = Promise.resolve();

function subscribe(eventName, callback) {
  subscriptions.push(listen(eventName, (event) => callback(event.payload)));
}

window.mossPet = {
  ready: async () => {
    await Promise.all(subscriptions);
    return invoke('renderer_ready');
  },
  onSettings: (callback) => subscribe('settings', callback),
  onPetEvent: (callback) => subscribe('pet-event', callback),
  onTaskSnapshot: (callback) => subscribe('task-snapshot', callback),
  onUsageSnapshot: (callback) => subscribe('usage-snapshot', callback),
  onPanelMode: (callback) => subscribe('panel-mode', callback),
  onDetailsExpanded: (callback) => subscribe('details-expanded', (value) => callback(Boolean(value))),
  onPanelPlacement: (callback) => subscribe('panel-placement', callback),
  onDirection: (callback) => subscribe('look-direction', callback),
  toggleSkin: () => invoke('toggle_skin'),
  showContextMenu: () => invoke('show_context_menu'),
  movePetBy: (deltaX, deltaY) => {
    dragMoveQueue = dragMoveQueue
      .catch(() => undefined)
      .then(() => invoke('move_pet_by', { deltaX, deltaY }));
    return dragMoveQueue;
  },
  setDetailsExpanded: (expanded) => invoke('set_details_expanded', { expanded: Boolean(expanded) }),
  setPanelMode: (mode) => invoke('set_panel_mode', { mode }),
  openTask: (taskId) => invoke('open_task', { taskId }),
  refreshUsage: () => invoke('refresh_usage')
};
