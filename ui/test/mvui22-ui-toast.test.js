// MVUI22 lane T: the take/release outcome toast stays visible for ~4 s.
// Regression (live7): the outcome state persisted but the toast painted at
// z-index 5, below every kit overlay layer, so wall/multislot overlays
// covered it. The App-level `#shell-wall #mv-host-outcome` override now wins
// the cascade at the overlay token while keeping pointer-events none and the
// out-of-flow corner placement that clears interactive rows.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { tick, until } from './frame-wait.mjs';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { createAuthorityAdapter } from '../src/core/hostAdapters.js';

const APP_URL = new URL('../src/App.vue', import.meta.url);
const OUTCOME_URL = new URL('../src/core/HostOutcome.vue', import.meta.url);
const THEME_URL = new URL('../.kit/capsule-ui-kit/src/design/theme.css', import.meta.url);
const HOST_ADAPTERS_URL = new URL('../src/core/hostAdapters.js', import.meta.url);
const APP_SOURCE = readFileSync(APP_URL, 'utf8');
const OUTCOME_SOURCE = readFileSync(OUTCOME_URL, 'utf8');
const THEME_SOURCE = readFileSync(THEME_URL, 'utf8');
const ID = 'surface-a';
const DISMISS_MS = 4000;
const TOAST_BASE = '#mv-host-outcome';
const TOAST_OVERRIDE = '#shell-wall #mv-host-outcome';
// Exact archived pre-fix App override (pointer-events only, no z-index).
const PREFIX_OVERRIDE_STYLES = '#shell-wall #mv-host-outcome { pointer-events:none; }';

const styleBlocks = (source) => [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ruleBody(styles, selector) {
  const match = styles.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, 's'));
  assert.ok(match, `rule ${selector} exists`);
  return match[1];
}

function declValue(body, property) {
  const match = body.match(new RegExp(`(?:^|;)\\s*${escapeRegExp(property)}\\s*:\\s*([^;]+)`, 'm'));
  return match ? match[1].trim() : null;
}

/** Specificity as [ids, classes/attrs, elements]; higher wins. */
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+/g) ?? []).length + (selector.match(/\[[^\]]+\]/g) ?? []).length;
  const elements = selector.split(/[\s>+~]+/).filter(part => /^[a-zA-Z][\w-]*/.test(part)).length;
  return [ids, classes, elements];
}

