// MVUI33 lane S: mounted settings panel controls. Density, live wall fps and
// recording fps persist through the injected host as one closed four-key
// object; bursts across fields keep every last value; every new control
// carries a stable id, a semantic anchor and an accessible name; no visible
// error appears in any legal state. Hosted-safe: the mvui-f2-panels harness
// (custom renderer, injected host double, no electron/socket/filesystem).
// Every behaviour ships with a negative control.
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
  const compiled = compileScript(descriptor, { id: 'mvui33-panel', inlineTemplate: true });
  globalThis.__mvui33Theme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__mvui33Theme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#33p-${serial++}`)).default; }
  finally { delete globalThis.__mvui33Theme; }
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
const byAnchor = (mounted, anchor) => nodes(mounted.root).find(node => node.props?.['data-semantic-anchor'] === anchor);
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await vue.nextTick(); } };
const settings = (patch = {}) => JSON.stringify({
  scheme: 'mv-light',
  density: 'compact',
  wallFps: 30,
  recordingFps: 3,
  ...patch,
});

/**
 * @param {string[]} saved
 */
function assertClosedSaves(saved) {
  for (const json of saved) {
    assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ['density', 'recordingFps', 'scheme', 'wallFps']);
  }
}

test('new controls carry stable ids, anchors and accessible names', async () => {
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: { loadSettings: async () => settings(), saveSettings: async () => true },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    for (const [id, anchor, name] of [
      ['settings-density', 'settings/density-control', 'Density'],
      ['settings-wall-fps', 'settings/wall-fps', 'Live wall fps'],
      ['settings-recording-fps', 'settings/recording-fps', 'Recording fps'],
      ['settings-recording-fps-input', 'settings/recording-fps-input', 'Recording fps'],
      ['settings-wall-fps-actual', 'settings/wall-fps-actual', 'Actual wall fps'],
      ['settings-density-comfortable', 'settings/density-comfortable', 'Density Comfortable'],
      ['settings-wall-fps-60', 'settings/wall-fps-60', 'Live wall fps 60'],
    ]) {
      const node = byId(mounted, id);
      assert.ok(node, `control rendered: ${id}`);
      assert.equal(node.props['data-semantic-anchor'], anchor, id);
      assert.equal(node.props['aria-label'], name, id);
    }
    assert.equal(byId(mounted, 'settings-wall-fps').props.role, 'radiogroup');
    assert.equal(byId(mounted, 'settings-density').props.role, 'radiogroup');
    assert.equal(byId(mounted, 'settings-wall-fps-actual').props.role, 'status');
    // Existing anchors are unchanged.
    assert.ok(byAnchor(mounted, 'settings/mv-panel'));
    assert.ok(byAnchor(mounted, 'settings/scheme'));
    assert.ok(byAnchor(mounted, 'settings/density'));
  } finally { mounted.close(); }
});

test('negative control: the audit fails on a planted anchor gap', () => {
  assert.equal(byAnchor({ root: { children: [] } }, 'settings/wall-fps'), undefined);
});

test('density change persists the full object and mirrors the model', async () => {
  const saved = [], models = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings({ density: 'comfortable' }),
      saveSettings: async json => { saved.push(json); return true; },
    },
    density: 'compact',
    'onUpdate:density': value => models.push(value),
    onSchemeChange: () => {},
  });
  try {
    await flush();
    assert.deepEqual(models, ['comfortable'], 'load mirrors the stored density');
    assert.match(text(mounted.root), /Density: Comfortable/);
    byId(mounted, 'settings-density-compact').props.onChange();
    await flush();
    assert.deepEqual(saved, [settings({ density: 'compact' })]);
    assertClosedSaves(saved);
    assert.deepEqual(models, ['comfortable', 'compact']);
    assert.match(text(mounted.root), /Density: Compact/);
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
});

test('wall fps change persists the preset and the readout follows the request', async () => {
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
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, -- actual/);
    byId(mounted, 'settings-wall-fps-60').props.onChange();
    await flush();
    assert.deepEqual(saved, [settings({ wallFps: 60 })]);
    assertClosedSaves(saved);
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /60 requested, -- actual/);
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
});

test('recording fps change persists with clamping and silent revert, never an error row', async () => {
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
    change('99');
    await flush();
    assert.deepEqual(saved.at(-1), settings({ recordingFps: 60 }), 'clamped to the 1..60 range');
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 60);
    change('0');
    await flush();
    assert.deepEqual(saved.at(-1), settings({ recordingFps: 1 }), 'clamped to the 1..60 range');
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 60);
    change('not-a-number');
    await flush();
    assert.equal(saved.length, 3, 'invalid input reverts silently without saving');
    assertClosedSaves(saved);
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
    assert.doesNotMatch(text(mounted.root), /ERR_|unreadable|could not/);
  } finally { mounted.close(); }
});

test('burst across fields keeps every last value in one trailing save', async () => {
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
    byId(mounted, 'settings-wall-fps-60').props.onChange();
    await flush();
    assert.deepEqual(saved, [settings({ wallFps: 60 })], 'leading change saves immediately');
    const input = byId(mounted, 'settings-recording-fps-input');
    input.props.value = '48';
    input.props.onChange({ target: input.props });
    nodes(mounted.root).find(node => node.props?.value === 'mv-dark').props.onChange();
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 100);
    await flush();
    assert.deepEqual(
      saved,
      [settings({ wallFps: 60 }), settings({ scheme: 'mv-dark', wallFps: 60, recordingFps: 48 })],
      'fps then scheme collapses to one trailing write with both last values',
    );
    assertClosedSaves(saved);
  } finally { mounted.close(); }
});

test('negative control: spaced cross-field changes save separately, proving the burst coalesced', async () => {
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
    byId(mounted, 'settings-wall-fps-60').props.onChange();
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 60);
    await flush();
    const input = byId(mounted, 'settings-recording-fps-input');
    input.props.value = '48';
    input.props.onChange({ target: input.props });
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 60);
    await flush();
    assert.deepEqual(saved, [settings({ wallFps: 60 }), settings({ wallFps: 60, recordingFps: 48 })]);
  } finally { mounted.close(); }
});

test('idle control input on the applied values performs no save', async () => {
  const saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings({ wallFps: 60 }),
      saveSettings: async json => { saved.push(json); return true; },
    },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    byId(mounted, 'settings-wall-fps-60').props.onChange();
    const input = byId(mounted, 'settings-recording-fps-input');
    input.props.value = '3';
    input.props.onChange({ target: input.props });
    await sleep(MV_SETTINGS_SAVE_WINDOW_MS + 100);
    await flush();
    assert.deepEqual(saved, [], 'true no-ops never schedule');
  } finally { mounted.close(); }
});
