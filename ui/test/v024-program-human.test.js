import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import { parse as parseBabel } from '@babel/parser';

import * as catalogModel from '../src/catalog/catalogModel.js';
import * as activityModelMod from '../src/activity/activityModel.js';
import * as openingModeMod from '../electron/openingMode.js';
import * as xpraBridgeMod from '../electron/xpraHumanBridge.js';
import * as roleHostMod from '../electron/roleHost.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CATALOG_MODEL_PATH = join(HERE, '../src/catalog/catalogModel.js');
const CATALOG_LAUNCHER_PATH = join(HERE, '../src/catalog/CatalogLauncher.vue');
const APP_PATH = join(HERE, '../src/App.vue');
const OPENING_MODE_PATH = join(HERE, '../electron/openingMode.js');
const XPRA_BRIDGE_PATH = join(HERE, '../electron/xpraHumanBridge.js');
const ROLE_HOST_PATH = join(HERE, '../electron/roleHost.js');

function extractFunctions(scriptContent, names) {
  const ast = parseBabel(scriptContent, { sourceType: 'module', plugins: ['typescript'] });
  const wanted = new Set(names);
  const chunks = [];
  for (const node of ast.program.body) {
    if (node.type === 'FunctionDeclaration' && node.id && wanted.has(node.id.name)) {
      chunks.push(scriptContent.slice(node.start, node.end));
    }
  }
  return chunks.join('\n\n');
}

function createLauncherHarness(sfcSource, buildCreateIntentFn, apiMock = null) {
  const { descriptor } = parse(sfcSource);
  const script = descriptor.scriptSetup?.content || '';
  const fnCode = extractFunctions(script, [
    'confirmRole',
    'confirmProgram',
    'cancelProgram',
    'forwardVisible',
    'onCreate',
    'onClose',
  ]);
  const events = [];
  const ctx = {
    props: { visible: true, kinds: [...catalogModel.CATALOG_KIND_IDS] },
    disabledArmKinds: { get value() { return catalogModel.unavailableArmCapsules(ctx.props.arm64Capabilities); } },
    api: apiMock,
    roleChoice: { value: 'agent' },
    profileChoice: { value: '' },
    choosingRole: { value: false },
    roleError: { value: '' },
    choosingProgram: { value: false },
    programBinary: { value: '' },
    programRole: { value: 'human' },
    programError: { value: '' },
    programBusy: { value: false },
    choiceGeneration: 0,
    pendingIntent: { value: null },
    profileChoices: { value: [] },
    matchingProfiles: { value: [] },
    buildCreateIntent: buildCreateIntentFn,
    emit: (event, ...args) => {
      events.push([event, ...args]);
    },
    Error,
    Array,
  };
  vm.createContext(ctx);
  vm.runInContext(fnCode, ctx);
  return { ctx, events, template: descriptor.template?.content || '' };
}

function createAppProgramHarness(appSource, rolesApi, opts = {}) {
  const { descriptor } = parse(appSource);
  const script = descriptor.scriptSetup?.content || '';
  const fnCode = extractFunctions(script, [
    'recordActivity',
    'submitHost',
    'createProgramCapsule',
    'onCreateCapsule',
  ]);
  const views = [];
  const revealed = [];
  const controlCalls = [];
  const activities = [];
  const hostOutcomes = [];
  const globalObj = { metaviewerRoles: rolesApi };
  const ctx = {
    globalThis: globalObj,
    nestedMode: { displayOnly: Boolean(opts.displayOnly) },
    props: {
      authorityHost: opts.authorityHost ?? {},
      runtime: opts.runtime ?? { intentBuilders: true },
      fixture: opts.fixture ?? null,
    },
    rows: { value: [] },
    wallInputPending: { value: {} },
    hostActive: true,
    activitySeq: 0,
    ACTIVITY_LIMIT: 8,
    activityFeed: { value: [] },
    pendingModeSwitch: { value: null },
    capsuleModes: { value: {} },
    hostOutcome: {
      _v: null,
      get value() {
        return this._v;
      },
      set value(v) {
        this._v = v;
        hostOutcomes.push(v);
      },
    },
    selectGlobalView: (v) => {
      views.push(v);
      if (opts.throwOnPostLaunch) throw new Error('simulated post-launch view failure');
    },
    nextTick: async () => {},
    revealOpenedIdentity: async (id, mode) => {
      revealed.push({ id, mode });
      return true;
    },
    applyWallControl: (id, verb) => {
      controlCalls.push({ id, verb });
    },
    reopenLiveSurfaces: () => false,
    emit: () => {},
    Object,
    Error,
  };
  vm.createContext(ctx);
  vm.runInContext(fnCode, ctx);
  const origRecord = ctx.recordActivity;
  ctx.recordActivity = (entry) => {
    origRecord(entry);
    activities.length = 0;
    activities.push(...ctx.activityFeed.value);
  };
  return { ctx, views, revealed, controlCalls, activities, hostOutcomes };
}

