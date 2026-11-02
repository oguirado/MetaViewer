/**
 * V023-HOST-MV suite: Program card Binary name field, intent payload, host
 * binary resolution (PATH + absolute path, argv-only, no shell), refusal
 * propagation to the dialog, profile-selection prohibition, immediate
 * writable tile arming, Stop, tile label, and mutant kills.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as catalogModel from '../src/catalog/catalogModel.js';
import * as roleHostMod from '../electron/roleHost.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_MODEL_PATH = join(HERE, '../src/catalog/catalogModel.js');
const CATALOG_LAUNCHER_PATH = join(HERE, '../src/catalog/CatalogLauncher.vue');
const APP_PATH = join(HERE, '../src/App.vue');
const ROLE_HOST_PATH = join(HERE, '../electron/roleHost.js');
const ROLE_PRELOAD_PATH = join(HERE, '../electron/rolePreload.cjs');

/**
 * Compile CatalogLauncher.vue scriptSetup functions into a VM context.
 * @param {string} sfcSource
 * @param {(input: unknown) => any} buildIntentFn
 * @param {any} [apiDouble]
 */
function createLauncherHarness(sfcSource, buildIntentFn, apiDouble = null) {
  const { descriptor } = parse(sfcSource);
  const compiled = compileScript(descriptor, { id: 'v023-catalog' });
  const script = descriptor.scriptSetup.content;
  const fns = compiled.scriptSetupAst
    .filter((n) => n.type === 'FunctionDeclaration')
    .map((n) => script.slice(n.start, n.end))
    .join('\n');
  const events = [];
  const ctx = {
    props: { visible: true },
    buildCreateIntent: buildIntentFn,
    api: apiDouble,
    pendingIntent: { value: null },
    roleChoice: { value: 'agent' },
    profileChoice: { value: '' },
    choosingRole: { value: false },
    roleError: { value: '' },
    choosingProgram: { value: false },
    programBinary: { value: '' },
    programError: { value: '' },
    programBusy: { value: false },
    profileChoices: { value: [] },
    matchingProfiles: { get value() { return ctx.profileChoices.value; } },
    choiceGeneration: 0,
    emit: (...args) => events.push(args),
  };
  vm.createContext(ctx);
  vm.runInContext(fns, ctx);
  return { ctx, events, template: descriptor.template?.content ?? '' };
}

/**
 * Compile App.vue onCreateCapsule + createProgramCapsule into a VM context.
 * @param {string} appSource
 * @param {any} rolesDouble
 */
function createAppProgramHarness(appSource, rolesDouble) {
  const { descriptor } = parse(appSource);
  const compiled = compileScript(descriptor, { id: 'v023-app' });
  const script = descriptor.scriptSetup.content;
  const fnMap = Object.fromEntries(
    compiled.scriptSetupAst
      .filter((n) => n.type === 'FunctionDeclaration')
      .map((n) => [n.id.name, script.slice(n.start, n.end)]),
  );
  const revealed = [];
  const controlCalls = [];
  const activities = [];
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
    pendingModeSwitch: { value: null },
    capsuleModes: { value: {} },
    selectGlobalView: (v) => views.push(v),
    nextTick: async () => {},
    revealOpenedIdentity: async (id, mode) => { revealed.push({ id, mode }); return true; },
    applyWallControl: (id, verb) => { controlCalls.push({ id, verb }); },
    reopenLiveSurfaces: () => false,
    recordActivity: (entry) => activities.push(entry),
    submitHost: async (fn) => {
      try {
        return await fn();
      } catch (err) {
        const code = err?.code || 'HOST_REQUEST_REFUSED';
        ctx.hostOutcome.value = { code, message: String(err?.message || code), tone: 'refusal' };
        activities.push({ code });
        return null;
      }
    },
    emit: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext([fnMap.createProgramCapsule, fnMap.onCreateCapsule].join('\n'), ctx);
  return { ctx, revealed, controlCalls, activities, views };
}

/**
 * Shared probe suite used for both the real implementation and mutant checks.
 */
