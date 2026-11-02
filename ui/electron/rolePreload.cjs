// Additive v0.3 capability; the frozen preload.js is unchanged.
const { contextBridge, ipcRenderer } = require('electron');
const channel = 'metaviewer:roles.v0.3';
if (process.isMainFrame && location.origin === 'app://metaviewer') {
  const invoke = (op, body = {}) => ipcRenderer.invoke(channel, {schema:'metaviewer.roles/v0.3', op, ...body});
  contextBridge.exposeInMainWorld('metaviewerRoles', Object.freeze({
    choices: () => invoke('choices'),
    surfaces: () => invoke('surfaces'),
    create: choice => invoke('create', {choice}),
    open: choice => invoke('open', {choice}),
    switchMode: surfaceId => invoke('switch', {surfaceId}),
    stop: surfaceId => invoke('stop', {surfaceId}),
    confirmLogin: surfaceId => invoke('confirm-login', {surfaceId}),
    status: surfaceId => invoke('status', {surfaceId}),
    mount: (surfaceId, bounds) => invoke('mount', {surfaceId,bounds}),
    resize: (surfaceId, bounds) => invoke('resize', {surfaceId,bounds}),
    visibility: (surfaceId, visible) => invoke('visibility', {surfaceId,visible}),
    raise: surfaceId => invoke('raise', {surfaceId}),
    onFocus: callback => {
      const listener = (_event,id) => {if(typeof id === 'string')callback(id);};
      ipcRenderer.on('metaviewer:role-focus.v0.3',listener);
      return () => ipcRenderer.removeListener('metaviewer:role-focus.v0.3',listener);
    },
    close: surfaceId => invoke('close', {surfaceId}),
  }));
}
