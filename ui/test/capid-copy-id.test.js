// CAPID-UI (FEEDBACK row 7, pillar P2): every wall tile shows its capsule id
// (short, full id on hover) and a keyboard-reachable "Copy ID for AI" action
// that copies one ready line: the id plus the documented mw_run attach usage.
//
// Layers: the pure module (grammar, short form, ready line, copy outcomes,
// timed confirmation), then the REAL SurfacePanel SFC mounted on a custom
// renderer with an injected clipboard. Mutants run in-suite against rewritten
// sources: each one must fail the same oracle that passes the baseline.
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { compileSfc, nodes, flush } from './mvui2-terminal-mount.mjs';
import { addOperatorStubs } from './operator-stubs.mjs';
import * as capsuleId from '../src/wall/capsuleId.js';
import * as tileStates from '../src/wall/tileStates.js';
import * as tileCapture from '../src/wall/tileCapture.js';

const SRC = (rel) => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));
const PANEL_SOURCE = readFileSync(SRC('wall/SurfacePanel.vue'), 'utf8');
const CHROME_SOURCE = readFileSync(SRC('wall/TileCaptureChrome.vue'), 'utf8');
const CAPSULE_ID_SOURCE = readFileSync(SRC('wall/capsuleId.js'), 'utf8');
const VUE_URL = pathToFileURL(createRequire(import.meta.url).resolve('vue')).href;
let serial = 0;

const SURFACE = 'surf-0123456789abcdef';
const IDENTITY = 'acct-main';

// ---------------------------------------------------------------- harness

async function importSource(code) {
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#capid${serial++}`);
}

/** capsuleId.js with an optional textual mutation; its one relative import is made absolute. */
async function loadCapsuleId(mutate = (s) => s) {
  return importSource(mutate(CAPSULE_ID_SOURCE));
}

/** Compiles one SFC source against a closed dependency map (an unmapped import fails). */
async function compileSource(source, deps, tag) {
  const { descriptor } = parse(source);
  let code = compileScript(descriptor, { id: `capid-${tag}-${serial++}`, inlineTemplate: true }).content;
  code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(VUE_URL));
    assert.ok(spec in deps, `Unmapped SFC dependency: ${spec}`);
    return `const ${bindings.trim()} = globalThis.__capidDeps[${JSON.stringify(spec)}];`;
  });
  globalThis.__capidDeps = deps;
  try {
    return (await importSource(code)).default;
  } finally {
    delete globalThis.__capidDeps;
  }
}

const KIT_SIDEBAR_ICON = await compileSfc('../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue', {});
const KIT_RECORD_BUTTON = await compileSfc('../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue', {});

function compileChrome(chromeSource, idModule) {
  return compileSource(chromeSource, {
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': KIT_SIDEBAR_ICON,
    '../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue': KIT_RECORD_BUTTON,
    './tileCapture.js': { ...tileCapture, ...idModule },
  }, 'chrome');
}

/**
 * The real SurfacePanel over the real TileCaptureChrome (each from a given
 * source), against a given capsuleId module re-exported by tileCapture.js.
 */
async function compilePanel(panelSource, idModule, chromeSource = CHROME_SOURCE) {
  const CapsulePanel = vue.defineComponent({
    props: { capsuleId: String, presentationStatus: String },
    setup: (_, ctx) => () => vue.h('div', { class: 'cuk-capsule-panel' }, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])),
  });
  const Chrome = await compileChrome(chromeSource, idModule);
  const deps = {
    'capsule-ui-kit/CapsulePanel': CapsulePanel,
    './tileStates.js': tileStates,
    './TileCaptureChrome.vue': Chrome,
  };
  addOperatorStubs(deps);
  return compileSource(panelSource, deps, 'panel');
}

