// MVUI16B lane T (L2-5): the multislot group-header Float (kit AiMultiSlot
// header, id cuk-ai-slot-<id>-float, no disabled prop) must be disabled with
// an accessible reason whenever placement is not allowed: agent control, READ
// mode, hidden slot, or a pending request - exactly like the slot-row Float
// (AiSlotControlBar float-disabled) and the placement section controls.
// Regression: header disabled in all four barrier states; negative controls:
// allowed state stays enabled + submits, and a mutant dropping the DOM sync
// reproduces the live L2-5 failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';
import { compileSfc, flush, nodes, text, SidebarIcon, UiButton } from './mvui2-terminal-mount.mjs';
import { boundedPush, mutatedCompiler } from './mvui16-harness.mjs';
import * as gate from '../src/multislot/multislotInputGate.js';
import * as attach from '../src/multislot/multislotAttach.js';
import * as providers from '../src/multislot/multislotProviders.js';
import * as copy from '../src/multislot/multislotCopy.js';
import * as facade from '../src/terminal/sideTerminalFacade.js';

const ID = 'surface-a';
const headerId = `cuk-ai-slot-${ID}-float`;
const reasonId = `mv-multislot-${ID}-placement-reason`;
const KIT_SLOT_URL = new URL('../.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue', import.meta.url);
const MV_CSS_URL = new URL('../src/multislot/multislot.css', import.meta.url);

/** Renderer element with a working [id="..."] querySelector (the node
 * renderer the host gates through with slotWrap.querySelector). */
function queryableElement(tag) {
  return {
    tag, children: [], props: {},
    setAttribute(key, value) { this.props[key] = value; },
    removeAttribute(key) { delete this.props[key]; },
    getAttribute(key) { return this.props[key] ?? null; },
    hasAttribute(key) { return key in this.props; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
    querySelectorAll(sel) {
      const m = /^\[id="([^"]+)"\]$/.exec(sel);
      assert.ok(m, 'probe selector shape: ' + sel);
      const out = [];
      const walk = (node) => {
        for (const child of node.children ?? []) {
          if (child.props?.id === m[1]) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    },
    addEventListener() {}, removeEventListener() {},
  };
}

/** Faithful kit-header stub: same float id scheme, anchor scheme and submit
 * intent shape as AiMultiSlot (parity pinned against the kit source below). */
function headerFloatStub(captured) {
  return vue.defineComponent({
    inheritAttrs: false,
    props: { capsuleId: { type: String, default: '' }, floating: { type: Boolean, default: false } },
    setup(props, ctx) {
      captured.slot = ctx;
      return () => vue.h('div', { class: 'ai-slot' }, [
        vue.h('header', { class: 'ai-slot__header' }, [
          ...Object.values(ctx.slots).flatMap((slot) => slot?.() ?? []),
          vue.h('button', {
            id: `cuk-ai-slot-${props.capsuleId}-float`,
            type: 'button',
            class: 'ai-slot__action',
            'data-semantic-anchor': `capsule/${props.capsuleId}/ai-slot/${props.floating ? 'dock-back' : 'float'}`,
            'aria-label': props.floating ? 'Dock slot back' : 'Detach slot to float',
            onClick: () => ctx.emit('submit-intent', { type: props.floating ? 'dock-back' : 'float', capsuleId: props.capsuleId }),
          }, props.floating ? 'Dock back' : 'Float'),
        ]),
      ]);
    },
  });
}

/** Control-bar stub capturing the slot-row float gate props for parity. */
function barStub(captured) {
  return vue.defineComponent({
    inheritAttrs: false,
    props: { floatDisabled: { type: Boolean, default: false }, floatReason: { type: String, default: '' } },
    setup(props, ctx) {
      captured.barProps = props;
      captured.bar = ctx;
      return () => vue.h('div');
    },
  });
}

async function mountFloatGate(initial = {}, compile = compileSfc) {
  const captured = {};
  const emitted = [];
  const stub = vue.defineComponent({ setup: () => () => vue.h('div') });
  const Host = await compile('multislot/MultislotHost.vue', {
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
    '@xterm/xterm': { Terminal: class {} },
    '@xterm/addon-fit': { FitAddon: class {} },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
    '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue': headerFloatStub(captured),
    '/.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue': barStub(captured),
    'capsule-ui-kit/TerminalView': { createStreamRegistry: () => ({ createSession() {}, beginAttach() {}, applyRestoreSnapshot() {}, setControlLease() {}, writeOutputChunk() {}, disposeSession() {}, forgetSession() {} }) },
    '../terminal/BrokerLaunchControls.vue': stub,
    '../terminal/sideTerminalFacade.js': facade,
    './multislotInputGate.js': gate,
    './multislotAttach.js': attach,
    './multislotProviders.js': providers,
    './multislotCopy.js': copy,
  });
  const props = vue.reactive({
    capsuleId: ID,
    inputMode: 'write',
    measureSlotBox: () => ({ x: 10, y: 20, width: 300, height: 200 }),
    onSubmitIntent: (...args) => boundedPush(emitted, args),
    ...initial,
  });
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: queryableElement,
    createText: (t) => ({ text: t }),
    createComment: (t) => ({ text: t }),
    insert(node, parent) { node.parent = parent; parent.children.push(node); },
    remove(node) { const list = node.parent?.children; if (list) list.splice(list.indexOf(node), 1); },
    setText(n, t) { n.text = t; },
    setElementText(n, t) { n.text = t; },
    patchProp(n, k, _old, v) { n.props[k] = v; },
    parentNode: (n) => n.parent,
    nextSibling: () => null,
    setScopeId() {},
  });
  const app = renderer.createApp({ setup: () => () => vue.h(Host, props) });
  app.mount(root);
  await flush();
  return { app, props, root, captured, emitted };
}

