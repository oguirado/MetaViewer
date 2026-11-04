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
import * as hostAdaptersMod from '../src/core/hostAdapters.js';
import * as activityModelMod from '../src/activity/activityModel.js';
import * as operatorBridgeMod from '../electron/operatorBridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_MODEL_PATH = join(HERE, '../src/catalog/catalogModel.js');
const CATALOG_LAUNCHER_PATH = join(HERE, '../src/catalog/CatalogLauncher.vue');
const APP_PATH = join(HERE, '../src/App.vue');
const ROLE_HOST_PATH = join(HERE, '../electron/roleHost.js');
const ROLE_PRELOAD_PATH = join(HERE, '../electron/rolePreload.cjs');
const HOST_ADAPTERS_PATH = join(HERE, '../src/core/hostAdapters.js');
const ACTIVITY_MODEL_PATH = join(HERE, '../src/activity/activityModel.js');
const IDENTITIES_DIALOG_PATH = join(HERE, '../src/identities/IdentitiesDialog.vue');

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
    disabledArmKinds: { get value() { return catalogModel.unavailableArmCapsules(ctx.props.arm64Capabilities); } },
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
  vm.runInContext([fnMap.recordActivity, fnMap.submitHost, fnMap.reportRevealPending, fnMap.createProgramCapsule, fnMap.onCreateCapsule].join('\n'), ctx);
  const origRecord = ctx.recordActivity;
  ctx.recordActivity = (entry) => {
    origRecord(entry);
    activities.length = 0;
    activities.push(...ctx.activityFeed.value);
  };
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
  hostAdapters = hostAdaptersMod,
  activityModel = activityModelMod,
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

  // 4. Refusal propagation to the dialog and Activity (never swallowed, dialog stays open, exact reason in dialog, HostOutcome, and ActivityStrip).
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
    await new Promise((r) => setTimeout(r, 0));
    const expectedReason = 'host_program_unavailable: missing-editor: not found in PATH';
    const expectedFull = `HOST_PROGRAM_UNAVAILABLE: ${expectedReason}`;
    const outcomeRow = hostAdapters.hostOutcomeFor(appH.ctx.hostOutcome.value);
    const activityRow = activityModel.normalizeActivityEntry(appH.ctx.activityFeed.value.at(-1));
    return h.ctx.choosingProgram.value === true
      && h.ctx.programError.value === expectedReason
      && outcomeRow?.message === expectedFull
      && activityRow?.text === expectedFull;
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

  // 7. Review Fix 1: failed or malformed listIdentities in createProgram fails closed with no capsule started.
  await check('listIdentities-fail-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v023-idlist-'));
    try {
      const binDir = join(root, 'bin');
      await mkdir(binDir, { mode: 0o700 });
      const gedit = join(binDir, 'gedit');
      await writeFile(gedit, '#!/bin/sh\nexit 0\n');
      await chmod(gedit, 0o755);
      const env = {
        PATH: binDir,
        MV_SRF_PROFILES: JSON.stringify({
          'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
        }),
        MV_SRF_STATE_DIR: root,
        MV_SRF_BIN_DIR: binDir,
      };
      for (const badList of [
        async () => { throw new Error('store down'); },
        async () => ({ ok: false, code: 'STORE_ERR' }),
        async () => ({ ok: true, rows: 'not-an-array' }),
        async () => ({ ok: true, rows: [{}] }),
        null,
      ]) {
        const handlers = new Map();
        const states = new Map();
        let started = 0;
        let staged = 0;
        const parent = new EventEmitter();
        parent.webContents = { session: { registerPreloadScript: () => 'p', unregisterPreloadScript() {} } };
        const host = roleHost.installRoleHost({
          electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
          window: parent,
          env,
          capsuleStates: states,
          core: {
            getHumanSurface: (id) => states.get(id),
            request: async () => {
              started++;
              return {
                schema: 'surface_event/v0.2',
                event: 'created',
                data: { surface: { schema: 'surface/v0.2', surface_id: 'surface-bad', profile_id: 'gedit', state: 'active', control: 'agent' } },
              };
            },
          },
          admit: () => true,
          listIdentities: badList,
          stageMode: async () => { staged++; return async () => {}; },
        });
        try {
          const reply = await handlers.get('metaviewer:roles.v0.3')({}, {
            schema: 'metaviewer.roles/v0.3',
            op: 'create-program',
            choice: { binary: 'gedit' },
          });
          if (!reply || reply.ok !== false || reply.code !== 'IDENTITY_LIST_UNAVAILABLE' || typeof reply.reason !== 'string' || !reply.reason.length) {
            return false;
          }
          if (started !== 0 || staged !== 0 || states.size !== 0) return false;
        } finally {
          await host.dispose();
        }
      }
      return true;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 8. Review Fix 2: rejecting clearMode in finally still resets creating and preserves the original error.
  await check('clearMode-reject-resets-creating-and-keeps-error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v023-clearmode-'));
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
      let shouldFailCreate = true;
      const host = roleHost.installRoleHost({
        electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
        window: parent,
        env: {
          PATH: binDir,
          MV_SRF_PROFILES: JSON.stringify({
            'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
          }),
          MV_SRF_STATE_DIR: root,
          MV_SRF_BIN_DIR: binDir,
        },
        capsuleStates: states,
        core: {
          getHumanSurface: (id) => states.get(id),
          request: async (req) => {
            if (shouldFailCreate) {
              return {
                schema: 'surface_event/v0.2',
                event: 'error',
                data: { code: 'HOST_PROGRAM_UNAVAILABLE', detail: 'host_program_unavailable: gedit rejected by surface' },
              };
            }
            const surface = {
              schema: 'surface/v0.2',
              surface_id: 'surface-pg-recovered',
              kind: 'desktop_capsule',
              profile_id: req.params.profile_id,
              state: 'active',
              control: 'agent',
            };
            states.set(surface.surface_id, surface);
            return { schema: 'surface_event/v0.2', event: 'created', data: { surface } };
          },
        },
        admit: () => true,
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }] }),
        stageMode: async () => async () => {
          throw Object.assign(new Error('CLEAR_MODE_BOOM'), { code: 'CLEAR_MODE_BOOM', reason: 'clearMode failed' });
        },
      });
      try {
        const invoke = () => handlers.get('metaviewer:roles.v0.3')({}, {
          schema: 'metaviewer.roles/v0.3',
          op: 'create-program',
          choice: { binary: 'gedit' },
        });
        const first = await invoke();
        if (first.ok !== false || first.code !== 'HOST_PROGRAM_UNAVAILABLE' || !String(first.reason).includes('gedit rejected by surface')) {
          return false;
        }
        shouldFailCreate = false;
        const second = await invoke();
        return second.ok === true && second.surfaceId === 'surface-pg-recovered' && second.profileId === 'gedit';
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 9. Only verified terminal removal makes the name immediately reusable.
  await check('programProfiles-pruned-on-destroy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v023-prune-'));
    try {
      const binDir = join(root, 'bin');
      await mkdir(binDir, { mode: 0o700 });
      const gedit = join(binDir, 'gedit');
      await writeFile(gedit, '#!/bin/sh\nexit 0\n');
      await chmod(gedit, 0o755);
      const handlers = new Map();
      const states = new Map();
      let seq = 0;
      const parent = new EventEmitter();
      parent.webContents = { session: { registerPreloadScript: () => 'p', unregisterPreloadScript() {} } };
      const host = roleHost.installRoleHost({
        electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
        window: parent,
        env: {
          PATH: binDir,
          MV_SRF_PROFILES: JSON.stringify({
            'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
          }),
          MV_SRF_STATE_DIR: root,
          MV_SRF_BIN_DIR: binDir,
        },
        capsuleStates: states,
        core: {
          getHumanSurface: (id) => states.get(id),
          request: async (req) => {
            const surface = {
              schema: 'surface/v0.2',
              surface_id: `surface-pg-${++seq}`,
              kind: 'desktop_capsule',
              profile_id: req.params.profile_id,
              state: 'active',
              control: 'agent',
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
        const first = await invoke('create-program', { choice: { binary: 'gedit' } });
        if (!first.ok || first.profileId !== 'gedit') return false;

        // Route A: surface transitions to 'destroyed' outside roleHost.stop()
        states.set(first.surfaceId, { ...states.get(first.surfaceId), state: 'destroyed' });
        const staleStatus = await invoke('status', { surfaceId: first.surfaceId });
        if (staleStatus.ok !== false || staleStatus.code !== 'SURFACE_UNKNOWN') return false;

        // Name 'gedit' is immediately reusable again (not 'gedit-2')
        const second = await invoke('create-program', { choice: { binary: 'gedit' } });
        if (!second.ok || second.profileId !== 'gedit') return false;

        // Route B: surface is deleted / destroyed externally
        states.delete(second.surfaceId);
        const third = await invoke('create-program', { choice: { binary: 'gedit' } });
        return third.ok === true && third.profileId === 'gedit';
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 10. Review Fix 4: CatalogLauncher never calls api.createProgram when parent does not settle; App displayOnly settles.
  await check('launcher-no-unsettled-bypass-and-displayOnly-settles', async () => {
    let directCalls = 0;
    const h = createLauncherHarness(launcherSource, model.buildCreateIntent, {
      createProgram: async () => {
        directCalls++;
        return { ok: true, surfaceId: 'bypassed' };
      },
    });
    await h.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
    h.ctx.programBinary.value = 'gedit';
    // Parent listener ignores settle completely:
    h.ctx.emit = (event, payload) => {
      h.events.push([event, payload]);
    };
    await h.ctx.confirmProgram();
    if (directCalls !== 0 || h.ctx.choosingProgram.value !== true || !h.ctx.programError.value) {
      return false;
    }

    // Now wire to App with nestedMode.displayOnly = true: App must settle so Launcher shows the refusal and never hangs or bypasses.
    let roleCalls = 0;
    const appH = createAppProgramHarness(appSource, {
      createProgram: async () => {
        roleCalls++;
        return { ok: true, surfaceId: 'should-not-run' };
      },
    });
    appH.ctx.nestedMode.displayOnly = true;
    const h2 = createLauncherHarness(launcherSource, model.buildCreateIntent, {
      createProgram: async () => {
        directCalls++;
        return { ok: true };
      },
    });
    await h2.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
    h2.ctx.programBinary.value = 'gedit';
    let settledOutcome = null;
    h2.ctx.emit = (event, payload, settle) => {
      h2.events.push([event, payload]);
      if (event === 'create') {
        appH.ctx.onCreateCapsule(payload, (res) => {
          settledOutcome = res;
          settle(res);
        });
      }
    };
    await h2.ctx.confirmProgram();
    return directCalls === 0
      && roleCalls === 0
      && settledOutcome?.ok === false
      && settledOutcome?.code === 'DISPLAY_ONLY'
      && h2.ctx.choosingProgram.value === true
      && h2.ctx.programError.value.includes('display-only');
  });

  // 11. Review Fix 5: App switches view to 'agent' only on success, and post-launch reveal/wall-control throws do not report launch as failed.
  await check('app-view-on-success-only-and-post-launch-throw-safe', async () => {
    // Part A: Failed createProgram must NOT switch global view to 'agent'.
    const failH = createAppProgramHarness(appSource, {
      createProgram: async () => ({ ok: false, code: 'HOST_PROGRAM_UNAVAILABLE', reason: 'missing binary' }),
    });
    let failSettled = null;
    failH.ctx.onCreateCapsule({ kind: 'program', binary: 'missing' }, (p) => { failSettled = p; });
    const failReply = await failSettled;
    if (failReply?.ok !== false || failH.views.length !== 0) return false;

    // Part B: Successful createProgram switches view to 'agent'; a throw in revealOpenedIdentity or applyWallControl does not fail the launch.
    const okH = createAppProgramHarness(appSource, {
      createProgram: async () => ({ ok: true, surfaceId: 'surface-pg-ok', profileId: 'gedit', binary: 'gedit' }),
    });
    okH.ctx.revealOpenedIdentity = async () => {
      throw new Error('REVEAL_EXPLODED');
    };
    let okSettled = null;
    okH.ctx.onCreateCapsule({ kind: 'program', binary: 'gedit' }, (p) => { okSettled = p; });
    const okReply = await okSettled;
    await new Promise((r) => setTimeout(r, 0));
    return okReply?.ok === true
      && okReply?.surfaceId === 'surface-pg-ok'
      && okH.views.includes('agent')
      && okH.ctx.hostOutcome.value?.code === 'CAPSULE_REVEAL_PENDING'
      && /running.*Identities.*retry/.test(okH.ctx.hostOutcome.value?.message);
  });

  // 12. Review Fix 6: intent with kind 'program' and empty binary or naming a profile is refused, never passed to identity branch.
  await check('app-program-empty-binary-or-profile-refused', async () => {
    let createSurfaceCalls = 0;
    const appH = createAppProgramHarness(appSource, {
      createProgram: async () => ({ ok: true, surfaceId: 's1' }),
    });
    appH.ctx.props.authorityHost.createSurface = async () => {
      createSurfaceCalls++;
      return { code: 'INTENT_ACKNOWLEDGED', message: 'Request sent.', tone: 'success' };
    };

    for (const emptyIntent of [
      { kind: 'program' },
      { kind: 'program', binary: '' },
      { kind: 'program', binary: '   ' },
      { kind: 'program', binary: null },
    ]) {
      let settled = null;
      appH.ctx.hostOutcome.value = null;
      appH.ctx.onCreateCapsule(emptyIntent, (res) => { settled = res; });
      if (!settled || settled.ok !== false || settled.code !== 'PROGRAM_BINARY_REQUIRED') return false;
      if (appH.ctx.hostOutcome.value?.code !== 'PROGRAM_BINARY_REQUIRED') return false;
    }

    for (const profileIntent of [
      { kind: 'program', binary: '', profileId: 'mv-live-1' },
      { kind: 'program', binary: 'gedit', profile: 'mv-live-1' },
      { kind: 'program', choice: { profileId: 'mv-live-1', role: 'agent' } },
    ]) {
      let settled = null;
      appH.ctx.hostOutcome.value = null;
      appH.ctx.onCreateCapsule(profileIntent, (res) => { settled = res; });
      if (!settled || settled.ok !== false || settled.code !== 'PROGRAM_PROFILE_FORBIDDEN') return false;
      if (appH.ctx.hostOutcome.value?.code !== 'PROGRAM_PROFILE_FORBIDDEN') return false;
    }

    return createSurfaceCalls === 0;
  });

  // 13. V023-HOST-MV2: createProgram provisions program identity before create, reuses earlier program identity, refuses protected names, rolls back on provisioning failure, and preserves binary name + reason across roleHost.
  await check('program-provisioning-and-reason-preservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v023-prov-probe-'));
    try {
      const binDir = join(root, 'bin');
      await mkdir(binDir, { mode: 0o700 });
      for (const name of ['gedit', 'gnome-calculator', 'notepad-1', 'srf-id-cuentas-1', 'mv-live-1']) {
        const p = join(binDir, name);
        await writeFile(p, '#!/bin/sh\nexit 0\n');
        await chmod(p, 0o755);
      }
      const handlers = new Map();
      const states = new Map();
      const parent = new EventEmitter();
      parent.webContents = { session: { registerPreloadScript: () => 'p', unregisterPreloadScript() {} } };
      const provisioned = new Map(); // id -> { browser: 'program', mode: 0o700, uid: 10001 }
      const identityStore = new Map([
        ['mv-live-1', { id: 'mv-live-1', label: 'Live 1', domains: [], logged_in: 'unknown' }],
      ]);
      let failProvision = false;
      let surfaceRefusal = null;
      let seq = 0;

      const host = roleHost.installRoleHost({
        electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
        window: parent,
        env: {
          PATH: binDir,
          MV_SRF_PROFILES: JSON.stringify({
            'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
          }),
          MV_SRF_STATE_DIR: root,
          MV_SRF_BIN_DIR: binDir,
        },
        capsuleStates: states,
        core: {
          getHumanSurface: (id) => states.get(id),
          stopSurface: async (surfaceId) => {
            const s = { ...states.get(surfaceId), state: 'destroyed' };
            states.set(surfaceId, s);
            return { schema: 'surface_event/v0.2', event: 'state_changed', data: { surface: s } };
          },
          request: async (req) => {
            const pid = req.params.profile_id;
            const prov = provisioned.get(pid);
            if (!prov || prov.browser !== 'program' || prov.mode !== 0o700 || prov.uid !== 10001) {
              return {
                schema: 'surface_event/v0.2',
                event: 'error',
                data: {
                  code: 'identity_unavailable',
                  detail: 'native start reported the identity unavailable (exit status 4)',
                },
              };
            }
            if (surfaceRefusal) {
              return {
                schema: 'surface_event/v0.2',
                event: 'error',
                data: surfaceRefusal,
              };
            }
            const surface = {
              schema: 'surface/v0.2',
              surface_id: `surface-prov-${++seq}`,
              kind: 'desktop_capsule',
              profile_id: pid,
              state: 'active',
              control: 'agent',
            };
            states.set(surface.surface_id, surface);
            return { schema: 'surface_event/v0.2', event: 'created', data: { surface } };
          },
        },
        admit: () => true,
        listIdentities: async () => ({ ok: true, rows: [...identityStore.values()] }),
        provisionProgramIdentity: async ({ id, label }) => {
          if (failProvision) {
            return { ok: false, code: 'PROFILE_NOT_PROVISIONED', reason: 'profile directory mode 0700 uid 10001 required' };
          }
          provisioned.set(id, { id, label, browser: 'program', mode: 0o700, uid: 10001 });
          identityStore.set(id, { id, label, domains: [], logged_in: 'unknown', browser: 'program' });
          return { ok: true, rows: [identityStore.get(id)] };
        },
      });
      try {
        const invoke = (op, extra = {}) => handlers.get('metaviewer:roles.v0.3')({}, { schema: 'metaviewer.roles/v0.3', op, ...extra });

        // A: Protected names are refused before provisioning or surface start.
        for (const badBin of ['notepad-1', 'srf-id-cuentas-1', 'mv-live-1']) {
          const prot = await invoke('create-program', { choice: { binary: badBin } });
          if (prot?.ok !== false || prot.code !== 'IDENTITY_PROTECTED' || !String(prot.reason).includes(badBin)) {
            return false;
          }
        }
        if (provisioned.size !== 0) return false;

        // B: Provisioning failure surfaces real code and reason naming the binary, and leaves no pending capsule.
        failProvision = true;
        const failedProv = await invoke('create-program', { choice: { binary: 'gedit' } });
        failProvision = false;
        if (failedProv?.ok !== false || failedProv.code !== 'PROFILE_NOT_PROVISIONED' || !String(failedProv.reason).includes('gedit') || !String(failedProv.reason).includes('0700')) {
          return false;
        }
        if (states.size !== 0) return false;

        // C: Normal launch provisions 'gedit' with browser 'program' before core.request and succeeds.
        const first = await invoke('create-program', { choice: { binary: 'gedit' } });
        if (first?.ok !== true || first.profileId !== 'gedit' || !provisioned.has('gedit')) {
          return false;
        }

        // D: Program identity 'gedit' is NOT offered as a browser in choices(), create(), or open().
        const browserChoices = await invoke('choices');
        if (!Array.isArray(browserChoices) || browserChoices.some((c) => c.profileId === 'gedit')) {
          return false;
        }
        const browserOpenAttempt = await invoke('open', { choice: { profileId: 'gedit', role: 'agent' } });
        if (browserOpenAttempt?.ok === true) return false;

        // E: Stop frees the capsule; a second launch of 'gedit' reuses the existing 'program' identity 'gedit' (not 'gedit-2' and not an error).
        const stopped = await invoke('stop', { surfaceId: first.surfaceId });
        if (stopped?.ok !== true) return false;
        const reused = await invoke('create-program', { choice: { binary: 'gedit' } });
        if (reused?.ok !== true || reused.profileId !== 'gedit') {
          return false;
        }

        // F: Native exit-2 refusal preserves the binary name and exact detail in reply.reason.
        surfaceRefusal = { code: 'HOST_PROGRAM_UNAVAILABLE', detail: 'host_program_unavailable: binary does not exist' };
        const calcRefused = await invoke('create-program', { choice: { binary: 'gnome-calculator' } });
        surfaceRefusal = null;
        if (calcRefused?.ok !== false || calcRefused.code !== 'HOST_PROGRAM_UNAVAILABLE'
            || calcRefused.reason !== 'host_program_unavailable: gnome-calculator: binary does not exist') {
          return false;
        }
        return true;
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 14. V024-WALL-FIXES: With metaviewerRoles present, kit dialog emits create then closes synchronously, and the role and identity dialog appears with its choices.
  await check('launcher-role-dialog-survives-sync-kit-close', async () => {
    const fakeChoices = [
      { profileId: 'mv-live-1', role: 'human', available: true, currentMode: 'human' },
      { profileId: 'mv-live-2', role: 'agent', available: false },
    ];
    const h = createLauncherHarness(launcherSource, model.buildCreateIntent, {
      choices: async () => {
        await new Promise((r) => setTimeout(r, 0));
        return fakeChoices;
      },
    });
    h.ctx.emit = (event, payload) => {
      h.events.push([event, payload]);
      if (event === 'update:visible') {
        h.ctx.props.visible = Boolean(payload);
      }
    };
    // Kit NewCapsuleDialog emits create, then synchronously emits update:visible(false) and close.
    const createPromise = h.ctx.onCreate({ type: { id: 'identity-browser' }, placement: 'tab' });
    h.ctx.forwardVisible(false);
    h.ctx.onClose();
    await createPromise;
    return h.ctx.choosingRole.value === true
      && h.ctx.props.visible === true
      && h.ctx.profileChoice.value === 'mv-live-1'
      && h.ctx.roleChoice.value === 'human'
      && Array.isArray(h.ctx.profileChoices.value)
      && h.ctx.profileChoices.value.length === 2
      && !h.events.some(([ev, val]) => ev === 'update:visible' && val === false)
      && !h.events.some(([ev]) => ev === 'close');
  });

  // 15. V024-CAPSULE-LIMIT: roleHost admits up to 16 capsules, checks 6 GiB free memory before create, and formats limit/slot/memory refusals without host_program_unavailable.
  await check('capsule-limit-and-memory-check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v024-limit-probe-'));
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
      let freeBytes = 12 * 1024 * 1024 * 1024;
      let forceSlotRefusal = false;
      let seq = 0;
      const host = roleHost.installRoleHost({
        electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
        window: parent,
        env: {
          PATH: binDir,
          MV_SRF_PROFILES: JSON.stringify({
            'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
          }),
          MV_SRF_STATE_DIR: root,
          MV_SRF_BIN_DIR: binDir,
        },
        capsuleStates: states,
        readFreeMemoryBytes: async () => freeBytes,
        core: {
          getHumanSurface: (id) => states.get(id),
          request: async (req) => {
            if (forceSlotRefusal) {
              return {
                schema: 'surface_event/v0.2',
                event: 'error',
                data: { code: 'CAPSULE_SLOT_UNAVAILABLE', detail: 'identity display pool exhausted; stop a capsule first' },
              };
            }
            const surface = {
              schema: 'surface/v0.2',
              surface_id: `surface-cap-${++seq}`,
              kind: 'desktop_capsule',
              profile_id: req.params.profile_id,
              state: 'active',
              control: 'agent',
            };
            states.set(surface.surface_id, surface);
            return { schema: 'surface_event/v0.2', event: 'created', data: { surface } };
          },
        },
        admit: () => true,
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }] }),
        provisionProgramIdentity: async () => ({ ok: true }),
      });
      try {
        const invoke = (op, extra = {}) => handlers.get('metaviewer:roles.v0.3')({}, { schema: 'metaviewer.roles/v0.3', op, ...extra });

        // Memory check refuses below 6 GiB (4 GiB RAM + 2 GiB shm) with clear reason and never host_program_unavailable.
        freeBytes = 6 * 1024 * 1024 * 1024 - 1;
        const lowMem = await invoke('create-program', { choice: { binary: 'gedit' } });
        if (lowMem?.ok !== false || lowMem.code !== 'RAM_ADMISSION_REFUSED'
            || typeof lowMem.reason !== 'string'
            || !lowMem.reason.includes('one capsule needs 6 GiB: 4 GiB RAM + 2 GiB shm')
            || !lowMem.reason.includes('Close an open capsule')
            || lowMem.reason.includes('host_program_unavailable')) {
          return false;
        }

        // Admits up to 16 concurrent capsules at >= 6 GiB free memory, and refuses the 17th with limit and open count.
        freeBytes = 6 * 1024 * 1024 * 1024;
        for (let i = 1; i <= 15; i++) {
          states.set(`pre-${i}`, { surface_id: `pre-${i}`, profile_id: `mv-live-${i}`, state: 'active', control: 'agent' });
        }
        const sixteenth = await invoke('create-program', { choice: { binary: 'gedit' } });
        if (sixteenth?.ok !== true || states.size !== 16) return false;

        const seventeenth = await invoke('create-program', { choice: { binary: 'gedit' } });
        if (seventeenth?.ok !== false || seventeenth.code !== 'CAPSULE_LIMIT_REACHED'
            || typeof seventeenth.reason !== 'string'
            || !seventeenth.reason.includes('At most 16 capsules run at once (16 of 16 open)')
            || !seventeenth.reason.includes('Close a capsule')
            || seventeenth.reason.includes('host_program_unavailable')) {
          return false;
        }

        // Adapter slot exhaustion surfaces clear limit/open reason and never host_program_unavailable.
        states.delete('pre-15');
        forceSlotRefusal = true;
        const slotRefused = await invoke('create-program', { choice: { binary: 'gedit' } });
        if (slotRefused?.ok !== false || slotRefused.code !== 'CAPSULE_SLOT_UNAVAILABLE'
            || typeof slotRefused.reason !== 'string'
            || !slotRefused.reason.includes('15 of 16 open; limit is 16')
            || !slotRefused.reason.includes('Stop another capsule first')
            || slotRefused.reason.includes('host_program_unavailable')) {
          return false;
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

test('V023-HOST-MV: multiple agent-controlled program capsules, tile reveal, tile label, and Stop', async (t) => {
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

  // Both tiles remain revealed in agent view without taking control from the agent.
  assert.deepEqual(appH.revealed, [
    { id: 'surface-pg-1', mode: 'agent' },
    { id: 'surface-pg-2', mode: 'agent' },
  ]);
  assert.deepEqual(appH.controlCalls, []);
  assert.deepEqual(Object.keys(appH.ctx.wallInputPending.value), []);

  // Tile label uses profile_id ('gedit') and status + Stop work on the program capsule.
  const status1 = await rolesBridge.status('surface-pg-1');
  assert.equal(status1.role, 'agent');
  assert.equal(status1.profileId, 'gedit');

  const stopped1 = await rolesBridge.stop('surface-pg-1');
  assert.deepEqual(stopped1, { ok: true, profileId: 'gedit' });
  assert.equal(states.get('surface-pg-1').state, 'destroyed');
});

test('V023-HOST-MV2: real sequence replay with CLI-like runner (unknown identity refused unless provisioned with browser program + 0700, reuse after stop, Identities panel filter + delete, and refusal reason in dialog + Activity)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'v023-cli-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const storeRoot = join(root, 'store');
  const stateDir = join(root, 'state');
  const mwHome = join(root, 'mw-home');
  await mkdir(binDir, { mode: 0o700 });
  await mkdir(storeRoot, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(mwHome, { mode: 0o700 });

  for (const prog of ['gedit', 'gnome-calculator', 'broken-prog']) {
    const p = join(binDir, prog);
    await writeFile(p, '#!/bin/sh\nexit 0\n');
    await chmod(p, 0o755);
  }

  // Fake srf-identity-admin: creates/shows metadata/<id>.json and profiles/<id> (0700).
  const adminScript = `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a = sys.argv[1:]
def arg(k): return a[a.index(k)+1]
verb = a[0]
root = Path(arg('--store-root'))
ident = arg('--id')
meta = root / 'metadata' / (ident + '.json')
prof = root / 'profiles' / ident
if verb == 'create':
    for d in ('metadata', 'profiles', 'locks'):
        (root / d).mkdir(mode=0o700, parents=True, exist_ok=True)
    if meta.exists():
        sys.exit(4)
    prof.mkdir(mode=0o700, exist_ok=True)
    browser = arg('--browser') if '--browser' in a else 'browser'
    domains = [d for d in arg('--domains').split(',') if d] if '--domains' in a else []
    rec = {'profile_id': ident, 'browser': browser, 'account_label': arg('--label'), 'allowed_domains': domains}
    meta.write_text(json.dumps(rec))
    meta.chmod(0o600)
    print(json.dumps(rec))
    sys.exit(0)
elif verb == 'show':
    if not meta.is_file():
        sys.exit(4)
    print(meta.read_text())
    sys.exit(0)
sys.exit(2)
`;
  const adminBin = join(binDir, 'srf-identity-admin');
  await writeFile(adminBin, adminScript);
  await chmod(adminBin, 0o755);

  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    MV_SRF_PROFILES: JSON.stringify({
      'mv-live-1': { Kind: 'browser', NativeKind: 'browser', Width: 1280, Height: 900, RAMRoot: '/dev/shm', Display: ':111' },
    }),
    MV_SRF_STATE_DIR: stateDir,
    MV_SRF_BIN_DIR: binDir,
    SRF_IDENTITY_STORE_ROOT: storeRoot,
    MV_MW_HOME: mwHome,
  };

  // Seed browser identity mv-live-1 in storeRoot.
  await mkdir(join(storeRoot, 'metadata'), { mode: 0o700 });
  await mkdir(join(storeRoot, 'profiles'), { mode: 0o700 });
  await mkdir(join(storeRoot, 'profiles', 'mv-live-1'), { mode: 0o700 });
  await mkdir(join(storeRoot, 'locks'), { mode: 0o700 });
  await writeFile(
    join(storeRoot, 'metadata', 'mv-live-1.json'),
    JSON.stringify({ profile_id: 'mv-live-1', browser: 'browser', account_label: 'Live 1', allowed_domains: [] }),
    { mode: 0o600 },
  );

  // Use a runner backed by tools/mv_identity.py with a stubbed profile_helper that sets mode 0700 and records uid 10001.
  const toolWrapper = join(root, 'mv_identity_stub.py');
  const realToolPath = operatorBridgeMod.defaultIdentityTool();
  await writeFile(
    toolWrapper,
    `import importlib.util, os, shutil, stat, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("mv_identity", ${JSON.stringify(realToolPath)})
mv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mv)
def stub_helper(self, identity, remove=False):
    identity = mv.operational_id(identity)
    target = self.profile_path(identity)
    self.show(identity)
    if remove:
        shutil.rmtree(target, ignore_errors=True)
    else:
        target.mkdir(mode=0o700, exist_ok=True)
        target.chmod(0o700)
        (target / '.uid-10001').write_text('10001')
mv.Identities.profile_helper = stub_helper
sys.exit(mv.main())
`,
  );

  const runIdentity = operatorBridgeMod.identityRunner({ tool: toolWrapper, env });
  t.after(() => runIdentity.dispose());

  const handlers = new Map();
  const states = new Map();
  const activeDisplays = new Set();
  let seq = 0;

  // Fake CLI surface runner: refuses unknown or unprovisioned identity with IDENTITY_UNAVAILABLE; refuses broken-prog with exit-2 detail.
  const core = {
    getHumanSurface: (id) => states.get(id),
    stopSurface: (surfaceId) => core.request({ schema: 'surface_request/v0.2', op: 'destroy', params: { surface_id: surfaceId } }),
    async request(req) {
      if (req.op === 'destroy') {
        const current = states.get(req.params.surface_id);
        activeDisplays.delete(current.display);
        const s = { ...current, state: 'destroyed' };
        states.set(s.surface_id, s);
        return { schema: 'surface_event/v0.2', event: 'state_changed', data: { surface: s } };
      }
      const pid = req.params.profile_id;
      const metaPath = join(storeRoot, 'metadata', `${pid}.json`);
      const profDir = join(storeRoot, 'profiles', pid);
      const uidMarker = join(profDir, '.uid-10001');
      let provisionedOk = false;
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf8'));
        const st = await import('node:fs/promises').then((fs) => fs.stat(profDir));
        const uidTxt = await readFile(uidMarker, 'utf8');
        provisionedOk = meta.browser === 'program' && (st.mode & 0o777) === 0o700 && uidTxt === '10001';
      } catch {
        provisionedOk = false;
      }
      if (!provisionedOk) {
        return {
          schema: 'surface_event/v0.2',
          event: 'error',
          data: {
            code: 'identity_unavailable',
            detail: 'native start reported the identity unavailable (exit status 4)',
          },
        };
      }
      const staged = JSON.parse(await readFile(join(stateDir, 'opening-modes', `${pid}.json`), 'utf8'));
      if (staged.host_binary.endsWith('/broken-prog')) {
        return {
          schema: 'surface_event/v0.2',
          event: 'error',
          data: {
            code: 'HOST_PROGRAM_UNAVAILABLE',
            detail: 'host_program_unavailable: binary does not exist',
          },
        };
      }
      const display = !activeDisplays.has(':111') ? ':111' : ':112';
      activeDisplays.add(display);
      const surface = {
        schema: 'surface/v0.2',
        surface_id: `surface-cli-${++seq}`,
        kind: 'desktop_capsule',
        profile_id: pid,
        state: 'active',
        control: 'agent',
        visibility: 'unfolded',
        display,
        geometry: { w: 1280, h: 900 },
      };
      states.set(surface.surface_id, surface);
      return { schema: 'surface_event/v0.2', event: 'created', data: { surface } };
    },
  };

  const parent = new EventEmitter();
  parent.webContents = { session: { registerPreloadScript: () => 'p', unregisterPreloadScript() {} } };
  const host = roleHostMod.installRoleHost({
    electron: { ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: (k) => handlers.delete(k) } },
    window: parent,
    env,
    capsuleStates: states,
    core,
    admit: () => true,
    listIdentities: () => runIdentity('list', {}),
    provisionProgramIdentity: ({ id, label }) => runIdentity('create', { id, label, domains: [], browser: 'program' }),
  });
  t.after(() => host.dispose());

  const invoke = (op, body = {}) => handlers.get('metaviewer:roles.v0.3')({}, { schema: 'metaviewer.roles/v0.3', op, ...body });
  const rolesBridge = {
    choices: () => invoke('choices'),
    createProgram: (choice) => invoke('create-program', { choice }),
    status: (surfaceId) => invoke('status', { surfaceId }),
    stop: (surfaceId) => invoke('stop', { surfaceId }),
  };

  const appH = createAppProgramHarness(readFileSync(APP_PATH, 'utf8'), rolesBridge);
  const launcherH = createLauncherHarness(readFileSync(CATALOG_LAUNCHER_PATH, 'utf8'), catalogModel.buildCreateIntent, rolesBridge);
  launcherH.ctx.emit = (event, payload, settle) => {
    launcherH.events.push([event, payload]);
    if (event === 'create') appH.ctx.onCreateCapsule(payload, settle);
  };

  // 1. Missing binary 'noexiste-xyz': dialog stays open with exact reason naming 'noexiste-xyz', and Activity shows the same reason.
  await launcherH.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
  launcherH.ctx.programBinary.value = 'noexiste-xyz';
  await launcherH.ctx.confirmProgram();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(launcherH.ctx.choosingProgram.value, true, 'dialog stays open on missing binary');
  assert.equal(launcherH.ctx.programError.value, 'host_program_unavailable: noexiste-xyz: not found in PATH');
  assert.equal(
    activityModelMod.normalizeActivityEntry(appH.ctx.activityFeed.value.at(-1))?.text,
    'HOST_PROGRAM_UNAVAILABLE: host_program_unavailable: noexiste-xyz: not found in PATH',
  );

  // 2. Native surface exit-2 refusal ('broken-prog'): dialog stays open with exact reason naming 'broken-prog', and Activity shows the same reason.
  launcherH.ctx.programBinary.value = 'broken-prog';
  await launcherH.ctx.confirmProgram();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(launcherH.ctx.choosingProgram.value, true, 'dialog stays open on native surface refusal');
  assert.equal(launcherH.ctx.programError.value, 'host_program_unavailable: broken-prog: binary does not exist');
  assert.equal(
    activityModelMod.normalizeActivityEntry(appH.ctx.activityFeed.value.at(-1))?.text,
    'HOST_PROGRAM_UNAVAILABLE: host_program_unavailable: broken-prog: binary does not exist',
  );

  // 3. Valid binary 'gedit': provisions program identity (mode 0700, uid 10001, browser 'program'), opens tile 'gedit', writable immediately.
  launcherH.ctx.programBinary.value = 'gedit';
  await launcherH.ctx.confirmProgram();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(launcherH.ctx.choosingProgram.value, false, 'dialog closes on successful gedit launch');
  assert.equal(states.get('surface-cli-1')?.profile_id, 'gedit');
  assert.equal(states.get('surface-cli-1')?.display, ':111');
  assert.deepEqual(Object.keys(appH.ctx.wallInputPending.value), [], 'program creation never arms pending human input');
  assert.deepEqual(appH.controlCalls, [], 'program creation preserves agent control');

  // 4. Stop frees display (:111) and name ('gedit'); re-opening 'gedit' reuses the 'gedit' program identity and display :111.
  const stopped1 = await rolesBridge.stop('surface-cli-1');
  assert.deepEqual(stopped1, { ok: true, profileId: 'gedit' });

  await launcherH.ctx.onCreate({ type: { id: 'program' }, placement: 'tab' });
  launcherH.ctx.programBinary.value = 'gedit';
  await launcherH.ctx.confirmProgram();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(launcherH.ctx.choosingProgram.value, false);
  assert.equal(states.get('surface-cli-2')?.profile_id, 'gedit', 'reused gedit identity instead of gedit-2');
  assert.equal(states.get('surface-cli-2')?.display, ':111', 'reused freed display :111');
  await rolesBridge.stop('surface-cli-2');

  // 5. Identity list & normal delete work on 'program' identities, and 'program' identities are never offered as browsers.
  const listed = await runIdentity('list', {});
  assert.equal(listed.ok, true);
  const geditRow = listed.rows.find((r) => r.id === 'gedit');
  assert.equal(geditRow?.browser, 'program');
  const choices = await rolesBridge.choices();
  assert.equal(choices.some((c) => c.profileId === 'gedit'), false, 'program identity never offered in browser choices');

  const identDialogSrc = readFileSync(IDENTITIES_DIALOG_PATH, 'utf8');
  assert.match(identDialogSrc, /row\.browser === 'program'/);

  const deleted = await runIdentity('delete', { id: 'gedit' });
  assert.deepEqual(deleted, { ok: true });
  const listedAfterDelete = await runIdentity('list', {});
  assert.equal(listedAfterDelete.rows.some((r) => r.id === 'gedit'), false);
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

  // Mutant 8 (Fix 1): createProgram ignores failed/malformed listIdentities and proceeds with empty knownIdentities.
  {
    const mutatedSrc = roleHostSrc.replace(
      "if (idReply?.ok !== true || !Array.isArray(idReply.rows) || !idReply.rows.every((/** @type {any} */ r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.length > 0)) {",
      'if (false) {',
    ).replace(
      'const knownIdentities = new Set(idReply.rows.map((/** @type {any} */ r) => r.id));',
      'const knownIdentities = new Set(Array.isArray(idReply?.rows) ? idReply.rows.map((r) => r?.id) : []);',
    );
    assert.notEqual(mutatedSrc, roleHostSrc);
    const mutatedMod = await importMutatedRoleHost(mutatedSrc, 'm8');
    const failed = await runProbes({ roleHost: mutatedMod });
    assert.ok(failed.includes('listIdentities-fail-closed'), `Mutant 8 survived: ${failed}`);
  }

  // Mutant 9 (Fix 2): clearMode() awaited unguarded before creating = false in createProgram finally block.
  {
    const mutatedSrc = roleHostSrc.replace(
      'try { await clearMode?.(); } catch { /* keep original error and always reset creating */ }\n      creating = false;',
      'await clearMode?.(); creating = false;',
    );
    assert.notEqual(mutatedSrc, roleHostSrc);
    const mutatedMod = await importMutatedRoleHost(mutatedSrc, 'm9');
    const failed = await runProbes({ roleHost: mutatedMod });
    assert.ok(failed.includes('clearMode-reject-resets-creating-and-keeps-error'), `Mutant 9 survived: ${failed}`);
  }

  // Mutant 10 (Fix 3): pruneProgramProfiles does not prune destroyed surfaces.
  {
    const mutatedSrc = roleHostSrc.replace(
      'if (csDead || hsDead) {',
      'if (false && (csDead || hsDead)) {',
    );
    assert.notEqual(mutatedSrc, roleHostSrc);
    const mutatedMod = await importMutatedRoleHost(mutatedSrc, 'm10');
    const failed = await runProbes({ roleHost: mutatedMod });
    assert.ok(failed.includes('programProfiles-pruned-on-destroy'), `Mutant 10 survived: ${failed}`);
  }

  // Mutant 11a (Fix 4 Launcher): CatalogLauncher falls back to api.createProgram when parent does not settle.
  {
    const mutatedLauncher = launcherSrc.replace(
      "if (!settledByListener) {\n      programError.value = 'Program launch was not handled by the host.';\n      return;\n    }",
      "if (!settledByListener && api?.createProgram) {\n      outcome = await api.createProgram({ binary: result.intent.binary });\n    }",
    );
    assert.notEqual(mutatedLauncher, launcherSrc);
    const failed = await runProbes({ launcherSource: mutatedLauncher });
    assert.ok(failed.includes('launcher-no-unsettled-bypass-and-displayOnly-settles'), `Mutant 11a survived: ${failed}`);
  }

  // Mutant 11b (Fix 4 App): App.vue returns early on nestedMode.displayOnly without settling.
  {
    const mutatedApp = appSrc.replace(
      "if (nestedMode.displayOnly) {\n    settle?.({ ok: false, code: 'DISPLAY_ONLY', reason: 'Nested walls are display-only and cannot open new capsules.' });\n    return;\n  }",
      'if (nestedMode.displayOnly) return;',
    );
    assert.notEqual(mutatedApp, appSrc);
    const failed = await runProbes({ appSource: mutatedApp });
    assert.ok(failed.includes('launcher-no-unsettled-bypass-and-displayOnly-settles'), `Mutant 11b survived: ${failed}`);
  }

  // Mutant 12a (Fix 5 view order): selectGlobalView('agent') called before roles.createProgram.
  {
    const mutatedApp = appSrc.replace(
      'const reply = await roles.createProgram({ binary: body.binary.trim() });',
      "selectGlobalView('agent');\n  const reply = await roles.createProgram({ binary: body.binary.trim() });",
    );
    assert.notEqual(mutatedApp, appSrc);
    const failed = await runProbes({ appSource: mutatedApp });
    assert.ok(failed.includes('app-view-on-success-only-and-post-launch-throw-safe'), `Mutant 12a survived: ${failed}`);
  }

  // Mutant 12b (Fix 5 post-launch throw): post-launch reveal throw is not caught.
  {
    const mutatedApp = appSrc.replace(
      '  } catch {\n    if (reply.surfaceId) reportRevealPending(reply.surfaceId);\n  }',
      '  } catch (err) { throw err; }',
    );
    assert.notEqual(mutatedApp, appSrc);
    const failed = await runProbes({ appSource: mutatedApp });
    assert.ok(failed.includes('app-view-on-success-only-and-post-launch-throw-safe'), `Mutant 12b survived: ${failed}`);
  }

  // Mutant 13 (Fix 6): onCreateCapsule only enters program branch when binary is non-empty string.
  {
    const mutatedApp = appSrc.replace(
      "if (body?.kind === 'program' || body?.kind === 'host-program') {",
      "if (body?.kind === 'program' && typeof body?.binary === 'string' && body.binary.trim().length > 0) {",
    );
    assert.notEqual(mutatedApp, appSrc);
    const failed = await runProbes({ appSource: mutatedApp });
    assert.ok(failed.includes('app-program-empty-binary-or-profile-refused'), `Mutant 13 survived: ${failed}`);
  }

  // Mutant 14 (V023-HOST-MV2): provisioning skipped in roleHost createProgram.
  {
    const mutatedSrc = roleHostSrc.replace(
      'const provReply = choice.hostXpra || programIdentities.has(profileId) ? {ok:true} : await provisionIdentity({id:profileId, label:resolved.name, binary:resolved.name, path:resolved.path});',
      'const provReply = {ok:true};',
    );
    assert.notEqual(mutatedSrc, roleHostSrc);
    const mutatedMod = await importMutatedRoleHost(mutatedSrc, 'm14');
    const failed = await runProbes({ roleHost: mutatedMod });
    assert.ok(failed.includes('program-provisioning-and-reason-preservation'), `Mutant 14 survived: ${failed}`);
  }

  // Mutant 15a (V023-HOST-MV2): refusal reason dropped in roleHost handler.
  {
    const mutatedSrc = roleHostSrc.replace(
      'return reason ? {ok:false,code,reason} : {ok:false,code};',
      'return {ok:false,code};',
    );
    assert.notEqual(mutatedSrc, roleHostSrc);
    const mutatedMod = await importMutatedRoleHost(mutatedSrc, 'm15a');
    const failed = await runProbes({ roleHost: mutatedMod });
    assert.ok(failed.includes('program-provisioning-and-reason-preservation'), `Mutant 15a survived: ${failed}`);
  }

  // Mutant 15b (V023-HOST-MV2): refusal reason dropped in App.vue submitHost / Activity recording.
  {
    const mutatedApp = appSrc.replace(
      'else if (safeReason) recordActivity({ code: activityCode, reason: safeReason });',
      'else if (false) recordActivity({ code: activityCode, reason: safeReason });',
    );
    assert.notEqual(mutatedApp, appSrc);
    const failed = await runProbes({ appSource: mutatedApp });
    assert.ok(failed.includes('refusal-propagates-to-dialog'), `Mutant 15b survived: ${failed}`);
  }

  // Mutant 15c (V023-HOST-MV2): refusal reason dropped in activityModel.js normalizeActivityEntry.
  {
    const activitySrc = readFileSync(ACTIVITY_MODEL_PATH, 'utf8');
    const mutatedActivitySrc = activitySrc.replace(
      'if (rawReason.length > 0 && rawReason.length <= 256',
      'if (false && rawReason.length > 0 && rawReason.length <= 256',
    );
    assert.notEqual(mutatedActivitySrc, activitySrc);
    const f = join(tmp, 'activityModel-m15c.js');
    await writeFile(f, mutatedActivitySrc);
    const mutatedActivityMod = await import(`${pathToFileURL(f).href}?m=15c`);
    const failed = await runProbes({ activityModel: mutatedActivityMod });
    assert.ok(failed.includes('refusal-propagates-to-dialog'), `Mutant 15c survived: ${failed}`);
  }

  // Mutant 16 (V024-WALL-FIXES): restore old forwardVisible and onCreate order in CatalogLauncher.vue.
  {
    const mutatedLauncher = launcherSrc
      .replace(
        "  // The kit dialog closes itself right after `create`: that close must not end the role or program step.\n  if (!value && (choosingRole.value || (typeof choosingProgram !== 'undefined' && choosingProgram.value))) return;\n",
        '',
      )
      .replace(
        "  profileChoices.value = []; profileChoice.value = '';\n  choosingRole.value = true;\n  try {\n    const choices = await api.choices();\n    if (!props.visible) { choosingRole.value = false; return; }\n    if (generation !== choiceGeneration) return;\n    profileChoices.value = choices;\n    if (!Array.isArray(profileChoices.value)) throw Error('IDENTITY_LIST_UNAVAILABLE');\n    profileChoice.value = matchingProfiles.value.find(p => p.available)?.profileId ?? '';\n    if (profileChoice.value && roleError.value.startsWith('NO_IDENTITY:')) roleError.value = '';\n    roleChoice.value = profileChoices.value.find(p=>p.profileId === profileChoice.value)?.role || 'agent';\n  } catch {if(!props.visible){choosingRole.value=false;return;}if(generation !== choiceGeneration)return;profileChoices.value = []; roleError.value = 'IDENTITY_LIST_UNAVAILABLE'; }",
        "  try {\n    const choices = await api.choices();\n    if (!props.visible || generation !== choiceGeneration) return;\n    profileChoices.value = choices;\n    if (!Array.isArray(profileChoices.value)) throw Error('IDENTITY_LIST_UNAVAILABLE');\n    profileChoice.value = matchingProfiles.value.find(p => p.available)?.profileId ?? '';\n    roleChoice.value = profileChoices.value.find(p=>p.profileId === profileChoice.value)?.role || 'agent';\n    choosingRole.value = true;\n  } catch {if(!props.visible || generation !== choiceGeneration)return;profileChoices.value = []; profileChoice.value = ''; roleError.value = 'IDENTITY_LIST_UNAVAILABLE'; choosingRole.value = true; }",
      )
      .replace(
        "  if (choosingRole.value || (typeof choosingProgram !== 'undefined' && choosingProgram.value)) return;\n",
        '',
      );
    assert.notEqual(mutatedLauncher, launcherSrc);
    const failed = await runProbes({ launcherSource: mutatedLauncher });
    assert.ok(failed.includes('launcher-role-dialog-survives-sync-kit-close'), `Mutant 16 survived: ${failed}`);
  }

  // Mutant 16a (V024-CAPSULE-LIMIT): createProgram skips 16-capsule ceiling check.
  {
    const mutatedSrc = roleHostSrc.replace(
      "if (live >= MAX_CAPSULES) throw Object.assign(refuse('CAPSULE_LIMIT_REACHED'), {reason:formatCapsuleLimitReason(live)});",
      'if (false && live >= MAX_CAPSULES) {}',
    );
    assert.notEqual(mutatedSrc, roleHostSrc);
    const mutatedMod = await importMutatedRoleHost(mutatedSrc, 'm16a');
    const failed = await runProbes({ roleHost: mutatedMod });
    assert.ok(failed.includes('capsule-limit-and-memory-check'), `Mutant 16a survived: ${failed}`);
  }

  // Mutant 16b (V024-CAPSULE-LIMIT): createProgram skips 6 GiB host free memory check.
  {
    const mutatedSrc = roleHostSrc.replace(
      'if (freeBytes === null || freeBytes < CAPSULE_MEMORY_LIMIT_BYTES) {',
      'if (false && (freeBytes === null || freeBytes < CAPSULE_MEMORY_LIMIT_BYTES)) {',
    );
    assert.notEqual(mutatedSrc, roleHostSrc);
    const mutatedMod = await importMutatedRoleHost(mutatedSrc, 'm16b');
    const failed = await runProbes({ roleHost: mutatedMod });
    assert.ok(failed.includes('capsule-limit-and-memory-check'), `Mutant 16b survived: ${failed}`);
  }

  // Mutant 16c (V024-CAPSULE-LIMIT): createProgram prefixes non-binary refusal reasons with host_program_unavailable.
  {
    const mutatedSrc = roleHostSrc.replace(
      '              : createRefusalReason(code);\n        throw Object.assign(refuse(code), {reason});',
      '              : createRefusalReason(code);\n        throw Object.assign(refuse(code), {reason:`host_program_unavailable: ${reason}`});',
    );
    assert.notEqual(mutatedSrc, roleHostSrc);
    const mutatedMod = await importMutatedRoleHost(mutatedSrc, 'm16c');
    const failed = await runProbes({ roleHost: mutatedMod });
    assert.ok(failed.includes('capsule-limit-and-memory-check'), `Mutant 16c survived: ${failed}`);
  }
});

test('V024-WALL-FIXES: mounted CatalogLauncher shows role and identity dialog with choices when kit dialog emits create then closes synchronously, and fails under old forwardVisible/onCreate order', async () => {
  const vue = await import('vue');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const vueHref = pathToFileURL(require.resolve('vue')).href;
  let compileSeq = 0;

  async function mountLauncherSfc(sfcSource, rolesApi) {
    const prevRoles = globalThis.metaviewerRoles;
    globalThis.metaviewerRoles = rolesApi;
    let kitDialogEmits = null;
    const KitNewCapsuleDialog = vue.defineComponent({
      props: ['visible', 'types', 'title', 'subtitle', 'emptyText'],
      emits: ['update:visible', 'create', 'close'],
      setup(_props, { emit }) {
        kitDialogEmits = emit;
        return () => vue.h('div', { id: 'kit-new-capsule-dialog' });
      },
    });
    globalThis.__v024CatalogDeps = {
      './GroupedCapsuleDialog.vue': KitNewCapsuleDialog,
      './catalogModel.js': catalogModel,
    };
    const { descriptor } = parse(sfcSource);
    const compiled = compileScript(descriptor, { id: `v024-launcher-${++compileSeq}`, inlineTemplate: true });
    const code = compiled.content.replace(
      /import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/g,
      (line, binding, _q, spec) => (spec === 'vue'
        ? line.replace(/(['"])vue\1/, JSON.stringify(vueHref))
        : `const ${binding.trim()} = globalThis.__v024CatalogDeps[${JSON.stringify(spec)}];`),
    );
    const LauncherComp = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${compileSeq}`)).default;

    const createNode = (tag) => {
      const node = {
        tag,
        props: {},
        children: [],
        parent: null,
        text: '',
        addEventListener() {},
        removeEventListener() {},
        get options() {
          return node.children.filter((c) => c.tag === 'option');
        },
        get value() {
          return node.props.value ?? '';
        },
        set value(v) {
          node.props.value = v;
        },
      };
      return node;
    };
    const renderer = vue.createRenderer({
      createElement: createNode,
      createText: (t) => ({ ...createNode('#text'), text: String(t) }),
      createComment: () => createNode('#comment'),
      setText(n, t) { n.text = String(t); },
      setElementText(n, t) { n.text = String(t); n.children = []; },
      patchProp(n, k, _prev, v) { n.props[k] = v; },
      insert(n, parent, anchor) {
        if (n.parent) this.remove(n);
        n.parent = parent;
        const i = parent.children.indexOf(anchor);
        parent.children.splice(i < 0 ? parent.children.length : i, 0, n);
      },
      remove(n) {
        if (n.parent) {
          const idx = n.parent.children.indexOf(n);
          if (idx >= 0) n.parent.children.splice(idx, 1);
          n.parent = null;
        }
      },
      parentNode: (n) => n.parent,
      nextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
      setScopeId() {},
      querySelector: () => null,
    });

    const visibleRef = vue.ref(true);
    const createdEvents = [];
    const Host = vue.defineComponent({
      setup() {
        return () => vue.h(LauncherComp, {
          visible: visibleRef.value,
          'onUpdate:visible': (v) => { visibleRef.value = v; },
          onCreate: (payload) => { createdEvents.push(payload); },
        });
      },
    });
    const root = createNode('root');
    const app = renderer.createApp(Host);
    app.mount(root);

    const allNodes = (n) => [n, ...(n.children || []).flatMap(allNodes)];
    const nodeText = (n) => [n.text || '', ...(n.children || []).map(nodeText)].join('').trim();

    return {
      root,
      visibleRef,
      createdEvents,
      triggerSyncKitCreateAndClose(payload) {
        kitDialogEmits('create', payload);
        kitDialogEmits('update:visible', false);
        kitDialogEmits('close');
      },
      allNodes: () => allNodes(root),
      nodeText,
      unmount() {
        app.unmount();
        globalThis.metaviewerRoles = prevRoles;
        delete globalThis.__v024CatalogDeps;
      },
    };
  }

  async function verifyLauncherRoleDialog(sfcSource) {
    const choicesList = [
      { profileId: 'mv-live-1', role: 'human', available: true, currentMode: 'human' },
      { profileId: 'mv-live-2', role: 'agent', available: false },
    ];
    const mounted = await mountLauncherSfc(sfcSource, {
      choices: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return choicesList;
      },
    });
    try {
      mounted.triggerSyncKitCreateAndClose({ type: { id: 'identity-browser' }, placement: 'tab' });
      await new Promise((r) => setTimeout(r, 25));
      await vue.nextTick();

      const dialog = mounted.allNodes().find(
        (n) => n.props?.role === 'dialog' && n.props?.['aria-label'] === 'Capsule role and identity',
      );
      assert.ok(dialog, 'Role and identity dialog must be rendered after synchronous kit create + close');
      assert.equal(mounted.visibleRef.value, true, 'Launcher must stay visible while choosing role and identity');
      const options = mounted.allNodes().filter((n) => n.tag === 'option').map((n) => ({
        value: n.props?.value,
        disabled: Boolean(n.props?.disabled),
        label: mounted.nodeText(n),
      }));
      assert.ok(options.some((o) => o.value === 'agent' && o.label === 'Agent'));
      assert.ok(options.some((o) => o.value === 'human' && o.label === 'Human'));
      assert.ok(options.some((o) => o.value === 'mv-live-1' && !o.disabled && o.label.includes('mv-live-1')));
      assert.ok(options.some((o) => o.value === 'mv-live-2' && o.disabled && o.label.includes('unavailable')));
    } finally {
      mounted.unmount();
    }
  }

  const realSource = readFileSync(CATALOG_LAUNCHER_PATH, 'utf8');
  await verifyLauncherRoleDialog(realSource);

  const revertedSource = realSource
    .replace(
      "  // The kit dialog closes itself right after `create`: that close must not end the role or program step.\n  if (!value && (choosingRole.value || (typeof choosingProgram !== 'undefined' && choosingProgram.value))) return;\n",
      '',
    )
    .replace(
      "  profileChoices.value = []; profileChoice.value = '';\n  choosingRole.value = true;\n  try {\n    const choices = await api.choices();\n    if (!props.visible) { choosingRole.value = false; return; }\n    if (generation !== choiceGeneration) return;\n    profileChoices.value = choices;\n    if (!Array.isArray(profileChoices.value)) throw Error('IDENTITY_LIST_UNAVAILABLE');\n    profileChoice.value = matchingProfiles.value.find(p => p.available)?.profileId ?? '';\n    if (profileChoice.value && roleError.value.startsWith('NO_IDENTITY:')) roleError.value = '';\n    roleChoice.value = profileChoices.value.find(p=>p.profileId === profileChoice.value)?.role || 'agent';\n  } catch {if(!props.visible){choosingRole.value=false;return;}if(generation !== choiceGeneration)return;profileChoices.value = []; roleError.value = 'IDENTITY_LIST_UNAVAILABLE'; }",
      "  try {\n    const choices = await api.choices();\n    if (!props.visible || generation !== choiceGeneration) return;\n    profileChoices.value = choices;\n    if (!Array.isArray(profileChoices.value)) throw Error('IDENTITY_LIST_UNAVAILABLE');\n    profileChoice.value = matchingProfiles.value.find(p => p.available)?.profileId ?? '';\n    roleChoice.value = profileChoices.value.find(p=>p.profileId === profileChoice.value)?.role || 'agent';\n    choosingRole.value = true;\n  } catch {if(!props.visible || generation !== choiceGeneration)return;profileChoices.value = []; profileChoice.value = ''; roleError.value = 'IDENTITY_LIST_UNAVAILABLE'; choosingRole.value = true; }",
    )
    .replace(
      "  if (choosingRole.value || (typeof choosingProgram !== 'undefined' && choosingProgram.value)) return;\n",
      '',
    );
  assert.notEqual(revertedSource, realSource);
  await assert.rejects(() => verifyLauncherRoleDialog(revertedSource), { code: 'ERR_ASSERTION' });
});

test('a bare binary name is also found in the standard program directories the app PATH omits', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const roleHost = await import('../electron/roleHost.js');
  assert.ok(roleHost.HOST_BINARY_STANDARD_DIRS.includes('/usr/games'));
  const games = mkdtempSync(join(tmpdir(), 'mv-games-'));
  try {
    writeFileSync(join(games, 'mines-fixture'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(roleHost.resolveHostBinary('mines-fixture', { PATH: '/nonexistent' }, [games]).path, join(games, 'mines-fixture'));
    assert.throws(() => roleHost.resolveHostBinary('mines-fixture', { PATH: '/nonexistent' }, []), /not found in PATH/);
  } finally { rmSync(games, { recursive: true, force: true }); }
});
