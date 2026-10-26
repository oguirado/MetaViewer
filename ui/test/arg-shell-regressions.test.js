import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDisplay } from '../electron/nesting.js';
import { ELECTRON_PIN } from '../electron/main.js';
import { packageShell, validateOutput } from '../tools/package.js';
const execute = promisify(execFile);
const entry = new URL('../electron/nesting.js', import.meta.url).href;
const repo = fileURLToPath(new URL('../../', import.meta.url));

function mockElectron(root, mode) {
  let attempts = 0, destroyed = false;
  const webContents = { on() {}, setWindowOpenHandler() {}, isDestroyed: () => destroyed,
    async executeJavaScript() { attempts++; if (mode === 'destroy' && attempts === 2) destroyed = true; return mode === 'happy'; } };
  const win = { webContents, isDestroyed: () => destroyed, removeMenu() {}, show() {}, destroy() { destroyed = true; },
    loadURL: () => mode === 'hang' ? new Promise(() => {}) : Promise.resolve() };
  return { app: { setName() {}, enableSandbox() {}, requestSingleInstanceLock: () => true, whenReady: async () => {},
      getAppPath: () => root, on() {}, quit() {}, exit() {} },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} }, BrowserWindow: function () { return win; },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } }, ipcMain: { handle() {} } };
}
async function displayFixture(mode, callback) {
  const root = await mkdtemp(join(tmpdir(), 'mv-display-'));
  const old = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: ELECTRON_PIN, configurable: true });
  try { await mkdir(join(root, 'dist/renderer'), { recursive: true }); await callback(mockElectron(root, mode)); }
  finally { if (old) Object.defineProperty(process.versions, 'electron', old); else delete process.versions.electron; await rm(root, { recursive: true, force: true }); }
}

test('ARG-ui_shell-1 pre-ready APIs complete before top-level ESM settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-ordering-'));
  await mkdir(join(root, 'dist/renderer'), { recursive: true });
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    let ready = false, calls = [], readyNow;
    const mockElectron = ${mockElectron.toString()};
    const stub = mockElectron(${JSON.stringify(root)}, 'happy');
    stub.app.isPackaged = true;
    stub.app.enableSandbox = () => { assert.equal(ready, false); calls.push('sandbox'); };
    stub.protocol.registerSchemesAsPrivileged = () => { assert.equal(ready, false); calls.push('scheme'); };
    stub.app.whenReady = () => new Promise(resolve => { readyNow = resolve; });
    stub.app.exit = () => calls.push('exit');
    globalThis.electronStub = stub;
    const source = 'await new Promise(r => setTimeout(r, 30)); export const {app,protocol,BrowserWindow,session,ipcMain} = globalThis.electronStub;';
    registerHooks({ resolve(specifier, context, next) { return specifier === 'electron' ? { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true } : next(specifier, context); } });
    Object.defineProperty(process.versions, 'electron', {value: ${JSON.stringify(ELECTRON_PIN)}, configurable: true});
    process.argv = ['node', 'entry', '--nested-depth=1'];
    await import(${JSON.stringify(entry)});
    assert.deepEqual(calls, ['sandbox', 'scheme']);
    await new Promise(resolve => setImmediate(() => { ready = true; readyNow(); resolve(); }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['sandbox', 'scheme']);
  `;
  try {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, env: {} });
    assert.match(stdout, /METAVIEWER_NESTED_DISPLAY_READY/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ARG-ui_shell-7 destroyed polling rejects DISPLAY_ONLY promptly', { timeout: 5000 }, async () => {
  await displayFixture('destroy', async electron => {
    await assert.rejects(startDisplay(electron), /DISPLAY_ONLY/);
  });
});

test('ARG-ui_shell-7 stalled loadURL has a bounded startup deadline', { timeout: 20000 }, async () => {
  await displayFixture('hang', async electron => {
    await assert.rejects(startDisplay(electron), /DISPLAY_ONLY.*deadline/);
  });
});

test('ARG-ui_shell-7 happy display emits readiness marker', async () => {
  await displayFixture('happy', async electron => {
    const old = console.log, logs = [];
    console.log = message => logs.push(message);
    try { assert.ok(await startDisplay(electron)); } finally { console.log = old; }
    assert.deepEqual(logs, ['METAVIEWER_NESTED_DISPLAY_READY']);
  });
});

test('ARG-ui_shell-3 symlink overlap refuses before mkdir; external output remains allowed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-output-'));
  const name = `.arg-shell-probe-${root.split('/').at(-1)}`;
  const created = join(repo, name);
  try {
    await symlink(repo, join(root, 'alias'));
    await assert.rejects(packageShell({ MV_PKG_OUT: join(root, 'alias', name) }), /overlap/);
    await assert.rejects(access(created), { code: 'ENOENT' });
    assert.equal(validateOutput(join(root, 'outside'), repo), join(root, 'outside'));
  } finally { await rm(root, { recursive: true, force: true }); await rm(created, { recursive: true, force: true }); }
});
