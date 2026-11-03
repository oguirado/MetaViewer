// Native role view: separate sandboxed WebContentsView for native HTML5 input and pixels.
import { xpraClientQuery, xpraReadyExpression, waitForXpraClient } from './xpraClient.js';
import { createXpraRecovery } from './xpraRecovery.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { interceptDesktopShortcut } from './desktopShortcuts.js';

/** Per-event refusals of the trace recorder: the event is dropped, the view stays. */
export const DROPPABLE_TRACE_CODES = Object.freeze(new Set(['TRACE_EVENT_REFUSED','TRACE_COORDINATE_REFUSED',
  'TRACE_BUTTON_REFUSED','TRACE_KEY_PHASE_REFUSED','TRACE_SCROLL_REFUSED','TRACE_GEOMETRY_REFUSED']));

/** Host owns geometry and the lease. No bridge capability enters renderer IPC.
 * @param {{electron:typeof import('electron'),window:import('electron').BrowserWindow,
 * bridge:Awaited<ReturnType<typeof import('./xpraHumanBridge.js').openXpraHumanBridge>>,
 * bounds:{x:number,y:number,width:number,height:number},
 * trace:ReturnType<typeof import('./humanTrace.js').createHumanTrace>,isActive:()=>boolean,writable?:boolean,capsuleId?:string,rawKeyboard?:boolean,initiallyVisible?:boolean,
 * capsuleSize:()=>{width:number,height:number},
 * axContext?:()=>{sensitive?:boolean,password?:boolean,row?:number}|null,clientQuery?:string,
 * recoverBridge?:()=>Promise<any>,onState?:(state:string)=>void,onFocus?:()=>void,onFailure:(error:unknown)=>void}} options
 */
