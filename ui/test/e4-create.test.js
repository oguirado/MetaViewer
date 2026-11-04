import * as rewindValues from '../electron/rewindValues.js';
import * as p18cDesktopModel from '../electron/desktopLayout.js';
import * as guestWorkloadTileModel from '../src/wall/guestWorkloadTile.js';
import * as guestCommandValues from '../electron/guestCommandValues.js';
// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createAuthorityAdapter, hostOutcomeFor } from '../src/core/hostAdapters.js';
import { buildCreateIntent, CATALOG_KINDS } from '../src/catalog/catalogModel.js';
import { normalizeActivityEntry } from '../src/activity/activityModel.js';
import { CREATE_REFUSAL_REASONS, REFUSAL_COPY, createRefusalReason } from '../electron/profilePicker.js';
import { installAuthorityWire, WIRE_CHANNELS } from '../electron/authorityWire.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';
import { createPreloadFacade } from '../electron/preload.js';

const APP_PATH = fileURLToPath(new URL('../src/App.vue', import.meta.url));
const OUTCOME_PATH = fileURLToPath(new URL('../src/core/HostOutcome.vue', import.meta.url));
const HOST_ADAPTERS_PATH = fileURLToPath(new URL('../src/core/hostAdapters.js', import.meta.url));
const ACTIVITY_MODEL_PATH = fileURLToPath(new URL('../src/activity/activityModel.js', import.meta.url));
const WIRE_PATH = fileURLToPath(new URL('../electron/authorityWire.js', import.meta.url));
const APP_SOURCE = readFileSync(APP_PATH, 'utf8');
const OUTCOME_SOURCE = readFileSync(OUTCOME_PATH, 'utf8');
const HOST_ADAPTERS_SOURCE = readFileSync(HOST_ADAPTERS_PATH, 'utf8');
const ACTIVITY_MODEL_SOURCE = readFileSync(ACTIVITY_MODEL_PATH, 'utf8');
const WIRE_SOURCE = readFileSync(WIRE_PATH, 'utf8');

/** Preserve ESM named aliases when lowering imports into the closed fixture map. */
function fixtureBinding(binding) {
  const value=binding.trim();
  if(value.startsWith('{'))return value.replace(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\b/g,'$1: $2');
  const namespace=/^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(value);
  return namespace?namespace[1]:value;
}
let serial = 0;

/**
 * Compile the real HostOutcome.vue component against an adapters module.
 * @param {any} [adaptersMod]
 */
async function compileRealHostOutcome(adaptersMod = hostAdapters) {
  const id = `e4-outcome-${++serial}`;
  /** @type {any} */ (globalThis).__e4OutcomeAdapters = adaptersMod;
  const { descriptor } = parse(OUTCOME_SOURCE);
  const compiled = compileScript(descriptor, { id, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(
    /^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
    (all, binding, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      if (spec === './hostAdapters.js') return `const ${fixtureBinding(binding)} = globalThis.__e4OutcomeAdapters;`;
      throw new Error(`unexpected HostOutcome import: ${spec}`);
    },
  );
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${id}`)).default;
}

/**
 * Compile App.vue with the real HostOutcome.vue component and an optional source transform.
 * @param {Record<string, any>} captured
 * @param {(src: string) => string} [transform]
 * @param {any} [adaptersMod]
 */
async function compileApp(captured, transform = (s) => s, adaptersMod = hostAdapters) {
  const stub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap((s) => s?.() ?? [])),
  });
  const wall = vue.defineComponent({
    setup(_, ctx) {
      captured.wall = ctx;
      ctx.expose({
        revealSurface: (id, mode) => {
          (captured.revealed ??= []).push({ id, mode });
          return { ok: true };
        },
      });
      return () => vue.h('div');
    },
  });
  const catalog = vue.defineComponent({
    setup(_, ctx) {
      captured.catalog = ctx;
      return () => vue.h('div');
    },
  });
  const RealHostOutcome = await compileRealHostOutcome(adaptersMod);
  const strip = vue.defineComponent({
    props: ['entries'],
    setup(p) {
      captured.entries = () => p.entries;
      return () =>
        vue.h(
          'ol',
          { id: 'mv-activity-list' },
          (p.entries ?? []).map((item) => {
            const entry = normalizeActivityEntry(item);
            return entry ? vue.h('li', { key: entry.seq, 'data-seq': entry.seq }, entry.text) : null;
          }),
        );
    },
  });
  /** @type {any} */ (globalThis).__e4Deps = {
    './demo/DemoDialog.vue': stub,
    './identities/IdentitiesDialog.vue': stub,
    './handoff/HandoffNotice.vue': stub,
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': RealHostOutcome,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': {
      ShellWorkspace: stub,
      TopBar: stub,
      Sidebar: stub,
      StatusBar: stub,
    },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': catalog,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': strip,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    '@openvue/icons/windowmaximize': {render:()=>null},
    '../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': {render:()=>null},
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/DesktopWorkspace.vue': wall,
    '../electron/desktopLayout.js': p18cDesktopModel,
    './wall/WallWorkspace.vue': wall,
    './surfaces/SurfaceCanvas.vue': stub,
    './surfaces/tileScheduler.js': { createTileScheduler },
    './wall/guestWorkloadTile.js': guestWorkloadTileModel,
    '../electron/guestCommandValues.js': guestCommandValues,
    '../electron/rewindValues.js': rewindValues,
  };
  const mutatedSource = transform(APP_SOURCE);
  const { descriptor } = parse(mutatedSource);
  const compiled = compileScript(descriptor, { id: `e4-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(
    /^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
    (all, binding, _q, spec) => {
      if(spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      assert.ok(Object.hasOwn(globalThis.__e4Deps,spec), `unmapped App dependency ${spec}`);
      return `const ${fixtureBinding(binding)} = globalThis.__e4Deps[${JSON.stringify(spec)}];`;
    },
  );
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#e4-${serial}`)).default;
}

/**
 * Mount compiled App in a lightweight custom renderer.
 * @param {any} Component
 * @param {Record<string, any>} props
 */
function mountApp(Component, props) {
  const root = { tag: 'root', props: {}, children: /** @type {any[]} */ ([]) };
  const renderer = vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }),
    createComment: (text) => ({ text }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const i = parent.children.indexOf(anchor);
      parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
    },
    remove(child) {
      const items = child.parent?.children;
      if (items) items.splice(items.indexOf(child), 1);
    },
    setText(node, text) {
      node.text = text;
    },
    setElementText(node, text) {
      node.text = text;
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, name, _old, value) {
      node.props[name] = value;
    },
    querySelector: () => null,
    setScopeId() {},
  });
  const app = renderer.createApp(Component, props);
  app.mount(root);
  return { root, close: () => app.unmount() };
}