function mountComponent(component, props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: (tag) => ({ tag, children: [], props: {}, style: {} }),
    createText: (content) => ({ text: content }),
    createComment: (content) => ({ text: content }),
    insert(node, parent, anchor) {
      if (node.parent) this.remove(node);
      node.parent = parent;
      const index = parent.children.indexOf(anchor);
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    },
    remove(node) {
      const list = node.parent?.children;
      if (list) list.splice(list.indexOf(node), 1);
    },
    setText(node, value) { node.text = value; },
    setElementText(node, value) { node.text = value; },
    patchProp(node, key, _old, value) { node.props[key] = value; },
    parentNode: (node) => node.parent,
    nextSibling: () => null,
    setScopeId() {},
  });
  const app = renderer.createApp(component, props);
  app.mount(root);
  return { root, close: () => app.unmount() };
}

const row = (overrides = {}) => ({
  id: SURFACE, surfaceId: SURFACE, profile_id: IDENTITY, backendLifecycle: 'active', generation: 1,
  visibility: 'unfolded', control: 'human', attachmentState: 'live', ...overrides,
});
const snapshotOf = (rows) => ({
  status: 'live', stale: false, error: null,
  envelope: { schema: 'surface/v0.1', epoch: 1, revision: 1, query: 'wall', projection: { rows } },
});
const fakeBuilders = { visibility: () => ({}), control: () => ({}), presentation: () => ({}) };

function clipboardDouble({ reject = false } = {}) {
  const writes = [];
  return { writes, writeText: async (text) => { writes.push(text); if (reject) throw new Error('refused'); } };
}

async function mountPanel(Panel, { rows = [row()], clipboard = clipboardDouble(), displayOnly = false, capsule = SURFACE } = {}) {
  const view = { getSnapshot: () => snapshotOf(rows), subscribe: () => () => {} };
  const mounted = mountComponent(Panel, {
    capsuleId: capsule, projectionView: view, intentBuilders: fakeBuilders, controlRegistry: {}, scheduler: {},
    tileScheduler: {}, title: 'Main tile', presentationInstance: `wall:${capsule}`, clipboard, displayOnly,
  });
  await flush();
  return { ...mounted, clipboard };
}

const byId = (root, id) => nodes(root).find((n) => n.props?.id === id);
const byClass = (root, cls) => nodes(root).find((n) => n.props?.class === cls);
const textOf = (n) => `${n.text ?? ''}${(n.children ?? []).map(textOf).join('')}`;

// ------------------------------------------------------------ pure oracle

