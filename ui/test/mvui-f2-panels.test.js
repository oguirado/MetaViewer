import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { SETTINGS_STORAGE_KEYS } from '../.kit/capsule-ui-kit/src/shell/SettingsModel.js';

let serial = 0;
async function component(file, apply = () => {}) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'f2-mounted', inlineTemplate: true });
  globalThis.__f2Theme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__f2Theme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default; }
  finally { delete globalThis.__f2Theme; }
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
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settings = scheme => JSON.stringify({ scheme, density: 'compact' });

// Each component runs its real setup, render, watchers, event handlers and lifecycle.
test('mounted recording maps raw errors and refusals to fixed text in all user-facing attributes', async () => {
  const Panel = await component('recording/MvRecordingPanel.vue');
  const mounted = mount(Panel, { capsuleId: 'cap-01', unavailableReason: 'ERR_HOST_SECRET private path', recordings: [{ id: 'rec', phase: 'error', error: 'ERR_HOST_SECRET private path' }] });
  try {
    assert.doesNotMatch(text(mounted.root), /ERR_|private path/);
    const attrs = nodes(mounted.root).flatMap(node => ['title', 'aria-label'].map(key => node.props?.[key] ?? '')).join(' ');
    assert.doesNotMatch(attrs, /ERR_|private path/);
    assert.match(text(mounted.root), /Recording failed/);
    assert.match(text(mounted.root), /Recording is unavailable/);
    assert.ok(nodes(mounted.root).some(node => node.props?.['data-refusal-code'] === 'ERR_RECORDING_UNAVAILABLE'));
    mounted.props.unavailableReason = ''; mounted.props.recordings = [{ id: 'rec', phase: 'sealed', error: 'must not show' }];
    await flush(); assert.doesNotMatch(text(mounted.root), /Recording failed|must not show/);
  } finally { mounted.close(); }
});

test('mounted recording rows have unique IDs and anchors even when IDs collide with fallback names', async () => {
  const Panel = await component('recording/MvRecordingPanel.vue');
  const events = [];
  const mounted = mount(Panel, { capsuleId: 'cap-01', exportDestination: 'picker', recordings: [{}, {}, { id: 'same' }, { id: 'same' }, { id: 'unknown-0' }, { id: '   ' }], onSubmitIntent: intent => events.push(intent) });
  try {
    const rendered = nodes(mounted.root).filter(node => node.props?.id);
    assert.equal(new Set(rendered.map(node => node.props.id)).size, rendered.length);
    const anchors = rendered.map(node => node.props['data-semantic-anchor']).filter(Boolean);
    assert.equal(new Set(anchors).size, anchors.length);
    const select = nodes(mounted.root).filter(node => node.props?.class === 'mv4-select');
    assert.ok(select[0].props.disabled, 'a missing ID must never dispatch an invented recording ID');
    select[0].props.onClick(); assert.deepEqual(events, []);
  } finally { mounted.close(); }
});

test('mounted recording emits real kit intents and respects export gates and prop updates', async () => {
  const Panel = await component('recording/MvRecordingPanel.vue');
  const events = [];
  const mounted = mount(Panel, { capsuleId: 'cap-01', recordings: [{ id: 'rec', phase: 'sealed' }], onSubmitIntent: event => events.push(event) });
  try {
    byId(mounted, 'mv-recordings-toggle-cap-01').props.onClick();
    byId(mounted, 'mv-recordings-export-rec').props.onClick();
    assert.equal(events.length, 1);
    mounted.props.exportDestination = 'picker'; await flush();
    byId(mounted, 'mv-recordings-export-rec').props.onClick();
    assert.equal(events.length, 2);
    assert.equal(events[1].recordingId ?? events[1].payload?.recordingId, 'rec');
  } finally { mounted.close(); }
});