/** @param {any} node @returns {any[]} */
const allNodes = (node) => [node, ...(node.children ?? []).flatMap(allNodes)];
/** @param {any} node @returns {string} */
const nodeText = (node) =>
  node ? [node.text ?? '', ...(node.children ?? []).map(nodeText)].join('') : '';

const tick = async () => {
  await new Promise((r) => setImmediate(r));
  await vue.nextTick();
};

test('E4-CREATE Goal 1: kit identity-browser create intent reaches authorityHost.createSurface while non-browser kinds and missing createSurface port refuse with NO_BROWSER_CAPSULE', async () => {
  const prev = { window: globalThis.window, document: globalThis.document };
  /** @type {any} */ (globalThis).window = { addEventListener() {}, removeEventListener() {} };
  /** @type {any} */ (globalThis).document = { documentElement: { dataset: {} }, getElementById: () => null };
  let mounted;
  try {
    assert.ok(CATALOG_KINDS.some((k) => k.kind === 'identity-browser'));
    // Confirm the exact intent shape produced by CatalogLauncher.vue:49-52 -> buildCreateIntent
    const built = buildCreateIntent({ kind: 'identity-browser', placement: 'tab' });
    assert.equal(built.ok, true);
    if (!built.ok) throw new Error('expected valid intent');
    const kitIntent = built.intent;
    assert.deepEqual(kitIntent, {
      type: 'create-capsule',
      kind: 'identity-browser',
      placement: 'tab',
    });

    let createCalls = 0;
    const authorityHost = createAuthorityAdapter({
      createSurface: async () => {
        createCalls += 1;
        return { ok: true };
      },
      propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
    });
    const captured = /** @type {Record<string, any>} */ ({});
    const App = await compileApp(captured);
    mounted = mountApp(App, {
      authorityHost,
      runtime: {
        projectionView: {
          getSnapshot: () => ({ envelope: { epoch: 'e1' } }),
          getProjection: () => ({ rows: [] }),
          subscribe: () => () => {},
        },
      },
      layout: {},
      scope: {},
      storage: { readRaw: async () => null, writeAtomic: async () => {} },
    });
    await tick();

    // 1. Kit's real intent shape ('identity-browser') reaches createSurface.
    captured.catalog.emit('create', kitIntent);
    await tick();
    assert.equal(createCalls, 1, 'identity-browser create intent reaches authorityHost.createSurface');
    const ackOutcome = allNodes(mounted.root).find((n) => n.props?.id === 'mv-host-outcome');
    assert.equal(ackOutcome?.props['data-outcome-code'], 'INTENT_ACKNOWLEDGED');
    assert.equal(nodeText(ackOutcome), 'Request sent.');

    // 2. Legacy 'browser' kind also reaches createSurface.
    captured.catalog.emit('create', { kind: 'browser' });
    await tick();
    assert.equal(createCalls, 2, 'browser create intent still reaches authorityHost.createSurface');

    // 3. Non-browser catalog kinds are refused with NO_BROWSER_CAPSULE before any IPC.
    for (const unsupportedKind of ['program', 'holdings-app', 'desktop', 'unknown']) {
      captured.catalog.emit('create', { type: 'create-capsule', kind: unsupportedKind, placement: 'tab' });
      await tick();
      assert.equal(createCalls, 2, `${unsupportedKind} must not call createSurface`);
      const refusedOutcome = allNodes(mounted.root).find((n) => n.props?.id === 'mv-host-outcome');
      assert.equal(refusedOutcome?.props['data-outcome-code'], 'NO_BROWSER_CAPSULE');
      assert.equal(nodeText(refusedOutcome), 'NO_BROWSER_CAPSULE: No browser capsule with a live frame.');
      const lastEntry = normalizeActivityEntry(captured.entries().at(-1));
      assert.equal(lastEntry?.text, 'NO_BROWSER_CAPSULE: No browser capsule with a live frame.');
    }

    // 4. Missing createSurface port on authorityHost keeps typed NO_BROWSER_CAPSULE (never HOST_REQUEST_REFUSED).
    mounted.close();
    const portlessCaptured = /** @type {Record<string, any>} */ ({});
    const PortlessApp = await compileApp(portlessCaptured);
    mounted = mountApp(PortlessApp, {
      authorityHost: createAuthorityAdapter({
        propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
      }),
      runtime: {
        projectionView: {
          getSnapshot: () => ({ envelope: { epoch: 'e1' } }),
          getProjection: () => ({ rows: [] }),
          subscribe: () => () => {},
        },
      },
      layout: {},
      scope: {},
      storage: { readRaw: async () => null, writeAtomic: async () => {} },
    });
    await tick();
    for (const missingPortIntent of [kitIntent, { kind: 'browser' }]) {
      portlessCaptured.catalog.emit('create', missingPortIntent);
      await tick();
      const portlessOutcome = allNodes(mounted.root).find((n) => n.props?.id === 'mv-host-outcome');
      assert.equal(portlessOutcome?.props['data-outcome-code'], 'NO_BROWSER_CAPSULE');
      assert.equal(nodeText(portlessOutcome), 'NO_BROWSER_CAPSULE: No browser capsule with a live frame.');
      assert.equal(
        normalizeActivityEntry(portlessCaptured.entries().at(-1))?.text,
        'NO_BROWSER_CAPSULE: No browser capsule with a live frame.',
      );
    }
  } finally {
    mounted?.close();
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    delete /** @type {any} */ (globalThis).__e4Deps;
    delete /** @type {any} */ (globalThis).__e4OutcomeAdapters;
  }
});

