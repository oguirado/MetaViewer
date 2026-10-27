// MVUI17 lane A (L2-6): Activity count reflects the live total once the feed is windowed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import {
  MV_ACTIVITY_LIMIT,
  mvActivityCountText,
  mvActivityFeedTotal,
  mvActivityListAccessibleName,
  normalizeActivityEntry,
} from '../src/activity/activityModel.js';

const STRIP_URL = new URL('../src/activity/ActivityStrip.vue', import.meta.url);
const strip = readFileSync(STRIP_URL, 'utf8');
const template = strip.slice(strip.indexOf('<template>'));

/** Feed rows exactly as App.recordActivity emits them: contiguous seqs from 1. */
const feedFor = (from, to) => Array.from({ length: to - from + 1 },
  (_, i) => ({ seq: from + i, code: 'INTENT_ACKNOWLEDGED' }));

/** Visible text carries human copy, never raw codes. */
function assertHumanText(text) {
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, 'count copy is non-empty');
  assert.doesNotMatch(text, /[A-Z]{2,}_[A-Z_]+/, `no raw code in copy: ${text}`);
  assert.doesNotMatch(text, /NaN|undefined/, `no leaked primitive in copy: ${text}`);
}

describe('mvui17 activity total model', () => {
  test('feed total recovers N from a windowed feed', () => {
    assert.equal(mvActivityFeedTotal([]), 0);
    assert.equal(mvActivityFeedTotal(feedFor(1, 3)), 3);
    assert.equal(mvActivityFeedTotal(feedFor(6, 13)), 13);
    assert.equal(mvActivityFeedTotal(feedFor(9, 16)), 16);
  });

  test('feed total ignores malformed rows and non-feeds', () => {
    assert.equal(mvActivityFeedTotal(null), 0);
    assert.equal(mvActivityFeedTotal('x'), 0);
    assert.equal(mvActivityFeedTotal([null, undefined, 7, 'x', [], { code: 'ACTION_ADMITTED' },
      { seq: 0, code: 'ACTION_ADMITTED' }, { seq: -2, code: 'ACTION_ADMITTED' },
      { seq: 1.5, code: 'ACTION_ADMITTED' }, { seq: '9', code: 'ACTION_ADMITTED' }]), 0);
    assert.equal(mvActivityFeedTotal([null, { seq: 0, code: 'X' }, ...feedFor(9, 16), { seq: 'x' }]), 16);
  });

  test('count copy stays a plain number while the history fits', () => {
    assert.equal(mvActivityCountText(0, 0), '0');
    assert.equal(mvActivityCountText(3, 3), '3');
    assert.equal(mvActivityCountText(8, 8), '8');
    assert.equal(mvActivityCountText(8, 0), '8');
  });

  test('count copy labels the bounded window once the feed overflows', () => {
    assert.equal(mvActivityCountText(8, 13), 'latest 8 of 13');
    assert.equal(mvActivityCountText(8, 16), 'latest 8 of 16');
    assert.equal(mvActivityCountText(7, 15), 'latest 7 of 15');
    assertHumanText(mvActivityCountText(8, 128));
  });

  test('count copy sanitizes garbage to a plain zero', () => {
    assert.equal(mvActivityCountText(-1, -1), '0');
    assert.equal(mvActivityCountText('x', 'y'), '0');
    assert.equal(mvActivityCountText(null, undefined), '0');
    assertHumanText(mvActivityCountText(-1, -1));
  });

  test('list accessible name keeps its shape, gains the window label', () => {
    assert.equal(mvActivityListAccessibleName(3), 'Latest authority outcomes, 3 shown');
    assert.equal(mvActivityListAccessibleName(-1), 'Latest authority outcomes, 0 shown');
    assert.equal(mvActivityListAccessibleName(8, 8), 'Latest authority outcomes, 8 shown');
    assert.equal(mvActivityListAccessibleName(8, 13), 'Latest authority outcomes, latest 8 of 13');
    assertHumanText(mvActivityListAccessibleName(8, 16));
  });

  test('negative control: window copy and total predicates reject planted values', () => {
    assertHumanText('latest 8 of 16');
    for (const planted of ['latest 8 of NaN', 'STALE_FRAME x', 'ERR_COUNT deno', 'latest 8 of undefined']) {
      assert.throws(() => assertHumanText(planted), assert.AssertionError, planted);
    }
    assert.equal(mvActivityFeedTotal(feedFor(9, 16)), 16);
    assert.notEqual(mvActivityFeedTotal(feedFor(9, 16)), 8, 'windowed total is not the shown count');
    assert.equal(mvActivityCountText(8, 16), 'latest 8 of 16');
    assert.throws(() => assert.equal(mvActivityCountText(8, 16), '8'), assert.AssertionError);
  });
});