export async function attachXpraHumanTile({ electron, window, bridge, bounds, trace,
  isActive, capsuleSize, capsuleId, writable = true, rawKeyboard = false, initiallyVisible = true, axContext = () => null, clientQuery = xpraClientQuery(writable),
  recoverBridge = async () => bridge, onState = () => {}, onFailure, onFocus = () => {} }) {
  const { WebContentsView, session, ipcMain } = electron;
  if (typeof isActive !== 'function' || isActive() !== true || typeof capsuleSize !== 'function' ||
      typeof onFailure !== 'function') {
    throw Error('XPRA_HUMAN_LEASE_ABSENT');
  }
  const isolated = session.fromPartition(`xpra-human-${randomUUID()}`, { cache: false });
  let origin = bridge.origin;
  let websocketOrigin = origin.replace(/^http:/, 'ws:');
  /** @param {string} url */
  const localURL = url => url.startsWith(origin + '/') || url.startsWith(websocketOrigin + '/');
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
    done({ cancel: !isActive() || !localURL(details.url) });
  });
  isolated.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, done) => {
    if (!isActive() || !localURL(details.url)) { done({ cancel: true }); return; }
    done({ requestHeaders: { ...details.requestHeaders, ...bridge.requestHeaders } });
  });
  const view = new WebContentsView({ webPreferences: { session: isolated,
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: fileURLToPath(new URL('./xpraTracePreload.cjs', import.meta.url)),
    backgroundThrottling: false, webSecurity: true, allowRunningInsecureContent: false } });
  const wc = view.webContents;
  const focusedBefore = electron.webContents?.getFocusedWebContents?.();
  let focusMoved = false;
  const markFocusMoved = () => { focusMoved = true; };
  const focusEvents = ['before-input-event','before-mouse-event','blur'];
  const focusOwner = /** @type {import('node:events').EventEmitter} */ (window.webContents);
  for (const event of focusEvents) focusOwner?.on?.(event, markFocusMoved);
  window.on?.('blur', markFocusMoved);
  const stopFocusWatch = () => {
    for (const event of focusEvents) focusOwner?.removeListener?.(event, markFocusMoved);
    window.removeListener?.('blur', markFocusMoved);
  };
  // This contents has its own input scope. Ignore Electron menu accelerators
  // without cancelling the DOM event: Ctrl+Q/W/T must reach the remote desktop.
  wc.setIgnoreMenuShortcuts(true);
  const capturedDesktopKeys = new Set();
  wc.on('before-input-event', (event, input) => {
    wc.setIgnoreMenuShortcuts(true);
    interceptDesktopShortcut(event, input, window, capturedDesktopKeys, capsuleId);
  });
  // Defense in depth: the OS layer has already acknowledged readonly.
  if (!writable) {
    wc.on('before-input-event', event => event.preventDefault());
    wc.on('before-mouse-event', event => event.preventDefault());
  }
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', event => event.preventDefault());
  wc.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
  wc.on('will-redirect', event => event.preventDefault());
  wc.setZoomFactor(1);
  let detached = false;
  let failed = false;
  let failure = /** @type {Error & {code:string}|undefined} */ (undefined);
  let recovery = /** @type {ReturnType<typeof createXpraRecovery>|undefined} */ (undefined);
  const live = () => !detached && !failed && isActive();
  /** @param {string} code */
  function fail(code) {
    if (detached || failed) return;
    failed = true;
    recovery?.stop();
    trace.setActive(false);
    const error = Object.assign(Error(code), {code});
    failure = error;
    // Remove the failed contents so the parent's typed error and Reopen action
    // can be seen. The host closes the bridge; never quit the app here.
    void close().then(() => onFailure(error), () => onFailure(error));
  }
  wc.on('render-process-gone', () => fail('XPRA_VIEW_CRASHED'));
  wc.on('unresponsive', () => fail('XPRA_VIEW_UNRESPONSIVE'));
  /** @param {string} state */
  function publish(state) {
    if (!live()) return;
    trace.setActive(state === 'ready');
    onState(state);
    void wc.executeJavaScript(`{const overlay=document.getElementById('metaviewer-reconnecting');if(overlay){overlay.hidden=${state === 'ready'};overlay.textContent=${JSON.stringify(state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…')};}}`)
      .catch(() => {});
  }
  /** @param {{x:number,y:number,width:number,height:number}} rect */
  function resize(rect) {
    if (detached) throw Error('XPRA_VIEW_CLOSED');
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(value => Number.isSafeInteger(value)) ||
        rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1) throw Error('XPRA_BOUNDS_REFUSED');
    // The capsule stays fixed; fit its native viewport inside this tile only.
    const size = capsuleSize();
    if (size.width !== 1280 || size.height !== 900) throw Error('XPRA_FIXED_SIZE_REQUIRED');
    wc.setZoomFactor(1);
    view.setBounds(rect);
  }
  /** @type {Set<string>} */
  const droppedCodes = new Set();
  /** @param {import('electron').IpcMainEvent} event @param {Record<string,any>} row */
  const onTrace = (event, row) => {
    if (detached || !isActive() || event.sender !== wc || event.senderFrame !== wc.mainFrame ||
        !wc.getURL().startsWith(origin + '/')) return;
    try {
      const size = capsuleSize();
      if (!writable) return;
      trace.record(row, { width: row.width, height: row.height,
        capsuleWidth: size.width, capsuleHeight: size.height }, axContext());
    } catch (error) {
      // One malformed input event (a drag leaving the page, an extra mouse
      // button) is dropped, not fatal: the input still reached the capsule.
      const code = error instanceof Error ? error.message : '';
      if (DROPPABLE_TRACE_CODES.has(code)) {
        if (!droppedCodes.has(code)) {
          droppedCodes.add(code);
          console.info(`METAVIEWER_XPRA_TRACE_DROPPED code=${code}`);
        }
        return;
      }
      // Recording failure revokes the view and its open WebSocket. The host
      // must retain blocked core ownership; never resume an agent on this path.
      console.info(`METAVIEWER_XPRA_TRACE_FATAL code=${/^TRACE_[A-Z_]{1,40}$/.test(code) ? code : 'UNKNOWN'}`);
      fail('XPRA_TRACE_FAILED');
    }
  };
  ipcMain.on('metaviewer:human-trace.v0.3', onTrace);
  function bringToFront() {
    if (detached) return;
    window.contentView.removeChildView(view);
    window.contentView.addChildView(view);
  }
  wc.on('focus', () => { if (!detached) {bringToFront();onFocus();} });
  async function close() {
    if (detached) return;
    detached = true;
    stopFocusWatch();
    recovery?.stop();
    trace.setActive(false);
    ipcMain.removeListener('metaviewer:human-trace.v0.3', onTrace);
    try { window.contentView.removeChildView(view); } catch { /* parent already closed */ }
    if (wc.isDestroyed?.() !== true) wc.close();
    isolated.webRequest.onBeforeRequest(null);
    isolated.webRequest.onBeforeSendHeaders(null);
    await isolated.clearStorageData();
  }
  try {
    // Insertion can fail during window teardown; it shares the cleanup gate.
    view.setVisible(initiallyVisible);
    window.contentView.addChildView(view);
    onState('connecting');
    resize(bounds);
    if (clientQuery && !/^\?[a-zA-Z0-9_=&.-]+$/.test(clientQuery)) throw Error('XPRA_QUERY_REFUSED');
    await wc.loadURL(origin + '/metaviewer-tile.html' + clientQuery);
    await waitForXpraClient(wc, {writable, rawKeyboard, isActive:live});
    if (!live()) throw Error('XPRA_HUMAN_LEASE_LOST');
    publish('ready');
    if (writable && initiallyVisible && !focusMoved
        && electron.webContents?.getFocusedWebContents?.() === focusedBefore) wc.focus();
    stopFocusWatch();
    recovery = createXpraRecovery({isActive:live,
      probe:async () => {
        // Bound a stalled renderer evaluation as well as a false result.
        let timer;
        try {
          return await Promise.race([wc.executeJavaScript(xpraReadyExpression(writable,rawKeyboard)),
            new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]) === true;
        } finally { clearTimeout(timer); }
      },
      reconnect:async () => {
        const nextBridge = await recoverBridge();
        if (!live()) throw Error('XPRA_HUMAN_LEASE_LOST');
        bridge = nextBridge;
        origin = bridge.origin;
        websocketOrigin = origin.replace(/^http:/, 'ws:');
        // Reload through the same authenticated request hook. A replacement
        // bridge supplies a fresh origin and capability, never a cached token.
        await wc.loadURL(origin + '/metaviewer-tile.html' + clientQuery);
        publish('reconnecting');
        await waitForXpraClient(wc, {writable, rawKeyboard, isActive:live});
      }, onState:publish});
    return Object.freeze({ view, resize, close, bringToFront,
      /** @param {boolean} visible */
      setVisible(visible) { if (!detached) view.setVisible(visible); } });
  } catch (error) { await close(); throw failure || error; }
  finally { stopFocusWatch(); }
}