test('mounted settings waits for persistence, rejects overlapping changes, and preserves theme on failed save', async () => {
  const calls = [], applied = [], emitted = [], saving = deferred();
  const Panel = await component('settings/MvSettingsPanel.vue', value => applied.push(value));
  const host = { loadSettings: async () => settings('mv-light'), saveSettings: json => { calls.push(json); return saving.promise; } };
  const mounted = mount(Panel, { settingsHost: host, onSchemeChange: value => emitted.push(value) });
  try {
    await flush(); assert.deepEqual(applied, ['mv-light']); assert.deepEqual(emitted, ['mv-light']);
    const dark = nodes(mounted.root).find(node => node.props?.value === 'mv-dark');
    dark.props.onChange(); await flush();
    assert.deepEqual(applied, ['mv-light'], 'theme changes only after host acknowledgement');
    assert.equal(dark.props.disabled, true);
    dark.props.onChange(); assert.equal(calls.length, 1);
    saving.reject(new Error('ERR_PRIVATE host secret')); await flush();
    assert.deepEqual(applied, ['mv-light']); assert.deepEqual(emitted, ['mv-light']);
    assert.doesNotMatch(text(mounted.root), /ERR_|host secret/);
    assert.equal(nodes(mounted.root).find(node => node.props?.value === 'mv-light').props.checked, true);
  } finally { mounted.close(); }
});

test('mounted settings persists then applies and emits the accepted scheme', async () => {
  const applied = [], emitted = [], saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', value => applied.push(value));
  const mounted = mount(Panel, { settingsHost: { loadSettings: async () => null, saveSettings: async json => { saved.push(json); return true; } }, onSchemeChange: value => emitted.push(value) });
  try {
    await flush(); nodes(mounted.root).find(node => node.props?.value === 'mv-dark').props.onChange(); await flush();
    assert.deepEqual(saved, [settings('mv-dark')]); assert.deepEqual(applied, ['mv-light', 'mv-dark']); assert.deepEqual(emitted, applied);
  } finally { mounted.close(); }
});

test('mounted settings replaces hosts and ignores old load/save completions and completions after unmount', async () => {
  const oldLoad = deferred(), oldSave = deferred(), applied = [], emitted = [];
  const Panel = await component('settings/MvSettingsPanel.vue', value => applied.push(value));
  const mounted = mount(Panel, { settingsHost: { loadSettings: () => oldLoad.promise, saveSettings: () => oldSave.promise }, onSchemeChange: value => emitted.push(value) });
  try {
    mounted.props.settingsHost = { loadSettings: async () => settings('mv-dark'), saveSettings: () => oldSave.promise };
    await flush(); oldLoad.resolve(settings('mv-light')); await flush();
    assert.deepEqual(applied, ['mv-dark']); assert.deepEqual(emitted, ['mv-dark']);
    nodes(mounted.root).find(node => node.props?.value === 'mv-light').props.onChange();
    mounted.close(); oldSave.resolve(true); await flush();
    assert.deepEqual(applied, ['mv-dark']); assert.deepEqual(emitted, ['mv-dark']);
  } finally { /* already unmounted */ }
});

test('mounted settings emits fallback only if theme application succeeds', async () => {
  const applied = [], emitted = [];
  const Panel = await component('settings/MvSettingsPanel.vue', value => { applied.push(value); if (value === 'mv-dark') throw new Error('private theme failure'); });
  const mounted = mount(Panel, { settingsHost: { loadSettings: async () => settings('mv-dark'), saveSettings: async () => true }, onSchemeChange: value => emitted.push(value) });
  try {
    await flush(); assert.deepEqual(emitted, []); assert.doesNotMatch(text(mounted.root), /ERR_|private theme failure/);
    mounted.props.settingsHost = { loadSettings: async () => { throw new Error('private load failure'); }, saveSettings: async () => true };
    await flush(); assert.deepEqual(emitted, ['mv-light']); assert.deepEqual(applied, ['mv-dark', 'mv-light']);
  } finally { mounted.close(); }
});

