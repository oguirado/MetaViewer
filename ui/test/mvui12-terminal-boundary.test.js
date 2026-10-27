import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defineComponent, h } from 'vue';
import { createSideTerminalFacade } from '../src/terminal/sideTerminalFacade.js';
import * as facade from '../src/terminal/sideTerminalFacade.js';
import { compileSfc, mountComponent, nodes, flush } from './mvui2-terminal-mount.mjs';

test('T5-R2-15 rejects malformed host ids before using the port with a typed refusal', () => {
  let touched = false;
  const port = { get postMessage() { touched = true; return () => {}; } };
  for (const session of ['../ghost', '', 'has space', 'a'.repeat(129), 42, {}]) {
    assert.throws(() => createSideTerminalFacade({ session, port }),
      { message: 'Invalid terminal binding', code: 'TERMINAL_BINDING_REFUSED' });
  }
  assert.equal(touched, false);
});

test('T5-R2-15 negative control: valid broker ids attach verbatim', async () => {
  for (const session of ['sess-9', 'A._-9', 'a'.repeat(128)]) {
    const port = { postMessage() {}, addEventListener() {}, removeEventListener() {}, start() {} };
    const view = createSideTerminalFacade({ session, port });
    try { assert.equal((await view.attach()).sessions[0].session, session); }
    finally { view.dispose(); }
  }
});

async function mountOverlay(initial = {}) {
  const listeners = new Map();
  const oldWindow = globalThis.window;
  globalThis.window = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  let panel;
  let geometry;
  try {
    const Panel = defineComponent({
      setup(_, ctx) { panel = ctx; return () => h('aside', { class: 'cui-side-terminal' }); },
    });
    const component = await compileSfc('terminal/SideTerminalOverlay.vue', {
      '/.kit/capsule-ui-kit/src/side-terminal/SideTerminalPanel.vue': Panel,
      './BrokerLaunchControls.vue': Panel,
      './sideTerminalFacade.js': { ...facade,
        useTerminalChromeGeometry(get) { geometry = get; return 'test-geometry'; },
      },
      '../multislot/multislotProviders.js': { toKitMenuProviders: () => [] },
    });
    const mounted = mountComponent(component, { open: true, ...initial });
    return { ...mounted, panel: () => panel, geometry: () => geometry(), listeners,
      close() { mounted.app.unmount(); globalThis.window = oldWindow; } };
  } catch (error) { globalThis.window = oldWindow; throw error; }
}

test('L8 Escape closes the overlay, ignores other keys/closed state, and tears down its listener', async () => {
  const updates = [];
  const view = await mountOverlay({ 'onUpdate:open': value => updates.push(value) });
  try {
    const keydown = view.listeners.get('keydown');
    assert.equal(typeof keydown, 'function');
    keydown({ key: 'Enter' });
    assert.deepEqual(updates, []);
    keydown({ key: 'Escape' });
    assert.deepEqual(updates, [false]);
    view.props.open = false;
    await flush();
    keydown({ key: 'Escape' });
    assert.deepEqual(updates, [false]);
    view.props.open = true;
    await flush();
    view.panel().emit('update:open', false);
    assert.deepEqual(updates, [false, false], 'existing kit collapse/toggle event still closes');
  } finally { view.close(); }
  assert.equal(view.listeners.size, 0);
});

test('L8 panel geometry stays below the top bar with measured offsets and token fallbacks', async () => {
  const css = readFileSync(new URL('../src/terminal/terminal.css', import.meta.url), 'utf8');
  const view = await mountOverlay({ topOffset: 76, bottomOffset: 24 });
  try {
    assert.equal(view.geometry()['--mv-terminal-top'], '76px');
    assert.equal(view.geometry()['--mv-terminal-bottom'], '24px');
    const root = nodes(view.root).find(n => n.props?.id === 'mv-side-terminal-overlay');
    assert.equal(root.props['data-cuk-geometry-id'], 'test-geometry');
    assert.match(css, /\.mv-side-terminal-overlay > \.cui-side-terminal\s*\{[^}]*top:\s*max\(var\(--cuk-component-app-shell-topbar-height\),\s*var\(--mv-terminal-top, 0px\)\)/);
    view.props.topOffset = 0;
    await flush();
    assert.equal(view.geometry()['--mv-terminal-top'], '0px', 'zero measurement leaves CSS token minimum authoritative');
    assert.doesNotMatch(css, /\.mv-side-terminal-overlay > \.cui-side-terminal\s*\{[^}]*top:\s*0\s*;/);
  } finally { view.close(); }
});

test('L8 negative control rejects a planted full-window panel boundary', () => {
  const boundary = /\.mv-side-terminal-overlay > \.cui-side-terminal\s*\{[^}]*top:\s*max\(var\(--cuk-component-app-shell-topbar-height\),\s*var\(--mv-terminal-top, 0px\)\)/;
  const css = readFileSync(new URL('../src/terminal/terminal.css', import.meta.url), 'utf8');
  assert.equal(boundary.test(css), true);
  assert.equal(boundary.test(css.replace(
    'top: max(var(--cuk-component-app-shell-topbar-height), var(--mv-terminal-top, 0px))',
    'top: 0',
  )), false);
});

test('invalid overlay binding projects a typed state without host id or error text', async () => {
  const view = await mountOverlay({ terminalBinding: { session: '../ghost', port: { postMessage() {} } } });
  try {
    const root = nodes(view.root).find(n => n.props?.id === 'mv-side-terminal-overlay');
    assert.equal(root.props['data-terminal-state'], 'TERMINAL_BINDING_REFUSED');
    assert.deepEqual(await view.panel().attrs.facade.attach(), { enabled: false, sessions: [] });
    assert.doesNotMatch(JSON.stringify(root.props), /ghost|Invalid terminal binding/);
  } finally { view.close(); }
});
