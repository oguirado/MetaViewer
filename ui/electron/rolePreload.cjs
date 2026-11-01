// Additive v0.3 capability; the frozen preload.js is unchanged.
const { contextBridge, ipcRenderer } = require('electron');
const channel = 'metaviewer:roles.v0.3';
if (process.isMainFrame && location.origin === 'app://metaviewer') {
  const invoke = (op, body = {}) => ipcRenderer.invoke(channel, {schema:'metaviewer.roles/v0.3', op, ...body});
  contextBridge.exposeInMainWorld('metaviewerRoles', Object.freeze({
    choices: () => invoke('choices'),
    create: choice => invoke('create', {choice}),
    status: surfaceId => invoke('status', {surfaceId}),
    mount: (surfaceId, bounds) => invoke('mount', {surfaceId,bounds}),
    resize: (surfaceId, bounds) => invoke('resize', {surfaceId,bounds}),
    visibility: (surfaceId, visible) => invoke('visibility', {surfaceId,visible}),
    close: surfaceId => invoke('close', {surfaceId}),
  }));
}
