// MVUI29SC lane S: host replacement cancels the previous trailing save.
// Swapping the settingsHost prop (and unmount) drops the queued write before
// the new host loads, so a pending value can never fire against a host that
// did not schedule it. Every behaviour ships with a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { MV_SETTINGS_SAVE_WINDOW_MS } from '../src/settings/settingsModel.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let serial = 0;
async function component(file, apply = () => {}) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'mvui29sc-replace', inlineTemplate: true });
  globalThis.__mvui29scTheme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__mvui29scTheme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#29h-${serial++}`)).default; }
  finally { delete globalThis.__mvui29scTheme; }
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
const settings = scheme => JSON.stringify({ scheme, density: 'compact' });

test('replacing the host drops the previous trailing save before the new load', async () => {
  const savesA = [], savesB = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings('mv-light'),
      saveSettings: async json => { savesA.push(json); return true; },
    },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    radio(mounted, 'mv-dark').props.onChange();
    await flush();
    assert.deepEqual(savesA, [settings('mv-dark')], 'leading change saves on the first host');
    radio(mounted, 'mv-light').props.onChange();
    mounted.props.settingsHost = {
      loadSettings: async () => settings('mv-dark'),
      saveSettings: async json => { savesB.push(json); return true; },
    };
    await flush();
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 100);
    await flush();
    assert.deepEqual(savesB, [], 'no queued write from the previous host fires against the new one');
    assert.deepEqual(savesA, [settings('mv-dark')]);
    assert.equal(radio(mounted, 'mv-dark').props.checked, true);
  } finally { mounted.close(); }
});

test('negative control: a stable host still fires its queued trailing save', async () => {
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
    click('mv-light');
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 100);
    await flush();
    assert.deepEqual(saved, [settings('mv-dark'), settings('mv-light')], 'the queue fires when the host is untouched');
  } finally { mounted.close(); }
});

test('unmount drops the queued trailing save', async () => {
  const saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings('mv-light'),
      saveSettings: async json => { saved.push(json); return true; },
    },
    onSchemeChange: () => {},
  });
  await flush();
  const click = value => radio(mounted, value).props.onChange();
  click('mv-dark');
  await flush();
  click('mv-light');
  mounted.close();
  await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 100);
  assert.deepEqual(saved, [settings('mv-dark')], 'no trailing write after unmount');
});
