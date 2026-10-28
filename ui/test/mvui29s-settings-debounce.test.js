// MVUI29S lane S: leading-edge save debounce. The first change saves
// immediately; bursts within the window collapse to one trailing save with
// the last value. Unit coverage of the runner plus mounted-panel coalescing,
// every behaviour with a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { MV_SETTINGS_SAVE_WINDOW_MS, createDebouncedRunner } from '../src/settings/settingsModel.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the first call runs immediately and a lone call never trails', async () => {
  const seen = [];
  const run = createDebouncedRunner(value => seen.push(value), 25);
  try {
    run('a');
    assert.deepEqual(seen, ['a']);
    assert.equal(run.pending(), false);
    await sleep(80);
    assert.deepEqual(seen, ['a'], 'no trailing call without a second schedule');
  } finally { run.cancel(); }
});

test('calls within the window collapse to one trailing call with the last value', async () => {
  const seen = [];
  const run = createDebouncedRunner(value => seen.push(value), 25);
  try {
    run('a');
    run('b');
    run('c');
    assert.deepEqual(seen, ['a']);
    assert.equal(run.pending(), true);
    await sleep(80);
    assert.deepEqual(seen, ['a', 'c']);
    assert.equal(run.pending(), false);
  } finally { run.cancel(); }
});

test('negative control: calls spaced beyond the window each run immediately', async () => {
  const seen = [];
  const run = createDebouncedRunner(value => seen.push(value), 20);
  try {
    run('a');
    await sleep(60);
    run('b');
    await sleep(60);
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(run.pending(), false);
  } finally { run.cancel(); }
});

test('cancel drops the pending trailing call', async () => {
  const seen = [];
  const run = createDebouncedRunner(value => seen.push(value), 20);
  run('a');
  run('b');
  assert.equal(run.pending(), true);
  run.cancel();
  assert.equal(run.pending(), false);
  await sleep(60);
  assert.deepEqual(seen, ['a']);
});

let serial = 0;
async function component(file, apply = () => {}) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'mvui29s-debounce', inlineTemplate: true });
  globalThis.__mvui29Theme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__mvui29Theme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#29d-${serial++}`)).default; }
  finally { delete globalThis.__mvui29Theme; }
}
function mount(Component, input) {
  const props = vue.reactive(input);
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: () => ({ text: '' }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
    },
    remove(child) { const list = child.parent?.children; if (list) list.splice(list.indexOf(child), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
    patchProp(node, key, _old, value) { node.props[key] = value; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    setScopeId() {},
  });
  const root = { children: [] };
  const app = renderer.createApp({ render: () => vue.h(Component, props) });
  app.mount(root);
  return { props, root, close: () => app.unmount() };
}
const nodes = node => [node, ...(node.children ?? []).flatMap(nodes)];
const radio = (mounted, value) => nodes(mounted.root).find(node => node.props?.value === value);
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await vue.nextTick(); } };
const settings = scheme => JSON.stringify({ scheme, density: 'compact', wallFps: 30, recordingFps: 3 });

test('mounted panel coalesces a burst to leading plus last-wins trailing', async () => {
  const saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings('mv-light'),
      saveSettings: async json => { saved.push(json); return true; },
    },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    const click = value => radio(mounted, value).props.onChange();
    click('mv-dark');
    await flush();
    assert.deepEqual(saved, [settings('mv-dark')], 'leading change saves immediately');
    click('mv-light');
    click('mv-dark');
    click('mv-light');
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 100);
    await flush();
    assert.deepEqual(saved, [settings('mv-dark'), settings('mv-light')], 'burst collapses to one trailing last-wins write');
    assert.equal(radio(mounted, 'mv-light').props.checked, true);
  } finally { mounted.close(); }
});

test('negative control: spaced changes each save immediately without coalescing', async () => {
  const saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings('mv-light'),
      saveSettings: async json => { saved.push(json); return true; },
    },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    const click = value => radio(mounted, value).props.onChange();
    for (const value of ['mv-dark', 'mv-light', 'mv-dark', 'mv-light']) {
      click(value);
      await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 60);
      await flush();
    }
    assert.deepEqual(saved, [settings('mv-dark'), settings('mv-light'), settings('mv-dark'), settings('mv-light')]);
  } finally { mounted.close(); }
});
