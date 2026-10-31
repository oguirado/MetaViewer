// PKG-FIX main.js seams: packaged identity tool path vs staged resources (ID-01/B1),
// Ctrl+Q quit (QC-05), window hidden before bridge teardown (QC-04), adapter stop
// grace above the adapter's closeManager budget (QC-03). Each guard has a mutant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ADAPTER_SHUTDOWN_GRACE_MS,
  CHANNELS,
  ELECTRON_PIN,
  PRIVILEGED_ORIGIN,
  isQuitShortcut,
  resolveIdentityTool,
} from '../electron/main.js';
import { OPERATOR_RESOURCES } from '../tools/package.js';

const mainSource = () => readFile(new URL('../electron/main.js', import.meta.url), 'utf8');

test('PKG-FIX ID-01/B1 packaged identity tool resolves to a staged resources/operator file (with pre-fix mutant)', async () => {
  const resources = '/opt/MetaViewer-linux-arm64/resources';
  const rendererRoot = join(resources, 'app.asar', 'dist', 'renderer');
  const staged = OPERATOR_RESOURCES.map(r => `operator/${r}`);
  const packaged = resolveIdentityTool({packaged: true, resourcesPath: resources, rendererRoot});
  assert.ok(staged.includes(relative(resources, packaged)), packaged);
  // process.resourcesPath absent: the asar layout still yields the staged file.
  assert.equal(resolveIdentityTool({packaged: true, resourcesPath: undefined, rendererRoot}), packaged);
  // Development launches keep the checkout tool above ui/dist/renderer.
  assert.equal(resolveIdentityTool({packaged: false, resourcesPath: resources, rendererRoot: '/repo/ui/dist/renderer'}),
    '/repo/tools/mv_identity.py');
  // Mutant: the pre-fix formula for packaged launches points outside the staged set.
  const prefix = resolveIdentityTool({packaged: false, resourcesPath: resources, rendererRoot});
  assert.equal(staged.includes(relative(resources, prefix)), false);
  const source = await mainSource();
  assert.match(source, /tool: resolveIdentityTool\(\{ packaged: packagedLaunch, resourcesPath: process\.resourcesPath, rendererRoot: paths\.rendererRoot \}\)/);
  assert.doesNotMatch(source, /tool: resolve\(paths\.rendererRoot/);
});

test('PKG-FIX QC-05 quit shortcut accepts only a plain Ctrl+Q key-down (with mutant)', () => {
  const yes = [{type: 'keyDown', control: true, key: 'q'}, {type: 'keyDown', control: true, key: 'Q', alt: false, shift: false, meta: false}];
  const no = [null, 'q', {type: 'keyUp', control: true, key: 'q'}, {type: 'keyDown', control: false, key: 'q'},
    {type: 'keyDown', control: true, shift: true, key: 'Q'}, {type: 'keyDown', control: true, alt: true, key: 'q'},
    {type: 'keyDown', control: true, meta: true, key: 'q'}, {type: 'keyDown', control: true, key: 'w'}];
  for (const input of yes) assert.equal(isQuitShortcut(input), true, JSON.stringify(input));
  for (const input of no) assert.equal(isQuitShortcut(input), false, JSON.stringify(input));
  const mutant = new Function(`return (${isQuitShortcut.toString().replace("i.shift !== true && ", '')})`)();
  assert.equal(mutant({type: 'keyDown', control: true, shift: true, key: 'Q'}), true);
});

test('PKG-FIX QC-03 adapter stop grace exceeds the adapter closeManager budget (with mutant)', async () => {
  const go = await readFile(new URL('../../daemon-adapter/internal/daemon/environment.go', import.meta.url), 'utf8');
  const close = go.slice(go.indexOf('func (s *helloState) closeManager('));
  // DAM-FIX moved the literal into the named constant closeManagerBudget; read either form, same value check.
  const named = /closeManagerBudget\s*=\s*(\d+)\s*\*\s*time\.Second/.exec(go);
  const budget = named && close.slice(0, 600).includes('closeManagerBudget') ? named
    : /context\.WithTimeout\(ctx, (\d+)\*time\.Second\)/.exec(close.slice(0, 400));
  assert.ok(budget, 'closeManager budget not found');
  const closeMs = Number(budget[1]) * 1000;
  // [TARGET] at least 10 s of margin for recorder/view/publisher close after the destroys.
  const admitted = graceMs => graceMs >= closeMs + 10000;
  assert.equal(admitted(ADAPTER_SHUTDOWN_GRACE_MS), true);
  assert.equal(admitted(30000), false, 'mutant: the pre-fix equal budget');
  assert.match(await mainSource(), /limits: \{shutdownTimeoutMs: ADAPTER_SHUTDOWN_GRACE_MS\}/);
});

async function fixture(baseDir) {
  const root = join(baseDir, 'shell');
  const xdg = join(baseDir, 'xdg');
  await mkdir(join(root, 'dist', 'renderer'), {recursive: true});
  await mkdir(join(root, 'dist', 'preload'), {recursive: true});
  await writeFile(join(root, 'dist', 'renderer', 'index.html'), '<!doctype html><title>MetaViewer</title>');
  await writeFile(join(root, 'dist', 'preload', 'preload.cjs'), '"use strict";\n');
  await mkdir(xdg, {recursive: true, mode: 0o700});
  await chmod(xdg, 0o700);
  /** @type {string[]} */
  const calls = [];
  /** @type {Map<string, Function>} */
  const contentsListeners = new Map();
  const webContents = {
    id: 7,
    mainFrame: {url: `${PRIVILEGED_ORIGIN}/index.html`, origin: PRIVILEGED_ORIGIN, parent: null, routingId: 10, processId: 20},
    isDestroyed: () => false,
    session: {setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}},
    setWindowOpenHandler: () => {},
    on: (/** @type {string} */ name, /** @type {Function} */ fn) => { contentsListeners.set(name, fn); },
    setUserAgent: () => {},
    loadURL: async () => {},
    send: () => {},
  };
  class StubWindow {
    constructor() { this.webContents = webContents; }
    once() {}
    show() { calls.push('window.show'); }
    hide() { calls.push('window.hide'); }
    destroy() { calls.push('window.destroy'); }
  }
  const status = {availability: /** @type {const} */ ('live'), pid: 4141, authority_epoch: 1, reason: null};
  const handles = {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      on: () => {},
      quit: () => { calls.push('app.quit'); },
      getAppPath: () => root,
      getPath: () => join(root, 'user-data'),
    },
    BrowserWindow: StubWindow,
    ipcMain: {handle: () => {}, removeHandler: () => {}},
    protocol: {registerSchemesAsPrivileged: () => {}, handle: () => {}, unhandle: () => { calls.push('protocol.unhandle'); }},
    session: {defaultSession: {setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}}},
    electronVersion: ELECTRON_PIN,
    shellRoot: root,
    argv: ['metaviewer'],
    env: {},
    runtime: {xdgRuntimeDir: xdg, uid: typeof process.getuid === 'function' ? process.getuid() : 1000},
    core: {start: async () => status, request: async (/** @type {unknown} */ m) => ({echo: m}),
      dispose: async () => { calls.push('core.dispose'); }, getStatus: () => status},
    bridge: [
      {channel: CHANNELS.load, decode: () => null, invoke: async () => null},
      {channel: CHANNELS.save, decode: (/** @type {unknown} */ v) => v, invoke: async () => true},
    ],
    geometry: {width: 1280, height: 720},
  };
  return {handles, calls, contentsListeners};
}