const headerFloat = (f) => nodes(f.root).find((n) => n.props?.id === headerId);
const reasonNode = (f) => nodes(f.root).find((n) => n.props?.id === reasonId);
const refusalNode = (f) => nodes(f.root).find((n) => n.props?.id === `mv-multislot-${ID}-placement-refusal`);

/** Assert the header float is disabled with the shared accessible reason. */
function assertHeaderGated(f, message, barMessage = message) {
  const button = headerFloat(f);
  assert.ok(button, 'header float renders');
  assert.ok('disabled' in button.props, 'header float disabled');
  assert.equal(button.props['aria-describedby'], reasonId, 'reason referenced');
  assert.ok(text(reasonNode(f)).includes(message), `reason carries: ${message}`);
  assert.equal(f.captured.barProps.floatDisabled, true, 'slot-row float agrees');
  assert.equal(f.captured.barProps.floatReason, barMessage, 'slot-row reason agrees');
}

async function readCase(compile = compileSfc) {
  const f = await mountFloatGate({ inputMode: 'read' }, compile);
  try {
    assertHeaderGated(f, 'Switch to WRITE mode to place this slot.');
    f.captured.slot.emit('submit-intent', { type: 'float', capsuleId: ID });
    await flush();
    assert.equal(f.emitted.length, 0, 'blocked float never emits');
    assert.equal(refusalNode(f)?.props?.['data-error-code'], 'ERR_INPUT_MODE_READ');
  } finally { f.app.unmount(); }
}

test('L2-5: header float disabled in READ mode with the shared reason', () => readCase());

test('L2-5: header float disabled under agent control', async () => {
  const f = await mountFloatGate({ agentControlled: true });
  try {
    assertHeaderGated(f, 'Placement is unavailable while the agent controls this slot.');
    f.captured.slot.emit('submit-intent', { type: 'float', capsuleId: ID });
    await flush();
    assert.equal(f.emitted.length, 0, 'blocked float never emits');
    assert.equal(refusalNode(f)?.props?.['data-error-code'], 'LAYOUT_INPUT_MODE_READ');
  } finally { f.app.unmount(); }
});

test('L2-5: header float disabled while the slot is hidden', async () => {
  const f = await mountFloatGate({ hidden: true });
  try {
    assertHeaderGated(f, 'Show this slot before changing its placement.', 'This placement change is unavailable.');
    f.captured.slot.emit('submit-intent', { type: 'float', capsuleId: ID });
    await flush();
    assert.equal(f.emitted.length, 0, 'blocked float never emits');
  } finally { f.app.unmount(); }
});

