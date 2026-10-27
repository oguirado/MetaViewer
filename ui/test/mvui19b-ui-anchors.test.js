/** MVUI19B lane U: grammar-valid anchor segments for host provider ids.
 * BrokerLaunchControls embeds host provider ids (PROVIDER_ID_RE, up to 128
 * chars, non-alnum leaders legal) into `data-semantic-anchor` segments (max
 * 64 chars, alnum-led), so long or oddly-led ids produced anchors the QA
 * collector drops. The control now derives the segment: ids that already fit
 * pass through byte-identical, others map to a deterministic
 * lead-plus-rest-plus-fnv1a32 segment. DOM ids keep the raw id. Fails before
 * the fix (raw ids embedded); negative controls prove the collector drops
 * raw adversarial anchors while a valid witness survives.
 * @module mvui19b-ui-anchors.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';
import { compileSfc, SidebarIcon, flush, mountComponent, nodes } from './mvui2-terminal-mount.mjs';
import { collectQaAnchors } from '../src/qa/anchorCollector.js';
import { PROVIDER_ID_RE, normalizeProviders } from '../src/terminal/providers.js';
import { toKitMenuProviders } from '../src/multislot/multislotProviders.js';

const CONTROLS_URL = new URL('../src/terminal/BrokerLaunchControls.vue', import.meta.url);
const HOST_URL = new URL('../src/multislot/MultislotHost.vue', import.meta.url);
const FACADE_URL = new URL('../src/terminal/sideTerminalFacade.js', import.meta.url);
const controlsSrc = readFileSync(CONTROLS_URL, 'utf8');
const hostSrc = readFileSync(HOST_URL, 'utf8');
const facadeSrc = readFileSync(FACADE_URL, 'utf8');

// Anchor segment grammar v2 (mirrors qa/anchorCollector SEGMENT, pinned by
// mvui17-qa-grammar): alnum-led token of at most 64 chars.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

// Host provider ids: every entry satisfies the closed provider grammar while
// the adversarial ones violate the anchor segment grammar (length or leader).
const LONG_A = `${'n'.repeat(60)}A${'z'.repeat(67)}`;
const LONG_B = `${'n'.repeat(60)}B${'z'.repeat(67)}`;
assert.equal(LONG_A.length, 128);
assert.equal(LONG_B.length, 128);
const VALID_IDS = ['my-provider_1', 'UPPER.Mixed_9-z', 'trailing-_.x9', 'r'.repeat(64), `${'x'.repeat(63)}-`];
const ADVERSARIAL_IDS = ['p'.repeat(128), 'q'.repeat(65), '-leading-dash', '_leading_underscore', '.leading.dot', LONG_A, LONG_B];
for (const id of [...VALID_IDS, ...ADVERSARIAL_IDS]) assert.ok(PROVIDER_ID_RE.test(id), `realistic host id: ${id.slice(0, 12)}`);
for (const id of VALID_IDS) assert.ok(SEGMENT.test(id), `valid segment: ${id.slice(0, 12)}`);
for (const id of ADVERSARIAL_IDS) assert.ok(!SEGMENT.test(id), `invalid segment: ${id.slice(0, 12)}`);

function hostEntries() {
  return [...VALID_IDS, ...ADVERSARIAL_IDS].map((id) => ({
    id, label: `Provider ${id.slice(0, 8)}`, hint: '', argv: ['/bin/sh'], command: undefined,
  }));
}

function facadeDouble() {
  return {
    state: { enabled: true, busy: false },
    canEnable: false,
    canOpen: true,
    setEnabled: async () => {},
    open: async () => ({ session: 's1' }),
    close: () => {},
  };
}

async function mountControls(entries) {
  const component = await compileSfc('terminal/BrokerLaunchControls.vue', {
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
    '../multislot/multislotProviders.js': { toKitMenuProviders: () => entries },
    './sideTerminalFacade.js': { createSideTerminalBrokerFacade: () => facadeDouble() },
    './providers.js': { SHELL_COMMAND: 'shell', PROVIDER_COMMAND: 'provider' },
  });
  const mounted = mountComponent(component, { broker: {} });
  await flush();
  return mounted;
}

function providerButtons(root) {
  return nodes(root).filter((n) => n.tag === 'button');
}

// Minimal fake DOM for the real collector (mirrors mvui17-qa-grammar).
function dom() {
  const root = {
    nodeType: 9,
    children: [],
    ownerDocument: null,
    querySelectorAll() { return this.children.filter((el) => el.hasAttribute('data-semantic-anchor')); },
    getElementById() { return null; },
  };
  root.ownerDocument = root;
  const window = {
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' }; },
  };
  function element(tag, attrs, text = '') {
    const node = {
      nodeType: 1,
      localName: tag,
      parentElement: null,
      ownerDocument: root,
      childNodes: text ? [{ nodeType: 3, nodeValue: text }] : [],
      box: { x: 10, y: 20, width: 80, height: 30 },
      getAttribute(name) { return attrs[name] ?? null; },
      hasAttribute(name) { return Object.hasOwn(attrs, name); },
      matches() { return false; },
      closest() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() {
        const b = this.box;
        return { ...b, left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
      },
    };
    root.children.push(node);
    return node;
  }
  return { root, window, element };
}

test('provider buttons derive the anchor segment (fail-before pin)', () => {
  const template = controlsSrc.slice(controlsSrc.indexOf('<template>'));
  assert.ok(template.includes('providerAnchorSegment(entry.id)'), 'derivation call present');
  assert.ok(template.includes('/provider/'), 'provider anchor scope kept');
});

test('mounted: fitting ids stay byte-identical, DOM ids keep the raw id', async () => {
  const entries = [...toKitMenuProviders(hostEntries())];
  assert.deepEqual(normalizeProviders(hostEntries()).map((e) => e.id), [...VALID_IDS, ...ADVERSARIAL_IDS]);
  const f = await mountControls(entries);
  try {
    const buttons = providerButtons(f.root);
    assert.equal(buttons.length, entries.length);
    for (const entry of entries) {
      const button = buttons.find((n) => n.props.id === `mv-terminal-broker-launch-${entry.id}`);
      assert.ok(button, `raw-id DOM id kept: ${entry.id.slice(0, 16)}`);
      if (SEGMENT.test(entry.id)) {
        assert.equal(button.props['data-semantic-anchor'], `terminal/provider/${entry.id}`);
      }
    }
    const shell = buttons.find((n) => n.props.id === 'mv-terminal-broker-launch-shell');
    assert.equal(shell.props['data-semantic-anchor'], 'terminal/provider/shell');
  } finally {
    f.app.unmount();
  }
});

test('mounted: adversarial ids map to valid, unique, deterministic anchors', async () => {
  const entries = [...toKitMenuProviders(hostEntries())];
  const first = await mountControls(entries);
  const second = await mountControls(entries);
  try {
    const anchorsOf = (root) => providerButtons(root).map((n) => n.props['data-semantic-anchor']);
    const a = anchorsOf(first.root);
    const b = anchorsOf(second.root);
    assert.deepEqual(a, b, 'deterministic across mounts');
    assert.equal(new Set(a).size, a.length, 'unique across providers');
    for (const anchor of a) {
      assert.ok(anchor.length <= 200, anchor);
      assert.ok(anchor.split('/').length <= 6, anchor);
      for (const segment of anchor.split('/')) assert.ok(SEGMENT.test(segment), segment);
    }
    for (const id of ADVERSARIAL_IDS) {
      assert.ok(!a.includes(`terminal/provider/${id}`), `raw adversarial id never embedded: ${id.slice(0, 12)}`);
    }
  } finally {
    first.app.unmount();
    second.app.unmount();
  }
});

test('real collector keeps derived anchors, drops raw adversarial ones', async () => {
  const entries = [...toKitMenuProviders(hostEntries())];
  const f = await mountControls(entries);
  try {
    const d = dom();
    for (const n of providerButtons(f.root)) {
      d.element('button', { 'data-semantic-anchor': n.props['data-semantic-anchor'] }, 'launch');
    }
    const rows = collectQaAnchors(d.root, d.window).rows;
    assert.equal(rows.length, entries.length, 'every derived anchor collected');
    assert.equal(new Set(rows.map((r) => r.anchor)).size, entries.length);
  } finally {
    f.app.unmount();
  }
  // Negative control: the pre-fix raw anchors are dropped while a valid
  // witness survives, so the test cannot pass by collecting nothing.
  const d = dom();
  for (const id of ADVERSARIAL_IDS) {
    d.element('button', { 'data-semantic-anchor': `terminal/provider/${id}` }, 'launch');
  }
  d.element('button', { 'data-semantic-anchor': 'terminal/provider/my-provider_1' }, 'witness');
  const rows = collectQaAnchors(d.root, d.window).rows;
  assert.deepEqual(rows.map((row) => row.anchor), ['terminal/provider/my-provider_1']);
});

test('every multislot control anchor validates and stays unique', () => {
  // Attribute templates plus script-side *Anchor derivations (facade
  // lifecycle refs, host refusal refs); identifier bindings must resolve.
  const attrTemplates = [];
  for (const src of [hostSrc, controlsSrc]) {
    for (const m of src.matchAll(/:data-semantic-anchor="`([^`]+)`"/g)) attrTemplates.push(m[1]);
    for (const m of src.matchAll(/data-semantic-anchor="([A-Za-z][^"`$]*\/[^"`$]*)"/g)) attrTemplates.push(m[1]);
  }
  const scriptTemplates = new Map();
  for (const src of [hostSrc, controlsSrc, facadeSrc]) {
    const script = src.includes('<template>') ? src.slice(0, src.indexOf('<template>')) : src;
    for (const m of script.matchAll(/(\w*[Aa]nchor\w*)\s*[:=][^`\n]*?`([^`]+)`/g)) {
      scriptTemplates.set(m[1], m[2]);
    }
  }
  const identifierBindings = [];
  for (const src of [hostSrc, controlsSrc]) {
    for (const m of src.matchAll(/:data-semantic-anchor="([A-Za-z][\w.]+)"/g)) {
      identifierBindings.push(m[1]);
    }
  }
  assert.ok(attrTemplates.length > 0 && scriptTemplates.size > 0 && identifierBindings.length > 0);
  for (const binding of identifierBindings) {
    const leaf = binding.split('.').pop();
    assert.ok(
      [...scriptTemplates.keys()].some((name) => name === leaf || name.endsWith(leaf)),
      `binding resolves: ${binding}`,
    );
  }
  const instantiate = (template) => {
    const outs = [];
    const bases = template.includes('anchorPrefix') ? ['terminal', 'capsule/cap-01'] : [null];
    const ops = template.includes('${op}') ? ['move', 'tab'] : [null];
    for (const base of bases) {
      for (const op of ops) {
        let s = template;
        if (base !== null) s = s.replace(/\$\{[^}]*anchorPrefix[^}]*\}/g, base);
        s = s.replace(/\$\{[^}]*providerAnchorSegment[^}]*\}/g, 'my-provider');
        if (op !== null) s = s.replace(/\$\{op\}/g, op);
        s = s.replace(/\$\{[^}]*\}/g, 'cap-01');
        outs.push(s);
      }
    }
    return outs;
  };
  const anchors = [...attrTemplates, ...scriptTemplates.values()].flatMap(instantiate);
  assert.ok(anchors.length >= attrTemplates.length + scriptTemplates.size);
  const d = dom();
  for (const anchor of anchors) d.element('button', { 'data-semantic-anchor': anchor }, 'control');
  const rows = collectQaAnchors(d.root, d.window).rows;
  assert.deepEqual(
    rows.map((row) => row.anchor).sort(),
    [...anchors].sort(),
    'every multislot control anchor collected verbatim',
  );
  assert.equal(new Set(anchors).size, anchors.length, 'anchors stay unique');
});

test('segment check rejects planted invalid segments (negative control)', () => {
  assert.equal(SEGMENT.test('-bad'), false);
  assert.equal(SEGMENT.test('_bad'), false);
  assert.equal(SEGMENT.test('k'.repeat(65)), false);
  assert.equal(SEGMENT.test('has space'), false);
  assert.equal(SEGMENT.test('ok-seg_1.2:3'), true);
});

test('rss stays under the 512 MiB lane budget', () => {
  const rss = process.memoryUsage.rss();
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
