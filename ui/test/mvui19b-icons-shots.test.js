// MVUI19B lane I: screenshots-section export control audit (the fifth
// recording action in MvRecordingPanel.vue). Source-level contract
// (decorative kit icon, stable id, anchor, accessible name), QA-grammar
// validity of the resolved anchors through the real collector, and a bound
// mount proving the rendered control carries the icon. Each checker ships
// a planted violation proving it can fail. Bounded fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mvExportAccessibleName,
  mvExportAnchor,
  mvExportDomId,
  mvExportGateAnchor,
  mvManifestRowAnchor,
  mvManifestRowDomId,
} from '../src/recording/recordingModel.js';
import { collectQaAnchors } from '../src/qa/anchorCollector.js';
import {
  nodes,
  panelComponent,
  mutantPanelComponent,
  mountPanel,
  panelFlush,
  panelById,
  fakeStore,
} from './mvui16-harness.mjs';

/** QA anchor grammar v2, mirroring src/qa/anchorCollector.js:8-20. */
const QA_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * @param {string} anchor Resolved anchor value.
 * @param {string} label Assertion label.
 */
function assertQaAnchor(anchor, label) {
  assert.ok(typeof anchor === 'string' && anchor.length > 0 && anchor.length <= 200,
    `${label}: anchor within 200 chars: ${anchor}`);
  const segments = anchor.split('/');
  assert.ok(segments.length <= 6, `${label}: at most 6 segments: ${anchor}`);
  for (const segment of segments) {
    assert.ok(segment !== '.' && segment !== '..', `${label}: no dot segment: ${anchor}`);
    assert.match(segment, QA_SEGMENT, `${label}: alnum-led segment of <= 64 chars: ${anchor}`);
  }
}

/** @returns {string} Panel template block. */
function panelTemplate() {
  const sfc = readFileSync(new URL('../src/recording/MvRecordingPanel.vue', import.meta.url), 'utf8');
  const index = sfc.indexOf('<template>');
  return index < 0 ? sfc : sfc.slice(index);
}

/**
 * @param {string} template Panel template source.
 * @returns {string} The screenshots-section export button element.
 */
function shotsExportButton(template) {
  const section = template.indexOf('mv4-shots-title');
  assert.ok(section >= 0, 'screenshots section present');
  const buttons = template.slice(section).match(/<button\b[\s\S]*?<\/button>/g) ?? [];
  assert.equal(buttons.length, 1, `screenshots section owns one action, saw ${buttons.length}`);
  return buttons[0];
}

/**
 * @param {string} button Full native button element.
 * @param {string} label Assertion label.
 */
function assertKitIcon(button, label) {
  assert.match(button, /<SidebarIcon\b[^>]*\bname="[^"]+"[^>]*\baria-hidden="true"[^>]*\/>/,
    `${label}: action without decorative kit icon`);
  assert.doesNotMatch(button, /<SidebarIcon\b[^>]*(?:\bv-if=|\bv-show=|\shidden(?:\s|=|>))/,
    `${label}: action icon must stay visible`);
}

test('shots export keeps the source contract: icon, id, anchor, name', () => {
  const button = shotsExportButton(panelTemplate());
  assertKitIcon(button, 'shots export');
  assert.ok(button.includes('entry.exportDomId'), 'shots export keeps a stable id binding');
  assert.ok(button.includes('entry.exportAnchor'), 'shots export keeps an anchor binding');
  assert.ok(/aria-label=/.test(button), 'shots export keeps an accessible name binding');
  assert.ok(button.includes('name="save"'), 'shots export reuses the export glyph');
  // Planted violation: removing the new icon must fail.
  const withoutIcon = button.replace(/<SidebarIcon\b[^>]*\/>/g, '');
  assert.throws(() => assertKitIcon(withoutIcon, 'shots export'), /without decorative kit icon/,
    'removing the shots export icon fails');
});

test('five-control inventory: shots export is distinct from the recordings export', () => {
  const template = panelTemplate();
  const buttons = template.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
  assert.equal(buttons.length, 5, `toggle, screenshot, select, export, shots export; saw ${buttons.length}`);
  const exports = buttons.filter((button) => button.includes('entry.exportAnchor'));
  assert.equal(exports.length, 2, 'recordings export plus screenshots-section export');
  const shots = shotsExportButton(template);
  assert.ok(exports.includes(shots), 'shots export is one of the two export-family controls');
  assert.ok(template.indexOf(exports[0]) < template.indexOf('mv4-shots-title'),
    'recordings export stays outside the screenshots section');
});

test('resolved shots anchors validate under the QA anchor grammar', () => {
  for (const id of ['shot-1', 'shot-abc-123', 'unknown-0']) {
    assertQaAnchor(mvExportAnchor(id), `shots export ${id}`);
    assertQaAnchor(mvManifestRowAnchor(id), `shots row ${id}`);
    assertQaAnchor(mvExportGateAnchor(id), `shots gate ${id}`);
    assert.ok(mvExportDomId(id).length > 0, `shots export id ${id}`);
    assert.ok(mvManifestRowDomId(id).length > 0, `shots row id ${id}`);
    assert.ok(mvExportAccessibleName({ id }).length > 0, `shots export name ${id}`);
  }
  assert.equal(mvExportAnchor('shot-1'), 'recording/shot-1/export', 'pinned shots export anchor');
  assert.equal(mvExportDomId('shot-1'), 'mv-recordings-export-shot-1', 'pinned shots export id');
  assert.equal(mvExportAccessibleName({ id: 'shot-1' }), 'Export shot-1 to host destination',
    'pinned shots export name');
  assert.equal(mvExportAnchor('shot-1'), mvExportAnchor('shot-1'), 'anchors are deterministic');
  assert.notEqual(mvExportAnchor('shot-1'), mvExportAnchor('shot-2'), 'anchors stay unique');
  // Planted violation: the grammar rejects a non-alnum-led segment.
  assert.throws(() => assertQaAnchor('recording/-bad/export', 'planted'), /alnum-led/,
    'an invalid anchor fails the grammar checker');
});

