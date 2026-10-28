// MVUI29c lane T: entry terminal wiring. main.js keeps its closed static
// import surface (the session-port factory travels through the
// fixtureRuntime re-export), builds the terminal port from the fixture
// double on terminal-live boots and from host.sideTerminal on live boots,
// and passes the port, providers, commands and clipboard to App. Shape
// checks in the mount-wiring idiom plus real entry boots against a fake
// module map (the int-boot pattern). Every behaviour has a negative
// control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import {
  TERMINAL_LIVE_COMMANDS,
  TERMINAL_LIVE_PROVIDERS,
  TERMINAL_LIVE_SESSION,
} from '../src/fixtures/terminalLive.js';
import { createSessionTransport } from '../src/terminal/sideTerminalFacade.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

/** @param {string} source */
function staticImportSpecifiers(source) {
  return [...source.matchAll(/^import\s+[^\n]+?\s+from\s+(['"])(.*?)\1;?$/gm)].map(match => match[2]);
}

test('entry keeps the closed static import surface while wiring the terminal port', () => {
  assert.deepEqual(staticImportSpecifiers(main), [
    'vue',
    './App.vue',
    './core/hostAdapters.js',
    './settings/settingsHost.js',
    './fixtures/resolveState.js',
    './fixtures/fixtureRuntime.js',
    './wall/layout.js',
    'capsule-ui-kit/theme',
  ]);
  for (const name of ['createSessionTransport', 'TERMINAL_LIVE_COMMANDS', 'TERMINAL_LIVE_PROVIDERS']) {
    assert.ok(main.includes(name), `re-exported name wired: ${name}`);
  }
});

test('negative control: the surface check fails on a planted direct import', () => {
  assert.deepEqual(staticImportSpecifiers(main).length, 8);
  assert.throws(() => assert.deepEqual(
    staticImportSpecifiers(`${main}\nimport { x } from './terminal/sideTerminalFacade.js';`).length, 8),
    assert.AssertionError);
});

test('entry builds the port from the double or the host and passes it to App', () => {
  for (const snippet of [
    'terminalLive?.transport',
    'host?.sideTerminal',
    'createSessionTransport(terminalSessionPort)',
    'terminalSessionPort, hostProviders: terminalProviders, brokerCommands: terminalCommands, clipboard: terminalClipboard,',
    'terminal: fixtureMount?.terminal ?? null',
  ]) {
    assert.ok(main.includes(snippet), `entry ships: ${snippet}`);
  }
});

test('negative control: the wiring check fails when the port build is stripped', () => {
  const wired = source => source.includes('createSessionTransport(terminalSessionPort)')
    && source.includes('hostProviders: terminalProviders, brokerCommands: terminalCommands, clipboard: terminalClipboard,');
  assert.equal(wired(main), true);
  assert.equal(wired(main.replaceAll('createSessionTransport(terminalSessionPort)', 'null')), false);
  assert.equal(wired(main.replaceAll('hostProviders: terminalProviders', 'hostProviders: []')), false);
});

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
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui29c-${bootSerial}`);
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

test('?state=terminal-live mounts with the built port, providers, commands and clipboard', async () => {
  const { mounted, mount } = await bootEntry('?state=terminal-live', {
    fixtureRuntimeExtra: { createSessionTransport, TERMINAL_LIVE_COMMANDS, TERMINAL_LIVE_PROVIDERS },
  });
  assert.equal(mount.textContent, '');
  assert.ok(mounted, 'alias boots');
  assert.equal(mounted.props.fixture.key, 'terminal-live');
  assert.equal(mounted.props.terminal.session, TERMINAL_LIVE_SESSION);
  assert.equal(mounted.props.terminalSessionPort.available, true);
  assert.equal(mounted.props.terminalSessionPort.canAttach, true);
  assert.deepEqual(mounted.props.hostProviders, [...TERMINAL_LIVE_PROVIDERS]);
  assert.deepEqual(mounted.props.brokerCommands, [...TERMINAL_LIVE_COMMANDS]);
  assert.equal(typeof mounted.props.clipboard.writeText, 'function');
});

test('negative control: missing factories degrade to the raw source but still boot', async () => {
  const { mounted, mount } = await bootEntry('?state=terminal-live', { fixtureRuntimeExtra: {} });
  assert.equal(mount.textContent, '');
  assert.ok(mounted, 'boots without terminal names (stub-harness shape)');
  assert.equal(typeof mounted.props.terminalSessionPort.attach, 'function');
  assert.equal(mounted.props.terminalSessionPort.available, undefined);
  assert.deepEqual(mounted.props.hostProviders, []);
  assert.deepEqual(mounted.props.brokerCommands, []);
  assert.equal(typeof mounted.props.clipboard.writeText, 'function');
});

test('canonical fixtures boot with no terminal port, providers or clipboard', async () => {
  const { mounted, mount } = await bootEntry('?state=one', {
    fixtureRuntimeExtra: { createSessionTransport, TERMINAL_LIVE_COMMANDS, TERMINAL_LIVE_PROVIDERS },
  });
  assert.equal(mount.textContent, '');
  assert.ok(mounted, 'one boots');
  assert.equal(mounted.props.terminalSessionPort, null);
  assert.deepEqual(mounted.props.hostProviders, []);
  assert.deepEqual(mounted.props.brokerCommands, []);
  assert.equal(mounted.props.clipboard, null);
  assert.equal(mounted.props.terminal, null);
});

test('live boot builds the port from host.sideTerminal with empty menu data', async () => {
  const calls = [];
  const sideTerminal = {
    attach: async ({ session }) => { calls.push(['attach', session]); return { port: { postMessage() {} } }; },
    resize: async () => true,
    close: async () => true,
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
  assert.equal(mounted.props.terminalSessionPort.available, true);
  assert.equal(mounted.props.terminalSessionPort.canCopy, true);
  assert.deepEqual(mounted.props.hostProviders, []);
  assert.deepEqual(mounted.props.brokerCommands, []);
  assert.equal(mounted.props.clipboard, null);
});
