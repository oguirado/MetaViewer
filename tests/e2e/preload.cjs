const { contextBridge } = require('electron');
// Sandboxed preloads do not have fs. Pass bounded fixture bytes in argv.
const prefix = '--mv-e2e-fixture=';
const raw = process.argv.find((arg) => arg.startsWith(prefix));
contextBridge.exposeInMainWorld('e2eFixture', JSON.parse(raw.slice(prefix.length)));