/** Minimal fake DOM feeding resolved anchors through the real collector. */
function collectorDom() {
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
  /**
   * @param {string} tag @param {Record<string, string>} attrs @param {string} textValue
   */
  function element(tag, attrs, textValue = '') {
    const node = {
      nodeType: 1,
      localName: tag,
      parentElement: null,
      ownerDocument: root,
      childNodes: textValue ? [{ nodeType: 3, nodeValue: textValue }] : [],
      box: { x: 10, y: 20, width: 80, height: 30 },
      getAttribute(name) { return attrs[name] ?? null; },
      hasAttribute(name) { return Object.hasOwn(attrs, name); },
      matches() { return false; },
      closest() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() {
        const box = this.box;
        return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
      },
    };
    root.children.push(node);
    return node;
  }
  return { root, window, element };
}

test('real collector keeps the resolved shots export anchor', () => {
  const dom = collectorDom();
  dom.element('button', {
    id: mvExportDomId('shot-1'),
    'data-semantic-anchor': mvExportAnchor('shot-1'),
    'aria-label': mvExportAccessibleName({ id: 'shot-1' }),
  }, 'Export');
  const rows = collectQaAnchors(dom.root, dom.window).rows;
  assert.deepEqual(rows.map((row) => row.anchor), ['recording/shot-1/export'], 'shots export collected');
  assert.equal(rows[0].role, 'button', 'shots export role');
  assert.equal(rows[0].name, 'Export shot-1 to host destination', 'shots export name');
});

test('real collector drops an invalid anchor while the witness survives', () => {
  const dom = collectorDom();
  dom.element('button', { 'data-semantic-anchor': 'recording/-bad/export' }, 'invalid');
  dom.element('button', {
    id: mvExportDomId('shot-1'),
    'data-semantic-anchor': mvExportAnchor('shot-1'),
    'aria-label': mvExportAccessibleName({ id: 'shot-1' }),
  }, 'Export');
  const rows = collectQaAnchors(dom.root, dom.window).rows;
  assert.deepEqual(rows.map((row) => row.anchor), ['recording/shot-1/export'],
    'invalid anchor dropped, witness survives');
});

/** One sealed shot row for the bound panel mount. */
function sealedShot(id = 'shot-1', surface = 'cap-01') {
  return {
    id, kind: 'shot', surface_id: surface, phase: 'sealed', frames: 2,
    duration_ms: 7000, sealed: true, created_ms: 9,
  };
}

/**
 * @param {{ props?: Record<string, unknown>, children?: unknown[] }} button Mounted button node.
 * @param {string} label Assertion label.
 */
function assertShotsIcon(button, label) {
  const icon = nodes(button).find((node) => node.tag === 'svg'
    && String(node.props?.class ?? '').includes('cuk-sidebar-icon'));
  assert.ok(icon, `${label}: shots export without decorative kit icon`);
  assert.ok(icon.props?.['aria-hidden'], `${label}: kit icon stays decorative`);
}

test('bound mount renders the contracted shots export with its kit icon', async () => {
  const Panel = await panelComponent();
  const store = fakeStore({ rows: [sealedShot()] });
  const mounted = mountPanel(Panel, {
    capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: 'host-advertised',
  });
  try {
    await panelFlush();
    const button = panelById(mounted, 'mv-recordings-export-shot-1');
    assert.ok(button, 'shots export renders');
    assert.equal(button.props['data-semantic-anchor'], 'recording/shot-1/export', 'shots export anchor');
    assert.equal(button.props['aria-label'], 'Export shot-1 to host destination', 'shots export name');
    assertShotsIcon(button, 'shots mount');
  } finally { mounted.close(); }
});

test('bound mount negative control: removing the shots icon fails the icon checker', async () => {
  const Mutant = await mutantPanelComponent((source) => {
    const marker = source.indexOf('mv4-shots-title');
    assert.ok(marker >= 0, 'mutant targets the screenshots section');
    const head = source.slice(0, marker);
    const tail = source.slice(marker);
    assert.equal((tail.match(/<SidebarIcon\b/g) ?? []).length, 1, 'shots section owns one icon');
    return head + tail.replace(/<SidebarIcon\b[^>]*\/>/, '');
  });
  const store = fakeStore({ rows: [sealedShot()] });
  const mounted = mountPanel(Mutant, {
    capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: 'host-advertised',
  });
  try {
    await panelFlush();
    const button = panelById(mounted, 'mv-recordings-export-shot-1');
    assert.ok(button, 'mutant shots export still renders');
    assert.throws(() => assertShotsIcon(button, 'mutant'), /without decorative kit icon/,
      'removing the mounted shots icon fails');
  } finally { mounted.close(); }
});

test('mvui19b icons shots memory ceiling', () => {
  assert.ok(process.memoryUsage().rss < 512 * 1024 * 1024, `rss ${process.memoryUsage().rss}`);
});
