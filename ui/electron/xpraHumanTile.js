// Native role view: separate sandboxed WebContentsView for native HTML5 input and pixels.
import { xpraClientQuery, waitForXpraClient } from './xpraClient.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Host owns geometry and the lease. No bridge capability enters renderer IPC.
 * @param {{electron:typeof import('electron'),window:import('electron').BrowserWindow,
 * bridge:Awaited<ReturnType<typeof import('./xpraHumanBridge.js').openXpraHumanBridge>>,
 * bounds:{x:number,y:number,width:number,height:number},
 * trace:ReturnType<typeof import('./humanTrace.js').createHumanTrace>,isActive:()=>boolean,writable?:boolean,
 * capsuleSize:()=>{width:number,height:number},
 * axContext?:()=>{sensitive?:boolean,password?:boolean,row?:number}|null,clientQuery?:string,onFailure:(error:unknown)=>void}} options
 */
export async function attachXpraHumanTile({ electron, window, bridge, bounds, trace,
  isActive, capsuleSize, writable = true, axContext = () => null, clientQuery = xpraClientQuery(writable), onFailure }) {
  const { WebContentsView, session, ipcMain } = electron;
  if (typeof isActive !== 'function' || isActive() !== true || typeof capsuleSize !== 'function' ||
      typeof onFailure !== 'function') {
    throw Error('XPRA_HUMAN_LEASE_ABSENT');
  }
  const isolated = session.fromPartition(`xpra-human-${randomUUID()}`, { cache: false });
  const origin = bridge.origin;
  const websocketOrigin = origin.replace(/^http:/, 'ws:');
  const filter = { urls: [`${origin}/*`, `${websocketOrigin}/*`] };
  /** @param {string} url */
  const localURL = url => url.startsWith(origin + '/') || url.startsWith(websocketOrigin + '/');
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
    done({ cancel: !isActive() || !localURL(details.url) });
  });
  isolated.webRequest.onBeforeSendHeaders(filter, (details, done) => {
    if (!isActive()) { done({ cancel: true }); return; }
    done({ requestHeaders: { ...details.requestHeaders, ...bridge.requestHeaders } });
  });
  const view = new WebContentsView({ webPreferences: { session: isolated,
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: fileURLToPath(new URL('./xpraTracePreload.cjs', import.meta.url)),
    webSecurity: true, allowRunningInsecureContent: false } });
  const wc = view.webContents;
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
      // Recording failure revokes the view and its open WebSocket. The host
      // must retain blocked core ownership; never resume an agent on this path.
      trace.setActive(false);
      void close().then(() => bridge.close()).then(() => onFailure(error), () => onFailure(error));
    }
  };
  ipcMain.on('metaviewer:human-trace.v0.3', onTrace);
  window.contentView.addChildView(view);
  async function close() {
    if (detached) return;
    detached = true;
    trace.setActive(false);
    ipcMain.removeListener('metaviewer:human-trace.v0.3', onTrace);
    try { window.contentView.removeChildView(view); } catch { /* parent already closed */ }
    if (wc.isDestroyed?.() !== true) wc.close();
    isolated.webRequest.onBeforeRequest(null);
    isolated.webRequest.onBeforeSendHeaders(null);
    await isolated.clearStorageData();
  }
  try {
    resize(bounds);
    if (clientQuery && !/^\?[a-zA-Z0-9_=&.-]+$/.test(clientQuery)) throw Error('XPRA_QUERY_REFUSED');
    await wc.loadURL(origin + '/metaviewer-tile.html' + clientQuery);
    await waitForXpraClient(wc, {writable, isActive});
    if (!isActive()) throw Error('XPRA_HUMAN_LEASE_LOST');
    trace.setActive(true);
    if (writable) wc.focus();
    return Object.freeze({ view, resize, close });
  } catch (error) { await close(); throw error; }
}
