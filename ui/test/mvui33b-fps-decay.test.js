// MVUI33B lane S: the actual wall fps readout decays after silence. When no
// frame notice arrives for longer than MV_WALL_FPS_WINDOW_MS the readout
// falls back to "-- actual" through a panel-owned timer and recovers when
// notices resume; the timer is injectable and cleared on unmount. Hosted-safe:
// fake clock, fake timer and frames double, no electron/socket/filesystem.
// Every behaviour ships with a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { MV_WALL_FPS_WINDOW_MS } from '../src/settings/settingsModel.js';

let serial = 0;
async function component(file, apply = () => {}) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'mvui33b-decay', inlineTemplate: true });
  globalThis.__mvui33bDecayTheme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__mvui33bDecayTheme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#33bd-${serial++}`)).default; }
  finally { delete globalThis.__mvui33bDecayTheme; }
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
const notice = tsNs => ({ frame_ref: { ts_ns: tsNs } });

/** Controllable setTimeout/clearTimeout double. */
function fakeTimer() {
  let nextId = 1;
  const pending = new Map();
  const cleared = [];
  return {
    pending,
    cleared,
    port: {
      setTimeout: (callback, ms) => {
        const id = nextId++;
        pending.set(id, { callback, ms });
        return id;
      },
      clearTimeout: (id) => { cleared.push(id); pending.delete(id); },
    },
    fire() {
      const entries = [...pending.entries()];
      assert.equal(entries.length, 1, 'exactly one decay timer is pending');
      const [id, entry] = entries[0];
      pending.delete(id);
      entry.callback();
      return id;
    },
  };
}

test('silence past the meter window decays the readout; resume recovers; unmount clears the timer', async () => {
  let at = 0;
  const listeners = [];
  let stops = 0;
  const timer = fakeTimer();
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: { loadSettings: async () => settings(), saveSettings: async () => true },
    framesPort: {
      subscribeFrames: callback => {
        listeners.push(callback);
        return () => { stops += 1; };
      },
    },
    frameClock: { now: () => at },
    frameTimer: timer.port,
    onSchemeChange: () => {},
  });
  try {
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, -- actual/);
    for (let i = 0; i < 4; i += 1) {
      at = i * 250;
      listeners[0](notice(1_000_000_000 + i));
    }
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, 2\.0 actual/);
    assert.equal(timer.pending.size, 1, 'the panel schedules a decay timer (judge note 1)');
    assert.equal([...timer.pending.values()][0].ms, MV_WALL_FPS_WINDOW_MS);
    at = 5000;
    timer.fire();
    await flush();
    assert.match(
      text(byId(mounted, 'settings-wall-fps-actual')),
      /30 requested, -- actual/,
      'silence past the window decays to the placeholder',
    );
    listeners[0](notice(9_000_000_000));
    await flush();
    assert.match(
      text(byId(mounted, 'settings-wall-fps-actual')),
      /30 requested, 0\.5 actual/,
      'the readout recovers when notices resume',
    );
    assert.equal(timer.pending.size, 1, 'resume re-arms the decay timer');
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
  assert.equal(stops, 1, 'unmount unsubscribes');
  assert.equal(timer.pending.size, 0, 'unmount clears the panel-owned timer');
});

test('negative control: steady notices keep the readout live without ever decaying', async () => {
  let at = 0;
  const listeners = [];
  const timer = fakeTimer();
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: { loadSettings: async () => settings(), saveSettings: async () => true },
    framesPort: { subscribeFrames: callback => { listeners.push(callback); return () => {}; } },
    frameClock: { now: () => at },
    frameTimer: timer.port,
    onSchemeChange: () => {},
  });
  try {
    await flush();
    for (let i = 0; i < 6; i += 1) {
      at = i * 250;
      listeners[0](notice(2_000_000_000 + i));
      await flush();
      assert.doesNotMatch(
        text(byId(mounted, 'settings-wall-fps-actual')),
        /-- actual/,
        `steady cadence stays measured at notice ${i}`,
      );
    }
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, 3\.0 actual/);
  } finally { mounted.close(); }
});

test('negative control: without a frames port no decay timer is ever scheduled', async () => {
  const timer = fakeTimer();
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: { loadSettings: async () => settings(), saveSettings: async () => true },
    frameTimer: timer.port,
    onSchemeChange: () => {},
  });
  try {
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, -- actual/);
    assert.equal(timer.pending.size, 0, 'no notices means no timer');
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
  assert.equal(timer.pending.size, 0);
});