test('L2-5: header float disabled while a placement request is pending', async () => {
  const f = await mountFloatGate({ layoutPending: true });
  try {
    assertHeaderGated(f, 'Placement request pending.');
    assert.equal(headerFloat(f).props['aria-busy'], 'true');
    f.captured.slot.emit('submit-intent', { type: 'float', capsuleId: ID });
    await flush();
    assert.equal(f.emitted.length, 0, 'blocked float never emits');
  } finally { f.app.unmount(); }
});

test('L2-5: header float re-gates on mode transitions (no stuck state)', async () => {
  const f = await mountFloatGate({ inputMode: 'write' });
  try {
    assert.ok(!('disabled' in headerFloat(f).props), 'enabled when placement allowed');
    f.props.inputMode = 'read';
    await flush();
    assertHeaderGated(f, 'Switch to WRITE mode to place this slot.');
    f.props.inputMode = 'write';
    await flush();
    assert.ok(!('disabled' in headerFloat(f).props), 'gate releases when allowed again');
  } finally { f.app.unmount(); }
});

test('L2-5 negative control: allowed float stays enabled and submits', async () => {
  const f = await mountFloatGate({ inputMode: 'write' });
  try {
    const button = headerFloat(f);
    assert.ok(button, 'header float renders');
    assert.ok(!('disabled' in button.props), 'enabled when placement allowed');
    assert.equal(f.captured.barProps.floatDisabled, false, 'slot-row float agrees');
    f.captured.slot.emit('submit-intent', { type: 'float', capsuleId: ID });
    await flush();
    assert.equal(f.emitted.length, 1, 'allowed float emits');
    assert.equal(f.emitted[0][0].op, 'float');
    assert.equal(refusalNode(f), undefined, 'no refusal row when allowed');
  } finally { f.app.unmount(); }
});

test('L2-5: stub header mirrors the kit id and anchor scheme', () => {
  const kit = readFileSync(KIT_SLOT_URL, 'utf8');
  assert.ok(kit.includes('float: `cuk-ai-slot-${capsuleId}-float`'), 'kit float id scheme');
  assert.ok(kit.includes('float: `capsule/${capsuleId}/ai-slot/float`'), 'kit float anchor scheme');
  assert.ok(kit.includes(`:id="domIds.float"`), 'kit binds the float id');
});

const dropShellGate = (source) => source.replace(
  `  if (floatAccess.value) button.setAttribute('disabled', ''); else button.removeAttribute('disabled');`,
  `  void floatAccess;`,
);

test('L2-5 negative control: mutant dropping the shell sync reproduces the live failure', async () => {
  const compile = mutatedCompiler('multislot/MultislotHost.vue', dropShellGate);
  const f = await mountFloatGate({ inputMode: 'read' }, compile);
  try {
    assert.ok(!('disabled' in headerFloat(f).props), 'mutant leaves the header float enabled');
    assert.equal(f.captured.barProps.floatDisabled, true, 'slot-row float still gated (the live L2-5 split)');
  } finally { f.app.unmount(); }
  await assert.rejects(readCase(compile), 'READ regression fails on the mutant');
});

/** Pin the renderer-owned disabled presentation of the kit header actions:
 * same muted/no-drop pair as the placement controls, kit tokens only. */
function assertHeaderDisabledRule(cssText) {
  const rule = /\.mv-multislot-host\s+\.ai-slot__action:disabled\s*\{([^}]*)\}/.exec(cssText);
  assert.ok(rule, 'scoped header :disabled rule present');
  assert.match(rule[1], /color:\s*var\(--cuk-semantic-text-muted\)/, 'muted disabled text');
  assert.match(rule[1], /cursor:\s*not-allowed/, 'not-allowed cursor');
}

test('L2-5: kit header actions show the placement-disabled state', () => {
  const cssText = readFileSync(MV_CSS_URL, 'utf8');
  assertHeaderDisabledRule(cssText);
  assert.throws(() => assertHeaderDisabledRule(
    cssText.replace(/\.mv-multislot-host\s+\.ai-slot__action:disabled\s*\{[^}]*\}/, '')),
  'stripped rule fails');
});

test('mvui16b-ui memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16b-ui-float-gate rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
