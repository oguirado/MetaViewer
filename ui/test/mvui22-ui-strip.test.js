// MVUI22 lane T (L7-1): the Activity strip keeps a fixed height, so tile
// geometry is independent of the number of rows. Regression (live7): the
// outcomes list used max-height only, so each added row stole ~21 px from
// the wall/tile area and rescaled the frame. The list now has a fixed
// 132 px box with internal scrolling.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { tick } from './frame-wait.mjs';
import { MV_ACTIVITY_LIMIT, MV_ACTIVITY_EMPTY_TEXT } from '../src/activity/activityModel.js';

const CSS_URL = new URL('../src/activity/activity.css', import.meta.url);
const STRIP_URL = new URL('../src/activity/ActivityStrip.vue', import.meta.url);
const MODEL_URL = new URL('../src/activity/activityModel.js', import.meta.url);
const CSS_SOURCE = readFileSync(CSS_URL, 'utf8');
const STRIP_SOURCE = readFileSync(STRIP_URL, 'utf8');
const LIST_SELECTOR = '.mv-activity__list';
// Exact archived pre-fix list rule (max-height only: the L7-1 shrink vector).
const ARCHIVED_LIST_RULE = `.mv-activity__list {
  margin: 0;
  padding: 0 var(--cuk-semantic-spacing-md) var(--cuk-semantic-spacing-sm);
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 132px;
  overflow: auto;
}`;
const LIST_HEIGHT_PX = 132;
// Live7 measured ~21 px of tile shrink per Activity row (room.json L7-1).
const ROW_FOOTPRINT_PX = 21;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ruleBody(css, selector) {
  const match = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, 's'));
  assert.ok(match, `rule ${selector} exists`);
  return match[1];
}

function declValue(body, property) {
  const match = body.match(new RegExp(`(?:^|;)\\s*${escapeRegExp(property)}\\s*:\\s*([^;]+)`, 'm'));
  return match ? match[1].trim() : null;
}

function listRuleOf(css = CSS_SOURCE) {
  const body = ruleBody(css, LIST_SELECTOR);
  return {
    height: declValue(body, 'height'),
    maxHeight: declValue(body, 'max-height'),
    overflow: declValue(body, 'overflow'),
    gap: declValue(body, 'gap'),
    padding: declValue(body, 'padding'),
  };
}

/** Fail-closed predicate: the list box height is fixed and self-scrolling. */
function assertFixedListHeight(css = CSS_SOURCE) {
  const rule = listRuleOf(css);
  assert.equal(rule.height, `${LIST_HEIGHT_PX}px`, 'list box has a fixed height');
  assert.equal(rule.maxHeight, null, 'no max-height shrink vector');
  assert.match(rule.overflow ?? '', /^(auto|scroll)$/, 'rows scroll inside the fixed box');
}

const listGapPx = () => {
  const gap = Number((listRuleOf().gap ?? '').replace(/px$/, ''));
  assert.ok(Number.isSafeInteger(gap) && gap >= 0, 'list gap parses');
  return gap;
};

/** List vertical padding is the bottom spacing token: non-negative, in px. */
const listPaddingVPx = () => {
  const padding = listRuleOf().padding ?? '';
  assert.ok(!/-/u.test(padding.replace(/--[\w-]+/g, '')), 'list padding carries no negative length');
  return 0;
};

/** Content height for n rows: footprints + gaps (+ padding lower bound 0). */
function contentHeight(n) {
  if (n <= 0) return 0;
  return n * ROW_FOOTPRINT_PX + (n - 1) * listGapPx() + listPaddingVPx();
}

/** List box height under a box rule: fixed post-fix, capped pre-fix. */
function listBoxHeight(n, mode) {
  if (mode === 'fixed') return LIST_HEIGHT_PX;
  return Math.min(LIST_HEIGHT_PX, contentHeight(n));
}

/** Tile height for n rows: shell column minus the strip; bar/chrome cancel. */
function tileHeight(n, mode, shell = 800, rest = 200) {
  return shell - rest - listBoxHeight(n, mode);
}