async function runProbes({
  model = catalogModel,
  launcherSource = readFileSync(CATALOG_LAUNCHER_PATH, 'utf8'),
  appSource = readFileSync(APP_PATH, 'utf8'),
  roleHost = roleHostMod,
  roleHostSource = readFileSync(ROLE_HOST_PATH, 'utf8'),
} = {}) {
  const failed = [];
  const check = async (name, fn) => {
    try {
      if ((await fn()) !== true) failed.push(name);
    } catch {
      failed.push(name);
    }
  };

  // 1. Field required + Start disabled while empty.
  await check('field-required-model', () => {
    const missing = model.buildCreateIntent({ kind: 'program', placement: 'tab' });
    const empty = model.buildCreateIntent({ kind: 'program', placement: 'tab', binary: '   ' });
    return missing.ok === false
      && missing.error.code === 'ERR_CATALOG_INVALID_INTENT'
      && empty.ok === false
      && empty.error.code === 'ERR_CATALOG_INVALID_INTENT';
  });

  await check('field-required-dialog', async () => {
    const h = createLauncherHarness(launcherSource, model.buildCreateIntent);
    if (!h.template.includes('id="shell/new-capsule/program-binary"')) return false;
    if (!h.template.includes('required')) return false;
    if (!h.template.includes(':disabled="programBusy || !programBinary.trim()"')) return false;
    await h.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
    if (h.ctx.choosingProgram.value !== true) return false;
    await h.ctx.confirmProgram();
    return h.events.length === 0 && h.ctx.choosingProgram.value === true && h.ctx.programError.value.length > 0;
  });

  // 2. Intent carries the binary.
  await check('intent-carries-binary', () => {
    const built = model.buildCreateIntent({ kind: 'program', placement: 'split', binary: '  gedit  ' });
    return built.ok === true
      && built.intent.type === 'create-capsule'
      && built.intent.kind === 'program'
      && built.intent.placement === 'split'
      && built.intent.binary === 'gedit'
      && Object.isFrozen(built.intent);
  });

  // 3. Name resolution on the host (bare name via PATH, absolute path accepted, missing/non-exec refused with typed refusal naming the binary).
  await check('host-name-resolution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v023-bin-'));
    try {
      const gedit = join(dir, 'gedit');
      const nonExec = join(dir, 'plain-file');
      await writeFile(gedit, '#!/bin/sh\nexit 0\n');
      await chmod(gedit, 0o755);
      await writeFile(nonExec, 'not executable');
      await chmod(nonExec, 0o644);

      const bare = roleHost.resolveHostBinary('gedit', { PATH: `/nonexistent:${dir}` });
      const abs = roleHost.resolveHostBinary(gedit, { PATH: '' });
      if (bare.path !== gedit || bare.name !== 'gedit') return false;
      if (abs.path !== gedit || abs.name !== 'gedit') return false;

      for (const bad of ['missing-prog', nonExec, './gedit', '../gedit']) {
        let threw = null;
        try {
          roleHost.resolveHostBinary(bad, { PATH: dir });
        } catch (err) {
          threw = err;
        }
        if (!threw || threw.code !== 'HOST_PROGRAM_UNAVAILABLE' || !String(threw.reason).includes(bad) || !String(threw.reason).startsWith('host_program_unavailable:')) {
          return false;
        }
      }
      return true;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // 4. Refusal propagation to the dialog (never swallowed, dialog stays open).
  await check('refusal-propagates-to-dialog', async () => {
    const h = createLauncherHarness(launcherSource, model.buildCreateIntent);
    await h.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
    h.ctx.programBinary.value = 'missing-editor';
    const appH = createAppProgramHarness(appSource, {
      createProgram: async ({ binary }) => ({
        ok: false,
        code: 'HOST_PROGRAM_UNAVAILABLE',
        reason: `host_program_unavailable: ${binary}: not found in PATH`,
      }),
    });
    h.ctx.emit = (event, payload, settle) => {
      h.events.push([event, payload]);
      if (event === 'create') appH.ctx.onCreateCapsule(payload, settle);
    };
    await h.ctx.confirmProgram();
    return h.ctx.choosingProgram.value === true
      && h.ctx.programError.value === 'host_program_unavailable: missing-editor: not found in PATH';
  });

  // 5. No shell anywhere (source + metacharacter refusal).
  await check('no-shell-anywhere', async () => {
    if (/\b(?:exec|execSync|spawnSync)\s*\(/.test(roleHostSource) || /shell\s*:\s*true/.test(roleHostSource) || /\/bin\/(?:sh|bash)/.test(roleHostSource)) {
      return false;
    }
    const dir = await mkdtemp(join(tmpdir(), 'v023-noshell-'));
    try {
      const gedit = join(dir, 'gedit');
      await writeFile(gedit, '#!/bin/sh\nexit 0\n');
      await chmod(gedit, 0o755);
      for (const payload of ['gedit;id', 'gedit|sh', 'gedit&&whoami', '$(id)', '`id`', 'gedit --flag']) {
        let refused = false;
        try {
          roleHost.resolveHostBinary(payload, { PATH: dir });
        } catch (err) {
          refused = err?.code === 'HOST_PROGRAM_UNAVAILABLE';
        }
        if (!refused) return false;
      }
      return true;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // 6. Renderer cannot pick a non-program profile (neither in App.vue nor in roleHost.js).
  await check('renderer-cannot-pick-profile', async () => {
    const appH = createAppProgramHarness(appSource, {
      createProgram: async () => ({ ok: true, surfaceId: 'surface-1', profileId: 'gedit', binary: 'gedit' }),
    });
    let settled = null;
    appH.ctx.onCreateCapsule(
      { type: 'create-capsule', kind: 'program', placement: 'tab', binary: 'gedit', profileId: 'mv-live-1' },
      (res) => { settled = res; },
    );
    if (!settled || settled.ok !== false || settled.code !== 'PROGRAM_PROFILE_FORBIDDEN') return false;

    const root = await mkdtemp(join(tmpdir(), 'v023-rolehost-'));
    try {
      const binDir = join(root, 'bin');
      await mkdir(binDir, { mode: 0o700 });
      const gedit = join(binDir, 'gedit');
      await writeFile(gedit, '#!/bin/sh\nexit 0\n');
      await chmod(gedit, 0o755);
      const handlers = new Map();
      const states = new Map();
      const parent = new EventEmitter();
      parent.webContents = { session: { registerPreloadScript: () => 'p', unregisterPreloadScript() {} } };
      const env = {
        PATH: binDir,
        MV_SRF_PROFILES: JSON.stringify({
          'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
        }),
        MV_SRF_STATE_DIR: root,
        MV_SRF_BIN_DIR: binDir,
      };
      const host = roleHost.installRoleHost({
        electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
        window: parent,
        env,
        capsuleStates: states,
        core: { getHumanSurface: (id) => states.get(id), request: async () => ({ schema: 'surface_event/v0.2', event: 'error' }) },
        admit: () => true,
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }] }),
      });
      try {
        const invoke = (choice) => handlers.get('metaviewer:roles.v0.3')({}, { schema: 'metaviewer.roles/v0.3', op: 'create-program', choice });
        for (const badChoice of [
          { binary: 'gedit', profileId: 'mv-live-1' },
          { binary: 'gedit', profile_id: 'cuentas-1' },
          { binary: 'gedit', profile: 'perplexity-1' },
        ]) {
          const reply = await invoke(badChoice);
          if (reply.ok !== false || reply.code !== 'PROGRAM_PROFILE_FORBIDDEN') return false;
        }
        return true;
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  return failed;
}

test('V023-HOST-MV: real modules pass all program binary probes', async () => {
  assert.deepEqual(await runProbes(), []);
});

test('V023-HOST-MV: multiple program capsules, immediate writable tile arming, tile label, and Stop', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'v023-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  await mkdir(binDir, { mode: 0o700 });
  const geditPath = join(binDir, 'gedit');
  await writeFile(geditPath, '#!/bin/sh\nexit 0\n');
  await chmod(geditPath, 0o755);

  const handlers = new Map();
  const states = new Map();
  const coreRequests = [];
  const stagedFiles = [];
  let seq = 0;

  const parent = new EventEmitter();
  parent.webContents = { session: { registerPreloadScript: () => 'p', unregisterPreloadScript() {} } };
  const env = {
    PATH: binDir,
    MV_SRF_PROFILES: JSON.stringify({
      'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
      'mv-live-2': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':112' },
    }),
    MV_SRF_STATE_DIR: root,
    MV_SRF_BIN_DIR: binDir,
  };
  const core = {
    getHumanSurface: (id) => states.get(id),
    stopSurface: (surfaceId) => core.request({ schema: 'surface_request/v0.2', op: 'destroy', params: { surface_id: surfaceId } }),
    async request(req) {
      coreRequests.push(req);
      if (req.op === 'destroy') {
        const s = { ...states.get(req.params.surface_id), state: 'destroyed' };
        states.set(s.surface_id, s);
        return { schema: 'surface_event/v0.2', event: 'state_changed', data: { surface: s } };
      }
      const staged = JSON.parse(await readFile(join(root, 'opening-modes', `${req.params.profile_id}.json`), 'utf8'));
      stagedFiles.push(staged);
      const surface = {
        schema: 'surface/v0.2',
        surface_id: `surface-pg-${++seq}`,
        kind: 'desktop_capsule',
        profile_id: req.params.profile_id,
        state: 'active',
        control: 'agent',
        visibility: 'unfolded',
        display: `:11${seq}`,
        geometry: { w: 1280, h: 900 },
      };
      states.set(surface.surface_id, surface);
      return { schema: 'surface_event/v0.2', event: 'created', data: { surface } };
    },
  };
  const host = roleHostMod.installRoleHost({
    electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
    window: parent,
    env,
    capsuleStates: states,
    core,
    admit: () => true,
    listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }, { id: 'mv-live-2' }] }),
  });
  t.after(() => host.dispose());

  const invoke = (op, body = {}) => handlers.get('metaviewer:roles.v0.3')({}, { schema: 'metaviewer.roles/v0.3', op, ...body });
  const rolesBridge = {
    createProgram: (choice) => invoke('create-program', { choice }),
    status: (surfaceId) => invoke('status', { surfaceId }),
    stop: (surfaceId) => invoke('stop', { surfaceId }),
  };

  // Preload exposes createProgram.
  const preloadSource = readFileSync(ROLE_PRELOAD_PATH, 'utf8');
  assert.match(preloadSource, /createProgram:\s*choice\s*=>\s*invoke\('create-program',\s*\{choice\}\)/);

  // Open two concurrent gedit capsules through Launcher -> App.onCreateCapsule -> roleHost.
  const appH = createAppProgramHarness(readFileSync(APP_PATH, 'utf8'), rolesBridge);
  const launcherH = createLauncherHarness(readFileSync(CATALOG_LAUNCHER_PATH, 'utf8'), catalogModel.buildCreateIntent, rolesBridge);
  launcherH.ctx.emit = (event, payload, settle) => {
    launcherH.events.push([event, payload]);
    if (event === 'create') appH.ctx.onCreateCapsule(payload, settle);
  };

  await launcherH.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
  launcherH.ctx.programBinary.value = 'gedit';
  await launcherH.ctx.confirmProgram();
  assert.equal(launcherH.ctx.choosingProgram.value, false, 'dialog closes on successful start');

  await launcherH.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
  launcherH.ctx.programBinary.value = geditPath;
  await launcherH.ctx.confirmProgram();

  assert.equal(stagedFiles.length, 2);
  assert.deepEqual(stagedFiles[0], {
    schema: 'metaviewer.opening_mode/v0.3',
    profile_id: 'gedit',
    mode: 'agent',
    host_binary: geditPath,
  });
  assert.deepEqual(stagedFiles[1], {
    schema: 'metaviewer.opening_mode/v0.3',
    profile_id: 'gedit-2',
    mode: 'agent',
    host_binary: geditPath,
  });

  // Both tiles were revealed in agent view and immediately armed via take_control with no extra menu click.
  assert.deepEqual(appH.revealed, [
    { id: 'surface-pg-1', mode: 'agent' },
    { id: 'surface-pg-2', mode: 'agent' },
  ]);
  assert.deepEqual(appH.controlCalls, [
    { id: 'surface-pg-1', verb: 'take_control' },
    { id: 'surface-pg-2', verb: 'take_control' },
  ]);
  assert.equal(appH.ctx.wallInputPending.value['surface-pg-1'], true);
  assert.equal(appH.ctx.wallInputPending.value['surface-pg-2'], true);

  // Tile label uses profile_id ('gedit') and status + Stop work on the program capsule.
  const status1 = await rolesBridge.status('surface-pg-1');
  assert.equal(status1.role, 'agent');
  assert.equal(status1.profileId, 'gedit');

  const stopped1 = await rolesBridge.stop('surface-pg-1');
  assert.deepEqual(stopped1, { ok: true, profileId: 'gedit' });
  assert.equal(states.get('surface-pg-1').state, 'destroyed');
});

