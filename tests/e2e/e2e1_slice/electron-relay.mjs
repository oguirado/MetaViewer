// [TARGET, unit decision] Real authority/preload/projection/tile path, local host.
import { app, BrowserWindow, MessageChannelMain, protocol, net, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sep, dirname, join } from 'node:path';
import { deliverAuthorityFrame, WIRE_CHANNELS } from '../../../ui/electron/authorityWire.js';
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const deadline = setTimeout(() => { console.log(JSON.stringify({error:'renderer timeout',stage})); app.exit(1); }, 15000);
const streams = new Set();
let stage = 'startup';
void probe();
async function probe() {
try {
  await app.whenReady();stage='app-ready';
  const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
  protocol.handle('app', request => {
    const url = new URL(request.url);
    const path = fileURLToPath(new URL(request.url.replace(/^app:\/\/metaviewer/, pathToFileURL(root).href)));
    if (url.host !== 'metaviewer' || !path.startsWith(root + sep)) return new Response('',{status:403});
    return net.fetch(pathToFileURL(path).href);
  });
  const {frame, surface} = JSON.parse(await readFile(process.env.MV_E2E_FRAME_FIXTURE, 'utf8'));
  const bytes = new Uint8Array(await readFile(frame.ramws_path));
  const binding = {principal:'ui',epoch:1,surfaceId:frame.surface_id,surfaceGeneration:1};
  const readerOptions = {binding,
    limits:{maxFrameBytes:64*1024*1024,maxWidth:4096,maxHeight:4096,readTimeoutMs:1000,maxConcurrentReads:1},
    pixelEnvironment:{environmentId:'mv-live-1',zoom:1,dpr:1},onReleaseLease(){},
    acquirePublishedLease:async()=>({identity:{...binding,frameGeneration:frame.generation,leaseId:'live-frame'},
      published:true,byteLength:bytes.length,readOwnedBytes:async()=>bytes,release:async()=>{}})};
  const preload = join(dirname(process.env.MV_E2E_FRAME_FIXTURE),'relay-preload.cjs');
  const source = await readFile(new URL('../../../ui/electron/preload.js',import.meta.url),'utf8');
  if (/^import\s|^export\s+(?!const |class |function )/m.test(source)) throw new Error('Preload bundling contract changed');
  await writeFile(preload,source.replace(/^export (?=const |class |function )/gm,''));
  const win = new BrowserWindow({show:false,webPreferences:{
    preload,
    sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message', event => { if(event.level === 'error') console.error(event.message); });
  win.webContents.on('preload-error', (_event, _path, error) => console.error(String(error)));
  const subscribed = new Promise(resolve => ipcMain.handle(WIRE_CHANNELS.subscribeFrames,()=>{resolve();return true;}));
  ipcMain.handle(WIRE_CHANNELS.unsubscribeFrames,()=>true);
  await win.loadURL('app://metaviewer/tests/e2e/e2e1_slice/relay.html');
  stage='loaded';
  await subscribed;stage='subscribed';
  const {port1,port2} = new MessageChannelMain();
  const delivered = await deliverAuthorityFrame({frameRef:frame,state:surface,readerOptions,
    portOptions:{port:port1,role:'sender',binding,
      limits:{maxFrameBytes:64*1024*1024,ackTimeoutMs:10000,maxSurfacesPerPort:1},
      onReleaseLease(){},onRevoke(){}},rendererPorts:[port2]},win.webContents,streams);
  if (!delivered) throw new Error('authority relay refused real frame');
  stage='delivered';
  const result = await win.webContents.executeJavaScript(`Promise.race([
    window.relayResult,
    new Promise((_,reject)=>setTimeout(()=>reject(JSON.stringify({
      error:'authority notice arrived without a rendered frame',origin:location.origin,
      stage:window.relayStage,noticeReceived:!!window.relayNotice,
      framePortReceived:!!window.relayPortReceived,rendererError:window.relayError
    })),2000))])`);
  if (!result.ok || result.sha256 !== frame.sha256 || result.generation !== frame.generation) throw new Error(JSON.stringify(result));
  console.log(JSON.stringify({electron:process.versions.electron,authority_delivered:delivered,tile:'PASS',...result}));
  for (const stream of streams) { await stream.reader.closeReader(); stream.port.revokeFramePort('SHUTDOWN'); }
  clearTimeout(deadline);app.exit(0);
} catch(error) {
  console.log(JSON.stringify({error:String(error),tile:'FAIL'}));
  clearTimeout(deadline);app.exit(1);
}
}