describe('mvui17 activity strip count wiring', () => {
  test('count span renders the live count copy, not the capped row length', () => {
    assert.match(template,
      /<span\b[^>]*class="mv-activity__count"[^>]*aria-hidden="true"[^>]*>\{\{\s*countText\s*\}\}<\/span>/s,
      'count span keeps its class and hidden state and renders countText');
    assert.doesNotMatch(template, /\{\{\s*rows\.length\s*\}\}/, 'capped length is no longer rendered');
  });

  test('strip derives total and count from the feed without new props', () => {
    assert.ok(strip.includes('mvActivityFeedTotal'), 'total helper imported');
    assert.ok(strip.includes('mvActivityCountText'), 'count copy helper imported');
    assert.match(strip, /const total = computed\(\(\) => mvActivityFeedTotal\(/,
      'total derives from props.entries');
    assert.match(strip, /const countText = computed\(\(\) => mvActivityCountText\(rows\.value\.length, total\.value\)\)/,
      'count copy derives from shown rows and live total');
    assert.match(strip, /mvActivityListAccessibleName\(rows\.value\.length, total\.value\)/,
      'list name follows the same window label');
    assert.doesNotMatch(strip, /total\.value\s*=/, 'no computed writes the state it reads');
    assert.doesNotMatch(strip, /watch\(|watchEffect\(/, 'no watcher writes strip state');
  });

  test('ids and anchors stay byte-identical', () => {
    for (const pinned of [':id="stripId"', ':data-semantic-anchor="stripAnchor"', ':aria-label="stripName"',
      ':id="toggleId"', ':data-semantic-anchor="toggleAnchor"', 'label="Activity"',
      ':id="listId"', ':data-semantic-anchor="listAnchor"', ':aria-label="listName"',
      ':id="mvActivityRowDomId(entry.seq)"', ':data-semantic-anchor="mvActivityRowAnchor(entry.seq)"',
      ':data-activity-type="entry.type"', ':data-activity-tone="entry.tone"']) {
      assert.ok(template.includes(pinned), `template keeps ${pinned}`);
    }
    assert.match(template, /<li\b[^>]*v-for="entry in rows"[^>]*:key="entry\.seq"/s, 'rows keep their key');
  });

  test('strip adds no inline-style vector', () => {
    assert.doesNotMatch(strip, /style\s*=/, 'no style attribute');
    assert.doesNotMatch(strip, /:style\b/, 'no :style binding');
    assert.doesNotMatch(strip, /\.style\b/, 'no element.style write');
  });

  test('negative control: capped-length rendering and renamed anchors fail', () => {
    const countSpan = (tag) => {
      assert.match(tag, /class="mv-activity__count"/, `count span keeps its class: ${tag}`);
      assert.match(tag, /\{\{\s*countText\s*\}\}/, `count span renders countText: ${tag}`);
    };
    countSpan('<span class="mv-activity__count" aria-hidden="true">{{ countText }}</span>');
    for (const bad of [
      '<span class="mv-activity__count" aria-hidden="true">{{ rows.length }}</span>',
      '<span class="mv-activity__total" aria-hidden="true">{{ countText }}</span>',
      '<span aria-hidden="true">{{ countText }}</span>',
    ]) {
      assert.throws(() => countSpan(bad), assert.AssertionError, bad);
    }
  });
});

async function loadStrip() {
  const stubButton = vue.defineComponent({
    props: { id: String, label: String },
    setup: (props) => () => vue.h('button', { id: props.id }, props.label),
  });
  globalThis.__mvui17ActivityDeps = {
    'capsule-ui-kit/ui': { UiButton: stubButton },
    './activityModel.js': await import('../src/activity/activityModel.js'),
  };
  const { descriptor } = parse(readFileSync(STRIP_URL, 'utf8'));
  let code = compileScript(descriptor, { id: 'mvui17-activity', inlineTemplate: true }).content;
  code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  const require = createRequire(import.meta.url);
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') {
      return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    }
    assert.ok(spec in globalThis.__mvui17ActivityDeps, `Unmapped SFC dependency: ${spec}`);
    return `const ${bindings.trim()} = globalThis.__mvui17ActivityDeps[${JSON.stringify(spec)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui17a`)).default;
}

function mountStrip(Strip, initial) {
  const props = vue.reactive(initial);
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }),
    createComment: (text) => ({ text }),
    insert(child, parent, anchor) {
      if (child.parent) renderer.remove(child);
      child.parent = parent;
      const i = parent.children.indexOf(anchor);
      parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
    },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, _old, value) { node.props[key] = value; },
    querySelector: () => null,
    setScopeId() {},
  });
  // Wrapper keeps props reactive so feed updates flow live into the strip.
  const app = renderer.createApp({ setup: () => () => vue.h(Strip, props) });
  app.mount(root);
  return { app, props, root };
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await vue.nextTick(); };

