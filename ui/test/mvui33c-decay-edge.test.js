// MVUI33C lane S: the readout decay timer never leaves a stale rate. When
// the decay timer fires at or just before the window edge the panel re-reads
// the meter and re-arms for the remaining time, so the readout still reaches
// "-- actual". Hosted-safe: fake clock, fake timer and frames double, no
// electron/socket/filesystem. Every behaviour ships with a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { MV_WALL_FPS_WINDOW_MS, createWallFpsMeter } from '../src/settings/settingsModel.js';

let serial = 0;
async function component(file, apply = () => {}) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'mvui33c-decay', inlineTemplate: true });
  globalThis.__mvui33cDecayTheme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__mvui33cDecayTheme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#33cd-${serial++}`)).default; }
  finally { delete globalThis.__mvui33cDecayTheme; }
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
      return { id, ms: entry.ms };
    },
  };
}

test('timer firing exactly at the window edge re-arms and then decays', async () => {
  let at = 1000;
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
    listeners[0](notice(1_000_000_000));
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, 0\.5 actual/);
    assert.equal(timer.pending.size, 1);
    assert.equal([...timer.pending.values()][0].ms, MV_WALL_FPS_WINDOW_MS);
    at = 1000 + MV_WALL_FPS_WINDOW_MS;
    timer.fire();
    await flush();
    assert.match(
      text(byId(mounted, 'settings-wall-fps-actual')),
      /30 requested, 0\.5 actual/,
      'the edge sample still counts on the first fire',
    );
    assert.equal(timer.pending.size, 1, 'an edge fire re-arms for the remaining time (mvui33c defect 2)');
    assert.equal([...timer.pending.values()][0].ms, 1, 'the remaining time at the edge is the 1 ms margin');
    at += 1;
    timer.fire();
    await flush();
    assert.match(
      text(byId(mounted, 'settings-wall-fps-actual')),
      /30 requested, -- actual/,
      'the re-armed fire decays to the placeholder instead of going stale',
    );
    assert.equal(timer.pending.size, 0, 'no further re-arm once the window is empty');
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
});

test('timer firing 1 ms before the window edge re-arms for the remaining time', async () => {
  let at = 1000;
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
    listeners[0](notice(2_000_000_000));
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, 0\.5 actual/);
    at = 1000 + MV_WALL_FPS_WINDOW_MS - 1;
    timer.fire();
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, 0\.5 actual/);
    assert.equal(timer.pending.size, 1, 'an early fire re-arms instead of going stale (mvui33c defect 2)');
    assert.equal([...timer.pending.values()][0].ms, 2, 're-arm covers the remaining 1 ms plus the margin');
    at = 1000 + MV_WALL_FPS_WINDOW_MS + 1;
    timer.fire();
    await flush();
    assert.match(
      text(byId(mounted, 'settings-wall-fps-actual')),
      /30 requested, -- actual/,
      'the re-armed fire decays to the placeholder',
    );
    assert.equal(timer.pending.size, 0);
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
});

test('msUntilEmpty reports the remaining window age plus the edge margin', () => {
  let at = 1000;
  const meter = createWallFpsMeter({ windowMs: MV_WALL_FPS_WINDOW_MS, now: () => at });
  assert.equal(meter.msUntilEmpty(), 0, 'an empty window waits nothing');
  meter.push(1_000_000_000);
  at = 1000 + MV_WALL_FPS_WINDOW_MS - 1;
  assert.equal(meter.read(), 0.5);
  assert.equal(meter.msUntilEmpty(), 2);
  at = 1000 + MV_WALL_FPS_WINDOW_MS;
  assert.equal(meter.read(), 0.5, 'the inclusive edge still counts');
  assert.equal(meter.msUntilEmpty(), 1);
  at = 1000 + MV_WALL_FPS_WINDOW_MS + 1;
  assert.equal(meter.read(), null);
  assert.equal(meter.msUntilEmpty(), 0);
});

test('negative control: firing well past the window decays at once with no re-arm', async () => {
  let at = 1000;
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
    listeners[0](notice(3_000_000_000));
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, 0\.5 actual/);
    at = 5000;
    timer.fire();
    await flush();
    assert.match(
      text(byId(mounted, 'settings-wall-fps-actual')),
      /30 requested, -- actual/,
      'silence past the window still decays immediately',
    );
    assert.equal(timer.pending.size, 0, 'an empty window never re-arms');
    listeners[0](notice(9_000_000_000));
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, 0\.5 actual/);
    assert.equal(timer.pending.size, 1, 'resume re-arms the decay timer');
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
});

test('negative control: firing mid-window keeps the measured readout', async () => {
  let at = 1000;
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
    listeners[0](notice(4_000_000_000));
    await flush();
    at = 1500;
    timer.fire();
    await flush();
    assert.match(
      text(byId(mounted, 'settings-wall-fps-actual')),
      /30 requested, 0\.5 actual/,
      'a mid-window fire never forces the placeholder',
    );
    listeners[0](notice(4_000_000_001));
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, 1\.0 actual/);
    assert.equal(timer.pending.size, 1, 'a fresh notice leaves exactly one timer pending');
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
  assert.equal(timer.pending.size, 0, 'unmount clears the re-armed timer');
});
