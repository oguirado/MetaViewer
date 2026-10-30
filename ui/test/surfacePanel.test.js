import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE_URL = new URL('../src/wall/SurfacePanel.vue', import.meta.url);
const source = readFileSync(SOURCE_URL, 'utf8');

/** Extract the dependency-free <script> module block (the one without setup). */
function extractPureModule(text) {
  const blocks = [...text.matchAll(/<script(\s+setup)?>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 2);
  const plain = blocks.filter((match) => !match[1]);
  const setup = blocks.filter((match) => match[1]);
  assert.equal(plain.length, 1);
  assert.equal(setup.length, 1);
  return { pure: plain[0][2], setup: setup[0][2] };
}

const { pure, setup } = extractPureModule(source);
const template = source.slice(source.indexOf('<template>'));

const pureModule = await import(`data:text/javascript;base64,${Buffer.from(pure).toString('base64')}`);

/** Build a minimal valid projection snapshot carrying the given rows. */
function liveSnapshot(rows, overrides = {}) {
  return {
    status: 'live',
    stale: false,
    ramRevision: 7,
    durableRevision: 7,
    envelope: { schema: 'surface/v0.1', epoch: 3, revision: 7, query: 'wall',
      projection: { rows } },
    error: null,
    ...overrides,
  };
}

/** Build a valid panel row for one capsule id. */
function panelRow(id, overrides = {}) {
  return { id, surfaceId: id, backendLifecycle: 'active', generation: 1,
    visibility: 'unfolded', control: 'human', ...overrides };
}

test('pure module block carries zero imports, so the data-URL load is faithful', () => {
  assert.doesNotMatch(pure, /^\s*import\s/m);
  assert.doesNotMatch(pure, /from\s+['"]/m);
  assert.ok(Object.keys(pureModule).length > 0);
});

test('closed panel sets match the ratified enums and are frozen', () => {
  assert.deepEqual(pureModule.BACKEND_LIFECYCLES,
    ['active', 'standby', 'ceded', 'destroyed', 'lost']);
  assert.deepEqual(pureModule.UI_REQUEST_PHASES,
    ['idle', 'creating', 'readiness-error', 'folding', 'unfolding', 'taking-control',
      'releasing-control', 'destroying']);
  assert.deepEqual(pureModule.AI_SESSION_ACTIVITIES,
    ['unknown', 'ready', 'busy', 'waiting-input', 'waiting-permission', 'exited', 'failed']);
  assert.deepEqual(pureModule.ATTACHMENT_STATES,
    ['detached', 'attaching', 'restoring', 'live', 'disconnected']);
  assert.deepEqual(pureModule.DISPATCH_OUTCOMES,
    ['none', 'admitting', 'accepted', 'executing', 'completed-unverified', 'verified',
      'refused', 'uncertain', 'cancelled']);
  assert.deepEqual(pureModule.REFUSAL_CODES,
    ['STALE_FRAME', 'SURFACE_NOT_AGENT_CONTROLLED', 'LOCKED_BY_OTHER', 'BUDGET_EXCEEDED',
      'OUT_OF_BOUNDS', 'POLICY']);
  assert.deepEqual(pureModule.PANEL_ACTIONS,
    ['fold', 'pin', 'control', 'close', 'popout', 'dock-back', 'network']);
  for (const set of [pureModule.BACKEND_LIFECYCLES, pureModule.UI_REQUEST_PHASES,
    pureModule.AI_SESSION_ACTIVITIES, pureModule.ATTACHMENT_STATES,
    pureModule.DISPATCH_OUTCOMES, pureModule.REFUSAL_CODES, pureModule.PANEL_ACTIONS]) {
    assert.equal(Object.isFrozen(set), true);
    assert.throws(() => set.push('mutant'), TypeError);
  }
});

test('status derivation keeps Waiting Live Stale Lost Destroyed Refused distinct', () => {
  const { derivePanelStatus } = pureModule;
  assert.equal(derivePanelStatus(
    { status: 'unavailable', stale: false, envelope: null, error: null }, null), 'Waiting');
  assert.equal(derivePanelStatus(liveSnapshot([panelRow('a1')]), panelRow('a1')), 'Live');
  assert.equal(derivePanelStatus(
    liveSnapshot([panelRow('a1')], { status: 'stale', stale: true }), panelRow('a1')), 'Stale');
  assert.equal(derivePanelStatus(
    liveSnapshot([panelRow('a1', { backendLifecycle: 'lost' })]),
    panelRow('a1', { backendLifecycle: 'lost' })), 'Lost');
  assert.equal(derivePanelStatus(
    liveSnapshot([panelRow('a1', { backendLifecycle: 'destroyed' })]),
    panelRow('a1', { backendLifecycle: 'destroyed' })), 'Destroyed');
  const codes = ['STALE_FRAME', 'SURFACE_NOT_AGENT_CONTROLLED', 'LOCKED_BY_OTHER',
    'BUDGET_EXCEEDED', 'OUT_OF_BOUNDS', 'POLICY'];
  const rendered = new Set();
  for (const code of codes) {
    const status = derivePanelStatus(liveSnapshot([panelRow('a1')]),
      panelRow('a1', { refusal: { code, message: code } }));
    assert.equal(status, `Refused: ${code}`);
    rendered.add(status);
  }
  assert.equal(rendered.size, codes.length);
  assert.equal(derivePanelStatus(
    { status: 'live', stale: false, envelope: {}, error: { code: 'LOCKED_BY_OTHER',
      message: 'x' } }, null), 'Refused: LOCKED_BY_OTHER');
});

test('status negative controls: unknown lifecycle, missing row, backend truth wins', () => {
  const { derivePanelStatus } = pureModule;
  assert.equal(derivePanelStatus(liveSnapshot([]),
    panelRow('a1', { backendLifecycle: 'evaporated' })), 'Waiting');
  assert.equal(derivePanelStatus(liveSnapshot([panelRow('b2')]), null), 'Waiting');
  assert.equal(derivePanelStatus(
    liveSnapshot([panelRow('a1', { backendLifecycle: 'destroyed' })],
      { status: 'stale', stale: true }),
    panelRow('a1', { backendLifecycle: 'destroyed' })), 'Destroyed');
  assert.equal(derivePanelStatus(
    { status: 'live', stale: false, envelope: null, error: null }, panelRow('a1')), 'Waiting');
});

test('row lookup matches exact identity only; cross-surface rows never leak', () => {
  const { findSurfaceRow } = pureModule;
  const snapshot = liveSnapshot([panelRow('a1'), panelRow('a10')]);
  assert.equal(findSurfaceRow(snapshot, 'a1')?.surfaceId, 'a1');
  assert.equal(findSurfaceRow(snapshot, 'a10')?.surfaceId, 'a10');
  assert.equal(findSurfaceRow(snapshot, 'a'), null);
  assert.equal(findSurfaceRow(snapshot, 'b2'), null);
  assert.equal(findSurfaceRow({ status: 'unavailable', envelope: null }, 'a1'), null);
  assert.equal(findSurfaceRow(null, 'a1'), null);
  const tampered = liveSnapshot([{ ...panelRow('a1'), surfaceId: 'b2' }]);
  assert.equal(findSurfaceRow(tampered, 'a1'), null);
});

test('drawable flag admits live lifecycles only; frames lane keeps final say', () => {
  const { isDrawableRow } = pureModule;
  for (const lifecycle of ['active', 'standby', 'ceded']) {
    assert.equal(isDrawableRow(panelRow('a1', { backendLifecycle: lifecycle })), true);
  }
  for (const lifecycle of ['destroyed', 'lost', 'evaporated', undefined, null]) {
    assert.equal(isDrawableRow(panelRow('a1', { backendLifecycle: lifecycle })), false);
  }
  assert.equal(isDrawableRow(null), false);
});

test('surface host stays visible except for terminal destroyed state', () => {
  const { isSurfaceHostVisible } = pureModule;
  assert.equal(isSurfaceHostVisible(null), true);
  assert.equal(isSurfaceHostVisible(panelRow('a1')), true);
  assert.equal(isSurfaceHostVisible(panelRow('a1', { backendLifecycle: 'lost' })), true);
  assert.equal(isSurfaceHostVisible(panelRow('a1', { backendLifecycle: 'destroyed' })), false);
});

test('semantic anchors use the exact capsule id action template', () => {
  const { buildSemanticAnchor } = pureModule;
  for (const action of ['fold', 'pin', 'control', 'close', 'popout', 'dock-back', 'network']) {
    assert.equal(buildSemanticAnchor('a1', action), `capsule/a1/${action}`);
  }
  for (const badId of ['', '   ', 'a 1', ' a1', 'a1 ', '42', 42, null, undefined, {}]) {
    assert.throws(() => buildSemanticAnchor(badId, 'fold'), /capsuleId/);
  }
  for (const badAction of ['', 'FOLD', 'record', 'destroy', 'float', 'hide', 'maximize']) {
    assert.throws(() => buildSemanticAnchor('a1', badAction), /action/);
  }
});

test('popout is registered but unavailable with reason; other actions available', () => {
  const { actionAvailability } = pureModule;
  for (const action of ['fold', 'pin', 'control', 'close', 'dock-back']) {
    assert.deepEqual(actionAvailability(action), { available: true });
  }
  const popout = actionAvailability('popout');
  assert.equal(popout.available, false);
  assert.equal(typeof popout.reason, 'string');
  assert.ok(popout.reason.length > 0);
  assert.equal(Object.isFrozen(popout), true);
  assert.throws(() => actionAvailability('record'), /action/);
});

test('registry boxes round to integer CSS pixels; hidden boxes stay null', () => {
  const { roundControlBox } = pureModule;
  assert.deepEqual(roundControlBox({ x: 10.4, y: 20.6, width: 100.5, height: 50.49 }),
    { x: 10, y: 21, width: 101, height: 50 });
  assert.equal(Object.isFrozen(roundControlBox({ x: 1, y: 2, width: 3, height: 4 })), true);
  assert.equal(roundControlBox(null), null);
  assert.equal(roundControlBox(undefined), null);
  assert.equal(roundControlBox({ x: 1, y: 2, width: 3, height: 4, hidden: true }), null);
  for (const bad of [{ x: Number.NaN, y: 0, width: 1, height: 1 },
    { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 },
    { x: 0, y: 0, width: 1 }, 'box', 7]) {
    assert.equal(roundControlBox(bad), null);
  }
});

test('dependency validation refuses every malformed panel prop with a coded error', () => {
  const { validatePanelDeps } = pureModule;
  const view = { getSnapshot: () => null, subscribe: () => () => {} };
  const builders = { visibility: () => ({}), control: () => ({}), presentation: () => ({}) };
  const valid = { capsuleId: 'a1', presentationInstance: 'panel-a1', projectionView: view,
    intentBuilders: builders, controlRegistry: {}, scheduler: {}, tileScheduler: {} };
  assert.doesNotThrow(() => validatePanelDeps(valid));
  const mutants = [
    [{ ...valid, capsuleId: '' }, /capsuleId/],
    [{ ...valid, capsuleId: 'a 1' }, /capsuleId/],
    [{ ...valid, capsuleId: '42' }, /capsuleId/],
    [{ ...valid, presentationInstance: '' }, /presentationInstance/],
    [{ ...valid, projectionView: null }, /projectionView/],
    [{ ...valid, projectionView: {} }, /projectionView/],
    [{ ...valid, intentBuilders: null }, /intentBuilders/],
    [{ ...valid, intentBuilders: { visibility: () => ({}) } }, /intentBuilders/],
    [{ ...valid, controlRegistry: null }, /controlRegistry/],
    [{ ...valid, scheduler: 'x' }, /scheduler/],
    [{ ...valid, tileScheduler: undefined }, /tileScheduler/],
  ];
  for (const [deps, pattern] of mutants) {
    assert.throws(() => validatePanelDeps(deps), pattern);
    try {
      validatePanelDeps(deps);
      assert.fail('mutant was admitted');
    } catch (error) {
      assert.equal(error.code, 'ERR_PANEL_INVALID_PROP');
    }
  }
});

test('component declares the required props, optionals, and exact emit set', () => {
  for (const name of ['capsuleId', 'projectionView', 'intentBuilders', 'controlRegistry',
    'scheduler', 'tileScheduler', 'presentationInstance']) {
    assert.match(setup, new RegExp(`${name}:[\\s\\S]{0,160}?required:\\s*true`));
  }
  assert.match(setup, /hasKeyboardOwnership:\s*\{[^}]*default:\s*false/);
  assert.match(setup, /title:\s*\{[^}]*default:\s*''/);
  const emits = setup.match(/\bdefineEmits\(\[([\s\S]*?)\]\)/)[1]
    .split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
  assert.deepEqual(emits, ['submit-intent', 'presentation-intent', 'activate-surface']);
});

test('kit panel is wired for one gesture one intent, without the generic emit', () => {
  assert.match(setup, /from 'capsule-ui-kit\/CapsulePanel'/);
  assert.match(template, /<CapsulePanel/);
  assert.match(template, /:external-ai-slot="true"/);
  for (const listener of ['@activate-surface', '@fold-change', '@pin-change',
    '@control-request', '@close-panel', '@dock-back']) {
    assert.ok(template.includes(listener), `missing ${listener}`);
  }
  assert.doesNotMatch(template, /@submit-intent/);
  assert.doesNotMatch(template, /onSubmitIntent/);
  assert.doesNotMatch(template, /:projection-view=/);
  assert.doesNotMatch(template, /:scheduler=/);
  assert.doesNotMatch(template, /:control-registry=/);
});

test('snapshot subscription binds, rebinds on view replacement, unbinds on exit', () => {
  assert.match(setup, /\.subscribe\(/);
  assert.match(setup, /unsubscribe/);
  assert.match(setup, /watch\(/);
  assert.match(setup, /onBeforeUnmount\(\(\) => \{ unbindView\(\); \}\)/);
  assert.match(setup, /uiPhase/);
});

test('surface slot forwards exact identity; host never unmounts', () => {
  assert.match(template, /<template #surface>/);
  assert.match(template, /<slot name="surface"/);
  assert.match(template, /:capsule-id="props\.capsuleId"/);
  assert.match(template, /:surface="row"/);
  assert.match(template, /:drawable="drawable"/);
  // The hidden attribute preserves mounting without CSP-blocked inline styles.
  assert.match(template, /:hidden="!surfaceHostVisible"/);
  assert.doesNotMatch(template, /v-if/);
});

test('dependencies reach children through provides; no imperative API escapes', () => {
  for (const key of ['tileScheduler', 'publicProjectionView', 'presentationScheduler',
    'controlRegistry']) {
    assert.ok(setup.includes(`provide('${key}',`), `missing provide ${key}`);
  }
  assert.doesNotMatch(source, /defineExpose/);
  assert.doesNotMatch(source, /@type \{any\}/);
});
