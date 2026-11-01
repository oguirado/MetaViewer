// Replays the operator's 1 Nov failure: one refused trace event (a drag that
// leaves the page, an extra mouse button) closed the whole human view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHumanTraceFile } from '../electron/humanTrace.js';
import { attachXpraHumanTile } from '../electron/xpraHumanTile.js';

const bounds = {x:0,y:0,width:1280,height:900};

function fakeElectron() {
  const ipcMain = new EventEmitter();
  class WC extends EventEmitter {
    mainFrame = {}; url = ''; closed = false;
    setIgnoreMenuShortcuts() {} setWindowOpenHandler() {} setZoomFactor() {}
    async loadURL(url) { this.url = url; } getURL() { return this.url; } focus() {}
    async executeJavaScript() { return true; }
    close() { this.closed = true; }
  }
  class WebContentsView { webContents = new WC(); setBounds(b) { this.bounds = b; } setVisible(v) { this.visible = v; } }
  const isolated = new EventEmitter();
  Object.assign(isolated, {setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: {onBeforeRequest() {}, onBeforeSendHeaders() {}}, async clearStorageData() {}});
  const parentSession = {registerPreloadScript() { return 'role-preload'; }, unregisterPreloadScript() {}};
  const window = new EventEmitter(); window.webContents = {session: parentSession};
  window.contentView = {addChildView() {}, removeChildView() {}};
  return {electron: {WebContentsView, ipcMain, session: {fromPartition() { return isolated; }}}, window, ipcMain};
}

test('a refused trace event is dropped and the human view stays open', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-drop-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const trace = createHumanTraceFile({directory, sessionId: 'session', surfaceId: 'human', capsuleId: 'srf-id-human'});
  const f = fakeElectron(), failures = [];
  const tile = await attachXpraHumanTile({...f, bridge: {origin: 'http://127.0.0.1:12345', requestHeaders: {}}, bounds,
    trace, isActive: () => true, writable: true, capsuleSize: () => ({width: 1280, height: 900}), onFailure: e => failures.push(e)});
  const wc = tile.view.webContents;
  const send = row => f.ipcMain.emit('metaviewer:human-trace.v0.3', {sender: wc, senderFrame: wc.mainFrame}, row);
  send({width: 1280, height: 900, kind: 'move', x: 1300, y: 10});
  send({width: 1280, height: 900, kind: 'click', x: 10, y: 10, button: 3});
  send({width: 1280, height: 900, kind: 'move', x: 10, y: 10});
  await new Promise(r => setImmediate(r));
  assert.deepEqual(failures, []);
  assert.equal(wc.closed, false);
  await tile.close();
});