describe('mvui17 activity count live behavior (L2-6)', () => {
  test('windowed feed shows "latest 8 of N" and updates live', async () => {
    const Strip = await loadStrip();
    const { app, props, root } = mountStrip(Strip, { entries: feedFor(9, 16) });
    try {
      await tick();
      const countOf = () => find(root, (n) => typeof n.props?.class === 'string'
        && n.props.class.includes('mv-activity__count'))?.text;
      const listNameOf = () => find(root, (n) => n.tag === 'ol')?.props?.['aria-label'];
      assert.equal(MV_ACTIVITY_LIMIT, 8);
      assert.equal(countOf(), 'latest 8 of 16');
      assert.equal(listNameOf(), 'Latest authority outcomes, latest 8 of 16');
      props.entries = feedFor(10, 17);
      await tick();
      assert.equal(countOf(), 'latest 8 of 17', 'count moves with each new outcome');
      assert.equal(listNameOf(), 'Latest authority outcomes, latest 8 of 17');
      props.entries = feedFor(1, 3);
      await tick();
      assert.equal(countOf(), '3', 'unwindowed feed keeps the plain number');
      assert.equal(listNameOf(), 'Latest authority outcomes, 3 shown');
    } finally {
      app.unmount();
      delete globalThis.__mvui17ActivityDeps;
    }
  });

  test('regression: rows alone cannot report the total (the stuck-at-8 shape)', () => {
    // App slices the feed to the newest 8 but keeps seqs: rows.length is 8
    // while the true total is 16. The old `{{ rows.length }}` count froze here.
    const feed = feedFor(9, 16);
    const rows = [];
    for (const item of feed.slice(-MV_ACTIVITY_LIMIT)) {
      const entry = normalizeActivityEntry(item);
      if (entry) rows.push(entry);
    }
    assert.equal(rows.length, 8, 'capped window holds 8 rows');
    assert.equal(mvActivityFeedTotal(feed), 16, 'seqs still carry the live total');
    assert.equal(mvActivityCountText(rows.length, mvActivityFeedTotal(feed)), 'latest 8 of 16');
  });

  test('negative control: malformed rows never inflate the count', async () => {
    const Strip = await loadStrip();
    const { app, props, root } = mountStrip(Strip, {
      entries: [...feedFor(9, 15), { seq: 'x', code: 'INTENT_ACKNOWLEDGED' }],
    });
    try {
      await tick();
      const count = find(root, (n) => typeof n.props?.class === 'string'
        && n.props.class.includes('mv-activity__count'))?.text;
      assert.equal(count, 'latest 7 of 15', 'shown counts rendered rows, total ignores malformed seqs');
      assertHumanText(count ?? '');
      props.entries = [null, { seq: 0, code: 'X' }, ...feedFor(9, 16)];
      await tick();
      const next = find(root, (n) => typeof n.props?.class === 'string'
        && n.props.class.includes('mv-activity__count'))?.text;
      assert.equal(next, 'latest 8 of 16');
    } finally {
      app.unmount();
      delete globalThis.__mvui17ActivityDeps;
    }
  });
});

test('mvui17 activity count: rss stays bounded', () => {
  const rss = process.memoryUsage.rss();
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
