import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';
import { compileSfc, mountComponent, nodes, flush, text } from './mvui2-terminal-mount.mjs';
import * as tileStates from '../src/wall/tileStates.js';
import * as tileCapture from '../src/wall/tileCapture.js';

// MVUI17 lane W: wall tile Fold visible effect (L2-4). Committed folds must
// hide the kit body (cuk-csp-hidden) with a Folded chip, unfold restores,
// pending shows busy in the tile live-region status row, refusal keeps the
// authoritative state with a typed row. Rows here are live-shaped: a
// visibility string and NO kit `folded` boolean (the fixture harness mirrors
// one; the live authority feed never does). The tile template stays
// byte-identical (shared SFC pins); all change is setup + pure module.

const SOURCE_URL = new URL('../src/wall/SurfacePanel.vue', import.meta.url);
const source = readFileSync(SOURCE_URL, 'utf8');

function extractBlocks(textInput) {
  const blocks = [...textInput.matchAll(/<script(\s+setup)?>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 2);
  const plain = blocks.filter((match) => !match[1]);
  const setup = blocks.filter((match) => match[1]);
  assert.equal(plain.length, 1);
  assert.equal(setup.length, 1);
  return { pure: plain[0][2], setup: setup[0][2] };
}

const { pure, setup } = extractBlocks(source);
const template = source.slice(source.indexOf('<template>'));
const pureModule = await import(`data:text/javascript;base64,${Buffer.from(pure).toString('base64')}`);

// --- pure mirror + pending helpers -----------------------------------------

test('mvui17 wall fold: mirror derives the kit folded boolean from visibility', () => {
  const { mirrorKitFoldedRow } = pureModule;
  assert.equal(typeof mirrorKitFoldedRow, 'function');
  assert.deepEqual(mirrorKitFoldedRow({ visibility: 'folded' }), { visibility: 'folded', folded: true });
  assert.deepEqual(mirrorKitFoldedRow({ visibility: 'unfolded' }), { visibility: 'unfolded', folded: false });
  assert.deepEqual(mirrorKitFoldedRow({ visibility: 'pinned' }), { visibility: 'pinned', folded: false });
  assert.deepEqual(mirrorKitFoldedRow({}), { folded: false });
  assert.equal(mirrorKitFoldedRow(null), null);
  assert.equal(mirrorKitFoldedRow(undefined), undefined);
  assert.equal(mirrorKitFoldedRow('folded'), 'folded');
});

test('mvui17 wall fold: mirror never mutates and preserves correct rows by reference', () => {
  const { mirrorKitFoldedRow, mirrorKitFoldedSnapshot } = pureModule;
  const liveShaped = Object.freeze({ id: 'a1', surfaceId: 'a1', visibility: 'unfolded' });
  const mirrored = mirrorKitFoldedRow(liveShaped);
  assert.equal(liveShaped.folded, undefined);
  assert.equal(mirrored.folded, false);
  const fixtureShaped = Object.freeze({ id: 'a1', surfaceId: 'a1', visibility: 'folded', folded: true });
  assert.equal(mirrorKitFoldedRow(fixtureShaped), fixtureShaped);
  assert.equal(mirrorKitFoldedSnapshot(null), null);
  const bare = { status: 'unavailable', stale: true, envelope: null, error: null };
  assert.equal(mirrorKitFoldedSnapshot(bare), bare);
  const snapshot = Object.freeze({ status: 'live', stale: false,
    envelope: Object.freeze({ schema: 's', epoch: 1, revision: 1, query: 'q',
      projection: Object.freeze({ rows: [liveShaped, fixtureShaped] }) }),
    error: null });
  const next = mirrorKitFoldedSnapshot(snapshot);
  assert.notEqual(next, snapshot);
  assert.equal(next.envelope.projection.rows[0].folded, false);
  assert.equal(next.envelope.projection.rows[1], fixtureShaped);
  const clean = { status: 'live', stale: false,
    envelope: { schema: 's', epoch: 1, revision: 1, query: 'q', projection: { rows: [fixtureShaped] } },
    error: null };
  assert.equal(mirrorKitFoldedSnapshot(clean), clean);
});

test('mvui17 wall fold: pending labels and live-axis gate matrix', () => {
  const { foldPendingStatus, isLiveAxisTileState } = pureModule;
  assert.equal(typeof foldPendingStatus, 'function');
  assert.equal(typeof isLiveAxisTileState, 'function');
  assert.equal(foldPendingStatus('folding'), 'Folding');
  assert.equal(foldPendingStatus('unfolding'), 'Unfolding');
  for (const phase of ['idle', 'taking-control', 'releasing-control', '', null, undefined, 7]) {
    assert.equal(foldPendingStatus(phase), '');
  }
  for (const state of ['live', 'folded', 'human-control', 'agent-acting']) {
    assert.equal(isLiveAxisTileState(state), true, state);
  }
  for (const state of ['connecting', 'lost', 'error', '', null, undefined]) {
    assert.equal(isLiveAxisTileState(state), false, String(state));
  }
});

// --- wiring pins (source text) -----------------------------------------------

test('mvui17 wall fold: kit view is provided through the visibility mirror', () => {
  assert.match(setup, /provide\('publicProjectionView', kitProjectionView\)/);
  assert.match(setup, /mirrorKitFoldedSnapshot\(/);
  assert.doesNotMatch(setup, /provide\('publicProjectionView', props\.projectionView\)/);
});

test('mvui17 wall fold: pending busy and refusal reset are wired; template untouched', () => {
  assert.match(setup, /foldPendingStatus\(uiPhase\.value\)/);
  assert.match(setup, /if \(foldPending\.value !== ''\) return foldPending\.value;/);
  assert.match(setup, /refusal\?\.code/);
  assert.match(setup, /snapshot\.value\?\.status/);
  assert.match(setup, /snapshot\.value\?\.error\?\.code/);
  assert.match(setup, /isLiveAxisTileState\(tile\.value\.tile\)/);
  assert.match(template, /<div class="mv-tile" :data-tile-state="tile\.tile" :data-error-code="row\?\.refusal\?\.code \?\? snapshot\?\.error\?\.code">/);
  assert.ok(template.includes(":presentation-status=\"tile.tile === 'error' ? 'Surface update unavailable' : tile.status\""));
  assert.doesNotMatch(template, /v-if/);
});

// --- mounted behaviour (real kit panel + SurfacePanel, live-shaped rows) -----

const Chrome = vue.defineComponent({ props: ['label'], setup: (p, c) => () => vue.h('div', {},
  [p.label, ...Object.values(c.slots).flatMap((slot) => slot?.() ?? [])]) });
const CapsulePanel = await compileSfc('../.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue', {
  '../ui/UiTag.vue': Chrome, '../ui/UiToolbar.vue': Chrome,
});
const SidebarIcon = await compileSfc('../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue', {});
const SaasRecordButton = await compileSfc('../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue', {});
const TileCaptureChrome = await compileSfc('wall/TileCaptureChrome.vue', {
  '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
  '../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue': SaasRecordButton,
  './tileCapture.js': tileCapture,
});
const SurfacePanel = await compileSfc('wall/SurfacePanel.vue', {
  'capsule-ui-kit/CapsulePanel': CapsulePanel, './tileStates.js': tileStates,
  './TileCaptureChrome.vue': TileCaptureChrome,
});

const CAPSULE = 'live-1';

function liveRow(overrides = {}) {
  return { id: CAPSULE, surfaceId: CAPSULE, title: `Capsule ${CAPSULE}`, display: ':100', profile_id: '',
    generation: 1, backendLifecycle: 'active', visibility: 'unfolded', control: 'shared',
    controlOwner: 'none', attachmentState: 'live', ...overrides };
}

function liveSnapshot(rows, overrides = {}) {
  return { status: 'live', stale: false,
    envelope: { schema: 'metaviewer.frame-wall/v1', epoch: 1, revision: 7, query: 'authority.frames',
      projection: { rows } },
    error: null, ...overrides };
}

function harness(initialRows) {
  let snapshot = liveSnapshot(initialRows);
  const listeners = new Set();
  const view = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const intents = [];
  const builders = {
    visibility: (input) => { intents.push(['visibility', { ...input }]); return Object.freeze({ op: input.verb, surfaceId: input.capsuleId }); },
    control: (input) => { intents.push(['control', { ...input }]); return Object.freeze({ op: input.verb, surfaceId: input.capsuleId }); },
    presentation: (input) => { intents.push(['presentation', { ...input }]); return Object.freeze({ type: input.verb, capsuleId: input.capsuleId }); },
  };
  const schedulerCalls = [];
  const fakeTileScheduler = {
    foldSurface: (id) => { schedulerCalls.push(['fold', id]); },
    unfoldSurface: (id) => { schedulerCalls.push(['unfold', id]); },
    getInstrumentation: () => null,
    subscribePresentation: () => () => {},
  };
  const submitted = [];
  const mounted = mountComponent(SurfacePanel, {
    capsuleId: CAPSULE, title: `Capsule ${CAPSULE}`, projectionView: view, intentBuilders: builders,
    controlRegistry: {}, scheduler: {}, tileScheduler: fakeTileScheduler,
    presentationInstance: `panel-${CAPSULE}`,
    onSubmitIntent: (body) => { submitted.push(body); },
  });
  return {
    mounted, intents, submitted, schedulerCalls,
    emit(rows, overrides) { snapshot = liveSnapshot(rows, overrides); for (const listener of [...listeners]) listener(snapshot); },
    close() { mounted.app.unmount(); },
  };
}

const tileOf = (root) => nodes(root).find((n) => n.props?.['data-tile-state']);
const chipOf = (tile) => nodes(tile).find((n) => n.props?.class === 'cuk-capsule-panel__chip');
const bodyOf = (tile) => nodes(tile).find((n) => n.props?.['data-permanent-host']);
const foldButtonOf = (root) => nodes(root).find((n) => n.props?.['data-semantic-anchor'] === `capsule/${CAPSULE}/fold`);
const statusRowOf = (tile) => nodes(tile).find((n) => n.props?.class === 'mv-tile-status');
const bodyHidden = (tile) => String(bodyOf(tile).props.class).split(/\s+/).includes('cuk-csp-hidden');

test('mvui17 wall fold: committed fold hides the kit body with a Folded chip', async () => {
  const f = harness([liveRow()]);
  try {
    await flush();
    assert.equal(tileOf(f.mounted.root).props['data-tile-state'], 'live');
    assert.match(text(chipOf(tileOf(f.mounted.root))), /Live/);
    assert.equal(bodyHidden(tileOf(f.mounted.root)), false);
    assert.equal(statusRowOf(tileOf(f.mounted.root)).props.hidden, true);
    f.emit([{ ...liveRow(), generation: 2, visibility: 'folded' }]);
    await flush();
    const tile = tileOf(f.mounted.root);
    assert.equal(tile.props['data-tile-state'], 'folded');
    assert.match(text(chipOf(tile)), /Folded/);
    assert.equal(bodyHidden(tile), true);
    assert.equal(statusRowOf(tile).props.hidden, true);
    assert.ok(f.schedulerCalls.some(([op, id]) => op === 'fold' && id === CAPSULE));
  } finally { f.close(); }
});

test('mvui17 wall fold: unfold echo restores the tile', async () => {
  const f = harness([{ ...liveRow(), visibility: 'folded' }]);
  try {
    await flush();
    assert.equal(bodyHidden(tileOf(f.mounted.root)), true);
    f.emit([{ ...liveRow(), generation: 2, visibility: 'unfolded' }]);
    await flush();
    const tile = tileOf(f.mounted.root);
    assert.equal(tile.props['data-tile-state'], 'live');
    assert.match(text(chipOf(tile)), /Live/);
    assert.equal(bodyHidden(tile), false);
    assert.equal(statusRowOf(tile).props.hidden, true);
  } finally { f.close(); }
});

test('mvui17 wall fold: pending fold shows busy until the authority moves', async () => {
  const f = harness([liveRow()]);
  try {
    await flush();
    const button = foldButtonOf(f.mounted.root);
    assert.ok(button);
    assert.equal(button.props.disabled, false);
    button.props.onClick();
    await flush();
    assert.deepEqual(f.intents, [['visibility', { capsuleId: CAPSULE, verb: 'fold' }]]);
    assert.equal(f.submitted.length, 1);
    // A live frame notice re-syncs the kit to the still-unfolded authority row;
    // pending busy must survive that churn (values, not identities, settle it).
    f.emit([{ ...liveRow(), generation: 2 }]);
    await flush();
    const tile = tileOf(f.mounted.root);
    assert.equal(tile.props['data-tile-state'], 'live');
    assert.match(text(chipOf(tile)), /Live/);
    const busy = statusRowOf(tile);
    assert.equal(busy.props.hidden, false);
    assert.equal(busy.props.role, 'status');
    assert.match(text(busy), /Folding/);
    assert.equal(bodyHidden(tile), false);
    assert.ok(!f.schedulerCalls.some(([op]) => op === 'fold'), 'pending never folds capture');
    // The committed echo clears busy and folds the tile.
    f.emit([{ ...liveRow(), generation: 3, visibility: 'folded' }]);
    await flush();
    const folded = tileOf(f.mounted.root);
    assert.match(text(chipOf(folded)), /Folded/);
    assert.equal(statusRowOf(folded).props.hidden, true);
    assert.equal(bodyHidden(folded), true);
  } finally { f.close(); }
});

test('mvui17 wall fold: refusal keeps the authoritative state with a typed row', async () => {
  const f = harness([liveRow()]);
  try {
    await flush();
    foldButtonOf(f.mounted.root).props.onClick();
    f.emit([{ ...liveRow(), generation: 2 }]);
    await flush();
    const busy = statusRowOf(tileOf(f.mounted.root));
    assert.equal(busy.props.hidden, false);
    assert.match(text(busy), /Folding/);
    f.emit([{ ...liveRow(), generation: 2, refusal: { code: 'POLICY', message: 'denied' } }]);
    await flush();
    const tile = tileOf(f.mounted.root);
    assert.equal(tile.props['data-tile-state'], 'error');
    assert.match(text(chipOf(tile)), /Surface update unavailable/);
    assert.equal(tile.props['data-error-code'], 'POLICY');
    const row = statusRowOf(tile);
    assert.equal(row.props.hidden, false);
    assert.match(text(row), /Surface update unavailable/);
    assert.doesNotMatch(text(row), /Folding/);
    assert.equal(bodyHidden(tile), false);
  } finally { f.close(); }
});

test('mvui17 wall fold negative control: unrelated notices never arm busy or fold', async () => {
  const f = harness([liveRow()]);
  try {
    await flush();
    f.emit([{ ...liveRow(), generation: 2 }]);
    f.emit([{ ...liveRow(), generation: 3 }]);
    f.emit([{ ...liveRow(), generation: 4 }]);
    await flush();
    const tile = tileOf(f.mounted.root);
    assert.equal(tile.props['data-tile-state'], 'live');
    assert.match(text(chipOf(tile)), /Live/);
    assert.equal(statusRowOf(tile).props.hidden, true);
    assert.equal(bodyHidden(tile), false);
    assert.deepEqual(f.intents, []);
    assert.ok(!f.schedulerCalls.some(([op]) => op === 'fold'));
  } finally { f.close(); }
});

test('mvui17 wall fold negative control: error-tile gesture emits but never arms busy', async () => {
  const f = harness([{ ...liveRow(), refusal: { code: 'POLICY', message: 'denied' } }]);
  try {
    await flush();
    assert.equal(tileOf(f.mounted.root).props['data-tile-state'], 'error');
    const button = foldButtonOf(f.mounted.root);
    assert.ok(button);
    assert.equal(button.props.disabled, false);
    button.props.onClick();
    await flush();
    assert.deepEqual(f.intents, [['visibility', { capsuleId: CAPSULE, verb: 'fold' }]]);
    const tile = tileOf(f.mounted.root);
    const row = statusRowOf(tile);
    assert.equal(row.props.hidden, false);
    assert.match(text(row), /Surface update unavailable/);
    assert.doesNotMatch(text(row), /Folding/);
  } finally { f.close(); }
});

test('mvui17 wall fold: rss stays bounded', () => {
  const rss = process.memoryUsage.rss();
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