function compareSpecificity(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Resolve a kit token to a px/z number, following first-match var() chains. */
function resolveToken(name, depth = 0) {
  assert.ok(depth < 8, 'token chain is bounded');
  const match = THEME_SOURCE.match(new RegExp(`${escapeRegExp(name)}\\s*:\\s*([^;]+);`));
  assert.ok(match, `kit token ${name} exists`);
  const value = match[1].trim();
  const ref = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (ref) return resolveToken(ref[1], depth + 1);
  return Number(value.replace(/px$/, ''));
}

/** Winning declarations for the toast across the base + App override. */
function winningToastDecls(appStyles = styleBlocks(APP_SOURCE)) {
  const baseBody = ruleBody(styleBlocks(OUTCOME_SOURCE), TOAST_BASE);
  const overrideBody = ruleBody(appStyles, TOAST_OVERRIDE);
  // The base rule is scoped (`#mv-host-outcome[data-v-…]`); the App override
  // still outranks it on ID count (2 vs 1).
  const order = compareSpecificity(specificity(TOAST_OVERRIDE), specificity(`${TOAST_BASE}[data-v-scoped]`));
  assert.ok(order > 0, 'App override outranks the scoped base rule');
  const get = (property) => {
    const fromOverride = declValue(overrideBody, property);
    if (fromOverride !== null) return { value: fromOverride, from: 'override' };
    return { value: declValue(baseBody, property), from: 'base' };
  };
  return { get };
}

function winningToastZ(appStyles = styleBlocks(APP_SOURCE)) {
  const found = winningToastDecls(appStyles).get('z-index');
  assert.ok(found.value, 'a z-index wins the cascade');
  const ref = found.value.match(/--[\w-]+/);
  return ref ? resolveToken(ref[0]) : Number(found.value);
}

/** True when a same-context overlay at overlayZ would paint over the toast. */
function toastCoveredBy(appStyles, overlayZ) {
  return winningToastZ(appStyles) < overlayZ;
}

describe('mvui22 toast cascade (lane T)', () => {
  test('App override hoists the toast to the overlay token, rows stay clickable', () => {
    const winning = winningToastDecls();
    const z = winning.get('z-index');
    assert.equal(z.from, 'override', 'z-index comes from the App override');
    assert.equal(z.value, 'var(--cuk-semantic-z-index-overlay)', 'z rides the kit overlay token');
    assert.equal(winning.get('pointer-events').value, 'none', 'clicks pass through to rows');
    assert.equal(winning.get('position').value, 'absolute', 'toast stays out of flow');
    assert.ok(winning.get('bottom').value, 'bottom corner offset survives');
    assert.ok(winning.get('left').value, 'left corner offset survives');
  });

  test('toast paints at/above the overlay layer, clear of every lower kit layer', () => {
    const toastZ = winningToastZ();
    assert.equal(toastZ, resolveToken('--cuk-semantic-z-index-overlay'), 'toast z resolves to the overlay token');
    for (const layer of ['--cuk-semantic-z-index-drawer', '--cuk-semantic-z-index-floating',
      '--cuk-semantic-z-index-sticky', '--cuk-semantic-z-index-panel', '--cuk-semantic-z-index-base']) {
      assert.ok(toastZ >= resolveToken(layer), `toast z ${toastZ} clears ${layer} ${resolveToken(layer)}`);
    }
    assert.ok(toastZ > 5, 'toast clears the legacy base z');
    assert.equal(toastCoveredBy(styleBlocks(APP_SOURCE), resolveToken('--cuk-semantic-z-index-drawer')), false,
      'fixed toast clears a drawer-layer overlay');
  });

  test('negative control: the pre-fix override leaves the toast under a drawer-layer overlay', () => {
    const drawerZ = resolveToken('--cuk-semantic-z-index-drawer');
    assert.equal(winningToastZ(PREFIX_OVERRIDE_STYLES), 5, 'pre-fix cascade falls back to the base z');
    assert.equal(toastCoveredBy(PREFIX_OVERRIDE_STYLES, drawerZ), true, 'z5 hides under a drawer-layer overlay');
    const missing = winningToastDecls('#shell-wall #mv-host-outcome { color: red; }');
    assert.equal(missing.get('z-index').value, '5', 'missing z override falls back to the base z');
    assert.equal(toastCoveredBy('#shell-wall #mv-host-outcome { color: red; }', drawerZ), true, 'missing z override stays covered');
  });
});

function renderer() {
  return vue.createRenderer({
    createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
    insert(child, parent, anchor) { if (child.parent) this.remove(child); child.parent = parent; const i = parent.children.indexOf(anchor); parent.children.splice(i < 0 ? parent.children.length : i, 0, child); },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, _old, value) { node.props[key] = value; }, querySelector: () => null, setScopeId() {},
  });
}

function allNodes(root) {
  const out = [];
  const visit = (node) => { out.push(node); for (const child of node.children ?? []) visit(child); };
  visit(root);
  return out;
}