/** Collects failures so a mutant can be asserted to fail; baseline asserts none. */
function pureOracle(m) {
  const failures = [];
  const check = (name, fn) => { try { fn(); } catch (error) { failures.push(`${name}: ${error.message.split('\n').slice(0, 4).join(' ').slice(0, 300)}`); } };

  check('short id keeps short ids whole and ellipsizes long ones', () => {
    assert.equal(m.shortCapsuleId('slot-1'), 'slot-1');
    const long = m.shortCapsuleId(SURFACE);
    assert.ok(long.length < SURFACE.length && long.includes('…') && long.startsWith('surf-012') && long.endsWith('bcdef'));
  });
  check('ready line carries id, identity and the exact mw_run usage', () => {
    const line = m.buildCapsuleReadyLine({ surfaceId: SURFACE, profileId: IDENTITY });
    assert.ok(line.includes(SURFACE));
    assert.ok(line.includes(`--identity ${IDENTITY}`));
    assert.ok(line.includes('python3 -m metaviewer_agents.mw_run'));
    assert.ok(line.includes('--site <site> --workflow <workflow>'));
    assert.ok(line.includes('metaviewer/attach/current.env'));
    assert.ok(line.includes('HUMAN_HANDOFF'));
  });
  check('ready line is one line with no host path or secret shape', () => {
    const line = m.buildCapsuleReadyLine({ surfaceId: SURFACE, profileId: IDENTITY });
    assert.equal(/[\r\n\0]/.test(line), false);
    assert.equal(/\/home\/|\/usr\/|\/Users\/|token|password/i.test(line), false);
    assert.ok(Buffer.byteLength(line) <= 4096);
  });
  check('no identity gives an id-only line with no command', () => {
    for (const profileId of [undefined, '', 'Has Space', 'a;b', 'UPPER', 42, null]) {
      const line = m.buildCapsuleReadyLine({ surfaceId: SURFACE, profileId });
      assert.ok(line.includes(SURFACE));
      assert.equal(line.includes('mw_run'), false, `profile ${String(profileId)}`);
      assert.equal(line.includes('--identity'), false);
    }
  });
  check('hostile identity and id never reach a line', () => {
    for (const hostile of ['x; rm -rf ~', 'a b', 'a`id`', '$(id)', 'a\nb', '-lead', 'x'.repeat(65), '../up']) {
      const line = m.buildCapsuleReadyLine({ surfaceId: SURFACE, profileId: hostile });
      assert.equal(line.includes(hostile), false, `identity ${JSON.stringify(hostile)}`);
      if (hostile.length <= 64) assert.equal(m.buildCapsuleReadyLine({ surfaceId: hostile, profileId: IDENTITY }), null, `id ${JSON.stringify(hostile)}`);
    }
    for (const bad of [undefined, null, '', 7, {}, 'x'.repeat(129)]) {
      assert.equal(m.buildCapsuleReadyLine({ surfaceId: bad, profileId: IDENTITY }), null);
    }
  });
  check('model: visible chip, full id on hover, accessible copy name', () => {
    const model = m.capsuleIdModel({ surfaceId: SURFACE, profileId: IDENTITY, tile: 'live' });
    assert.equal(model.visible, true);
    assert.equal(model.hover, `Capsule ID: ${SURFACE} · Identity: ${IDENTITY}`);
    assert.equal(model.copyName, `Copy ID for AI: capsule ${SURFACE}`);
    assert.equal(model.canCopy, true);
    assert.equal(m.capsuleIdModel({ surfaceId: '', tile: 'live' }).visible, false);
  });
  check('model: lost and error tiles keep the id but block the copy', () => {
    for (const tile of ['lost', 'error']) {
      const model = m.capsuleIdModel({ surfaceId: SURFACE, profileId: IDENTITY, tile });
      assert.equal(model.visible, true);
      assert.equal(model.canCopy, false);
      assert.ok(model.blockedReason.includes(tile));
    }
    for (const tile of ['connecting', 'live', 'folded', 'human-control', 'agent-acting']) {
      assert.equal(m.capsuleIdModel({ surfaceId: SURFACE, tile }).canCopy, true, tile);
    }
  });
  return failures;
}

async function copyOracle(m) {
  const failures = [];
  const check = async (name, fn) => { try { await fn(); } catch (error) { failures.push(`${name}: ${error.message.split('\n').slice(0, 4).join(' ').slice(0, 300)}`); } };
  await check('copy writes exactly the ready line', async () => {
    const clipboard = clipboardDouble();
    const out = await m.copyCapsuleReadyLine({ surfaceId: SURFACE, profileId: IDENTITY }, clipboard);
    assert.equal(out.state, 'copied');
    assert.deepEqual(clipboard.writes, [m.buildCapsuleReadyLine({ surfaceId: SURFACE, profileId: IDENTITY })]);
    assert.ok(clipboard.writes[0].includes('mw_run'), 'the line is not the bare id');
  });
  await check('refusing clipboard projects unavailable and never throws', async () => {
    const out = await m.copyCapsuleReadyLine({ surfaceId: SURFACE, profileId: IDENTITY }, clipboardDouble({ reject: true }));
    assert.equal(out.state, 'unavailable');
    assert.equal(out.reason, 'ERR_CLIPBOARD_WRITE_REFUSED');
  });
  await check('invalid id never touches the clipboard', async () => {
    const clipboard = clipboardDouble();
    const out = await m.copyCapsuleReadyLine({ surfaceId: 'bad id', profileId: IDENTITY }, clipboard);
    assert.equal(out.state, 'unavailable');
    assert.deepEqual(clipboard.writes, []);
  });
  await check('no clipboard anywhere is unavailable', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    try {
      const out = await m.copyCapsuleReadyLine({ surfaceId: SURFACE, profileId: IDENTITY }, null);
      assert.equal(out.reason, 'ERR_CLIPBOARD_UNAVAILABLE');
      assert.equal(m.capsuleCopyAvailable(null), false);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
    }
  });
  await check('ambient clipboard is the fallback', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const ambient = clipboardDouble();
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: ambient }, configurable: true });
    try {
      assert.equal(m.capsuleCopyAvailable(null), true);
      const out = await m.copyCapsuleReadyLine({ surfaceId: SURFACE, profileId: IDENTITY }, null);
      assert.equal(out.state, 'copied');
      assert.equal(ambient.writes.length, 1);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
    }
  });
  return failures;
}