async function runProbes(overrides = {}) {
  const failed = [];
  const check = async (name, fn) => {
    try {
      await fn();
    } catch {
      failed.push(name);
    }
  };

  const model = overrides.model || catalogModel;
  const launcherSource = overrides.launcherSource ?? readFileSync(CATALOG_LAUNCHER_PATH, 'utf8');
  const appSource = overrides.appSource ?? readFileSync(APP_PATH, 'utf8');
  const openingMode = overrides.openingMode || openingModeMod;
  const xpraBridge = overrides.xpraBridge || xpraBridgeMod;
  const roleHost = overrides.roleHost || roleHostMod;

  await check('dialog-role-select-default-human', async () => {
    const h = createLauncherHarness(launcherSource, model.buildCreateIntent);
    assert.match(h.template, /id="shell\/new-capsule\/program-role"/);
    assert.match(h.template, /data-semantic-anchor="dialog\/new-capsule\/program-role"/);
    assert.match(h.template, /<option value="human">Human<\/option>/);
    assert.match(h.template, /<option value="agent">Agent<\/option>/);
    assert.match(h.template, /id="shell\/new-capsule\/program-binary"/);
    await h.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
    assert.equal(h.ctx.choosingProgram.value, true);
    assert.equal(h.ctx.programRole.value, 'human');
    h.ctx.programBinary.value = 'gedit';
    let emitted = null;
    h.ctx.emit = (ev, payload, settle) => {
      if (ev === 'create') {
        emitted = payload;
        settle?.({ ok: true });
      }
    };
    await h.ctx.confirmProgram();
    assert.equal(emitted?.kind, 'program');
    assert.equal(emitted?.binary, 'gedit');
    assert.equal(emitted?.role, 'human');
  });

  await check('model-validates-program-role', async () => {
    const okHuman = model.buildCreateIntent({ kind: 'program', binary: 'gedit', role: 'human' });
    assert.equal(okHuman.ok, true);
    assert.equal(okHuman.intent.role, 'human');
    const okAgent = model.buildCreateIntent({ kind: 'program', binary: 'gedit', role: 'agent' });
    assert.equal(okAgent.ok, true);
    assert.equal(okAgent.intent.role, 'agent');
    const badRole = model.buildCreateIntent({ kind: 'program', binary: 'gedit', role: 'root' });
    assert.equal(badRole.ok, false);
  });

  await check('opening-mode-allows-human-program', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v024-openmode-'));
    try {
      await chmod(dir, 0o700);
      const clean = await openingMode.stageOpeningMode(dir, 'gedit', 'human', '/usr/bin/gedit');
      const staged = JSON.parse(await readFile(join(dir, 'opening-modes', 'gedit.json'), 'utf8'));
      assert.deepEqual(staged, {
        schema: 'metaviewer.opening_mode/v0.3',
        profile_id: 'gedit',
        mode: 'human',
        host_binary: '/usr/bin/gedit',
      });
      await clean();
      await assert.rejects(
        () => openingMode.stageOpeningMode(dir, 'gedit', 'invalid', '/usr/bin/gedit'),
        /CAPSULE_MODE_INVALID/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await check('xpra-bridge-accepts-program-container', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v024-bridge-'));
    try {
      const viewRoot = join(dir, 'view');
      const outer = join(viewRoot, 'srf-pg-gedit');
      const inner = join(outer, 's');
      await mkdir(viewRoot, { mode: 0o700 });
      await mkdir(outer, { mode: 0o700 });
      await mkdir(inner, { mode: 0o777 });
      await chmod(inner, 0o777);
      const sockPath = join(inner, 'xpra.sock');
      const unixSrv = net.createServer();
      await new Promise((res) => unixSrv.listen(sockPath, res));
      await chmod(sockPath, 0o666);
      try {
        const bridge = await xpraBridge.openXpraHumanBridge({
          viewRoot,
          capsule: 'srf-pg-gedit',
          expectedSocketUid: process.getuid(),
        });
        assert.match(bridge.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.equal(await bridge.isHealthy(), true);
        await bridge.close();
        await assert.rejects(
          () =>
            xpraBridge.openXpraHumanBridge({
              viewRoot,
              capsule: 'srf-xx-gedit',
              expectedSocketUid: process.getuid(),
            }),
          /XPRA_BINDING_REFUSED/,
        );
      } finally {
        await new Promise((res) => unixSrv.close(res));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await check('role-binding-and-human-mode-accept-program', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v024-bind-'));
    try {
      await chmod(dir, 0o700);
      const bindDir = join(dir, 'human-bindings');
      await mkdir(bindDir, { mode: 0o700 });
      const surface = { surface_id: 'surface_1', profile_id: 'gedit' };
      const bindPath = join(bindDir, 'surface_1.json');
      await writeFile(
        bindPath,
        JSON.stringify({
          schema: 'metaviewer.human_binding/v0.3',
          surface_id: 'surface_1',
          profile_id: 'gedit',
          role: 'human',
          control_ready: true,
          kind: 'program',
          container: 'srf-pg-gedit',
          run_id: 'run-pg-1',
          width: 1280,
          height: 900,
        }),
        { mode: 0o600 },
      );
      const parsed = await roleHost.readRoleBinding(dir, surface, 'human');
      assert.equal(parsed.container, 'srf-pg-gedit');

      await writeFile(
        bindPath,
        JSON.stringify({
          schema: 'metaviewer.human_binding/v0.3',
          surface_id: 'surface_1',
          profile_id: 'gedit',
          role: 'human',
          control_ready: true,
          kind: 'other',
          container: 'srf-pg-gedit',
          run_id: 'run-pg-1',
          width: 1280,
          height: 900,
        }),
        { mode: 0o600 },
      );
      await assert.rejects(() => roleHost.readRoleBinding(dir, surface, 'human'), /XPRA_BINDING_REFUSED/);

      const tool = join(dir, 'srf-identity-surface');
      await writeFile(
        tool,
        '#!/bin/sh\necho \'{"schema":"srf.human-xpra/v1","container":"srf-pg-gedit","kind":"program","ready":true,"writable":true}\'\n',
        { mode: 0o755 },
      );
      const modeOk = await roleHost.runHumanMode({
        tool,
        stateDir: dir,
        container: 'srf-pg-gedit',
        readonly: false,
        env: process.env,
      });
      assert.equal(modeOk, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await check('create-program-human-and-switch-mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v024-host-'));
    try {
      await chmod(dir, 0o700);
      const binDir = join(dir, 'bin');
      const stateDir = join(dir, 'state');
      const traceDir = join(dir, 'traces');
      await mkdir(binDir, { mode: 0o700 });
      await mkdir(stateDir, { mode: 0o700 });
      await mkdir(traceDir, { mode: 0o700 });
      const geditPath = join(binDir, 'gedit');
      await writeFile(geditPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const handlers = new Map();
      const states = new Map();
      const stagedModes = [];
      let seq = 0;

      const core = {
        getHumanSurface: (id) => states.get(id),
        stopSurface: async (surfaceId) => {
          const cur = states.get(surfaceId);
          const s = { ...cur, state: 'destroyed' };
          states.set(surfaceId, s);
          return { schema: 'surface_event/v0.2', event: 'state_changed', data: { surface: s } };
        },
        request: async (req) => {
          const pid = req.params.profile_id;
          const staged = JSON.parse(await readFile(join(stateDir, 'opening-modes', `${pid}.json`), 'utf8'));
          stagedModes.push(staged);
          const surface = {
            schema: 'surface/v0.2',
            surface_id: `surface-pg-${++seq}`,
            kind: 'desktop_capsule',
            profile_id: pid,
            state: 'active',
            control: staged.mode,
            visibility: 'unfolded',
            display: ':111',
            geometry: { w: 1280, h: 900 },
          };
          states.set(surface.surface_id, surface);
          return { schema: 'surface_event/v0.2', event: 'created', data: { surface } };
        },
      };

      const parent = new EventEmitter();
      parent.webContents = { session: { registerPreloadScript: () => 'p', unregisterPreloadScript() {} } };
      const host = roleHost.installRoleHost({
        electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
        window: parent,
        env: {
          PATH: `${binDir}:/usr/bin:/bin`,
          MV_SRF_PROFILES: JSON.stringify({
            'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
          }),
          MV_SRF_STATE_DIR: stateDir,
          MV_SRF_BIN_DIR: binDir,
          MV_RECORDING_DESTINATION: traceDir,
        },
        capsuleStates: states,
        core,
        admit: () => true,
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1', browser: 'browser' }] }),
        provisionProgramIdentity: async ({ id, label }) => ({
          ok: true,
          rows: [{ id, label, domains: [], logged_in: 'unknown', browser: 'program' }],
        }),
        stageMode: openingMode.stageOpeningMode,
      });
      try {
        const invoke = (op, body = {}) =>
          handlers.get('metaviewer:roles.v0.3')({}, { schema: 'metaviewer.roles/v0.3', op, ...body });
        const rolesBridge = {
          createProgram: (choice) => invoke('create-program', { choice }),
          surfaces: () => invoke('surfaces'),
          switchMode: (surfaceId) => invoke('switch', { surfaceId }),
          stop: (surfaceId) => invoke('stop', { surfaceId }),
        };

        const appH = createAppProgramHarness(appSource, rolesBridge);
        const launcherH = createLauncherHarness(launcherSource, model.buildCreateIntent, rolesBridge);
        launcherH.ctx.emit = (ev, payload, settle) => {
          if (ev === 'create') appH.ctx.onCreateCapsule(payload, settle);
        };

        await launcherH.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
        launcherH.ctx.programBinary.value = 'gedit';
        await launcherH.ctx.confirmProgram();

        assert.equal(stagedModes.length, 1);
        assert.equal(stagedModes[0].mode, 'human');
        assert.equal(stagedModes[0].host_binary, geditPath);
        assert.deepEqual(appH.views, ['human']);
        assert.deepEqual(appH.revealed, [{ id: 'surface-pg-1', mode: 'human' }]);
        assert.deepEqual(appH.controlCalls, []);

        const humanSurfaces = await rolesBridge.surfaces();
        assert.equal(humanSurfaces.length, 1);
        assert.equal(humanSurfaces[0].surface.surface_id, 'surface-pg-1');
        assert.equal(humanSurfaces[0].role, 'human');

        const switchedAgent = await rolesBridge.switchMode('surface-pg-1');
        assert.equal(switchedAgent.ok, true);
        assert.equal(switchedAgent.role, 'agent');
        assert.equal(switchedAgent.profileId, 'gedit');

        const switchedHuman = await rolesBridge.switchMode(switchedAgent.surfaceId);
        assert.equal(switchedHuman.ok, true);
        assert.equal(switchedHuman.role, 'human');
        assert.equal(switchedHuman.profileId, 'gedit');
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  return failed;
}

test('V024-PROGRAM-HUMAN-MV: full sequence replay with fake runner (human program create, xpra binding for program, tile mount/resize/stop, switch to agent and back, profile+display reuse, and refusal reasons)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'v024-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);

  const binDir = join(root, 'bin');
  const stateDir = join(root, 'state');
  const viewRoot = join(stateDir, 'view');
  const bindDir = join(stateDir, 'human-bindings');
  const traceDir = join(root, 'traces');
  await mkdir(binDir, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(viewRoot, { mode: 0o700 });
  await mkdir(bindDir, { mode: 0o700 });
  await mkdir(traceDir, { mode: 0o700 });

  const geditPath = join(binDir, 'gedit');
  await writeFile(geditPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const brokenPath = join(binDir, 'broken-prog');
  await writeFile(brokenPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  // Fake srf-identity-surface human command returning kind: "program"
  const surfaceTool = join(binDir, 'srf-identity-surface');
  await writeFile(
    surfaceTool,
    `#!/bin/sh
container=""
writable="true"
while [ $# -gt 0 ]; do
  case "$1" in
    --container) container="$2"; shift 2 ;;
    --readonly) writable="false"; shift ;;
    --writable) writable="true"; shift ;;
    *) shift ;;
  esac
done
printf '{"schema":"srf.human-xpra/v1","container":"%s","kind":"program","ready":true,"writable":%s}\\n' "$container" "$writable"
`,
    { mode: 0o755 },
  );

  // Set up fake xpra Unix socket for srf-pg-gedit
  const outer = join(viewRoot, 'srf-pg-gedit');
  const inner = join(outer, 's');
  await mkdir(outer, { mode: 0o700 });
  await mkdir(inner, { mode: 0o777 });
  await chmod(inner, 0o777);
  const sockPath = join(inner, 'xpra.sock');
  const unixSrv = net.createServer();
  await new Promise((res) => unixSrv.listen(sockPath, res));
  await chmod(sockPath, 0o666);
  t.after(() => new Promise((res) => unixSrv.close(res)));

  const provisioned = new Map([['mv-live-1', { id: 'mv-live-1', browser: 'browser' }]]);
  const handlers = new Map();
  const states = new Map();
  const activeDisplays = new Set();
  const stagedFiles = [];
  const mountedTiles = [];
  let seq = 0;

  const core = {
    getHumanSurface: (id) => states.get(id),
    stopSurface: (surfaceId) =>
      core.request({ schema: 'surface_request/v0.2', op: 'destroy', params: { surface_id: surfaceId } }),
    async request(req) {
      if (req.op === 'destroy') {
        const cur = states.get(req.params.surface_id);
        activeDisplays.delete(cur.display);
        const s = { ...cur, state: 'destroyed' };
        states.set(s.surface_id, s);
        return { schema: 'surface_event/v0.2', event: 'state_changed', data: { surface: s } };
      }
      const pid = req.params.profile_id;
      const staged = JSON.parse(await readFile(join(stateDir, 'opening-modes', `${pid}.json`), 'utf8'));
      stagedFiles.push(staged);
      if (staged.host_binary.endsWith('/broken-prog')) {
        return {
          schema: 'surface_event/v0.2',
          event: 'error',
          data: {
            code: 'HOST_PROGRAM_UNAVAILABLE',
            detail: 'host_program_unavailable: xpra display failed to start',
          },
        };
      }
      const display = !activeDisplays.has(':111') ? ':111' : ':112';
      activeDisplays.add(display);
      const surfaceId = `surface_pg_${++seq}`;
      const surface = {
        schema: 'surface/v0.2',
        surface_id: surfaceId,
        kind: 'desktop_capsule',
        profile_id: pid,
        state: 'active',
        control: staged.mode,
        visibility: 'unfolded',
        display,
        geometry: { w: 1280, h: 900 },
      };
      states.set(surfaceId, surface);
      if (staged.mode === 'human') {
        await writeFile(
          join(bindDir, `${surfaceId}.json`),
          JSON.stringify({
            schema: 'metaviewer.human_binding/v0.3',
            surface_id: surfaceId,
            profile_id: pid,
            role: 'human',
            control_ready: true,
            kind: 'program',
            container: `srf-pg-${pid}`,
            run_id: `run-pg-${seq}`,
            width: 1280,
            height: 900,
          }),
          { mode: 0o600 },
        );
      }
      return { schema: 'surface_event/v0.2', event: 'created', data: { surface } };
    },
  };

  const parent = new EventEmitter();
  parent.webContents = {
    send() {},
    session: { registerPreloadScript: () => 'p', unregisterPreloadScript() {} },
  };
  const host = roleHostMod.installRoleHost({
    electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
    window: parent,
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      MV_SRF_PROFILES: JSON.stringify({
        'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
      }),
      MV_SRF_STATE_DIR: stateDir,
      MV_SRF_BIN_DIR: binDir,
      MV_RECORDING_DESTINATION: traceDir,
    },
    capsuleStates: states,
    core,
    admit: () => true,
    listIdentities: async () => ({ ok: true, rows: [...provisioned.values()] }),
    provisionProgramIdentity: async ({ id, label }) => {
      provisioned.set(id, { id, label, domains: [], logged_in: 'unknown', browser: 'program' });
      return { ok: true, rows: [provisioned.get(id)] };
    },
    keyboardLayout: async () => 'us',
    keyboardMap: async () => undefined,
    bridgeFactory: (opts) =>
      xpraBridgeMod.openXpraHumanBridge({
        ...opts,
        expectedSocketUid: process.getuid(),
      }),
    tileFactory: async (opts) => {
      mountedTiles.push(opts);
      opts.onState?.('ready');
      return {
        resize(b) {
          opts.bounds = b;
        },
        setVisible(v) {
          opts.visible = v;
        },
        bringToFront() {},
        async close() {},
      };
    },
  });
  t.after(() => host.dispose());

  const invoke = (op, body = {}) =>
    handlers.get('metaviewer:roles.v0.3')({}, { schema: 'metaviewer.roles/v0.3', op, ...body });
  const rolesBridge = {
    choices: () => invoke('choices'),
    surfaces: () => invoke('surfaces'),
    createProgram: (choice) => invoke('create-program', { choice }),
    status: (surfaceId) => invoke('status', { surfaceId }),
    mount: (surfaceId, bounds) => invoke('mount', { surfaceId, bounds }),
    resize: (surfaceId, bounds) => invoke('resize', { surfaceId, bounds }),
    visibility: (surfaceId, visible) => invoke('visibility', { surfaceId, visible }),
    raise: (surfaceId) => invoke('raise', { surfaceId }),
    switchMode: (surfaceId) => invoke('switch', { surfaceId }),
    stop: (surfaceId) => invoke('stop', { surfaceId }),
    close: (surfaceId) => invoke('close', { surfaceId }),
  };

  const appH = createAppProgramHarness(readFileSync(APP_PATH, 'utf8'), rolesBridge);
  const launcherH = createLauncherHarness(
    readFileSync(CATALOG_LAUNCHER_PATH, 'utf8'),
    catalogModel.buildCreateIntent,
    rolesBridge,
  );
  launcherH.ctx.emit = (ev, payload, settle) => {
    if (ev === 'create') appH.ctx.onCreateCapsule(payload, settle);
  };

  // 1. Refusal reason shown in dialog, HostOutcome, and Activity when binary is missing or fails native start.
  await launcherH.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
  assert.equal(launcherH.ctx.programRole.value, 'human', 'Human is the default role in the Program dialog');
  launcherH.ctx.programBinary.value = 'missing-prog';
  await launcherH.ctx.confirmProgram();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(launcherH.ctx.choosingProgram.value, true);
  assert.equal(launcherH.ctx.programError.value, 'host_program_unavailable: missing-prog: not found in PATH');
  assert.equal(
    activityModelMod.normalizeActivityEntry(appH.activities.at(-1))?.text,
    'HOST_PROGRAM_UNAVAILABLE: host_program_unavailable: missing-prog: not found in PATH',
  );

  launcherH.ctx.programBinary.value = 'broken-prog';
  await launcherH.ctx.confirmProgram();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(launcherH.ctx.choosingProgram.value, true);
  assert.equal(
    launcherH.ctx.programError.value,
    'host_program_unavailable: broken-prog: xpra display failed to start',
  );

  // 2. Human program create (default role 'human') opens in Humans view and lists in surfaces().
  launcherH.ctx.programBinary.value = 'gedit';
  await launcherH.ctx.confirmProgram();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(launcherH.ctx.choosingProgram.value, false);
  assert.equal(stagedFiles.at(-1)?.mode, 'human');
  assert.equal(stagedFiles.at(-1)?.profile_id, 'gedit');
  assert.deepEqual(appH.views, ['human']);
  assert.deepEqual(appH.revealed, [{ id: 'surface_pg_1', mode: 'human' }]);
  assert.deepEqual(appH.controlCalls, [], 'human program does not arm agent take_control');

  const surfaces = await rolesBridge.surfaces();
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].role, 'human');
  assert.equal(surfaces[0].surface.surface_id, 'surface_pg_1');
  assert.equal(surfaces[0].surface.profile_id, 'gedit');
  assert.equal(surfaces[0].surface.control, 'human');

  // 3. Mount native xpra tile for program container srf-pg-gedit, resize, visibility, status.
  const mounted = await rolesBridge.mount('surface_pg_1', { x: 10, y: 20, width: 800, height: 600 });
  assert.deepEqual(mounted, { ok: true, role: 'human', visible: false });
  assert.equal(mountedTiles.length, 1);
  assert.equal(mountedTiles[0].writable, true);
  assert.equal(mountedTiles[0].capsuleId, 'surface_pg_1');

  const resized = await rolesBridge.resize('surface_pg_1', { x: 0, y: 0, width: 1280, height: 900 });
  assert.deepEqual(resized, { ok: true });
  const vis = await rolesBridge.visibility('surface_pg_1', true);
  assert.deepEqual(vis, { ok: true });
  const st = await rolesBridge.status('surface_pg_1');
  assert.equal(st.role, 'human');
  assert.equal(st.profileId, 'gedit');
  assert.deepEqual(st.storedData, {available:true,profileId:'gedit'});
  assert.equal(st.control, 'human');
  assert.equal(st.view.state, 'ready');

  // 4. Switch to agent mode and back to human mode on the same program capsule.
  const toAgent = await rolesBridge.switchMode('surface_pg_1');
  assert.equal(toAgent.ok, true);
  assert.equal(toAgent.role, 'agent');
  assert.equal(toAgent.profileId, 'gedit');
  assert.equal(states.get(toAgent.surfaceId)?.control, 'agent');

  const toHuman = await rolesBridge.switchMode(toAgent.surfaceId);
  assert.equal(toHuman.ok, true);
  assert.equal(toHuman.role, 'human');
  assert.equal(toHuman.profileId, 'gedit');
  assert.equal(states.get(toHuman.surfaceId)?.control, 'human');

  // 5. Stop frees profile ('gedit') and display (':111'), and a fresh create reuses both.
  const stopped = await rolesBridge.stop(toHuman.surfaceId);
  assert.deepEqual(stopped, { ok: true, profileId: 'gedit' });
  assert.equal(activeDisplays.size, 0);

  await launcherH.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
  launcherH.ctx.programRole.value = 'agent';
  launcherH.ctx.programBinary.value = 'gedit';
  await launcherH.ctx.confirmProgram();
  await new Promise((r) => setTimeout(r, 0));
  const agentSurfaceId = `surface_pg_${seq}`;
  assert.equal(states.get(agentSurfaceId)?.profile_id, 'gedit');
  assert.equal(states.get(agentSurfaceId)?.display, ':111');
  assert.equal(states.get(agentSurfaceId)?.control, 'agent');
  assert.equal(appH.views.at(-1), 'agent');
  assert.deepEqual(appH.controlCalls, [], 'Agent program opening preserves agent control');
  assert.deepEqual(Object.keys(appH.ctx.wallInputPending.value), [], 'Agent program opening never arms pending human input');
  assert.deepEqual(appH.revealed.at(-1), { id: agentSurfaceId, mode: 'agent' });
  await rolesBridge.stop(agentSurfaceId);
});

test('V024-PROGRAM-HUMAN-MV: mutant suite kills every gate mutation', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'v024-mutants-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const modelSrc = readFileSync(CATALOG_MODEL_PATH, 'utf8');
  const launcherSrc = readFileSync(CATALOG_LAUNCHER_PATH, 'utf8');
  const appSrc = readFileSync(APP_PATH, 'utf8');
  const openingModeSrc = readFileSync(OPENING_MODE_PATH, 'utf8');
  const xpraBridgeSrc = readFileSync(XPRA_BRIDGE_PATH, 'utf8');
  const roleHostSrc = readFileSync(ROLE_HOST_PATH, 'utf8');
  const electronBaseHref = pathToFileURL(join(HERE, '../electron/')).href;

  const importMutated = async (src, name) => {
    const rewritten = src
      .replace(/from\s+'\.\/([^']+)'/g, `from '${electronBaseHref}$1'`)
      .replace(/import\('\.\/([^']+)'\)/g, `import('${electronBaseHref}$1')`)
      .replace("new URL('./rolePreload.cjs',import.meta.url)", `new URL('${electronBaseHref}rolePreload.cjs')`);
    const f = join(tmp, `${name}.js`);
    await writeFile(f, rewritten);
    return await import(`${pathToFileURL(f).href}?m=${name}`);
  };

  // Baseline must pass all probes.
  assert.deepEqual(await runProbes(), []);

  // Mutant 1: openingMode.js still refuses human mode when hostBinary is present.
  {
    const mutated = openingModeSrc.replace(
      "if ((mode !== 'agent' && mode !== 'human') || !target.startsWith('/')",
      "if (mode !== 'agent' || !target.startsWith('/')",
    );
    assert.notEqual(mutated, openingModeSrc);
    const mod = await importMutated(mutated, 'm1-opening');
    const failed = await runProbes({ openingMode: mod });
    assert.ok(failed.includes('opening-mode-allows-human-program'), `Mutant 1 survived: ${failed}`);
  }

  // Mutant 2: xpraHumanBridge.js rejects srf-pg-* container names.
  {
    const mutated = xpraBridgeSrc.replace(
      '!/^srf-(id|pg)-[a-z0-9-]+$/.test(capsule)',
      '!/^srf-id-[a-z0-9-]+$/.test(capsule)',
    );
    assert.notEqual(mutated, xpraBridgeSrc);
    const mod = await importMutated(mutated, 'm2-bridge');
    const failed = await runProbes({ xpraBridge: mod });
    assert.ok(failed.includes('xpra-bridge-accepts-program-container'), `Mutant 2 survived: ${failed}`);
  }

  // Mutant 3: roleHost.js readRoleBinding rejects srf-pg-* container names.
  {
    const mutated = roleHostSrc.replace(
      '!/^srf-(id|pg)-[a-z0-9-]+$/.test(b.container)',
      '!/^srf-id-[a-z0-9-]+$/.test(b.container)',
    );
    assert.notEqual(mutated, roleHostSrc);
    const mod = await importMutated(mutated, 'm3-binding');
    const failed = await runProbes({ roleHost: mod });
    assert.ok(failed.includes('role-binding-and-human-mode-accept-program'), `Mutant 3 survived: ${failed}`);
  }

  // Mutant 4: roleHost.js runHumanMode rejects ack with kind: "program".
  {
    const mutated = roleHostSrc.replace(
      "if ((!exact(ack,'container,ready,schema,writable') && !(exact(ack,'container,kind,ready,schema,writable') && ['browser','program'].includes(ack.kind))) ||",
      "if (!exact(ack,'container,ready,schema,writable') ||",
    );
    assert.notEqual(mutated, roleHostSrc);
    const mod = await importMutated(mutated, 'm4-humanmode');
    const failed = await runProbes({ roleHost: mod });
    assert.ok(failed.includes('role-binding-and-human-mode-accept-program'), `Mutant 4 survived: ${failed}`);
  }

  // Mutant 5: CatalogLauncher.vue defaults programRole to 'agent' instead of 'human'.
  {
    const mutated = launcherSrc.replace("programRole = ref('human')", "programRole = ref('agent')").replace(
      "programRole.value = payload?.role === 'agent' ? 'agent' : 'human';",
      "programRole.value = 'agent';",
    );
    assert.notEqual(mutated, launcherSrc);
    const failed = await runProbes({ launcherSource: mutated });
    assert.ok(failed.includes('dialog-role-select-default-human'), `Mutant 5 survived: ${failed}`);
  }

  // Mutant 6: App.vue hardcodes selectGlobalView('agent') for human program capsules.
  {
    const mutated = appSrc.replace('selectGlobalView(openedRole);', "selectGlobalView('agent');");
    assert.notEqual(mutated, appSrc);
    const failed = await runProbes({ appSource: mutated });
    assert.ok(failed.includes('create-program-human-and-switch-mode'), `Mutant 6 survived: ${failed}`);
  }

  // Mutant 7: roleHost.js switchMode does not handle programProfiles.
  {
    const mutated = roleHostSrc.replace(
      'if (program) {\n        return await createProgram({binary:program.path,role,...(program.hostXpra ? {hostXpra:true} : {})},true,profileId);\n      }',
      'if (false) {}',
    );
    assert.notEqual(mutated, roleHostSrc);
    const mod = await importMutated(mutated, 'm7-switch');
    const failed = await runProbes({ roleHost: mod });
    assert.ok(failed.includes('create-program-human-and-switch-mode'), `Mutant 7 survived: ${failed}`);
  }

  // Mutant 8: catalogModel.js accepts arbitrary invalid role values on program intents.
  {
    const mutated = modelSrc.replace(
      "if (record.role !== undefined && record.role !== 'human' && record.role !== 'agent') {",
      'if (false) {',
    );
    assert.notEqual(mutated, modelSrc);
    const f = join(tmp, 'm8-model.js');
    await writeFile(f, mutated);
    const mod = await import(`${pathToFileURL(f).href}?m=8`);
    const failed = await runProbes({ model: mod });
    assert.ok(failed.includes('model-validates-program-role'), `Mutant 8 survived: ${failed}`);
  }
});