let cachedOutcome = null;
async function loadOutcome() {
  if (cachedOutcome) return cachedOutcome;
  const { descriptor } = parse(OUTCOME_SOURCE);
  const compiled = compileScript(descriptor, { id: 'mvui22-outcome', inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    if (specifier === './hostAdapters.js') return all.replace(/(['"])\.\/hostAdapters\.js\1/, JSON.stringify(HOST_ADAPTERS_URL.href));
    throw new Error(`unexpected HostOutcome import ${specifier}`);
  });
  cachedOutcome = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui22-outcome`)).default;
  return cachedOutcome;
}

/** Mount the real HostOutcome; null when v-if renders nothing. */
async function mountOutcome(row) {
  const Outcome = await loadOutcome();
  const root = { children: [] };
  const handle = renderer().createApp(Outcome, { row });
  handle.mount(root);
  await tick();
  await vue.nextTick();
  const nodes = allNodes(root);
  const node = nodes.find(candidate => candidate.props?.id === 'mv-host-outcome') ?? null;
  const text = nodes.map(candidate => candidate.text).filter(text => typeof text === 'string').join('');
  handle.unmount();
  return node ? { node, text } : null;
}

let appSerial = 0;
async function loadApp(captured) {
  const stub = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
  const strip = vue.defineComponent({ props: ['entries'],
    setup: props => { captured.stripEntries = () => props.entries; return () => vue.h('section', { id: 'test-activity' }); } });
  const outcome = vue.defineComponent({ props: ['row'],
    setup: props => { captured.outcome = () => props.row; return () => vue.h('p', { id: 'test-outcome' }); } });
  const slot = vue.defineComponent({ setup: (_, ctx) => { captured.slot = ctx; return () => vue.h('section'); } });
  const wall = vue.defineComponent({ setup: (_, ctx) => {
    captured.wall = ctx;
    ctx.expose({ applyLayoutEcho: () => undefined });
    return () => vue.h('div');
  } });
  globalThis.__mvui22toastdeps = {
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': outcome,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': slot,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': strip,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wall,
    './surfaces/SurfaceCanvas.vue': stub,
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const { descriptor } = parse(readFileSync(APP_URL, 'utf8'));
  const compiled = compileScript(descriptor, { id: `mvui22-toast-${++appSerial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__mvui22toastdeps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#t-${appSerial}`)).default;
}

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

/** Selective timer double: captures only the dismissal delay, delegates the rest. */
function installTimerDouble() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let timerSerial = 1000;
  const timers = new Map();
  globalThis.setTimeout = (callback, ms, ...rest) => {
    if (ms !== DISMISS_MS) return realSetTimeout(callback, ms, ...rest);
    const id = ++timerSerial;
    timers.set(id, { callback, cleared: false });
    return /** @type {any} */ (id);
  };
  globalThis.clearTimeout = (id) => {
    if (timers.has(id)) { timers.get(id).cleared = true; return; }
    return realClearTimeout(id);
  };
  return {
    timers,
    armed: () => [...timers].filter(([, timer]) => !timer.cleared).map(([id]) => id),
    fire(id) { const timer = timers.get(id); if (timer && !timer.cleared) timer.callback(); },
    restore() { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; },
  };
}

async function mountToast() {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const captured = {};
  const calls = [];
  const authorityHost = createAuthorityAdapter({
    intent: (json) => { const wait = deferred(); calls.push({ json, ...wait }); return wait.promise; },
    propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
  });
  const App = await loadApp(captured);
  const root = { children: [] };
  const appHandle = renderer().createApp(App, {
    authorityHost,
    runtime: { projectionView: { getSnapshot: () => ({ envelope: null }),
      getProjection: () => ({ rows: [{ id: ID, generation: 1, visibility: 'unfolded', control: 'human', backendLifecycle: 'active' }] }),
      subscribe: () => () => {} } },
    layout: {}, scope: {}, fixture: { key: 'multislot', ui: {}, capsules: [{ id: ID }] },
    nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
  });
  appHandle.mount(root);
  await tick();
  await vue.nextTick();
  return {
    captured, calls,
    feed: () => captured.stripEntries(),
    close() { appHandle.unmount(); globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__mvui22toastdeps; },
  };
}

const wallTake = id => ({ schema: 'ui_intent/v0.2', request_id: `mvui22-toast-${id}`, op: 'take_control', params: { surface_id: ID } });

describe('mvui22 toast mount and dismiss (lane T)', () => {
  test('ack renders a visible toast per the cascade and dismisses after 4 s', async () => {
    const clock = installTimerDouble();
    const f = await mountToast();
    try {
      f.captured.wall.emit('submit-intent', wallTake(1));
      await tick();
      await vue.nextTick();
      f.calls.at(-1).resolve(true);
      await until(() => f.captured.outcome()?.code === 'INTENT_ACKNOWLEDGED', 'ack toast');
      await vue.nextTick();
      assert.equal(f.feed().length, 1, 'ack records once in the feed');
      const toast = await mountOutcome(f.captured.outcome());
      assert.ok(toast, 'ack outcome renders the toast node');
      assert.equal(toast.node.props.id, 'mv-host-outcome');
      assert.equal(toast.node.props.role, 'status', 'ack toast announces as a status');
      assert.equal(toast.node.props['data-outcome-code'], 'INTENT_ACKNOWLEDGED');
      assert.match(toast.text, /Request sent\./, 'toast carries the ack copy');
      assert.ok(!('hidden' in toast.node.props), 'toast carries no hidden attribute');
      const winning = winningToastDecls();
      for (const [property, hidden] of [['display', /^(none)$/], ['visibility', /^(hidden|collapse)$/], ['opacity', /^0(\.0+)?$/]]) {
        const value = winning.get(property).value;
        assert.ok(value === null || !hidden.test(value), `cascade keeps the toast displayed (${property})`);
      }
      assert.ok(winningToastZ() >= resolveToken('--cuk-semantic-z-index-overlay'), 'toast z reaches the overlay layer');
      const armed = clock.armed();
      assert.equal(armed.length, 1, 'one dismissal timer is armed');
      clock.fire(armed[0]);
      await until(() => f.captured.outcome() === null, 'toast dismiss');
      await vue.nextTick();
      assert.equal(f.feed().length, 1, 'dismissal invents no row');
    } finally { f.close(); clock.restore(); }
  });

  test('negative control: no outcome renders no toast; refusals alert', async () => {
    assert.equal(await mountOutcome(null), null, 'no toast without an outcome');
    const refusal = await mountOutcome({ code: 'HOST_REQUEST_REFUSED', message: 'This request is unavailable. Please try again.', tone: 'refusal' });
    assert.ok(refusal, 'refusal renders the toast node');
    assert.equal(refusal.node.props.role, 'alert', 'refusal toast announces as an alert');
    assert.equal(refusal.node.props['data-outcome-code'], 'HOST_REQUEST_REFUSED');
  });
});

const rectsDisjoint = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
// Bounded layout doubles: representative main + toast + recording-row boxes.
const MAIN_BOX = Object.freeze({ x: 0, y: 0, width: 1280, height: 720 });
const TOAST_BOX = Object.freeze({ width: 320, height: 48 });
const ROW_BOX = Object.freeze({ height: 48, pitch: 56 });

/** Toast box from the winning corner offsets (bottom-left, kit spacing margins). */
function toastBox(appStyles = styleBlocks(APP_SOURCE)) {
  const winning = winningToastDecls(appStyles);
  assert.equal(winning.get('position').value, 'absolute', 'toast stays out of flow');
  const margin = (property) => {
    const ref = (winning.get(property).value ?? '').match(/--[\w-]+/);
    assert.ok(ref, `corner offset ${property} rides a kit token`);
    return resolveToken(ref[0]);
  };
  const left = margin('left');
  const bottom = margin('bottom');
  const top = MAIN_BOX.height - bottom - TOAST_BOX.height;
  return { left, top, right: left + TOAST_BOX.width, bottom: top + TOAST_BOX.height };
}

/** In-flow rows stack from the top; an in-flow toast would push them down. */
function recordRows(count, toastPosition) {
  const top = toastPosition === 'absolute' || toastPosition === 'fixed' ? 0 : TOAST_BOX.height;
  return Array.from({ length: count }, (_, i) => {
    const y = top + i * ROW_BOX.pitch;
    return { left: 0, top: y, right: MAIN_BOX.width, bottom: y + ROW_BOX.height };
  });
}

function assertRowsClear(appStyles, count) {
  const box = toastBox(appStyles);
  for (const [index, row] of recordRows(count, 'absolute').entries()) {
    assert.ok(rectsDisjoint(box, row), `toast clears row ${index}`);
  }
}

describe('mvui22 toast never covers rows (lane T)', () => {
  test('toast corner box is disjoint from interactive rows and moves nothing', () => {
    const winning = winningToastDecls();
    assert.equal(winning.get('pointer-events').value, 'none', 'clicks pass through to rows beneath');
    const box = toastBox();
    assert.ok(box.left >= 0 && box.top >= 0 && box.right <= MAIN_BOX.width && box.bottom <= MAIN_BOX.height,
      'toast sits inside the wall main');
    assertRowsClear(styleBlocks(APP_SOURCE), 2);
    assert.deepEqual(recordRows(2, winning.get('position').value), recordRows(2, 'fixed'),
      'out-of-flow toast moves no row');
  });

  test('negative control: planted covering variants fail the predicates', () => {
    assert.throws(() => toastBox('#shell-wall #mv-host-outcome { position: static; pointer-events: none; }'),
      assert.AssertionError, 'in-flow toast fails the placement predicate');
    assert.throws(() => assert.equal(
      winningToastDecls('#shell-wall #mv-host-outcome { pointer-events: auto; z-index: var(--cuk-semantic-z-index-overlay); }').get('pointer-events').value,
      'none'), assert.AssertionError, 'intercepting toast fails click-through');
    assert.throws(() => assertRowsClear(styleBlocks(APP_SOURCE), 13),
      assert.AssertionError, 'a main-full row list reaches the toast corner');
  });
});

test('mvui22 toast: rss stays bounded', () => {
  const rss = process.memoryUsage.rss();
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