async function feedbackOracle(m) {
  const failures = [];
  const check = async (name, fn) => { try { await fn(); } catch (error) { failures.push(`${name}: ${error.message.split('\n').slice(0, 4).join(' ').slice(0, 300)}`); } };
  function rig() {
    const states = [];
    const timers = [];
    const feedback = m.createCapsuleCopyFeedback((state) => states.push(state), {
      setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
      clearTimer: (h) => { timers[h].live = false; },
    });
    const fire = () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); });
    return { states, timers, feedback, fire };
  }
  await check('copying then copied then ready after the delay', async () => {
    const { states, timers, feedback, fire } = rig();
    await feedback.run(async () => ({ state: 'copied', reason: '' }));
    assert.deepEqual(states, ['copying', 'copied']);
    assert.equal(timers.at(-1).ms, m.CAPSULE_COPY_CONFIRM_MS);
    assert.equal(m.CAPSULE_COPY_CONFIRM_MS, 2000);
    fire();
    assert.deepEqual(states, ['copying', 'copied', 'ready']);
  });
  await check('a failed copy shows unavailable then clears', async () => {
    const { states, feedback, fire } = rig();
    await feedback.run(async () => ({ state: 'unavailable', reason: 'ERR_CLIPBOARD_WRITE_REFUSED' }));
    assert.deepEqual(states, ['copying', 'unavailable']);
    fire();
    assert.equal(states.at(-1), 'ready');
  });
  await check('a throwing copy never escapes', async () => {
    const { states, feedback } = rig();
    await feedback.run(async () => { throw new Error('boom'); });
    assert.equal(states.at(-1), 'unavailable');
  });
  await check('a second copy restarts the timer', async () => {
    const { states, timers, feedback, fire } = rig();
    await feedback.run(async () => ({ state: 'copied', reason: '' }));
    await feedback.run(async () => ({ state: 'copied', reason: '' }));
    assert.equal(timers[0].live, false, 'first timer cancelled');
    fire();
    assert.equal(states.filter((s) => s === 'ready').length, 1);
  });
  await check('dispose cancels the pending reset', async () => {
    const { states, timers, feedback } = rig();
    await feedback.run(async () => ({ state: 'copied', reason: '' }));
    feedback.dispose();
    assert.equal(timers.at(-1).live, false);
    const before = states.length;
    await feedback.run(async () => ({ state: 'copied', reason: '' }));
    assert.equal(states.length, before, 'disposed feedback stays silent');
  });
  return failures;
}

// -------------------------------------------------------- component oracle