test('V023-HOST-MV: mutant suite kills every required mutant', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'v023-mutants-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const modelSrc = readFileSync(CATALOG_MODEL_PATH, 'utf8');
  const launcherSrc = readFileSync(CATALOG_LAUNCHER_PATH, 'utf8');
  const appSrc = readFileSync(APP_PATH, 'utf8');
  const roleHostSrc = readFileSync(ROLE_HOST_PATH, 'utf8');

  // Mutant 1: field not required in buildCreateIntent.
  {
    const mutatedSrc = modelSrc.replace('if (binary.length === 0) {', 'if (false && binary.length === 0) {');
    assert.notEqual(mutatedSrc, modelSrc);
    const f = join(tmp, 'model-m1.js');
    await writeFile(f, mutatedSrc);
    const mutatedModel = await import(`${pathToFileURL(f).href}?m=1`);
    const failed = await runProbes({ model: mutatedModel });
    assert.ok(failed.includes('field-required-model'), `Mutant 1 survived: ${failed}`);
  }

  // Mutant 2: Start button not disabled while empty in CatalogLauncher.vue.
  {
    const mutatedLauncher = launcherSrc.replace(':disabled="programBusy || !programBinary.trim()"', ':disabled="programBusy"');
    assert.notEqual(mutatedLauncher, launcherSrc);
    const failed = await runProbes({ launcherSource: mutatedLauncher });
    assert.ok(failed.includes('field-required-dialog'), `Mutant 2 survived: ${failed}`);
  }

  // Mutant 3: buildCreateIntent drops binary from the returned intent.
  {
    const mutatedSrc = modelSrc.replace('        binary,\n', '');
    assert.notEqual(mutatedSrc, modelSrc);
    const f = join(tmp, 'model-m3.js');
    await writeFile(f, mutatedSrc);
    const mutatedModel = await import(`${pathToFileURL(f).href}?m=3`);
    const failed = await runProbes({ model: mutatedModel });
    assert.ok(failed.includes('intent-carries-binary'), `Mutant 3 survived: ${failed}`);
  }

  // Mutant 4: resolveHostBinary skips executable check / accepts missing binary.
  {
    const mutatedRoleHost = roleHostSrc.replace(
      "fail(`${trimmed}: not found in PATH`);",
      "return {path:'/' + trimmed, name:trimmed};",
    );
    assert.notEqual(mutatedRoleHost, roleHostSrc);
    const mutatedFake = {
      ...roleHostMod,
      resolveHostBinary(binary) {
        return { path: `/${binary}`, name: String(binary) };
      },
    };
    const failed = await runProbes({ roleHost: mutatedFake });
    assert.ok(failed.includes('host-name-resolution'), `Mutant 4 survived: ${failed}`);
  }

  // Mutant 5: refusal swallowed in CatalogLauncher.vue (dialog closes and clears error on refusal).
  {
    const mutatedLauncher = launcherSrc.replace(
      "if (outcome && outcome.ok === false) {\n      programError.value = outcome.reason || outcome.message || outcome.code || 'Program could not be started.';\n      return;\n    }",
      "if (false) {}",
    );
    assert.notEqual(mutatedLauncher, launcherSrc);
    const failed = await runProbes({ launcherSource: mutatedLauncher });
    assert.ok(failed.includes('refusal-propagates-to-dialog'), `Mutant 5 survived: ${failed}`);
  }

  // Mutant 6: shell usage / metacharacters not refused.
  {
    const mutatedSource = `${roleHostSrc}\n// shell: true\n`;
    const failed = await runProbes({ roleHostSource: mutatedSource });
    assert.ok(failed.includes('no-shell-anywhere'), `Mutant 6 survived: ${failed}`);
  }

  // Mutant 7: renderer allowed to supply a non-program profileId.
  {
    const mutatedApp = appSrc.replace(
      'if (body.profileId || body.profile_id || body.choice?.profileId || body.choice?.profile_id) {',
      'if (false) {',
    );
    assert.notEqual(mutatedApp, appSrc);
    const failed = await runProbes({ appSource: mutatedApp });
    assert.ok(failed.includes('renderer-cannot-pick-profile'), `Mutant 7 survived: ${failed}`);
  }
});
