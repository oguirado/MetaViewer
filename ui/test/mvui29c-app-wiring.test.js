// MVUI29c lane T: App terminal wiring. The multislot child receives the
// terminal session port, the provider list, the broker commands and the
// clipboard; the auto-open keeps its key rule and additionally opens for
// the terminal-live screen. Real App.vue through the shared SFC harness;
// doubles only below the component boundary. Every behaviour has a
// negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import {
  childStub,
  compileSfc,
  flush,
  mountComponent,
  UiButton,
} from './mvui16-harness.mjs';
import * as adapters from '../src/core/hostAdapters.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { TERMINAL_LIVE_FIXTURE } from '../src/fixtures/terminalLive.js';

const stub = vue.defineComponent({ setup: () => () => vue.h('div') });

async function mountAppForTerminal(initial = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const children = {};
  try {
    const hostOutcome = await compileSfc('core/HostOutcome.vue', { './hostAdapters.js': adapters });
    const App = await compileSfc('App.vue', {
      './creative/CreativeCapsule.vue': stub,
      './core/HostOutcome.vue': hostOutcome,
      'capsule-ui-kit/DockWorkspace': stub,
      '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
      './wall/EmptyWallView.vue': stub,
      './catalog/CatalogLauncher.vue': stub,
      './terminal/SideTerminalOverlay.vue': stub,
      './multislot/MultislotHost.vue': childStub('multislot', children),
      './recording/MvRecordingPanel.vue': stub,
      './settings/MvSettingsPanel.vue': stub,
      './agent/AgentLaneHost.vue': stub,
      './activity/ActivityStrip.vue': stub,
      './nested/nested.js': { resolveNestedMode, applyNestedWall },
      'capsule-ui-kit/ui': { UiButton },
      'capsule-ui-kit/theme': { setKitScheme() {} },
      './wall/WallWorkspace.vue': stub,
      './surfaces/SurfaceCanvas.vue': stub,
      './surfaces/tileScheduler.js': { createTileScheduler },
    });
    const id = initial.fixture?.capsules?.[0]?.id ?? 'cap-01';
    const row = vue.reactive({
      id, surfaceId: id, title: 'Capsule', generation: 1,
      visibility: 'unfolded', control: 'human', backendLifecycle: 'active',
    });
    const feed = {
      getSnapshot: () => null,
      getProjection: () => ({ rows: [row] }),
      subscribe: () => () => {},
    };
    const f = mountComponent(App, {
      layout: {},
      scope: {},
      storage: { readRaw: async () => null, writeAtomic: async () => {} },
      fixture: { key: 'multislot', ui: {}, capsules: [{ id }] },
      runtime: { projectionView: feed },
      authorityHost: { intent: async () => true },
      onSubmitIntent: () => {},
      ...initial,
    });
    await flush();
    return {
      ...f,
      children,
      close() {
        f.app.unmount();
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
      },
    };
  } catch (error) {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    throw error;
  }
}

test('multislot child receives the terminal port, providers, commands and clipboard', async () => {
  const port = { available: true };
  const providers = [{ id: 'alpha', label: 'Alpha', hint: '' }];
  const commands = ['shell', 'provider'];
  const clipboard = { writeText: async () => {} };
  const f = await mountAppForTerminal({
    terminalSessionPort: port,
    hostProviders: providers,
    brokerCommands: commands,
    clipboard,
  });
  try {
    assert.ok(f.children.multislot, 'key mount opens the multislot');
    // Props cross as reactive projections: structural equality, not identity.
    assert.deepEqual(f.children.multislot.attrs['terminal-session-port'], port);
    assert.deepEqual(f.children.multislot.attrs['host-providers'], providers);
    assert.deepEqual(f.children.multislot.attrs['broker-commands'], commands);
    assert.deepEqual(Object.keys(f.children.multislot.attrs.clipboard), ['writeText']);
  } finally {
    f.close();
  }
});

test('without terminal props the child keeps the binding-only defaults (negative control)', async () => {
  const f = await mountAppForTerminal({});
  try {
    assert.ok(f.children.multislot, 'key mount opens the multislot');
    assert.equal(f.children.multislot.attrs['terminal-session-port'], null);
    assert.deepEqual(f.children.multislot.attrs['host-providers'], []);
    assert.deepEqual(f.children.multislot.attrs['broker-commands'], []);
    assert.equal(f.children.multislot.attrs.clipboard, null);
  } finally {
    f.close();
  }
});

test('auto-open keeps the fixture-key rule for multislot and recording', async () => {
  for (const key of ['multislot', 'recording']) {
    const f = await mountAppForTerminal({
      fixture: { key, ui: {}, capsules: [{ id: 'cap-01' }] },
    });
    try {
      assert.ok(f.children.multislot, `key ${key} opens the multislot`);
    } finally {
      f.close();
    }
  }
});

test('auto-open additionally opens for the terminal-live screen', async () => {
  const f = await mountAppForTerminal({ fixture: TERMINAL_LIVE_FIXTURE });
  try {
    assert.equal(TERMINAL_LIVE_FIXTURE.key, 'terminal-live');
    assert.equal(TERMINAL_LIVE_FIXTURE.screen, 'multislot');
    assert.ok(f.children.multislot, 'terminal-live screen opens the multislot');
  } finally {
    f.close();
  }
});

test('wall fixtures keep the multislot closed (negative control)', async () => {
  const f = await mountAppForTerminal({
    fixture: { key: 'one', screen: 'wall', ui: {}, capsules: [{ id: 'cap-01' }] },
  });
  try {
    assert.equal(f.children.multislot, undefined);
  } finally {
    f.close();
  }
});