async function panelOracle(Panel) {
  const failures = [];
  const check = async (name, fn) => { try { await fn(); } catch (error) { failures.push(`${name}: ${error.message.split('\n').slice(0, 4).join(' ').slice(0, 300)}`); } };

  await check('chip shows the short id with the full id on hover', async () => {
    const { root, close } = await mountPanel(Panel);
    const chip = byId(root, `tile-${SURFACE}-capsule-id`);
    assert.ok(chip, 'id chip mounts');
    assert.equal(chip.tag, 'code');
    assert.equal(textOf(chip), capsuleId.shortCapsuleId(SURFACE));
    assert.equal(chip.props.title, `Capsule ID: ${SURFACE} · Identity: ${IDENTITY}`);
    close();
  });
  await check('copy control is a native keyboard-reachable button with an accessible name', async () => {
    const { root, close } = await mountPanel(Panel);
    const button = byId(root, `tile-${SURFACE}-copy-id`);
    assert.ok(button, 'copy control mounts');
    assert.equal(button.tag, 'button');
    assert.equal(button.props.type, 'button');
    assert.equal(button.props.disabled, false);
    assert.notEqual(button.props.tabindex, -1);
    assert.equal(button.props['aria-label'], `Copy ID for AI: capsule ${SURFACE}`);
    assert.equal(textOf(button), 'Copy ID for AI');
    assert.equal(button.props['data-semantic-anchor'], `tile-${SURFACE}-copy-id`);
    close();
  });
  await check('click copies the ready line and shows Copied, then clears', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { root, close, clipboard } = await mountPanel(Panel);
      const button = byId(root, `tile-${SURFACE}-copy-id`);
      button.props.onClick();
      await flush();
      assert.deepEqual(clipboard.writes, [capsuleId.buildCapsuleReadyLine({ surfaceId: SURFACE, profileId: IDENTITY })]);
      const status = byClass(root, 'mv-tile-capid__status');
      assert.ok(status, 'confirmation mounts');
      assert.equal(status.props.role, 'status');
      assert.equal(textOf(status), 'Copied');
      mock.timers.tick(2000);
      await flush();
      assert.ok(byClass(root, 'mv-tile-capid__status') === undefined, 'confirmation is transient');
      close();
    } finally {
      mock.timers.reset();
    }
  });
  await check('unmounting a tile clears the pending Copied reset timer', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const realClear = globalThis.clearTimeout;
    const cleared = [];
    globalThis.clearTimeout = (handle) => { cleared.push(handle); return realClear(handle); };
    try {
      const { root, close } = await mountPanel(Panel);
      byId(root, `tile-${SURFACE}-copy-id`).props.onClick();
      await flush();
      assert.equal(cleared.length, 0, 'timer pending before unmount');
      close();
      assert.ok(cleared.length >= 1, 'unmount cleared the timer');
    } finally {
      globalThis.clearTimeout = realClear;
      mock.timers.reset();
    }
  });
  await check('a refusing clipboard shows Copy unavailable, never Copied', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { root, close } = await mountPanel(Panel, { clipboard: clipboardDouble({ reject: true }) });
      byId(root, `tile-${SURFACE}-copy-id`).props.onClick();
      await flush();
      assert.equal(textOf(byClass(root, 'mv-tile-capid__status')), 'Copy unavailable');
      close();
    } finally {
      mock.timers.reset();
    }
  });
  await check('without a host identity the copy is id only', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { root, close, clipboard } = await mountPanel(Panel, { rows: [row({ profile_id: '' })] });
      byId(root, `tile-${SURFACE}-copy-id`).props.onClick();
      await flush();
      assert.equal(clipboard.writes.length, 1);
      assert.ok(clipboard.writes[0].includes(SURFACE));
      assert.equal(clipboard.writes[0].includes('--identity'), false);
      close();
    } finally {
      mock.timers.reset();
    }
  });
  await check('a lost tile keeps the id and disables the copy', async () => {
    const { root, close, clipboard } = await mountPanel(Panel, { rows: [row({ backendLifecycle: 'lost' })] });
    assert.ok(byId(root, `tile-${SURFACE}-capsule-id`));
    const button = byId(root, `tile-${SURFACE}-copy-id`);
    assert.equal(button.props.disabled, true);
    button.props.onClick?.();
    await flush();
    assert.deepEqual(clipboard.writes, []);
    close();
  });
  await check('a missing row still shows the id from the capsule id', async () => {
    const { root, close } = await mountPanel(Panel, { rows: [] });
    assert.equal(textOf(byId(root, `tile-${SURFACE}-capsule-id`)), capsuleId.shortCapsuleId(SURFACE));
    close();
  });
  await check('nested display-only tiles render no id chip', async () => {
    const { root, close } = await mountPanel(Panel, { displayOnly: true });
    assert.ok(byId(root, `tile-${SURFACE}-capsule-id`) === undefined, 'no chip in display-only tiles');
    close();
  });
  await check('two tiles keep distinct ids', async () => {
    const other = 'surf-fedcba9876543210';
    const a = await mountPanel(Panel, { rows: [row(), row({ id: other, surfaceId: other })] });
    const b = await mountPanel(Panel, { rows: [row(), row({ id: other, surfaceId: other })], capsule: other });
    assert.ok(byId(a.root, `tile-${SURFACE}-capsule-id`) && !byId(a.root, `tile-${other}-capsule-id`));
    assert.ok(byId(b.root, `tile-${other}-capsule-id`) && !byId(b.root, `tile-${SURFACE}-capsule-id`));
    a.close(); b.close();
  });
  return failures;
}