test('E4-CREATE Goal 2: every typed refusal code renders its code and actionable sentence through the real HostOutcome / hostOutcomeFor toast and the Activity row, including dynamic missing identity ids', async () => {
  const prev = { window: globalThis.window, document: globalThis.document };
  /** @type {any} */ (globalThis).window = { addEventListener() {}, removeEventListener() {} };
  /** @type {any} */ (globalThis).document = { documentElement: { dataset: {} }, getElementById: () => null };
  let mounted;
  try {
    // Verify profilePicker copy reuse and NO_IDENTITY naming mv-live-2.
    assert.equal(CREATE_REFUSAL_REASONS.NO_FREE_PROFILE, REFUSAL_COPY.NO_FREE_PROFILE.message);
    assert.equal(CREATE_REFUSAL_REASONS.CAPSULE_LIMIT_REACHED, REFUSAL_COPY.CAPSULE_LIMIT_REACHED.message);
    assert.equal(CREATE_REFUSAL_REASONS.IDENTITY_LIST_UNAVAILABLE, REFUSAL_COPY.IDENTITY_LIST_UNAVAILABLE.message);
    assert.ok(
      CREATE_REFUSAL_REASONS.NO_IDENTITY.includes('mv-live-2'),
      'NO_IDENTITY names the default second profile id mv-live-2',
    );
    assert.ok(
      CREATE_REFUSAL_REASONS.NO_IDENTITY.includes(
        'No free capsule profile has an identity yet.',
      ),
      'NO_IDENTITY reuses profilePicker operator copy',
    );

    let nextReply = /** @type {any} */ ({ ok: false, code: 'NO_IDENTITY' });
    const authorityHost = createAuthorityAdapter({
      createSurface: async () => nextReply,
      propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
    });
    const captured = /** @type {Record<string, any>} */ ({});
    const App = await compileApp(captured);
    mounted = mountApp(App, {
      authorityHost,
      runtime: {
        projectionView: {
          getSnapshot: () => ({ envelope: { epoch: 'e1' } }),
          getProjection: () => ({ rows: [] }),
          subscribe: () => () => {},
        },
      },
      layout: {},
      scope: {},
      storage: { readRaw: async () => null, writeAtomic: async () => {} },
    });
    await tick();

    const typedCodes = [
      'NO_FREE_PROFILE',
      'NO_IDENTITY',
      'IDENTITY_LIST_UNAVAILABLE',
      'CAPSULE_LIMIT_REACHED',
      'SURFACE_PROFILE_BOUND',
      'PICKER_INPUT_INVALID',
      'PROFILE_ALREADY_BOUND',
      'SURFACE_CAPACITY_OR_QUARANTINE',
      'SURFACE_PROFILE_QUARANTINED',
      'IDENTITY_UNAVAILABLE',
      'IDENTITY_REFUSED',
      'RAM_ADMISSION_REFUSED',
      'SURFACE_CREATE_BUSY',
      'SURFACE_CREATE_TIMEOUT',
      'SURFACE_CREATE_FAILED',
      'SURFACE_CREATE_KIND_UNAVAILABLE',
      'SURFACE_CREATE_INVALID',
      'DISPLAY_ONLY',
      'ADAPTER_ERROR',
    ];

    for (const code of typedCodes) {
      nextReply = { ok: false, code };
      const expectedSentence = CREATE_REFUSAL_REASONS[/** @type {keyof typeof CREATE_REFUSAL_REASONS} */ (code)];
      const expectedText = `${code}: ${expectedSentence}`;

      // Direct hostOutcomeFor check (proving hostOutcomeFor ignores row.message and maps from closed table)
      const directOutcome = hostOutcomeFor({ code, message: 'UNTRUSTED_PROP_TEXT', tone: 'refusal' });
      assert.equal(directOutcome?.code, code);
      assert.equal(directOutcome?.tone, 'refusal');
      assert.equal(directOutcome?.message, expectedText, `hostOutcomeFor produces ${expectedText}`);

      captured.catalog.emit('create', { type: 'create-capsule', kind: 'identity-browser', placement: 'tab' });
      await tick();

      const toast = allNodes(mounted.root).find((n) => n.props?.id === 'mv-host-outcome');
      assert.equal(toast?.props['data-outcome-code'], code);
      assert.equal(toast?.props['data-semantic-anchor'], 'host/outcome');
      assert.equal(toast?.props.role, 'alert');
      assert.equal(nodeText(toast), expectedText, `real HostOutcome toast shows code and sentence for ${code}`);
      assert.notEqual(
        nodeText(toast),
        `${code}: This request is unavailable. Please try again.`,
        `${code} toast must not collapse to generic text`,
      );

      const feedItem = captured.entries().at(-1);
      assert.equal(feedItem?.code, code);
      const activityEntry = normalizeActivityEntry(feedItem);
      assert.equal(activityEntry?.type, 'request-refused');
      assert.equal(activityEntry?.tone, 'refusal');
      assert.equal(activityEntry?.text, expectedText, `activity row shows code and sentence for ${code}`);
      if (code === 'NO_IDENTITY') {
        assert.match(nodeText(toast), /\bmv-live-2\b/, 'NO_IDENTITY toast names mv-live-2');
        assert.match(activityEntry?.text ?? '', /\bmv-live-2\b/, 'NO_IDENTITY activity row names mv-live-2');
      }
    }

    // Dynamic missing identity id end-to-end (main -> preload -> adapter -> App -> HostOutcome toast & Activity row & stderr)
    const stderrLines = /** @type {string[]} */ ([]);
    const origConsoleError = console.error;
    console.error = (...args) => {
      stderrLines.push(args.map(String).join(' '));
    };
    try {
      const handlers = new Map();
      const contents = {
        id: 1,
        mainFrame: { origin: PRIVILEGED_ORIGIN, routingId: 10, url: `${PRIVILEGED_ORIGIN}/index.html` },
        isDestroyed: () => false,
        send() {},
        postMessage() {},
      };
      const event = { sender: contents, senderFrame: contents.mainFrame };
      const wire = installAuthorityWire({
        ipcMain: {
          handle: (ch, fn) => handlers.set(ch, fn),
          removeHandler: (ch) => handlers.delete(ch),
        },
        contents,
        env: {
          HOME: '/tmp/mv-e4-home',
          MV_SRF_PROFILES: JSON.stringify({
            'mv-live-1': { kind: 'browser' },
            'mv-live-2': { kind: 'browser' },
            'mv-live-3': { kind: 'browser' },
          }),
        },
        argv: [],
        capsuleStates: new Map([
          ['s1', { profile_id: 'mv-live-1', state: 'running' }],
          ['s2', { profile_id: 'mv-live-2', state: 'running' }],
        ]),
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }, { id: 'mv-live-2' }] }),
        core: { request: async () => ({ ok: false }) },
      });
      try {
        const preloadApi = createPreloadFacade({
          transport: {
            invoke: async (channel, args) => handlers.get(channel)(event, ...args),
          },
          bridge: { exposeInMainWorld() {} },
        });
        nextReply = await preloadApi.authority.createSurface();
      } finally {
        await wire.dispose();
      }
    } finally {
      console.error = origConsoleError;
    }

    assert.deepEqual(nextReply, { ok: false, code: 'NO_IDENTITY__MV_LIVE_3' });
    captured.catalog.emit('create', { type: 'create-capsule', kind: 'identity-browser', placement: 'tab' });
    await tick();

    const expectedDynamicSentence = createRefusalReason('NO_IDENTITY', 'mv-live-3');
    const expectedDynamicText = `NO_IDENTITY: ${expectedDynamicSentence}`;
    const dynamicToast = allNodes(mounted.root).find((n) => n.props?.id === 'mv-host-outcome');
    assert.equal(dynamicToast?.props['data-outcome-code'], 'NO_IDENTITY');
    assert.equal(nodeText(dynamicToast), expectedDynamicText, 'toast names mv-live-3');
    const dynamicActivity = normalizeActivityEntry(captured.entries().at(-1));
    assert.equal(dynamicActivity?.text, expectedDynamicText, 'Activity row names mv-live-3');
    assert.equal(
      stderrLines[0],
      `[metaviewer] create refused NO_IDENTITY: ${expectedDynamicSentence}`,
      'stderr names mv-live-3 matching toast and Activity row',
    );

    // Unknown adapter/create codes keep generic text and show the code in both toast and Activity row.
    for (const unknownCode of ['ADAPTER_CUSTOM_FAULT', 'UNKNOWN_CREATE_CODE']) {
      nextReply = { ok: false, code: unknownCode };
      const expectedUnknown = `${unknownCode}: This request is unavailable. Please try again.`;

      captured.catalog.emit('create', { type: 'create-capsule', kind: 'identity-browser', placement: 'tab' });
      await tick();

      const toast = allNodes(mounted.root).find((n) => n.props?.id === 'mv-host-outcome');
      assert.equal(toast?.props['data-outcome-code'], unknownCode);
      assert.equal(nodeText(toast), expectedUnknown);

      const activityEntry = normalizeActivityEntry(captured.entries().at(-1));
      assert.equal(activityEntry?.text, expectedUnknown);
    }
  } finally {
    mounted?.close();
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    delete /** @type {any} */ (globalThis).__e4Deps;
    delete /** @type {any} */ (globalThis).__e4OutcomeAdapters;
  }
});