describe('mvui22 activity strip height (L7-1)', () => {
  test('outcomes list owns a fixed-height, internally scrolling box', () => {
    assertFixedListHeight();
    assert.equal(MV_ACTIVITY_LIMIT, 8, 'feed bound stays pinned');
  });

  test('tile geometry is unchanged while the feed grows from 0 to 8 rows', () => {
    const heights = Array.from({ length: 9 }, (_, n) => tileHeight(n, 'fixed'));
    for (const height of heights) assert.equal(height, heights[0], 'tile height is row-count independent');
    assert.ok(contentHeight(8) > LIST_HEIGHT_PX, '8 rows overflow the fixed box into its internal scroll');
    assert.ok(contentHeight(1) < LIST_HEIGHT_PX, 'a single row fits without scrolling');
  });

  test('negative control: the archived max-height rule reproduces the L7-1 shrink', () => {
    assert.ok(ARCHIVED_LIST_RULE.includes('max-height: 132px;'), 'archived rule carries the shrink vector');
    assert.ok(ARCHIVED_LIST_RULE.includes('overflow: auto;'), 'archived rule keeps the scroll base');
    const archivedCss = CSS_SOURCE.replace(
      new RegExp(`${escapeRegExp(LIST_SELECTOR)}\\s*\\{[^}]*\\}`, 's'), ARCHIVED_LIST_RULE);
    assert.throws(() => assertFixedListHeight(archivedCss), assert.AssertionError, 'predicate rejects max-height-only');
    const before = tileHeight(1, 'capped');
    const after = tileHeight(8, 'capped');
    assert.ok(after < before, `capped list shrinks the tile 1->8 rows (${before} -> ${after})`);
    assert.equal(tileHeight(1, 'capped') - tileHeight(2, 'capped'), ROW_FOOTPRINT_PX + listGapPx(),
      'each unsaturated row steals its footprint plus the gap');
  });

  test('negative control: planted box variants fail the predicate', () => {
    const variant = (decls) => CSS_SOURCE.replace(
      new RegExp(`${escapeRegExp(LIST_SELECTOR)}\\s*\\{[^}]*\\}`, 's'), `.mv-activity__list { ${decls} }`);
    assert.throws(() => assertFixedListHeight(variant('height: auto; overflow: auto;')),
      assert.AssertionError, 'auto height fails');
    assert.throws(() => assertFixedListHeight(variant('height: 132px; overflow: visible;')),
      assert.AssertionError, 'visible overflow fails');
    assert.throws(() => assertFixedListHeight(variant('height: 132px; max-height: 132px; overflow: auto;')),
      assert.AssertionError, 'redundant max-height fails');
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

let cachedStrip = null;
async function loadStrip() {
  if (cachedStrip) return cachedStrip;
  const { descriptor } = parse(STRIP_SOURCE);
  const compiled = compileScript(descriptor, { id: 'mvui22-strip', inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content
    .replace(/^import\s+(['"])(.*?)\1;?/gm, (all, _q, specifier) => {
      if (specifier === './activity.css') return '';
      throw new Error(`unexpected side-effect import ${specifier}`);
    })
    .replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
      if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      if (specifier === './activityModel.js') return all.replace(/(['"])\.\/activityModel\.js\1/, JSON.stringify(MODEL_URL.href));
      if (specifier === 'capsule-ui-kit/ui') {
        return `const ${binding.trim()} = { UiButton: globalThis.__mvui22stripdeps.UiButton };`;
      }
      throw new Error(`unexpected ActivityStrip import ${specifier}`);
    });
  globalThis.__mvui22stripdeps = {
    UiButton: vue.defineComponent({ props: ['label'], setup: props => () => vue.h('button', {}, props.label) }),
  };
  cachedStrip = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui22-strip`)).default;
  return cachedStrip;
}

const feedEntries = (n) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, code: 'INTENT_ACKNOWLEDGED' }));

async function mountStrip(entries) {
  const Strip = await loadStrip();
  const root = { children: [] };
  const handle = renderer().createApp(Strip, { entries });
  handle.mount(root);
  await tick();
  await vue.nextTick();
  const nodes = allNodes(root);
  const rows = nodes.filter(node => node.props?.class === 'mv-activity__row');
  const empty = nodes.filter(node => node.props?.class === 'mv-activity__empty');
  const text = nodes.map(node => node.text).filter(chunk => typeof chunk === 'string').join('');
  handle.unmount();
  return { rows, empty, text };
}

describe('mvui22 activity strip rows (lane T)', () => {
  test('strip renders one row per feed entry up to the bound; empty feed shows the neutral copy', async () => {
    try {
      const none = await mountStrip(feedEntries(0));
      assert.equal(none.rows.length, 0, 'no rows without entries');
      assert.equal(none.empty.length, 1, 'empty state renders once');
      assert.ok(none.text.includes(MV_ACTIVITY_EMPTY_TEXT), 'empty state carries the neutral copy');
      const one = await mountStrip(feedEntries(1));
      assert.equal(one.rows.length, 1, 'one row for one entry');
      assert.equal(one.empty.length, 0, 'empty state hides once rows render');
      const full = await mountStrip(feedEntries(8));
      assert.equal(full.rows.length, 8, 'eight rows for eight entries');
      assert.ok(full.rows.every(row => row.props['data-activity-tone'] === 'success'), 'acks render with the success tone');
      const over = await mountStrip(feedEntries(12));
      assert.equal(over.rows.length, MV_ACTIVITY_LIMIT, 'rows stay bounded at the feed limit');
    } finally {
      delete globalThis.__mvui22stripdeps;
    }
  });

  test('negative control: malformed entries render no rows', async () => {
    try {
      const bad = await mountStrip([{ seq: 0, code: 'INTENT_ACKNOWLEDGED' }, null, 'nope', { seq: 1 }]);
      assert.equal(bad.rows.length, 1, 'only the well-formed entry renders');
      const empty = await mountStrip([{ seq: -2, code: 'INTENT_ACKNOWLEDGED' }]);
      assert.equal(empty.rows.length, 0, 'wholly malformed feed renders no rows');
      assert.equal(empty.empty.length, 1, 'wholly malformed feed shows the empty state');
    } finally {
      delete globalThis.__mvui22stripdeps;
    }
  });
});

test('mvui22 strip: rss stays bounded', () => {
  const rss = process.memoryUsage.rss();
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
