// MVUI33C lane S: clearing the recording fps field reverts silently. An
// empty or whitespace-only value (user clears the input and blurs) restores
// the current value without saving and without an error row; only a
// non-empty trimmed integer string (/^-?\d+$/ then Number) is accepted and
// clamped to 1..60. Hosted-safe: the mvui33 panel harness (custom renderer,
// injected host double, no electron/socket/filesystem). Every behaviour ships
// with a negative control.
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
  const compiled = compileScript(descriptor, { id: 'mvui33c-recfps', inlineTemplate: true });
  globalThis.__mvui33cRecfpsTheme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__mvui33cRecfpsTheme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#33cr-${serial++}`)).default; }
  finally { delete globalThis.__mvui33cRecfpsTheme; }
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
const text = node => [node.text ?? '', ...(node.children ?? []).map(text)].join(' ');
const byId = (mounted, id) => nodes(mounted.root).find(node => node.props?.id === id);
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await vue.nextTick(); } };
const settings = (patch = {}) => JSON.stringify({
  scheme: 'mv-light',
  density: 'compact',
  wallFps: 30,
  recordingFps: 3,
  ...patch,
});

test('empty and whitespace-only input reverts silently without saving', async () => {
  const saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings(),
      saveSettings: async json => { saved.push(json); return true; },
    },
    onSchemeChange: () => {},
  });
  const change = value => {
    const input = byId(mounted, 'settings-recording-fps-input');
    input.props.value = value;
    input.props.onChange({ target: input.props });
  };
  try {
    await flush();
    for (const bad of ['', '   ', '\t \n']) {
      change(bad);
      await flush();
      assert.equal(saved.length, 0, `${JSON.stringify(bad)} reverts without saving (mvui33c defect 1)`);
      assert.equal(byId(mounted, 'settings-recording-fps-input').props.value, '3');
    }
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
    assert.doesNotMatch(text(mounted.root), /ERR_|unreadable|could not/);
  } finally { mounted.close(); }
});

test('non-canonical numeric strings revert silently without saving', async () => {
  const saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings(),
      saveSettings: async json => { saved.push(json); return true; },
    },
    onSchemeChange: () => {},
  });
  const change = value => {
    const input = byId(mounted, 'settings-recording-fps-input');
    input.props.value = value;
    input.props.onChange({ target: input.props });
  };
  try {
    await flush();
    for (const bad of ['+5', '0x10', '1e3']) {
      change(bad);
      await flush();
      assert.equal(saved.length, 0, `"${bad}" is not a plain integer string (mvui33c defect 1)`);
      assert.equal(byId(mounted, 'settings-recording-fps-input').props.value, '3');
    }
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
});

test('negative control: trimmed and negative integers still save with clamping', async () => {
  const saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings(),
      saveSettings: async json => { saved.push(json); return true; },
    },
    onSchemeChange: () => {},
  });
  const change = value => {
    const input = byId(mounted, 'settings-recording-fps-input');
    input.props.value = value;
    input.props.onChange({ target: input.props });
  };
  try {
    await flush();
    change('48');
    await flush();
    assert.deepEqual(saved, [settings({ recordingFps: 48 })]);
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 60);
    change(' 42 ');
    await flush();
    assert.deepEqual(saved.at(-1), settings({ recordingFps: 42 }), 'surrounding whitespace is trimmed');
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 60);
    change('-5');
    await flush();
    assert.deepEqual(saved.at(-1), settings({ recordingFps: 1 }), 'negative integers clamp to 1..60');
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 60);
    change(42);
    await flush();
    assert.deepEqual(saved.at(-1), settings({ recordingFps: 42 }), 'numeric input still saves');
    for (const json of saved) {
      assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ['density', 'recordingFps', 'scheme', 'wallFps']);
    }
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
});

test('negative control: decimals still revert silently', async () => {
  const saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings(),
      saveSettings: async json => { saved.push(json); return true; },
    },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    const input = byId(mounted, 'settings-recording-fps-input');
    input.props.value = '12.5';
    input.props.onChange({ target: input.props });
    await flush();
    assert.equal(saved.length, 0, 'decimal input reverts silently without saving');
    assert.equal(byId(mounted, 'settings-recording-fps-input').props.value, '3');
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
});