test('E4-CREATE Goal 3: authorityWire createSurface emits exactly one [metaviewer] create refused <CODE>: <reason> stderr line per refusal', async () => {
  const stderrLines = /** @type {string[]} */ ([]);
  const origConsoleError = console.error;
  console.error = (...args) => {
    stderrLines.push(args.map(String).join(' '));
  };

  try {
    /** @param {Record<string, any>} opts */
    const setupWire = (opts) => {
      const handlers = new Map();
      const contents = {
        id: 1,
        mainFrame: { origin: PRIVILEGED_ORIGIN, routingId: 10, url: `${PRIVILEGED_ORIGIN}/index.html` },
        isDestroyed: () => false,
        send() {},
        postMessage() {},
      };
      const ipcMain = {
        handle: (ch, fn) => handlers.set(ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
      };
      const event = {
        sender: contents,
        senderFrame: contents.mainFrame,
      };
      const defaultProfiles = JSON.stringify({
        'mv-live-1': { kind: 'browser' },
        'mv-live-2': { kind: 'browser' },
      });
      const wire = installAuthorityWire({
        ipcMain,
        contents,
        env: opts.env ?? { HOME: '/tmp/mv-e4-home', MV_SRF_PROFILES: defaultProfiles },
        argv: opts.argv ?? [],
        capsuleStates: opts.capsuleStates ?? new Map([['surface-1', { profile_id: 'mv-live-1', state: 'running' }]]),
        listIdentities: opts.listIdentities ?? null,
        core: opts.core ?? { request: async () => ({ schema: 'surface_event/v0.2', event: 'created', data: { surface: { surface_id: 's2', profile_id: 'mv-live-2', state: 'running' } } }) },
      });
      return {
        invokeCreate: () => handlers.get(WIRE_CHANNELS.createSurface)(event),
        dispose: () => wire.dispose(),
      };
    };

    // 1. Picker refusals: NO_IDENTITY (names mv-live-2 and custom missing id), NO_FREE_PROFILE, IDENTITY_LIST_UNAVAILABLE, CAPSULE_LIMIT_REACHED
    {
      stderrLines.length = 0;
      const w = setupWire({
        listIdentities: async () => ({
          ok: true,
          rows: [{ id: 'mv-live-1', secretPath: '/secret/private/path/must-not-leak' }],
        }),
      });
      const res = await w.invokeCreate();
      w.dispose();
      assert.deepEqual(res, { ok: false, code: 'NO_IDENTITY' });
      assert.equal(stderrLines.length, 1, 'emits once per refusal');
      assert.equal(
        stderrLines[0],
        `[metaviewer] create refused NO_IDENTITY: ${createRefusalReason('NO_IDENTITY', 'mv-live-2')}`,
      );
      assert.doesNotMatch(stderrLines[0], /\/secret\/private\/path/);
    }

    {
      stderrLines.length = 0;
      const w = setupWire({
        env: {
          HOME: '/tmp/mv-e4-home',
          MV_SRF_PROFILES: JSON.stringify({
            'mv-live-1': { kind: 'browser' },
            'mv-live-3': { kind: 'browser' },
          }),
        },
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }] }),
      });
      const res = await w.invokeCreate();
      w.dispose();
      assert.deepEqual(res, { ok: false, code: 'NO_IDENTITY__MV_LIVE_3' });
      assert.equal(stderrLines.length, 1);
      assert.equal(
        stderrLines[0],
        `[metaviewer] create refused NO_IDENTITY: ${createRefusalReason('NO_IDENTITY', 'mv-live-3')}`,
      );
    }

    {
      stderrLines.length = 0;
      const w = setupWire({
        env: { HOME: '/tmp/mv-e4-home', MV_SRF_PROFILES: JSON.stringify({ 'mv-live-1': { kind: 'browser' } }) },
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }] }),
      });
      const res = await w.invokeCreate();
      w.dispose();
      assert.deepEqual(res, { ok: false, code: 'NO_FREE_PROFILE' });
      assert.equal(stderrLines.length, 1);
      assert.equal(
        stderrLines[0],
        `[metaviewer] create refused NO_FREE_PROFILE: ${createRefusalReason('NO_FREE_PROFILE')}`,
      );
    }

    {
      stderrLines.length = 0;
      const w = setupWire({
        listIdentities: async () => ({ ok: false, code: 'TOOL_FAILED' }),
      });
      const res = await w.invokeCreate();
      w.dispose();
      assert.deepEqual(res, { ok: false, code: 'IDENTITY_LIST_UNAVAILABLE' });
      assert.equal(stderrLines.length, 1);
      assert.equal(
        stderrLines[0],
        `[metaviewer] create refused IDENTITY_LIST_UNAVAILABLE: ${createRefusalReason('IDENTITY_LIST_UNAVAILABLE')}`,
      );
    }

    {
      stderrLines.length = 0;
      const sixteenIds = Array.from({ length: 16 }, (_, i) => `mv-live-${i + 1}`);
      const sixteenRunning = new Map(sixteenIds.map((id, i) => [`s${i + 1}`, { profile_id: id, state: 'running' }]));
      const w = setupWire({
        env: {
          HOME: '/tmp/mv-e4-home',
          MV_SRF_PROFILES: JSON.stringify(Object.fromEntries(sixteenIds.map((id) => [id, { kind: 'browser' }]))),
        },
        capsuleStates: sixteenRunning,
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }, { id: 'mv-live-2' }] }),
      });
      const res = await w.invokeCreate();
      w.dispose();
      assert.deepEqual(res, { ok: false, code: 'CAPSULE_LIMIT_REACHED' });
      assert.equal(stderrLines.length, 1);
      assert.equal(
        stderrLines[0],
        `[metaviewer] create refused CAPSULE_LIMIT_REACHED: ${createRefusalReason('CAPSULE_LIMIT_REACHED')}`,
      );
    }

    // 2. Nested display-only refusal
    {
      stderrLines.length = 0;
      const w = setupWire({
        argv: ['--nested-depth=1'],
      });
      const res = await w.invokeCreate();
      w.dispose();
      assert.deepEqual(res, { ok: false, code: 'DISPLAY_ONLY' });
      assert.equal(stderrLines.length, 1);
      assert.equal(stderrLines[0], `[metaviewer] create refused DISPLAY_ONLY: ${createRefusalReason('DISPLAY_ONLY')}`);
    }

    // 3. Adapter/core refusals and thrown errors
    for (const code of ['PROFILE_ALREADY_BOUND', 'SURFACE_CAPACITY_OR_QUARANTINE', 'IDENTITY_UNAVAILABLE', 'RAM_ADMISSION_REFUSED', 'ADAPTER_CUSTOM_ERR']) {
      stderrLines.length = 0;
      const w = setupWire({
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }, { id: 'mv-live-2' }] }),
        core: {
          request: async () => ({
            schema: 'action_verdict/v0.2',
            decision: 'refused',
            reason_code: code,
          }),
        },
      });
      const res = await w.invokeCreate();
      w.dispose();
      assert.deepEqual(res, { ok: false, code });
      assert.equal(stderrLines.length, 1);
      assert.equal(
        stderrLines[0],
        `[metaviewer] create refused ${code}: ${createRefusalReason(code)}`,
      );
    }

    // 4. Positive control: successful create emits zero refusal lines
    {
      stderrLines.length = 0;
      const w = setupWire({
        listIdentities: async () => ({ ok: true, rows: [{ id: 'mv-live-1' }, { id: 'mv-live-2' }] }),
      });
      const res = await w.invokeCreate();
      w.dispose();
      assert.deepEqual(res, { ok: true });
      assert.equal(stderrLines.length, 0, 'successful create logs no refusal');
    }
  } finally {
    console.error = origConsoleError;
  }
});