test('settings adapter normalizes legacy kit values and falls back per absent method only', async () => {
  const data = new Map([[SETTINGS_STORAGE_KEYS.scheme, 'dark']]);
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  assert.equal(JSON.parse(await createSettingsHost(null, storage).loadSettings()).scheme, 'mv-dark');
  data.set(SETTINGS_STORAGE_KEYS.scheme, 'light');
  assert.equal(JSON.parse(await createSettingsHost(null, storage).loadSettings()).scheme, 'mv-light');
  const partial = createSettingsHost({ loadSettings: async () => settings('mv-dark') }, storage);
  assert.equal(JSON.parse(await partial.loadSettings()).scheme, 'mv-dark');
  await partial.saveSettings(settings('mv-dark')); assert.equal(data.get(SETTINGS_STORAGE_KEYS.scheme), 'mv-dark');
  const broken = createSettingsHost({ loadSettings: async () => { throw new Error('host failure'); }, saveSettings: async () => false }, storage);
  await assert.rejects(broken.loadSettings(), /host failure/); assert.equal(await broken.saveSettings(settings('mv-light')), false);
  assert.equal(data.get(SETTINGS_STORAGE_KEYS.scheme), 'mv-dark', 'host refusal cannot trigger storage fallback');
  const denied = createSettingsHost(null, { getItem: () => null, setItem: () => { throw new Error('denied'); } });
  await assert.rejects(denied.saveSettings(settings('mv-dark')));
});


test('mounted settings restores persisted state when applying an acknowledged scheme fails', async () => {
  const applied = [], emitted = [], saved = [];
  const Panel = await component('settings/MvSettingsPanel.vue', value => {
    applied.push(value);
    if (value === 'mv-dark') throw new Error('private adapter error');
  });
  const mounted = mount(Panel, { settingsHost: {
    loadSettings: async () => settings('mv-light'),
    saveSettings: async json => { saved.push(json); return true; },
  }, onSchemeChange: value => emitted.push(value) });
  try {
    await flush(); nodes(mounted.root).find(node => node.props?.value === 'mv-dark').props.onChange(); await flush();
    assert.deepEqual(saved, [settings('mv-dark'), settings('mv-light')]);
    assert.deepEqual(applied, ['mv-light', 'mv-dark', 'mv-light']);
    assert.deepEqual(emitted, ['mv-light']);
    assert.equal(nodes(mounted.root).find(node => node.props?.value === 'mv-light').props.checked, true);
    assert.doesNotMatch(text(mounted.root), /ERR_|private adapter error/);
  } finally { mounted.close(); }
});

test('mounted settings ignores an old save completing after the host is replaced', async () => {
  const pending = deferred(), applied = [], emitted = [];
  const Panel = await component('settings/MvSettingsPanel.vue', value => applied.push(value));
  const mounted = mount(Panel, { settingsHost: { loadSettings: async () => settings('mv-light'), saveSettings: () => pending.promise }, onSchemeChange: value => emitted.push(value) });
  try {
    await flush(); nodes(mounted.root).find(node => node.props?.value === 'mv-dark').props.onChange();
    mounted.props.settingsHost = { loadSettings: async () => settings('mv-light'), saveSettings: async () => true };
    await flush(); pending.resolve(true); await flush();
    assert.deepEqual(applied, ['mv-light', 'mv-light']); assert.deepEqual(emitted, applied);
    assert.equal(nodes(mounted.root).find(node => node.props?.value === 'mv-light').props.checked, true);
  } finally { mounted.close(); }
});

test('settings adapter uses a present save method while only the absent load method falls back', async () => {
  const writes = [], json = settings('mv-dark');
  const storage = { getItem: () => 'light', setItem: () => { throw new Error('storage must not be written'); } };
  const host = { async saveSettings(value) { writes.push(value); assert.equal(this, host); return true; } };
  const adapter = createSettingsHost(host, storage);
  assert.equal(await adapter.loadSettings(), settings('mv-light'));
  assert.equal(await adapter.saveSettings(json), true); assert.deepEqual(writes, [json]);
});