/** A chrome mounted without a surface id (legacy mount) renders no chip: the rail keeps its three controls. */
async function chromeOracle(Chrome) {
  const failures = [];
  try {
    const mounted = mountComponent(Chrome, { capsuleId: SURFACE, captureState: null });
    await flush();
    assert.ok(byId(mounted.root, `tile-${SURFACE}-capsule-id`) === undefined, 'no id chip without a surface id');
    assert.ok(byId(mounted.root, `tile-${SURFACE}-copy-id`) === undefined, 'no copy control without a surface id');
    assert.ok(byId(mounted.root, `tile-${SURFACE}-screenshot`) !== undefined, 'the legacy rail keeps its controls');
    mounted.close();
  } catch (error) {
    failures.push(`legacy chrome: ${error.message.split('\n').slice(0, 4).join(' ').slice(0, 300)}`);
  }
  return failures;
}

// ------------------------------------------------------------------ suites

describe('pure capsule id module', () => {
  test('oracle passes on the shipped module', async () => {
    assert.deepEqual(pureOracle(capsuleId), []);
    assert.deepEqual(await copyOracle(capsuleId), []);
    assert.deepEqual(await feedbackOracle(capsuleId), []);
  });
  test('states and grammar are closed and frozen', () => {
    assert.deepEqual(capsuleId.CAPSULE_COPY_STATES, ['ready', 'copying', 'copied', 'unavailable']);
    assert.equal(Object.isFrozen(capsuleId.CAPSULE_COPY_STATES), true);
    assert.equal(Object.isFrozen(capsuleId.CAPSULE_COPY_BLOCKED_TILES), true);
    assert.equal(Object.isFrozen(capsuleId.capsuleIdModel({ surfaceId: SURFACE })), true);
  });
  test('the seven tile states stay closed (the chip adds no state)', () => {
    assert.deepEqual(tileStates.TILE_STATES, ['connecting', 'live', 'folded', 'human-control', 'agent-acting', 'lost', 'error']);
  });
  test('dom ids use the shared safe segment encoder', () => {
    assert.equal(tileCapture.tileCapsuleIdDomId('Odd Id'), `tile-${tileCapture.tileIdSegment('Odd Id')}-capsule-id`);
    assert.equal(tileCapture.tileCopyIdDomId(SURFACE), `tile-${SURFACE}-copy-id`);
    for (const id of [SURFACE, 'Odd Id', 'x'.repeat(40)]) {
      for (const dom of [tileCapture.tileCapsuleIdDomId(id), tileCapture.tileCopyIdDomId(id)]) assert.match(dom, /^tile-[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
  test('tileCapture re-exports the pure module (the chrome single pure import)', () => {
    for (const name of ['buildCapsuleReadyLine', 'capsuleIdModel', 'copyCapsuleReadyLine', 'createCapsuleCopyFeedback', 'capsuleCopyAvailable']) {
      assert.equal(tileCapture[name], capsuleId[name], name);
    }
  });
});

describe('wall tile id chip and Copy ID for AI', () => {
  test('oracle passes on the real SurfacePanel over the real TileCaptureChrome', async () => {
    const Panel = await compilePanel(PANEL_SOURCE, capsuleId);
    assert.deepEqual(await panelOracle(Panel), []);
    assert.deepEqual(await chromeOracle(await compileChrome(CHROME_SOURCE, capsuleId)), []);
  });
  test('the shipped SurfacePanel still mounts under the legacy closed dependency map', async () => {
    // Existing suites map exactly CapsulePanel, tileStates and TileCaptureChrome.
    const CapsulePanel = await compileSfc('../.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue', {
      '../ui/UiTag.vue': vue.defineComponent({ render: () => null }), '../ui/UiToolbar.vue': vue.defineComponent({ render: () => null }),
    });
    const Chrome = await compileSfc('wall/TileCaptureChrome.vue', {
      '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': KIT_SIDEBAR_ICON,
      '../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue': KIT_RECORD_BUTTON,
      './tileCapture.js': tileCapture,
    });
    const Panel = await compileSfc('wall/SurfacePanel.vue', {
      'capsule-ui-kit/CapsulePanel': CapsulePanel, './tileStates.js': tileStates, './TileCaptureChrome.vue': Chrome,
    });
    const { root, close } = await mountPanel(Panel);
    assert.ok(byId(root, `tile-${SURFACE}-capsule-id`));
    close();
  });
  test('the chip adds no lane control to SurfacePanel and no template v-if', () => {
    const template = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('<template>'));
    assert.doesNotMatch(template, /v-if|<button|tabindex/);
    assert.match(template, /:surface-id=/);
    assert.match(template, /:profile-id=/);
    assert.match(template, /:tile-state="tile\.tile"/);
    assert.match(template, /:clipboard="props\.clipboard"/);
  });
});

describe('mutants are rejected by the oracles', () => {
  const CASES = [
    ['copy writes the bare id instead of the ready line', 'copy',
      (s) => s.replace('await target.writeText(text);', 'await target.writeText(ids.surfaceId);')],
    ['identity grammar not enforced', 'pure',
      (s) => s.replace('return typeof id === \'string\' && CAPSULE_IDENTITY_RE.test(id);', 'return typeof id === \'string\' && id.length > 0;')],
    ['surface id grammar not enforced', 'pure',
      (s) => s.replace('return typeof id === \'string\' && CAPSULE_SURFACE_ID_RE.test(id);', 'return typeof id === \'string\' && id.length > 0;')],
    ['full id missing from the hover', 'pure',
      (s) => s.replace('hover: `Capsule ID: ${id}${identity}`', 'hover: `Capsule ID: ${shortCapsuleId(id)}${identity}`')],
    ['lost tiles can still copy', 'pure',
      (s) => s.replace("CAPSULE_COPY_BLOCKED_TILES = Object.freeze(['lost', 'error'])", 'CAPSULE_COPY_BLOCKED_TILES = Object.freeze([])')],
    ['confirmation never resets', 'feedback',
      (s) => s.replace("if (!disposed && mine === generation) onState('ready', '');", '')],
    ['failure reported as copied', 'feedback',
      (s) => s.replace("const state = outcome?.state === 'copied' ? 'copied' : 'unavailable';", "const state = 'copied';")],
    ['dispose leaves the timer', 'feedback',
      (s) => s.replace('      disposed = true;\n      stopTimer();', '      disposed = true;')],
    ['copy failure swallowed as success', 'copy',
      (s) => s.replace("return { state: 'unavailable', reason: 'ERR_CLIPBOARD_WRITE_REFUSED', text: '' };", "return { state: 'copied', reason: '', text };")],
  ];
  for (const [name, layer, mutate] of CASES) {
    test(`module mutant: ${name}`, async () => {
      assert.notEqual(mutate(CAPSULE_ID_SOURCE), CAPSULE_ID_SOURCE, 'mutation applies');
      const mutant = await loadCapsuleId(mutate);
      const failures = layer === 'pure' ? pureOracle(mutant) : layer === 'copy' ? await copyOracle(mutant) : await feedbackOracle(mutant);
      assert.ok(failures.length > 0, `mutant survived: ${name}`);
    });
  }

  const CHROME_CASES = [
    ['click never copies', (c) => c.replace('void copyFeedback.run(() => copyCapsuleReadyLine(ids, props.clipboard));', '')],
    ['copy ignores the injected clipboard', (c) => c.replace('copyCapsuleReadyLine(ids, props.clipboard)', 'copyCapsuleReadyLine(ids, null)')],
    ['copy never disabled', (c) => c.replace("const copyDisabled = computed(() => !capId.value.canCopy || !copyReachable.value || copyState.value === 'copying');", 'const copyDisabled = computed(() => false);')],
    ['hover title dropped', (c) => c.replace(' :title="capId.hover">{{ capId.text }}', '>{{ capId.text }}')],
    ['accessible name dropped', (c) => c.replace('        :aria-label="capId.copyName"\n', '')],
    ['confirmation always shown', (c) => c.replace('<span v-if="copyStatusText !== \'\'" role="status"', '<span role="status"')],
    ['chip shown in display-only tiles', (c) => c.replace('<div v-if="!props.displayOnly" class="mv-tile-chrome"', '<div class="mv-tile-chrome"')],
    ['wrong id source (profile instead of surface id)', (c) => c.replace('surfaceId: capSurfaceId.value,\n  profileId', 'surfaceId: props.profileId || capSurfaceId.value,\n  profileId')],
    ['button not a button (div)', (c) => c.replace('      <button\n        :id="copyIdDomId"\n        type="button"', '      <div\n        :id="copyIdDomId"').replace('{{ CAPSULE_COPY_LABEL }}</button>', '{{ CAPSULE_COPY_LABEL }}</div>')],
    ['chip falls back to the capsule id without a surface id', (c) => c.replace('const capSurfaceId = computed(() => props.surfaceId);', 'const capSurfaceId = computed(() => props.surfaceId || props.capsuleId);')],
    ['reset timer not cleared on unmount', (c) => c.replace("onBeforeUnmount(() => { copyFeedback.dispose(); });", '')],
  ];
  for (const [name, mutate] of CHROME_CASES) {
    test(`chrome mutant: ${name}`, async () => {
      const source = mutate(CHROME_SOURCE);
      assert.notEqual(source, CHROME_SOURCE, 'mutation applies');
      const Panel = await compilePanel(PANEL_SOURCE, capsuleId, source);
      const failures = [...await panelOracle(Panel), ...await chromeOracle(await compileChrome(source, capsuleId))];
      assert.ok(failures.length > 0, `mutant survived: ${name}`);
    });
  }

  const PANEL_CASES = [
    ['profile identity not forwarded', (c) => c.replace("    :profile-id=\"(row ?? lastRow)?.profile_id ?? ''\"\n", '')],
    ['tile state not forwarded (lost tiles can copy)', (c) => c.replace('    :tile-state="tile.tile"\n', '')],
    ['clipboard not forwarded', (c) => c.replace('    :clipboard="props.clipboard"\n', '')],
  ];
  for (const [name, mutate] of PANEL_CASES) {
    test(`panel mutant: ${name}`, async () => {
      const source = mutate(PANEL_SOURCE);
      assert.notEqual(source, PANEL_SOURCE, 'mutation applies');
      const Panel = await compilePanel(source, capsuleId);
      const failures = await panelOracle(Panel);
      assert.ok(failures.length > 0, `mutant survived: ${name}`);
    });
  }
});
