// MVUI29S lane S: a refused save renders a short typed refusal and keeps UI
// state; malformed stored text falls back to defaults with no visible error.
// Mounted-panel harness in the mvui-f2-panels style. Every behaviour ships
// with a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';

let serial = 0;
async function component(file, apply = () => {}) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'mvui29s-refusal', inlineTemplate: true });
  globalThis.__mvui29Theme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__mvui29Theme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#29r-${serial++}`)).default; }
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
const text = node => [node.text ?? '', ...(node.children ?? []).map(text)].join(' ');
const byId = (mounted, id) => nodes(mounted.root).find(node => node.props?.id === id);
const radio = (mounted, value) => nodes(mounted.root).find(node => node.props?.value === value);
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await vue.nextTick(); } };
const settings = scheme => JSON.stringify({ scheme, density: 'compact', wallFps: 30, recordingFps: 3 });

test('a refused save shows a short typed refusal and keeps the UI state', async () => {
  const applied = [], emitted = [];
  const Panel = await component('settings/MvSettingsPanel.vue', value => applied.push(value));
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => settings('mv-light'),
      saveSettings: async () => { throw new Error('PRIVATE disk fault'); },
    },
    onSchemeChange: value => emitted.push(value),
  });
  try {
    await flush();
    radio(mounted, 'mv-dark').props.onChange();
    await flush();
    const row = byId(mounted, 'mv-settings-save-refusal');
    assert.ok(row, 'refusal row is rendered');
    assert.equal(row.props['data-refusal-code'], 'ERR_SETTINGS_SAVE_FAILED');
    assert.equal(row.props.role, 'alert');
    assert.equal(row.props['data-semantic-anchor'], 'settings/save-refusal');
    assert.match(text(mounted.root), /could not be saved/);
    assert.doesNotMatch(text(mounted.root), /PRIVATE|disk fault|ERR_/);
    assert.equal(radio(mounted, 'mv-light').props.checked, true);
    assert.deepEqual(applied, ['mv-light']);
    assert.deepEqual(emitted, ['mv-light']);
  } finally { mounted.close(); }
});

test('negative control: an acknowledged save leaves no refusal row', async () => {
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: { loadSettings: async () => settings('mv-light'), saveSettings: async () => true },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    radio(mounted, 'mv-dark').props.onChange();
    await flush();
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
    assert.equal(radio(mounted, 'mv-dark').props.checked, true);
    assert.throws(() => assert.equal(radio(mounted, 'mv-light').props.checked, true), assert.AssertionError);
  } finally { mounted.close(); }
});

test('malformed stored text falls back to defaults with no visible error', async () => {
  const cases = ['{nope', '42', '[1]', '{"scheme":"invented"}', '{"density":"huge"}'];
  for (const bad of cases) {
    const emitted = [];
    const Panel = await component('settings/MvSettingsPanel.vue', () => {});
    const mounted = mount(Panel, {
      settingsHost: { loadSettings: async () => bad, saveSettings: async () => true },
      onSchemeChange: value => emitted.push(value),
    });
    try {
      await flush();
      assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined, `silent for ${bad}`);
      assert.doesNotMatch(text(mounted.root), /ERR_|unreadable|could not/, bad);
      assert.equal(radio(mounted, 'mv-light').props.checked, true, bad);
      assert.deepEqual(emitted, ['mv-light'], bad);
    } finally { mounted.close(); }
  }
});

test('negative control: a transport failure still renders its typed refusal with defaults applied', async () => {
  const emitted = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: {
      loadSettings: async () => { throw new Error('PRIVATE transport down'); },
      saveSettings: async () => true,
    },
    onSchemeChange: value => emitted.push(value),
  });
  try {
    await flush();
    const row = byId(mounted, 'mv-settings-save-refusal');
    assert.ok(row, 'transport failures stay loud, proving the silence check above can fail');
    assert.equal(row.props['data-refusal-code'], 'ERR_SETTINGS_SAVE_FAILED');
    assert.doesNotMatch(text(mounted.root), /PRIVATE|transport down/);
    assert.deepEqual(emitted, ['mv-light']);
    assert.equal(radio(mounted, 'mv-light').props.checked, true);
  } finally { mounted.close(); }
});

test('a valid scheme with an invalid density keeps the scheme with no visible error', async () => {
  const emitted = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: { loadSettings: async () => '{"scheme":"mv-dark","density":7}', saveSettings: async () => true },
    onSchemeChange: value => emitted.push(value),
  });
  try {
    await flush();
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
    assert.doesNotMatch(text(mounted.root), /ERR_|unreadable|could not/);
    assert.equal(radio(mounted, 'mv-dark').props.checked, true);
    assert.deepEqual(emitted, ['mv-dark']);
  } finally { mounted.close(); }
});