test('mounted settings preserves the apply refusal when persistence rollback rejects', async () => {
  const saved = [], emitted = [];
  const Panel = await component('settings/MvSettingsPanel.vue', value => {
    if (value === 'mv-dark') throw new Error('private theme failure');
  });
  const mounted = mount(Panel, { settingsHost: {
    loadSettings: async () => settings('mv-light'),
    saveSettings: async json => {
      saved.push(json);
      if (saved.length === 2) throw Object.assign(new Error('private rollback failure'), { code: 'ERR_SETTINGS_SAVE_FAILED' });
      return true;
    },
  }, onSchemeChange: value => emitted.push(value) });
  try {
    await flush(); nodes(mounted.root).find(node => node.props?.value === 'mv-dark').props.onChange(); await flush();
    assert.deepEqual(saved, [settings('mv-dark'), settings('mv-light')]);
    assert.equal(byId(mounted, 'mv-settings-save-refusal').props['data-refusal-code'], 'ERR_SETTINGS_APPLY_FAILED');
    assert.match(text(mounted.root), /Color scheme could not be applied/);
    assert.doesNotMatch(text(mounted.root), /ERR_|private/);
    assert.deepEqual(emitted, ['mv-light']);
    assert.equal(nodes(mounted.root).find(node => node.props?.value === 'mv-light').props.checked, true);
  } finally { mounted.close(); }
});

test('mounted settings disables unverified live state when restoring the previous scheme fails', async () => {
  const applied = [], emitted = [], saved = [];
  let failLive = true;
  const Panel = await component('settings/MvSettingsPanel.vue', value => {
    applied.push(value);
    if (failLive && applied.length > 1) throw new Error('private live failure');
  });
  const mounted = mount(Panel, { settingsHost: {
    loadSettings: async () => settings('mv-light'),
    saveSettings: async json => { saved.push(json); return true; },
  }, onSchemeChange: value => emitted.push(value) });
  try {
    await flush(); nodes(mounted.root).find(node => node.props?.value === 'mv-dark').props.onChange(); await flush();
    assert.deepEqual(applied, ['mv-light', 'mv-dark', 'mv-light']);
    assert.deepEqual(saved, [settings('mv-dark'), settings('mv-light')]);
    const radios = nodes(mounted.root).filter(node => node.props?.type === 'radio');
    assert.ok(radios.every(node => node.props.disabled === true));
    assert.ok(radios.every(node => node.props.checked === false), 'no live scheme is claimed after failed restoration');
    radios.find(node => node.props.value === 'mv-dark').props.onChange(); await flush();
    assert.equal(saved.length, 2);
    assert.deepEqual(emitted, ['mv-light']);
    assert.equal(byId(mounted, 'mv-settings-save-refusal').props['data-refusal-code'], 'ERR_SETTINGS_APPLY_FAILED');
    // A fresh host load can establish verified live state again.
    failLive = false;
    mounted.props.settingsHost = { loadSettings: async () => settings('mv-dark'), saveSettings: async () => true };
    await flush();
    assert.ok(radios.every(node => node.props.disabled === false));
    assert.equal(radios.find(node => node.props.value === 'mv-dark').props.checked, true);
    assert.deepEqual(emitted, ['mv-light', 'mv-dark']);
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
});

test('settings fallback errors retain their specific refusal codes', async () => {
  const { settingsRefusalFor } = await import('../src/settings/settingsModel.js');
  const storage = { getItem: () => null, setItem: () => {} };
  const adapter = createSettingsHost(null, storage);
  await assert.rejects(adapter.saveSettings(settings('unknown')), error => {
    assert.equal(error.code, 'ERR_SETTINGS_UNKNOWN_SCHEME');
    assert.equal(settingsRefusalFor(error).code, 'ERR_SETTINGS_UNKNOWN_SCHEME');
    return true;
  });
  await assert.rejects(createSettingsHost(null, null).saveSettings(settings('mv-dark')), error => {
    assert.equal(error.code, 'ERR_SETTINGS_SAVE_FAILED');
    assert.equal(settingsRefusalFor(error).code, 'ERR_SETTINGS_SAVE_FAILED');
    return true;
  });
});
