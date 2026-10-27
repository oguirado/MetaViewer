import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDisplay } from '../electron/nesting.js';
import { ELECTRON_PIN } from '../electron/main.js';

test('ARG-ui_shell-1 pre-ready policy runs during ESM evaluation before the next macrotask', async () => {
  const entry = new URL('../electron/nesting.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    Object.defineProperty(process.versions, 'electron', { value: ${JSON.stringify(ELECTRON_PIN)} });
    process.argv = ['node', 'packaged-entry', '--nested-depth=1'];
    delete process.env.NODE_OPTIONS;
    const calls = globalThis.calls = [];
    let ready = false;
    globalThis.handles = {
      app: { isPackaged: true, enableSandbox() { assert.equal(ready, false); calls.push('sandbox'); },
        setName() {}, requestSingleInstanceLock: () => true,
        whenReady() { return new Promise(() => { setImmediate(() => {
          ready = true;
          assert.deepEqual(calls, ['sandbox', 'scheme', 'evaluated']);
          console.log('ORDER_OK');
          process.exit(0);
        }); }); }, exit() { process.exitCode = 1; } },
      protocol: { registerSchemesAsPrivileged() { assert.equal(ready, false); calls.push('scheme'); } }
    };
    const stub = 'export const app = globalThis.handles.app; export const protocol = globalThis.handles.protocol;';
    registerHooks({ resolve(specifier, context, next) {
      return specifier === 'electron' ? { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true } : next(specifier, context);
    } });
    await import(${JSON.stringify(entry)});
    calls.push('evaluated');
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, env: {} });
  assert.match(result.stdout, /ORDER_OK/);
  assert.equal(result.stderr, '');
});

async function displayFixture({ stalled = false, destroyedAt = Infinity, contentsOnly = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mv-nested-Música-'));
  await mkdir(join(root, 'dist/renderer'), { recursive: true });
  let destroyed = false, attempts = 0, shown = false;
  const webContents = { on() {}, setWindowOpenHandler() {}, isDestroyed: () => destroyed,
    async executeJavaScript() {
      assert.equal(destroyed, false, 'poll must not touch destroyed contents');
      if (++attempts === destroyedAt) { destroyed = true; return false; }
      return attempts >= 3;
    } };
  class Window {
    constructor() { this.webContents = webContents; }
    removeMenu() {}
    isDestroyed() { return contentsOnly ? false : destroyed; }
    destroy() { destroyed = true; }
    async loadURL() { if (stalled) await new Promise(() => {}); }
    show() { shown = true; }
  }
  return { electron: { app: { setName() {}, requestSingleInstanceLock: () => true,
    whenReady: async () => {}, getAppPath: () => root, on() {}, quit() {}, exit() {} },
    BrowserWindow: Window, protocol: { handle() {} }, ipcMain: { handle() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } } },
    state: () => ({ destroyed, attempts, shown }), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('ARG-ui_shell-7 display startup bounds navigation, guards destroyed handles and logs readiness', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: ELECTRON_PIN, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor);
    else delete process.versions.electron;
  });
  for (const contentsOnly of [false, true]) {
    const f = await displayFixture({ destroyedAt: 2, contentsOnly });
    const before = performance.now();
    try {
      await assert.rejects(startDisplay(f.electron), /DISPLAY_ONLY/);
      assert.ok(performance.now() - before < 5000);
      assert.equal(f.state().attempts, 2);
    } finally { await f.cleanup(); }
  }
  const stalled = await displayFixture({ stalled: true });
  const before = performance.now();
  try {
    await assert.rejects(startDisplay(stalled.electron), /DISPLAY_ONLY.*deadline/);
    assert.ok(performance.now() - before <= 20000);
    assert.equal(stalled.state().destroyed, true);
    assert.equal(stalled.state().shown, false);
  } finally { await stalled.cleanup(); }
  const happy = await displayFixture();
  const messages = [], log = console.log;
  console.log = message => messages.push(message);
  try {
    await startDisplay(happy.electron);
    assert.equal(happy.state().shown, true);
    assert.deepEqual(messages, ['METAVIEWER_NESTED_DISPLAY_READY']);
  } finally { console.log = log; await happy.cleanup(); }
});
