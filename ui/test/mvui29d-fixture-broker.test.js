// MVUI29d lane T: fixture wiring. On a ?state=terminal-live boot main.js
// wires the fixture broker port (terminalLive.brokerPort) as the terminal
// broker, so broker launches work in the fixture; real boots unchanged.
// Real entry boots against a fake module map (the int-boot pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import {
  TERMINAL_LIVE_COMMANDS,
  TERMINAL_LIVE_ENDED,
  TERMINAL_LIVE_PROVIDERS,
} from '../src/fixtures/terminalLive.js';
import {
  createSessionTransport,
  createSideTerminalBrokerFacade,
} from '../src/terminal/sideTerminalFacade.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

/**
 * Boot the real entry with a fake module map (int-boot pattern).
 * @param {string} search
 * @param {{ fixtureRuntimeExtra?: object, windowExtra?: object }} [over]
 */
async function bootEntry(search, over = {}) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const previousBoot = globalThis.__mvuiBoot;
  const mount = { textContent: '', dataset: {} };
  let mounted = null;
  try {
    const forbidden = () => { throw new Error('fixture called live preload'); };
    globalThis.window = { location: { search }, addEventListener() {}, removeEventListener() {},
      metaviewer: { load: forbidden, save: forbidden, nestedDepth: forbidden,
        selfCapsuleId: forbidden, recordingDestination: forbidden }, ...over.windowExtra };
    globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount };
    globalThis.__mvuiBoot = {
      vue: { createApp: (_App, props) => ({ mount: selector => { mounted = { props, selector }; } }) },
      './App.vue': {},
      './core/hostAdapters.js': hostAdapters,
      './settings/settingsHost.js': { createSettingsHost },
      './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
      './fixtures/fixtureRuntime.js': { createFixtureRuntime, ...over.fixtureRuntimeExtra },
      './wall/layout.js': { createWallLayout, migrateWallLayout },
      'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
    };
    const code = main.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
      (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiBoot[${JSON.stringify(specifier)}];`)
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    bootSerial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui29d-${bootSerial}`);
    await new Promise(resolve => setImmediate(resolve));
    return { mounted, mount };
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    if (previousBoot === undefined) delete globalThis.__mvuiBoot;
    else globalThis.__mvuiBoot = previousBoot;
  }
}
let bootSerial = 0;

test('?state=terminal-live boots with the fixture broker wired for launches', async () => {
  assert.ok(main.includes('terminalLive?.brokerPort'), 'entry reads the fixture broker port');
  const { mounted, mount } = await bootEntry('?state=terminal-live', {
    fixtureRuntimeExtra: { createSessionTransport, TERMINAL_LIVE_COMMANDS, TERMINAL_LIVE_PROVIDERS },
  });
  assert.equal(mount.textContent, '');
  assert.ok(mounted, 'alias boots');
  assert.ok(mounted.props.terminalBroker, 'fixture broker wired');
  const broker = createSideTerminalBrokerFacade(mounted.props.terminalBroker);
  assert.equal(broker.canOpen, true);
  await broker.setEnabled(true);
  const opened = await broker.open({ command: 'shell', args: [], cols: 80, rows: 24 });
  assert.equal(opened.session, TERMINAL_LIVE_ENDED);
});

test('canonical fixtures boot with no terminal broker (negative control)', async () => {
  const { mounted, mount } = await bootEntry('?state=one', {
    fixtureRuntimeExtra: { createSessionTransport, TERMINAL_LIVE_COMMANDS, TERMINAL_LIVE_PROVIDERS },
  });
  assert.equal(mount.textContent, '');
  assert.ok(mounted, 'one boots');
  assert.equal(mounted.props.terminalBroker, null);
});

test('live boot still builds the broker from host.sideTerminal (negative control)', async () => {
  const sideTerminal = {
    open: async () => ({ session: 'live-1' }),
    setEnabled: async () => true,
    close: async () => true,
    attach: async ({ session }) => ({ port: { postMessage() {} } }),
    resize: async () => true,
    listProviders: async () => ({ entries: [], capabilities: [] }),
    copyText: async () => true,
  };
  const { mounted, mount } = await bootEntry('', {
    fixtureRuntimeExtra: { createSessionTransport, TERMINAL_LIVE_COMMANDS, TERMINAL_LIVE_PROVIDERS },
    windowExtra: { metaviewer: { load: async () => null, save: async () => true, sideTerminal } },
  });
  assert.equal(mount.textContent, '');
  assert.ok(mounted, 'live boots');
  assert.equal(mounted.props.fixture, null);
  assert.ok(mounted.props.terminalBroker, 'live broker built from the host');
  assert.equal(createSideTerminalBrokerFacade(mounted.props.terminalBroker).canOpen, true);
});
