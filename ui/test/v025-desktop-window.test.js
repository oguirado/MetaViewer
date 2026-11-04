/**
 * V025-WINDOW-MV suite: Desktop window catalog kind, window picker (list, search,
 * explicit Add), MetaViewer PID exclusion (`srf-host-window list --exclude-pid`),
 * attach without container/Xvfb or display pool slot, immediate one-click Stop
 * detach outside any AI path, visible indicator ("Real desktop — not isolated"),
 * minimized waiting state, closed/witness-mismatch termination without silent
 * rebind, and mutant kills.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as catalogModel from '../src/catalog/catalogModel.js';
import * as roleHostMod from '../electron/roleHost.js';
import * as openingModeMod from '../electron/openingMode.js';
import { createOverlayCoordinator } from '../src/surfaces/overlayCoordinator.js';
import { createHiddenSessionPool } from '../src/surfaces/hiddenSessions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_MODEL_PATH = join(HERE, '../src/catalog/catalogModel.js');
const CATALOG_LAUNCHER_PATH = join(HERE, '../src/catalog/CatalogLauncher.vue');
const APP_PATH = join(HERE, '../src/App.vue');
const ROLE_HOST_PATH = join(HERE, '../electron/roleHost.js');
const ROLE_SURFACE_PATH = join(HERE, '../src/surfaces/RoleSurface.vue');

let roleSurfaceSerial = 0;

function createWindowLauncherHarness(sfcSource, modelMod, apiDouble = null) {
  const { descriptor } = parse(sfcSource);
  const compiled = compileScript(descriptor, { id: 'v025-catalog' });
  const script = descriptor.scriptSetup.content;
  const fns = compiled.scriptSetupAst
    .filter((n) => n.type === 'FunctionDeclaration')
    .map((n) => script.slice(n.start, n.end))
    .join('\n');
  const events = [];
  const ctx = {
    props: { visible: true },
    disabledArmKinds: { get value() { return modelMod.unavailableArmCapsules(ctx.props.arm64Capabilities); } },
    buildCreateIntent: modelMod.buildCreateIntent,
    normalizeWindowList: modelMod.normalizeWindowList,
    filterWindowCandidates: modelMod.filterWindowCandidates,
    api: apiDouble,
    globalThis: { metaviewerRoles: apiDouble },
    pendingIntent: { value: null },
    roleChoice: { value: 'agent' },
    profileChoice: { value: '' },
    choosingRole: { value: false },
    roleError: { value: '' },
    choosingProgram: { value: false },
    programBinary: { value: '' },
    programError: { value: '' },
    programBusy: { value: false },
    choosingWindow: { value: false },
    windowSearch: { value: '' },
    windowChoices: { value: [] },
    windowChoiceXid: { value: 0 },
    windowError: { value: '' },
    windowBusy: { value: false },
    get filteredWindows() {
      return { value: modelMod.filterWindowCandidates(ctx.windowChoices.value, ctx.windowSearch.value) };
    },
    get selectedWindow() {
      return { value: ctx.windowChoices.value.find((w) => w.xid === ctx.windowChoiceXid.value) || null };
    },
    profileChoices: { value: [] },
    matchingProfiles: { get value() { return ctx.profileChoices.value; } },
    choiceGeneration: 0,
    emit: (...args) => events.push(args),
  };
  vm.createContext(ctx);
  vm.runInContext(fns, ctx);
  return { ctx, events, template: descriptor.template?.content ?? '' };
}

function createAppWindowHarness(appSource, rolesDouble) {
  const { descriptor } = parse(appSource);
  const compiled = compileScript(descriptor, { id: 'v025-app' });
  const script = descriptor.scriptSetup.content;
  const fnMap = Object.fromEntries(
    compiled.scriptSetupAst
      .filter((n) => n.type === 'FunctionDeclaration')
      .map((n) => [n.id.name, script.slice(n.start, n.end)]),
  );
  const revealed = [];
  const controlCalls = [];
  const views = [];
  const ctx = {
    nestedMode: { displayOnly: false },
    props: {
      authorityHost: {
        createSurface: async () => ({ code: 'INTENT_ACKNOWLEDGED', message: 'Request sent.', tone: 'success' }),
        propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p1', core_seq: 1, decision: 'admitted' }),
      },
      runtime: {
        intentBuilders: {
          control: ({ capsuleId, verb }) => ({ schema: 'ui_intent/v0.2', op: verb, params: { surface_id: capsuleId } }),
        },
      },
    },
    globalThis: { metaviewerRoles: rolesDouble },
    rows: { value: [] },
    wallInputPending: { value: {} },
    hostOutcome: { value: null },
    hostActive: true,
    activitySeq: 0,
    ACTIVITY_LIMIT: 8,
    activityFeed: { value: [] },
    pendingModeSwitch: { value: null },
    capsuleModes: { value: {} },
    selectGlobalView: (v) => views.push(v),
    nextTick: async () => {},
    revealOpenedIdentity: async (id, mode) => { revealed.push({ id, mode }); return true; },
    applyWallControl: (id, verb) => { controlCalls.push({ id, verb }); },
    reopenLiveSurfaces: () => false,
    emit: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(
    [fnMap.recordActivity, fnMap.submitHost, fnMap.createProgramCapsule, fnMap.createWindowCapsule, fnMap.onCreateCapsule]
      .filter(Boolean)
      .join('\n'),
    ctx,
  );
  return { ctx, revealed, controlCalls, views };
}

const walkNodes = (node) => [node, ...(node.children || []).flatMap(walkNodes)];
const nodeText = (node) => [node.text || '', ...(node.children || []).map(nodeText)].join(' ').trim();

async function compileRoleSurface(source) {
  const { descriptor } = parse(source);
  let code = compileScript(descriptor, { id: 'v025-rs-' + (++roleSurfaceSerial), inlineTemplate: true }).content;
  code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/^import\s+(.+?)\s+from\s+(['"])(.*?)\2;?/gm, (line, _binding, _q, path) =>
    path === 'vue' ? line.replace(/(['"])vue\1/, JSON.stringify(import.meta.resolve('vue'))) : line);
  return (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64') + '#' + roleSurfaceSerial)).default;
}

function mountRoleSurface(Component, props = {}, providers = {}, slots = {}) {
  const node = (tag) => ({
    tag,
    children: [],
    props: {},
    parent: null,
    style: {},
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 700, height: 500 }),
    getClientRects: () => [1],
  });
  const renderer = vue.createRenderer({
    createElement: node,
    createText: (value) => ({ ...node('#text'), text: value }),
    createComment: () => node('#comment'),
    setText(n, value) { n.text = value; },
    setElementText(n, value) { n.text = value; n.children = []; },
    patchProp(n, key, _previous, value) { n.props[key] = value; },
    insert(n, parent, anchor) {
      if (n.parent) this.remove(n);
      n.parent = parent;
      const at = parent.children.indexOf(anchor);
      parent.children.splice(at < 0 ? parent.children.length : at, 0, n);
    },
    remove(n) {
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      n.parent = null;
    },
    parentNode: (n) => n.parent,
    nextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
    setScopeId() {},
    querySelector: () => null,
  });
  const root = node('root');
  const app = renderer.createApp({ render: () => vue.h(Component, props, slots) });
  for (const [key, value] of Object.entries(providers)) app.provide(key, value);
  app.mount(root);
  return { root, app };
}

async function runWindowProbes({
  model = catalogModel,
  launcherSource = readFileSync(CATALOG_LAUNCHER_PATH, 'utf8'),
  appSource = readFileSync(APP_PATH, 'utf8'),
  roleHost = roleHostMod,
  roleSurfaceSource = readFileSync(ROLE_SURFACE_PATH, 'utf8'),
} = {}) {
  const failed = [];
  const check = async (name, fn) => {
    try {
      if ((await fn()) !== true) failed.push(name);
    } catch {
      failed.push(name);
    }
  };

  const sampleWindows = [
    { xid: 0x04a00003, witness: '0x04a00003:1730541000', title: 'Chromium — Logged In', program: 'chromium', width: 1280, height: 900 },
    { xid: 0x04a00009, witness: '0x04a00009:1730541009', title: 'Signal Desktop', program: 'signal-desktop', width: 1024, height: 768 },
  ];

  // 1. Catalog model: desktop-window kind, whole-list fail-closed normalization, search filter, and frozen intent.
  await check('catalog-window-model', () => {
    const resolved = model.resolveCatalogKind('desktop-window');
    if (!resolved.ok || resolved.type.label !== 'Desktop window' || resolved.type.category !== 'Windows') return false;

    const listOk = model.normalizeWindowList(sampleWindows);
    if (!listOk.ok || listOk.windows.length !== 2 || !Object.isFrozen(listOk.windows)) return false;

    // Whole-list fail-closed on malformed row or duplicate xid / witness.
    const dupXid = model.normalizeWindowList([sampleWindows[0], { ...sampleWindows[1], xid: sampleWindows[0].xid }]);
    const dupWitness = model.normalizeWindowList([sampleWindows[0], { ...sampleWindows[1], witness: sampleWindows[0].witness }]);
    const badRow = model.normalizeWindowList([sampleWindows[0], { xid: 0, witness: '', title: '', program: '' }]);
    if (dupXid.ok || dupWitness.ok || badRow.ok) return false;

    // Search filters by title and program case-insensitively.
    const byTitle = model.filterWindowCandidates(listOk.windows, 'logged in');
    const byProg = model.filterWindowCandidates(listOk.windows, 'SIGNAL');
    if (byTitle.length !== 1 || byTitle[0].xid !== 0x04a00003) return false;
    if (byProg.length !== 1 || byProg[0].xid !== 0x04a00009) return false;

    // Intent requires explicit window selection and freezes both intent and window.
    const noWin = model.buildCreateIntent({ kind: 'desktop-window', placement: 'tab' });
    if (noWin.ok) return false;
    const built = model.buildCreateIntent({ kind: 'desktop-window', placement: 'tab', window: sampleWindows[0] });
    return built.ok === true
      && built.intent.kind === 'desktop-window'
      && built.intent.window.xid === 0x04a00003
      && built.intent.window.witness === '0x04a00003:1730541000'
      && Object.isFrozen(built.intent)
      && Object.isFrozen(built.intent.window);
  });

  // 2. CatalogLauncher: opening Desktop window lists open windows, requires explicit row click + Add click, and propagates refusals.
  await check('launcher-window-picker-and-explicit-add', async () => {
    const h = createWindowLauncherHarness(launcherSource, model, {
      listWindows: async () => sampleWindows,
    });
    if (!h.template.includes('id="shell/new-capsule/window-dialog"')
        || !h.template.includes('id="shell/new-capsule/window-search"')
        || !h.template.includes('id="shell/new-capsule/window-add"')
        || !h.template.includes(':disabled="windowBusy || !selectedWindow"')) {
      return false;
    }
    await h.ctx.onCreate({ type: { id: 'desktop-window' }, placement: 'tab' });
    if (!h.ctx.choosingWindow.value || h.ctx.windowChoices.value.length !== 2 || h.ctx.selectedWindow.value !== null) {
      return false;
    }
    // Confirming without selecting a window is refused and emits nothing.
    await h.ctx.confirmWindow();
    if (h.events.length !== 0 || !h.ctx.windowError.value) return false;

    // Selecting a row alone never emits 'create'.
    h.ctx.selectWindowRow(sampleWindows[1].xid);
    if (h.events.length !== 0 || h.ctx.selectedWindow.value?.xid !== sampleWindows[1].xid) return false;

    // Clicking Add emits 'create' with the selected window and closes on ok:true.
    h.ctx.emit = (ev, payload, settle) => {
      h.events.push([ev, payload]);
      if (ev === 'create') settle?.({ ok: true, surfaceId: 'surface-hw-1' });
    };
    await h.ctx.confirmWindow();
    const createEv = h.events.find(([e]) => e === 'create');
    return Boolean(createEv)
      && createEv[1].kind === 'desktop-window'
      && createEv[1].window.xid === sampleWindows[1].xid
      && h.ctx.choosingWindow.value === false;
  });

  // 3. srf-host-window list excludes MetaViewer's own PID and fails closed on refusal or duplicate rows.
  await check('srf-host-window-list-excludes-pid-and-fails-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v025-list-'));
    try {
      const binDir = join(root, 'bin');
      await mkdir(binDir, { mode: 0o700 });
      const toolPath = join(binDir, 'srf-host-window');
      const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== 'list' || args[1] !== '--exclude-pid' || !args[2]) {
  process.stderr.write('host_window_unavailable: missing --exclude-pid\\n');
  process.exit(2);
}
if (process.env.FAKE_HW_MODE === 'refuse') {
  process.stderr.write('host_window_unavailable: X11 display unreachable\\n');
  process.exit(2);
}
if (process.env.FAKE_HW_MODE === 'dup') {
  process.stdout.write(JSON.stringify([
    { xid: 100, witness: 'w1', title: 'A', program: 'a', width: 800, height: 600 },
    { xid: 100, witness: 'w2', title: 'B', program: 'b', width: 800, height: 600 }
  ]));
  process.exit(0);
}
const excluded = Number(args[2]);
const all = [
  { xid: 999, witness: 'w-self', title: 'MetaViewer', program: 'electron', width: 1280, height: 900, pid: excluded },
  { xid: 77594627, witness: '0x04a00003:1730541000', title: 'Chromium — Logged In', program: 'chromium', width: 1280, height: 900, pid: excluded + 10 }
];
process.stdout.write(JSON.stringify(all));
`;
      await writeFile(toolPath, script);
      await chmod(toolPath, 0o755);

      const list = await roleHost.listHostWindows({ env: { ...process.env, MV_SRF_BIN_DIR: binDir }, excludePid: 4242 });
      if (list.length !== 1 || list[0].xid !== 77594627 || list[0].title !== 'Chromium — Logged In') return false;

      let refusedErr = null;
      try {
        await roleHost.listHostWindows({ env: { ...process.env, MV_SRF_BIN_DIR: binDir, FAKE_HW_MODE: 'refuse' }, excludePid: 4242 });
      } catch (err) {
        refusedErr = err;
      }
      if (!refusedErr || refusedErr.code !== 'HOST_WINDOW_UNAVAILABLE' || !String(refusedErr.reason).includes('X11 display unreachable')) {
        return false;
      }

      let dupErr = null;
      try {
        await roleHost.listHostWindows({ env: { ...process.env, MV_SRF_BIN_DIR: binDir, FAKE_HW_MODE: 'dup' }, excludePid: 4242 });
      } catch (err) {
        dupErr = err;
      }
      return Boolean(dupErr) && dupErr.code === 'HOST_WINDOW_UNAVAILABLE';
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 4. App + roleHost: attach without display pool slot, refuse profile selection, refuse duplicate xid, and detach immediately without closing window.
  await check('attach-and-detach-host-window', async () => {
    const appH = createAppWindowHarness(appSource, {
      createWindow: async (w) => ({ ok: true, surfaceId: 'surface-hw-1', profileId: 'hw-4a00003', ...w }),
    });
    // Renderer cannot supply a profileId for desktop-window.
    let badSettled = null;
    appH.ctx.onCreateCapsule(
      { kind: 'desktop-window', window: sampleWindows[0], profileId: 'mv-live-1' },
      (res) => { badSettled = res; },
    );
    if (!badSettled || badSettled.ok !== false || badSettled.code !== 'WINDOW_PROFILE_FORBIDDEN') return false;

    const root = await mkdtemp(join(tmpdir(), 'v025-host-'));
    try {
      const binDir = join(root, 'bin');
      await mkdir(binDir, { mode: 0o700 });
      const handlers = new Map();
      const states = new Map();
      const stagedWindows = [];
      let stoppedSurfaces = 0;
      let provisionedCount = 0;
      let seq = 0;
      const parent = new EventEmitter();
      parent.webContents = { session: { registerPreloadScript: () => 'p', unregisterPreloadScript() {} } };

      const host = roleHost.installRoleHost({
        electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
        window: parent,
        env: {
          MV_SRF_PROFILES: JSON.stringify({
            'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
          }),
          MV_SRF_STATE_DIR: root,
          MV_SRF_BIN_DIR: binDir,
        },
        capsuleStates: states,
        stageMode: async (stateDir, profileId, mode, target) => {
          stagedWindows.push({ profileId, mode, target });
          return await openingModeMod.stageOpeningMode(stateDir, profileId, mode, target);
        },
        provisionProgramIdentity: async () => {
          provisionedCount++;
          return { ok: true };
        },
        core: {
          getHumanSurface: (id) => states.get(id),
          stopSurface: async (surfaceId) => {
            stoppedSurfaces++;
            const s = { ...states.get(surfaceId), state: 'destroyed' };
            states.set(surfaceId, s);
            return { schema: 'surface_event/v0.2', event: 'state_changed', data: { surface: s } };
          },
          request: async (req) => {
            const surface = {
              schema: 'surface/v0.2',
              surface_id: `surface-hw-${++seq}`,
              kind: req.params.kind,
              profile_id: req.params.profile_id,
              state: 'active',
              control: 'agent',
              geometry: req.params.geometry,
            };
            states.set(surface.surface_id, surface);
            return { schema: 'surface_event/v0.2', event: 'created', data: { surface } };
          },
        },
        admit: () => true,
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }] }),
      });

      try {
        const invoke = (op, extra = {}) => handlers.get('metaviewer:roles.v0.3')({}, { schema: 'metaviewer.roles/v0.3', op, ...extra });
        const first = await invoke('create-window', { choice: sampleWindows[0] });
        if (!first?.ok || first.profileId !== 'hw-4a00003' || provisionedCount !== 0 || stagedWindows.length !== 1) {
          return false;
        }
        // Duplicate attach of the same xid is refused with PROFILE_ALREADY_BOUND.
        const dup = await invoke('create-window', { choice: sampleWindows[0] });
        if (dup?.ok !== false || dup.code !== 'PROFILE_ALREADY_BOUND') return false;

        // Second distinct window attaches cleanly even though only 1 display slot was configured in MV_SRF_PROFILES.
        const second = await invoke('create-window', { choice: sampleWindows[1] });
        if (!second?.ok || second.profileId !== 'hw-4a00009') return false;

        // Status returns hostWindow metadata.
        const st = await invoke('status', { surfaceId: first.surfaceId });
        if (!st?.hostWindow || st.hostWindow.xid !== sampleWindows[0].xid || st.hostWindow.witness !== sampleWindows[0].witness) {
          return false;
        }
        const projection = await invoke('surfaces');
        const projected = projection.find(row => row.surface.surface_id === first.surfaceId);
        if (projected?.role !== 'agent' || projected.hostWindow?.title !== sampleWindows[0].title
          || projected.hostWindow?.program !== sampleWindows[0].program
          || projected.surface.profile_id !== first.profileId) return false;

        // Detach stops the capsule binding immediately and frees the xid to be attached again later.
        const detached = await invoke('detach-window', { surfaceId: first.surfaceId });
        if (!detached?.ok || detached.detached !== true || stoppedSurfaces !== 1) return false;

        const reattached = await invoke('create-window', { choice: sampleWindows[0] });
        return reattached?.ok === true && reattached.profileId === 'hw-4a00003';
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 5. RoleSurface: visible indicator ("Real desktop — not isolated"), one-click immediate Stop, minimized waiting state, and lost state without Reopen.
  await check('role-surface-indicator-stop-minimized-and-lost', async () => {
    const prior = {
      api: globalThis.metaviewerRoles,
      doc: globalThis.document,
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    };
    const listeners = new Map();
    const doc = {
      body: {
        setAttribute() {},
        removeAttribute() {},
        hasAttribute: () => false,
        getAttribute: () => null,
      },
      addEventListener(k, fn) { if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k).add(fn); },
      removeEventListener(k, fn) { listeners.get(k)?.delete(fn); },
      querySelectorAll: () => [],
      getElementById: () => null,
    };
    globalThis.document = doc;
    globalThis.innerWidth = 1600;
    globalThis.innerHeight = 1100;

    let currentHostWindow = {
      xid: 0x04a00003,
      witness: '0x04a00003:1730541000',
      title: 'Chromium — Logged In',
      program: 'chromium',
      width: 1280,
      height: 900,
      state: 'active',
      minimized: false,
      lostReason: null,
    };
    let detachCalls = 0;
    globalThis.metaviewerRoles = {
      status: async () => ({ role: 'agent', view: { state: 'closed' }, hostWindow: { ...currentHostWindow } }),
      mount: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      visibility: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      detachWindow: async () => { detachCalls++; return { ok: true, detached: true }; },
      stop: async () => ({ ok: true }),
    };

    const Component = await compileRoleSurface(roleSurfaceSource);
    const overlays = createOverlayCoordinator(doc);
    const pool = createHiddenSessionPool();
    const stoppedEvents = [];
    const mounted = mountRoleSurface(
      Component,
      {
        surfaceId: 'hw-1',
        control: 'agent',
        onStopped: (id) => stoppedEvents.push(id),
      },
      { overlayCoordinator: overlays, hiddenSessionPool: pool },
      { default: () => vue.h('canvas') },
    );
    try {
      await new Promise((r) => setTimeout(r, 40));
      await vue.nextTick();

      const nodes1 = walkNodes(mounted.root);
      const badge = nodes1.find((n) => n.props?.id === 'tile-host-indicator-hw-1');
      const stopBtn = nodes1.find((n) => n.props?.id === 'tile-host-stop-hw-1');
      const canvasWrap = nodes1.find((n) => n.props?.class === 'mv-role-agent-canvas');
      if (!badge || nodeText(badge) !== 'Real desktop — not isolated') return false;
      if (!stopBtn || nodeText(stopBtn) !== 'Stop') return false;
      if (!canvasWrap || canvasWrap.props?.style?.visibility === 'hidden') return false;

      // Transition to minimized: canvas must be hidden so old frame is never shown as live, and waiting message shown.
      currentHostWindow = { ...currentHostWindow, minimized: true };
      await new Promise((r) => setTimeout(r, 140));
      await vue.nextTick();
      const nodesMin = walkNodes(mounted.root);
      const minMsg = nodesMin.find((n) => n.props?.id === 'tile-host-minimized-hw-1');
      const canvasMin = nodesMin.find((n) => n.props?.class === 'mv-role-agent-canvas');
      if (!minMsg || !nodeText(minMsg).includes('Window minimized')) return false;
      if (!canvasMin || canvasMin.props?.style?.visibility !== 'hidden') return false;

      // Transition to lost (closed window / witness changed): clear alert shown and NO Reopen button offered.
      currentHostWindow = {
        ...currentHostWindow,
        minimized: false,
        state: 'lost',
        lostReason: 'host_window_unavailable: window closed',
      };
      await new Promise((r) => setTimeout(r, 140));
      await vue.nextTick();
      const nodesLost = walkNodes(mounted.root);
      const lostAlert = nodesLost.find((n) => n.props?.id === 'tile-host-lost-hw-1');
      const reopenBtn = nodesLost.find((n) => n.tag === 'button' && nodeText(n) === 'Reopen');
      if (!lostAlert || !nodeText(lostAlert).includes('window closed') || reopenBtn) return false;

      // One-click Stop detaches immediately outside any AI path.
      await stopBtn.props.onClick({ stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 20));
      return detachCalls === 1 && stoppedEvents.includes('hw-1');
    } finally {
      mounted.app.unmount();
      globalThis.metaviewerRoles = prior.api;
      globalThis.document = prior.doc;
      globalThis.innerWidth = prior.width;
      globalThis.innerHeight = prior.height;
    }
  });

  return failed;
}

test('V025-WINDOW-MV: real modules pass all desktop window probes', async () => {
  assert.deepEqual(await runWindowProbes(), []);
});

test('V025-WINDOW-MV: mutant suite kills every required mutant', async () => {
  const catalogSrc = readFileSync(CATALOG_MODEL_PATH, 'utf8');
  const launcherSrc = readFileSync(CATALOG_LAUNCHER_PATH, 'utf8');
  const appSrc = readFileSync(APP_PATH, 'utf8');
  const roleHostSrc = readFileSync(ROLE_HOST_PATH, 'utf8');
  const roleSurfaceSrc = readFileSync(ROLE_SURFACE_PATH, 'utf8');
  const tmp = await mkdtemp(join(tmpdir(), 'v025-mutants-'));
  const electronBaseHref = pathToFileURL(join(HERE, '../electron/')).href;

  const importMutatedRoleHost = async (mutatedSrc, tag) => {
    const rewritten = mutatedSrc
      .replace(/from\s+'\.\/([^']+)'/g, `from '${electronBaseHref}$1'`)
      .replace(/import\('\.\/([^']+)'\)/g, `import('${electronBaseHref}$1')`)
      .replace("new URL('./rolePreload.cjs',import.meta.url)", `new URL('${electronBaseHref}rolePreload.cjs')`);
    const f = join(tmp, `roleHost-${tag}.js`);
    await writeFile(f, rewritten);
    return await import(`${pathToFileURL(f).href}?m=${tag}`);
  };

  try {
    // Mutant 1: catalogModel allows duplicate xid in normalizeWindowList.
    {
      const mutated = catalogSrc.replace(
        'if (!normalized || seenXids.has(normalized.xid) || seenWitnesses.has(normalized.witness)) {',
        'if (!normalized) {',
      );
      assert.notEqual(mutated, catalogSrc);
      const mod = await import(`data:text/javascript;base64,${Buffer.from(mutated).toString('base64')}#m1`);
      const failed = await runWindowProbes({ model: mod });
      assert.ok(failed.includes('catalog-window-model'), `Mutant 1 survived: ${failed}`);
    }

    // Mutant 2: CatalogLauncher auto-emits create when clicking a window row without clicking Add.
    {
      const mutated = launcherSrc.replace(
        "if (typeof windowChoiceXid !== 'undefined') windowChoiceXid.value = Number(xid) || 0;",
        "if (typeof windowChoiceXid !== 'undefined') { windowChoiceXid.value = Number(xid) || 0; emit('create', { kind: 'desktop-window' }); }",
      );
      assert.notEqual(mutated, launcherSrc);
      const failed = await runWindowProbes({ launcherSource: mutated });
      assert.ok(failed.includes('launcher-window-picker-and-explicit-add'), `Mutant 2 survived: ${failed}`);
    }

    // Mutant 3: listHostWindows does not exclude MetaViewer's own PID.
    {
      const mutated = roleHostSrc.replace(
        'if (rowPid !== undefined && Number(rowPid) === safePid) continue;',
        'if (false) continue;',
      );
      assert.notEqual(mutated, roleHostSrc);
      const mod = await importMutatedRoleHost(mutated, 'm3');
      const failed = await runWindowProbes({ roleHost: mod });
      assert.ok(failed.includes('srf-host-window-list-excludes-pid-and-fails-closed'), `Mutant 3 survived: ${failed}`);
    }

    // Mutant 4: App.vue allows renderer to supply a profileId for desktop-window.
    {
      const mutated = appSrc.replace(
        'if (body.profileId || body.profile_id || body.choice?.profileId || body.choice?.profile_id || body.profile || body.choice?.profile || body.choice) {',
        'if (false) {',
      );
      assert.notEqual(mutated, appSrc);
      const failed = await runWindowProbes({ appSource: mutated });
      assert.ok(failed.includes('attach-and-detach-host-window'), `Mutant 4 survived: ${failed}`);
    }

    // Mutant 5: roleHost.createWindow allows attaching the same xid twice concurrently.
    {
      const mutated = roleHostSrc.replace(
        "if ([...windowProfiles.values()].some(w => w.xid === validated.xid && w.state !== 'lost' && w.state !== 'destroyed')) {",
        'if (false) {',
      );
      assert.notEqual(mutated, roleHostSrc);
      const mod = await importMutatedRoleHost(mutated, 'm5');
      const failed = await runWindowProbes({ roleHost: mod });
      assert.ok(failed.includes('attach-and-detach-host-window'), `Mutant 5 survived: ${failed}`);
    }

    // Mutant 6: RoleSurface omits the visible "Real desktop — not isolated" indicator.
    {
      const mutated = roleSurfaceSrc.replace(
        'Real desktop — not isolated',
        'Isolated container',
      );
      assert.notEqual(mutated, roleSurfaceSrc);
      const failed = await runWindowProbes({ roleSurfaceSource: mutated });
      assert.ok(failed.includes('role-surface-indicator-stop-minimized-and-lost'), `Mutant 6 survived: ${failed}`);
    }

    // Mutant 7: RoleSurface leaves old frame canvas visible when window is minimized.
    {
      const mutated = roleSurfaceSrc.replace(
        "(watching || hostWindow?.minimized || hostWindow?.state === 'lost') ? 'hidden' : undefined",
        "watching ? 'hidden' : undefined",
      );
      assert.notEqual(mutated, roleSurfaceSrc);
      const failed = await runWindowProbes({ roleSurfaceSource: mutated });
      assert.ok(failed.includes('role-surface-indicator-stop-minimized-and-lost'), `Mutant 7 survived: ${failed}`);
    }

    // Mutant 8: RoleSurface offers Reopen button on a lost host window (allowing silent rebind).
    {
      const mutated = roleSurfaceSrc.replace(
        'v-if="error && !hostWindow"',
        'v-if="error"',
      );
      assert.notEqual(mutated, roleSurfaceSrc);
      const failed = await runWindowProbes({ roleSurfaceSource: mutated });
      assert.ok(failed.includes('role-surface-indicator-stop-minimized-and-lost'), `Mutant 8 survived: ${failed}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('listHostWindows reads the real srf-host-window row and skips unusable windows', async () => {
  const roleHostForRealRow = await import('../electron/roleHost.js');
  const realRow = { xid: 4194311, witness: '8aa4aec9bab6b0a7', pid: 3500288, pid_missing: false, exe: 'gnome-mines', class: 'Gnome-mines', class_missing: false, title: 'Minas', rect: { x: 289, y: 72, width: 821, height: 855 }, visible: true, minimized: false, window_type: 'normal' };
  const stdout = JSON.stringify({ ok: true, windows: [
    realRow,
    { ...realRow, xid: 5, witness: 'untitled', title: '' },
    { ...realRow, xid: 6, witness: 'hidden', minimized: true },
  ] });
  const rows = await roleHostForRealRow.listHostWindows({
    env: { MV_SRF_BIN_DIR: '/fake/bin' },
    excludePid: 1,
    runTool: (_tool, _args, _opts, cb) => cb(null, stdout, ''),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].program, 'gnome-mines');
  assert.equal(rows[0].width, 821);
  assert.equal(rows[0].height, 855);
});