test('E4-CREATE Goal 4 (Mutants): restoring browser-only gate, collapsing toast/activity copy, or hardcoding mv-live-2 fails the suite', async () => {
  const prev = { window: globalThis.window, document: globalThis.document };
  /** @type {any} */ (globalThis).window = { addEventListener() {}, removeEventListener() {} };
  /** @type {any} */ (globalThis).document = { documentElement: { dataset: {} }, getElementById: () => null };
  try {
    // Mutant A: restore the browser-only gate in App.vue (`body?.kind !== 'browser'`)
    const gateTarget = "(body?.kind !== 'browser' && body?.kind !== 'identity-browser')";
    assert.equal(APP_SOURCE.split(gateTarget).length, 2, 'unique anchor for browser+identity-browser gate');
    {
      let createCalls = 0;
      const captured = /** @type {Record<string, any>} */ ({});
      const MutatedApp = await compileApp(captured, (src) =>
        src.replace(gateTarget, "(body?.kind !== 'browser')"),
      );
      const mounted = mountApp(MutatedApp, {
        authorityHost: createAuthorityAdapter({
          createSurface: async () => {
            createCalls += 1;
            return { ok: true };
          },
          propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
        }),
        runtime: {
          projectionView: {
            getSnapshot: () => ({ envelope: { epoch: 'e1' } }),
            getProjection: () => ({ rows: [] }),
            subscribe: () => () => {},
          },
        },
        layout: {},
        scope: {},
        storage: { readRaw: async () => null, writeAtomic: async () => {} },
      });
      try {
        await tick();
        captured.catalog.emit('create', { type: 'create-capsule', kind: 'identity-browser', placement: 'tab' });
        await tick();
        assert.throws(
          () => assert.equal(createCalls, 1, 'identity-browser reaches createSurface'),
          assert.AssertionError,
          'Mutant A killed: restoring browser-only gate blocks identity-browser create',
        );
      } finally {
        mounted.close();
      }
    }

    // Mutant B (Toast path): strip E4 createReasons from hostAdapters.js hostOutcomeFor -> real HostOutcome renders generic text and fails
    const hostAdaptersTarget = 'if (Object.hasOwn(createReasons, row.code)) return { code: row.code,';
    assert.equal(HOST_ADAPTERS_SOURCE.split(hostAdaptersTarget).length, 2, 'unique anchor in hostAdapters.js');
    {
      const mutatedAdaptersSrc = HOST_ADAPTERS_SOURCE
        .replace('./projection.js', pathToFileURL(fileURLToPath(new URL('../src/core/projection.js', import.meta.url))).href)
        .replace('./intents.js', pathToFileURL(fileURLToPath(new URL('../src/core/intents.js', import.meta.url))).href)
        .replace(/if \(missingMatch\) return \{[\s\S]*?tone: 'refusal' \};\n\s*if \(Object\.hasOwn\(createReasons, row\.code\)\) return \{[\s\S]*?tone: 'refusal' \};/, '');
      const mutatedAdapters = await import(
        `data:text/javascript;base64,${Buffer.from(mutatedAdaptersSrc).toString('base64')}#mutant-adapters`
      );
      const captured = /** @type {Record<string, any>} */ ({});
      const MutatedApp = await compileApp(captured, (s) => s, mutatedAdapters);
      const mounted = mountApp(MutatedApp, {
        authorityHost: createAuthorityAdapter({
          createSurface: async () => ({ ok: false, code: 'NO_IDENTITY' }),
          propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
        }),
        runtime: {
          projectionView: {
            getSnapshot: () => ({ envelope: { epoch: 'e1' } }),
            getProjection: () => ({ rows: [] }),
            subscribe: () => () => {},
          },
        },
        layout: {},
        scope: {},
        storage: { readRaw: async () => null, writeAtomic: async () => {} },
      });
      try {
        await tick();
        captured.catalog.emit('create', { type: 'create-capsule', kind: 'identity-browser', placement: 'tab' });
        await tick();
        const toast = allNodes(mounted.root).find((n) => n.props?.id === 'mv-host-outcome');
        assert.equal(
          nodeText(toast),
          'NO_IDENTITY: This request is unavailable. Please try again.',
          'Mutant B reproduces R1 HOLD: without hostOutcomeFor E4 reasons, real HostOutcome collapses to generic text',
        );
        assert.throws(
          () =>
            assert.equal(
              nodeText(toast),
              `NO_IDENTITY: ${CREATE_REFUSAL_REASONS.NO_IDENTITY}`,
            ),
          assert.AssertionError,
          'Mutant B killed: collapsing hostOutcomeFor toast copy fails the real HostOutcome assertion',
        );
      } finally {
        mounted.close();
      }
    }

    // Mutant C (ID mismatch): drop dynamic missingId propagation in App.vue / authorityWire.js so renderer hardcodes mv-live-2 while main logs mv-live-3
    const wireTarget = "const wireCode = code === 'NO_IDENTITY' && target !== 'mv-live-2' && `NO_IDENTITY__${encodedId}`.length <= 64";
    assert.equal(WIRE_SOURCE.split(wireTarget).length, 2, 'unique anchor for missingId wire propagation in authorityWire.js');
    const appMissingTarget = 'const missingId = rawMissing ??';
    assert.equal(APP_SOURCE.split(appMissingTarget).length, 2, 'unique anchor for missingId extraction in App.vue');
    {
      const captured = /** @type {Record<string, any>} */ ({});
      const MutatedApp = await compileApp(captured, (src) =>
        src.replace(/const missingId = rawMissing \?\?[\s\S]*?: null\);/, 'const missingId = null;'),
      );
      const mounted = mountApp(MutatedApp, {
        authorityHost: createAuthorityAdapter({
          createSurface: async () => ({ ok: false, code: 'NO_IDENTITY__MV_LIVE_3' }),
          propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
        }),
        runtime: {
          projectionView: {
            getSnapshot: () => ({ envelope: { epoch: 'e1' } }),
            getProjection: () => ({ rows: [] }),
            subscribe: () => () => {},
          },
        },
        layout: {},
        scope: {},
        storage: { readRaw: async () => null, writeAtomic: async () => {} },
      });
      try {
        await tick();
        captured.catalog.emit('create', { type: 'create-capsule', kind: 'identity-browser', placement: 'tab' });
        await tick();
        const toast = allNodes(mounted.root).find((n) => n.props?.id === 'mv-host-outcome');
        const expectedMvLive3 = `NO_IDENTITY: ${createRefusalReason('NO_IDENTITY', 'mv-live-3')}`;
        assert.throws(
          () => assert.equal(nodeText(toast), expectedMvLive3),
          assert.AssertionError,
          'Mutant C1 killed: dropping missingId extraction in App.vue causes toast id mismatch',
        );
        const activityEntry = normalizeActivityEntry(captured.entries().at(-1));
        assert.throws(
          () => assert.equal(activityEntry?.text, expectedMvLive3),
          assert.AssertionError,
          'Mutant C2 killed: dropping missingId extraction in App.vue causes Activity row id mismatch',
        );
      } finally {
        mounted.close();
      }
    }

    // Mutant D: collapse activityModel.js create codes back to ACTIVITY_FALLBACK
    const modelTarget = 'NO_IDENTITY: Object.freeze({';
    assert.equal(ACTIVITY_MODEL_SOURCE.split(modelTarget).length, 2, 'unique anchor in activityModel.js');
    const mutatedModelSrc = ACTIVITY_MODEL_SOURCE
      .replace(/const missingMatch =[\s\S]*?if \(Object\.hasOwn\(ACTIVITY_ROWS, code\)\)/, 'if (Object.hasOwn(ACTIVITY_ROWS, code))')
      .replace(/NO_BROWSER_CAPSULE:[\s\S]*?ADAPTER_ERROR:[^\n]+\n/, '')
      .replace(
        /if \(\/\^\[A-Z\]\[A-Z0-9\]\*_\[A-Z0-9_\]\+\$\/\.test\(code\)[\s\S]*?\}\n/,
        '',
      );
    const mutatedModel = await import(
      `data:text/javascript;base64,${Buffer.from(mutatedModelSrc).toString('base64')}#mutant-model`
    );
    assert.throws(
      () =>
        assert.equal(
          mutatedModel.normalizeActivityEntry({ seq: 1, code: 'NO_IDENTITY' })?.text,
          `NO_IDENTITY: ${CREATE_REFUSAL_REASONS.NO_IDENTITY}`,
        ),
      assert.AssertionError,
      'Mutant D killed: collapsing activityModel.js create codes to generic text fails',
    );
  } finally {
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    delete /** @type {any} */ (globalThis).__e4Deps;
    delete /** @type {any} */ (globalThis).__e4OutcomeAdapters;
  }
});
