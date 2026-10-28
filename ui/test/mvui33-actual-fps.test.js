// MVUI33 lane S: actual wall fps readout. The panel measures presentation
// notices from the injected frames port over a short sliding window and
// renders requested next to actual; malformed notices are ignored, an empty
// window shows a placeholder, and unmount unsubscribes. Hosted-safe: a fake
// clock and a frames double drive everything, no electron/socket/filesystem.
// Every behaviour ships with a negative control.
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
  const compiled = compileScript(descriptor, { id: 'mvui33-fps', inlineTemplate: true });
  globalThis.__mvui33FpsTheme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__mvui33FpsTheme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#33f-${serial++}`)).default; }
  finally { delete globalThis.__mvui33FpsTheme; }
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

test('meter derives fps from notice arrivals over a fake clock window', () => {
  let at = 0;
  const meter = createWallFpsMeter({ windowMs: MV_WALL_FPS_WINDOW_MS, now: () => at });
  assert.equal(MV_WALL_FPS_WINDOW_MS, 2000);
  assert.equal(meter.read(), null);
  for (let i = 0; i < 6; i += 1) {
    at = i * 250;
    meter.push(1_000_000_000 + i);
  }
  assert.equal(meter.read(), 3);
  at = 4000;
  assert.equal(meter.read(), null, 'expired arrivals leave the window');
});

test('negative control: a different cadence measures differently, proving the readout is derived', () => {
  for (const [count, step, expected] of [[4, 250, 2], [6, 250, 3]]) {
    let at = 0;
    const meter = createWallFpsMeter({ windowMs: 2000, now: () => at });
    for (let i = 0; i < count; i += 1) {
      at = i * step;
      meter.push(1_000_000_000 + i);
    }
    assert.equal(meter.read(), expected);
  }
});

test('mounted readout follows presentation notices on the fake clock', async () => {
  let at = 0;
  const listeners = [];
  let stops = 0;
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: { loadSettings: async () => settings({ wallFps: 60 }), saveSettings: async () => true },
    framesPort: {
      subscribeFrames: callback => {
        listeners.push(callback);
        return () => { stops += 1; };
      },
    },
    frameClock: { now: () => at },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    assert.equal(listeners.length, 1, 'the panel subscribes once');
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /60 requested, -- actual/);
    for (let i = 0; i < 4; i += 1) {
      at = i * 250;
      listeners[0](notice(1_000_000_000 + i));
    }
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /60 requested, 2\.0 actual/);
    at = 5000;
    listeners[0](notice(9_000_000_000));
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /60 requested, 0\.5 actual/);
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
  } finally { mounted.close(); }
  assert.equal(stops, 1, 'unmount unsubscribes');
});

test('malformed notices are ignored without touching the readout', async () => {
  let at = 0;
  const listeners = [];
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: { loadSettings: async () => settings(), saveSettings: async () => true },
    framesPort: { subscribeFrames: callback => { listeners.push(callback); return () => {}; } },
    frameClock: { now: () => at },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    for (const bad of [null, undefined, {}, { frame_ref: null }, { frame_ref: { ts_ns: -1 } },
      { frame_ref: { ts_ns: 1.5 } }, { frame_ref: { ts_ns: 'now' } }, 'notice']) {
      at += 10;
      listeners[0](bad);
    }
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, -- actual/);
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
    at += 10;
    listeners[0](notice(42));
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /30 requested, 0\.5 actual/);
  } finally { mounted.close(); }
});

test('without a frames port the readout shows the request with a placeholder, never an error', async () => {
  const Panel = await component('settings/MvSettingsPanel.vue', () => {});
  const mounted = mount(Panel, {
    settingsHost: { loadSettings: async () => settings({ wallFps: 3 }), saveSettings: async () => true },
    onSchemeChange: () => {},
  });
  try {
    await flush();
    assert.match(text(byId(mounted, 'settings-wall-fps-actual')), /3 requested, -- actual/);
    assert.equal(byId(mounted, 'mv-settings-save-refusal'), undefined);
    assert.doesNotMatch(text(mounted.root), /ERR_|unreadable|could not/);
  } finally { mounted.close(); }
});