/** Import main.js, optionally mutated, from a temp copy wired to the real sibling modules. */
async function importMain(base, from = null, to = '') {
  const url = new URL('../electron/main.js', import.meta.url);
  let src = await readFile(url, 'utf8');
  if (from !== null) {
    const mutated = src.replace(from, to);
    assert.notEqual(mutated, src, `mutant did not apply: ${from}`);
    src = mutated;
  }
  const dir = new URL('../electron/', import.meta.url).href;
  src = src.replaceAll('import.meta.url', JSON.stringify(url.href))
    .replaceAll("from './", `from '${dir}`).replaceAll("import('./", `import('${dir}`);
  const file = join(base, `main-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(file, src);
  return import(pathToFileURL(file).href);
}

/** Boot one main module on the stub handles, press keys, dispose; report what happened. */
async function quitScenario(base, mod) {
  const {handles, calls, contentsListeners} = await fixture(base);
  const boot = await mod.bootProductionMain(/** @type {any} */ (handles));
  const onKey = contentsListeners.get('before-input-event');
  let prevented = 0;
  const event = {preventDefault: () => { prevented += 1; }};
  onKey?.(event, {type: 'keyDown', control: false, key: 'q'});
  const plainQuit = calls.includes('app.quit') || prevented > 0;
  onKey?.(event, {type: 'keyDown', control: true, key: 'q'});
  const ctrlQuit = calls.filter(c => c === 'app.quit').length === 1 && prevented === 1;
  await boot.dispose();
  const hide = calls.indexOf('window.hide');
  const hiddenFirst = hide >= 0 && hide < calls.indexOf('window.destroy') && hide < calls.indexOf('protocol.unhandle');
  return {listener: typeof onKey === 'function', plainQuit, ctrlQuit, hiddenFirst};
}

test('PKG-FIX QC-05 + QC-04 booted main: Ctrl+Q quits through will-quit; unwind hides the window before teardown (with mutants)',
  {timeout: 60000}, async () => {
    const base = await mkdtemp(join(tmpdir(), 'mv-pkgfix-main-'));
    try {
      const ok = await quitScenario(join(base, 'real'), await importMain(base));
      assert.deepEqual(ok, {listener: true, plainQuit: false, ctrlQuit: true, hiddenFirst: true});
      const noShortcut = await quitScenario(join(base, 'm1'), await importMain(base, "'before-input-event',", "'pkgfix-mutant',"));
      assert.equal(noShortcut.ctrlQuit, false);
      const noHide = await quitScenario(join(base, 'm2'), await importMain(base,
        '/** @type {{hide?: () => void}} */ (/** @type {unknown} */ (window)).hide?.();', ''));
      assert.equal(noHide.hiddenFirst, false);
    } finally { await rm(base, {recursive: true, force: true}); }
    // Source-order witness: the hide precedes the operator bridge teardown (a demo stop waits up to 10 s [CITED]),
    // and a failing operator teardown can no longer skip the window destroy.
    const source = await mainSource();
    const unwind = source.slice(source.indexOf('const unwind = async () => {'));
    const hideAt = unwind.indexOf('.hide?.()');
    assert.ok(hideAt > 0 && unwind.indexOf('await operatorBridge?.dispose();') > hideAt);
    assert.match(unwind.slice(0, unwind.indexOf('operatorBridge=null;')), /try \{\s*await operatorBridge\?\.dispose\(\);\s*\} catch \{/);
  });
