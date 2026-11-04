// [TARGET, unit decision] A live adapter status fixture enables production's
// boot create; the socket fixture owns its surface and VERIFIED frame feed.
import assert from 'node:assert/strict';
import * as electron from 'electron';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod, rm, readdir } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
// Use the sealed production modules when the packaged artifact is supplied.
const shellRoot = process.env.MV_DISPLAY_E2E_SHELL_ROOT;
const moduleUrl = name => shellRoot?.endsWith('.asar')
  ? pathToFileURL(join(shellRoot, 'electron', name)).href
  : new URL('../electron/' + name, import.meta.url).href;
const bootStage = stage => process.stderr.write(`DISPLAY_E2E_BOOT stage=${stage}\n`);
bootStage('ENTRY');
const { findForbiddenEnv } = await import(moduleUrl('coreLauncher.js'));
bootStage('CORE_LAUNCHER');
const { createMainBindings } = await import(moduleUrl('hostBindings.js'));
bootStage('HOST_BINDINGS');
const { bootProductionMain, registerPrivilegedScheme, createLayoutBridge, DEFAULT_GEOMETRY, ELECTRON_PIN } = await import(moduleUrl('main.js'));
bootStage('MAIN_IMPORTED');

electron.app.disableHardwareAcceleration();
for (const flag of ['disable-gpu', 'disable-gpu-compositing', 'disable-dev-shm-usage']) electron.app.commandLine.appendSwitch(flag);
registerPrivilegedScheme(electron.protocol);
void run();
async function run() {
  let root, ram, boot, host, server, writer, fd, failed = false;
  let earlyOfferDropped = false, pulledBeforeSubscription = false;
  const sockets = new Set();
  const lostPorts = [];
  const deadline = setTimeout(() => electron.app.exit(1), 22000);
  try {
    root = await mkdtemp(join(tmpdir(), 'mv-display-e2e-'));
    ram = await mkdtemp('/dev/shm/mv-display-e2e-');
    await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
    await mkdir(join(ram, 'metaviewer/display'), { recursive: true, mode: 0o700 });
    const reg = component => ({ endpoint: { component, instance: component + '-test' }, hello: {
      schema: 'hello/v0.2', contract_version: 'v0.2', component, component_version: '0.1.1',
      component_commit: 'a'.repeat(40), dependencies: [],
    } });
    const config = { session_id: 'display-e2e', core: reg('core'), peers: [reg('ui')] };
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const width = 1280, height = 900;
    const pixels = Buffer.alloc(width * height * 3, 79);
    const framePath = join(ram, 'verified.rgb');
    await writeFile(framePath, pixels, { mode: 0o600 });
    const surface = { schema: 'surface/v0.2', surface_id: 'display-e2e', kind: 'browser', display: ':100',
      geometry: { w: width, h: height }, state: 'active', visibility: 'unfolded', control: 'human', profile_id: 'default' };
    let seq = 0, gen = 0, created = false, createCount = 0;
    server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      const send = body => socket.write(JSON.stringify({ schema: 'envelope/v0.2', msg_id: 'reply-' + (++seq),
        ts_ns: seq, from: config.core.endpoint, to: config.peers[0].endpoint,
        session_id: config.session_id, seq, nonce: 'nonce-' + seq, body }) + '\n');
      let verifiedTimer;
      socket.on('close', () => clearInterval(verifiedTimer));
      const sendVerified = () => send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: {
        schema: 'frame_ref/v0.2', surface_id: surface.surface_id, generation: ++gen, tick: gen,
        ts_ns: gen, width, height, format: 'rgb24', ramws_path: framePath,
        sha256: createHash('sha256').update(pixels).digest('hex'), capture_us: 301000,
      } } });
      let buffer = '';
      socket.on('data', b => {
        buffer += b;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const { body } = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
          if (body.schema === 'hello/v0.2') {
            send(config.core.hello);
          }
          else if (body.schema === 'surface_request/v0.2' && body.op === 'create') {
            createCount++;
            surface.profile_id = body.params.profile_id;
            created = true;
            send({ schema: 'surface_event/v0.2', event: 'created', data: { surface } });
          } else if (body.schema === 'surface_request/v0.2' && body.op === 'frame_subscribe' && created) {
            sendVerified();
            if (!verifiedTimer) verifiedTimer = setInterval(sendVerified, 500);
          }
        }
      });
    });
    server.listen(join(root, 'metaviewer/core.sock')); await once(server, 'listening');
    await chmod(join(root, 'metaviewer/core.sock'), 0o600);
    const env = { ...process.env, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root,
      MV_CORE_CONFIG: configPath, MV_DISPLAY_DIR: ram };
    for (const key of findForbiddenEnv(env)) delete env[key];
    delete env.MV_CORE_BOOTSTRAP;
    const header = Buffer.alloc(64);
    header.write('MVDISP1\0'); header.writeUInt32LE(width, 8); header.writeUInt32LE(height, 12);
    header.writeUInt32LE(width * 3, 16); header.writeUInt32LE(1, 20);
    // Match the Go tap's UnixNano generation; it exceeds JS safe integers.
    header.writeBigUInt64LE(BigInt(Date.now()) * 1000000n + 1n, 40);
    let publish;
    const startRing = () => {
      fd = openSync(join(ram, 'metaviewer/display/display-e2e.ring'), 'wx+', 0o600);
      writeSync(fd, Buffer.alloc(64 + pixels.length * 2));
      let count = 0n;
      publish = () => {
        count++;
        header.writeBigUInt64LE(count * 2n - 1n, 24); writeSync(fd, header, 0, 64, 0);
        const frame = Buffer.alloc(pixels.length, Number(count % 200n));
        writeSync(fd, frame, 0, frame.length, 64 + Number(count % 2n) * frame.length);
        header.writeBigUInt64LE(process.hrtime.bigint(), 32);
        header.writeBigUInt64LE(count * 2n, 24); writeSync(fd, header, 0, 64, 0);
      };
      publish(); writer = setInterval(publish, 1000 / 30);
    };
    bootStage('BINDINGS_START');
    host = await createMainBindings({ env });
    bootStage('BINDINGS_READY');
    assert.ok(shellRoot);
    electron.app.setPath('userData', join(root, 'profile'));
    const app = new Proxy(electron.app, { get(target, key) {
      if (key === 'getAppPath') return () => shellRoot;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    // Drop one early offer: subsequent authenticated pulls must recover it.
    function HarnessWindow(options) {
      const window = new electron.BrowserWindow(options);
      const post = window.webContents.postMessage.bind(window.webContents);
      window.webContents.postMessage = (channel, value, ports) => {
        if (!earlyOfferDropped && value?.schema === 'display_port/v1') {
          earlyOfferDropped = true;
          lostPorts.push(...ports);
          // Model the real R4 lost early offer before lazy tile binding.
          // Keep the endpoint alive: only a subsequent pull can recover it.
          return;
        }
        return post(channel, value, ports);
      };
      return window;
    }
    // Bind pulls must survive a missing frame subscription as well as a lost
    // early offer. The adapter fixture stays resident throughout this gap.
    electron.ipcMain.once('metaviewer:display-receiver-ready', () => {
      host.wire.display.setSubscribed(false);
    });
    electron.ipcMain.once('metaviewer:display-request', () => {
      host.wire.display.setSubscribed(false);
      pulledBeforeSubscription = true;
      setTimeout(() => host.wire.display.setSubscribed(true), 100);
    });
    const adapterStatus = { availability: 'live', pid: process.pid, handshakeSeen: true,
      code: 'ADAPTER_LIVE', reason: null, userMessage: null };
    const adapter = { start: async () => adapterStatus, getStatus: () => adapterStatus,
      dispose: async () => {} };
    boot = await bootProductionMain({ core: host.core, wire: host.wire, adapter, electronVersion: ELECTRON_PIN,
      app, BrowserWindow: HarnessWindow, ipcMain: electron.ipcMain, protocol: electron.protocol,
      session: electron.session, argv: [], env, shellRoot,
      runtime: { xdgRuntimeDir: root, uid: process.getuid() }, geometry: DEFAULT_GEOMETRY,
      bridge: createLayoutBridge({ directory: join(root, 'layout') }) });
    const contents = boot.window.webContents;
    // Production already creates and reserves the boot profile. A renderer
    // create would require another configured profile and an existing identity.
    const verifiedPainted = () => contents.executeJavaScript(`(() => {
      const tile = document.querySelector('.mv-dock-workspace__dockview .mv-surface');
      const canvas = tile?.querySelector('canvas');
      if (tile?.dataset.state !== 'live' || !canvas || tile.dataset.displayState) return false;
      return canvas.getContext('2d').getImageData(0, 0, 1, 1).data[0] === 79;
    })()`);
    for (let i = 0; i < 100 && !await verifiedPainted(); i++) {
      await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(createCount, 1, 'production boot creates exactly one surface');
    assert.ok(gen > 0, 'VERIFIED frames precede the late ring');
    assert.ok(await contents.executeJavaScript('!!document.querySelector(".mv-dock-workspace__dockview .mv-surface")'), 'production dockview mounted a real SurfaceCanvas');
    assert.ok(await verifiedPainted(), 'VERIFIED pixels paint before the late DISPLAY ring');
    startRing();
    for (let i = 0; i < 100; i++) {
      if (await contents.executeJavaScript('!!document.querySelector("[data-fps]")')) break;
      await new Promise(r => setTimeout(r, 30));
    }
    let fps = 0;
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 100));
      fps = await contents.executeJavaScript(`document.querySelector('[data-display-chip="unverified"]') ? Number(document.querySelector('[data-fps]').dataset.fps) : 0`);
      if (fps >= 20) break;
    }
    assert.equal(earlyOfferDropped, true);
    assert.equal(pulledBeforeSubscription, true, "fixture requires a bind pull before frames subscription");
    assert.ok(fps >= 20, `DISPLAY chip/paint fps=${fps}; ${await contents.executeJavaScript('document.body.innerText.slice(-2000)')}`);
    const routerAsset = (await readdir(join(shellRoot, 'dist/renderer/assets'))).find(name => /^displayPortRouter-.*\.js$/.test(name));
    assert.ok(routerAsset);
    await contents.executeJavaScript(`import('/assets/${routerAsset}').then(m => { window.displayHarnessRouter = m.getSharedDisplayPortRouter(); })`);
    const reads = () => host.wire.display.getReaderInstrumentation(surface.surface_id).readsAttempted;
    await contents.executeJavaScript(`window.displayHarnessRouter.setSurfaceVisible('display-e2e',false)`);
    await new Promise(r => setTimeout(r, 100));
    const hiddenReads = reads();
    await new Promise(r => setTimeout(r, 180));
    assert.equal(reads(), hiddenReads, 'hidden tile reads must park');
    await contents.executeJavaScript(`window.displayHarnessRouter.setSurfaceVisible('display-e2e',true)`);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(reads() > hiddenReads, 'shown tile must resume reads');
    // A stopped writer must become stale; VERIFIED alone cannot pass above.
    clearInterval(writer); writer = null;
    await new Promise(r => setTimeout(r, 2300));
    assert.equal(await contents.executeJavaScript('document.querySelector("[data-display-state]")?.dataset.displayState'), 'stale');
    await contents.executeJavaScript(`window.displayHarnessRouter.unbindSurface('display-e2e')`);
    await new Promise(r => setTimeout(r, 100));
    const parkedReads = reads();
    await new Promise(r => setTimeout(r, 180));
    assert.equal(reads(), parkedReads, 'unbound tile must have zero host reads');
    writer = setInterval(publish, 1000 / 30);
    await contents.executeJavaScript(`window.displayHarnessRouter.bindSurface({surfaceId:'display-e2e',onFrame:()=>true}); true`);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(reads() > parkedReads, 'rebound tile must resume reads');
    console.log(`DISPLAY_E2E_OK fps=${fps}`);
  } catch (error) { console.error(error); failed = true; }
  finally {
    clearTimeout(deadline); clearInterval(writer);
    if (fd !== undefined) closeSync(fd);
    electron.app.removeAllListeners('window-all-closed');
    await boot?.dispose(); await host?.core.dispose();
    for (const port of lostPorts) { try { port.close(); } catch {} }
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(r => server.close(r));
    try {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
      if (ram) await rm(ram, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    } catch (error) { console.error(error); failed = true; }
    finally { electron.app.exit(failed ? 1 : 0); }
  }
}
