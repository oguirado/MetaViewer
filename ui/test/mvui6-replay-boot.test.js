// Lane R mvui6: named replay bench boot wiring. Executes the real entry
// like mvui5-replay-boot: named steps mount full frames and drive the real
// App dispatch paths through the fixture-only hook; numeric steps, live
// boot, and other fixtures ignore the bench branch entirely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime, createLiveReplayMount, LIVE_REPLAY_FIXTURE } from '../src/fixtures/fixtureRuntime.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const FIXED_PREVIEW_COPY = 'MetaViewer cannot start: This preview is unavailable.';
let serial = 0;

/**
 * Boots the real entry with a stubbed module map and an optional bench hook.
 * @param {string} search
 * @param {{ hook?: any, host?: any }} [options]
 */
async function bootEntry(search, { hook = null, host = null, buttons = null } = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousTimeout = globalThis.setTimeout;
  const mount = { textContent: '', dataset: {} };
  let mounted = null;
  const kitSchemes = [];
  const events = new Map();
  const timers = [];
  let nowMs = 0;
  const fakeWindow = {
    location: { search },
    ...(host === null ? {} : { metaviewer: host }),
    ...(hook === null ? {} : { __metaviewerBench: hook }),
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name) => events.delete(name),
  };
  const fakeDocument = {
    documentElement: { dataset: {} },
    querySelector: () => mount,
    getElementById: (id) => (buttons && typeof buttons === "object" ? buttons[id] ?? null : null),
  };
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  globalThis.setTimeout = (fn, ms = 0, ...rest) => {
    const delay = Number(ms) || 0;
    timers.push({ fn: () => fn(...rest), ms: delay, dueAt: nowMs + delay, fired: false });
    return timers.length;
  };
  const advanceClock = (deltaMs) => {
    nowMs += deltaMs;
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    globalThis.window = fakeWindow;
    globalThis.document = fakeDocument;
    try {
      for (const timer of timers) {
        if (!timer.fired && timer.dueAt <= nowMs) {
          timer.fired = true;
          timer.fn();
        }
      }
    } finally {
      globalThis.window = prevWin;
      globalThis.document = prevDoc;
    }
  };
  globalThis.__mvuiRBoot = {
    vue: { createApp: (_App, props) => ({ mount: (selector) => { mounted = { props, selector }; } }) },
    './App.vue': {},
    './core/hostAdapters.js': hostAdapters,
    './settings/settingsHost.js': { createSettingsHost },
    './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
    './fixtures/fixtureRuntime.js': { createFixtureRuntime, createLiveReplayMount, LIVE_REPLAY_FIXTURE },
    './wall/layout.js': { createWallLayout, migrateWallLayout },
    'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme: (scheme) => kitSchemes.push(scheme) },
  };
  try {
    const code = main
      .replace(
        /^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiRBoot[${JSON.stringify(specifier)}];`,
      )
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    serial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#r6-bench-${serial}`);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.setTimeout = previousTimeout;
    delete globalThis.__mvuiRBoot;
  }
  return { mount, mounted, kitSchemes, events, fakeWindow, timers, advanceClock };
}

test('named propose steps mount full frames and call the real dispatch', async () => {
  for (const [step, body] of [
    ['propose-admitted', { schema:'action_proposal/v0.2',proposal_id:'replay-proposal',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'} }],
    ['propose-refused', { schema:'action_proposal/v0.2',proposal_id:'replay-proposal',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'}, refuse: true }],
  ]) {
    const calls = [];
    const hook = { dispatch: (intent) => calls.push(intent) };
    const { mount, mounted } = await bootEntry(`?state=live-replay&step=${step}`, { hook });
    assert.equal(mount.textContent, '', step);
    assert.ok(mounted, step);
    const rows = mounted.props.runtime.projectionView.getProjection()?.rows ?? [];
    assert.equal(rows[0]?.generation, 7, step);
    assert.deepEqual(calls, [body], step);
    assert.equal(mounted.props.terminalBroker, null, `${step} binds no terminal broker`);
    assert.equal(mounted.props.terminal, null, step);
  }
});

test('named intent steps call dispatch with take_control bodies', async () => {
  const acked = [];
  await bootEntry('?state=live-replay&step=intent-acked', { hook: { dispatch: (intent) => acked.push(intent) } });
  assert.deepEqual(acked, [{ op: 'take_control', surfaceId: 'cap-01' }]);
  const refused = [];
  await bootEntry('?state=live-replay&step=intent-refused', { hook: { dispatch: (intent) => refused.push(intent) } });
  assert.deepEqual(refused, [{ op: 'take_control', surfaceId: '' }]);
});

test('named multislot steps call the real multislot dispatch', async () => {
  const calls = [];
  const hook = { dispatchMultislot: (intent, capsuleId) => calls.push([intent, capsuleId]) };
  const { mount, mounted } = await bootEntry('?state=live-replay&step=multislot-fold-acked', { hook });
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'cap-01');
  assert.equal(calls[0][0].op, 'fold');
  assert.deepEqual(calls[0][0].params, { slot_id: 'cuk-ai-slot-cap-01' });
  const refused = [];
  await bootEntry('?state=live-replay&step=multislot-unfold-refused', {
    hook: { dispatchMultislot: (intent, capsuleId) => refused.push([intent, capsuleId]) },
  });
  assert.equal(refused[0][0].op, 'unfold');
  assert.deepEqual(refused[0][0].params, {});
});

test('terminal pending opens the side terminal and clicks the real launch button', async () => {
  const calls = [];
  const hook = { openTerminal: () => calls.push('openTerminal') };
  const buttons = { 'mv-terminal-broker-launch-shell': { click: () => calls.push('clickLaunch') } };
  const { mount, mounted, timers, advanceClock } = await bootEntry('?state=live-replay&step=terminal-pending', { hook, buttons });
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.ok(mounted.props.terminalBroker, 'pending binds the fake broker');
  assert.equal(mounted.props.terminal, null, 'pending carries no binding');
  assert.deepEqual(calls, ['openTerminal'], 'terminal opens synchronously');
  assert.ok(timers.some((timer) => timer.ms === 50), 'launch click is scheduled after render');
  advanceClock(49);
  assert.deepEqual(calls, ['openTerminal'], 'launch click waits for the 50ms timer');
  advanceClock(1);
  assert.deepEqual(calls, ['openTerminal', 'clickLaunch']);
  const missing = [];
  const missingBoot = await bootEntry('?state=live-replay&step=terminal-pending', {
    hook: { openTerminal: () => missing.push('open') }, buttons: {},
  });
  missingBoot.advanceClock(50);
  assert.deepEqual(missing, ['open'], 'missing button never breaks boot');
});

test('terminal attached opens multislot with a live binding and broker', async () => {
  const calls = [];
  const { mount, mounted } = await bootEntry('?state=live-replay&step=terminal-attached', {
    hook: { openMultislot: () => calls.push('openMultislot') },
  });
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.deepEqual(calls, ['openMultislot']);
  assert.equal(mounted.props.terminal?.session, 'term-01');
  assert.ok(mounted.props.terminal?.port);
  assert.ok(mounted.props.terminalBroker);
});

test('terminal exited and failed open multislot and schedule the harness emit', async () => {
  for (const step of ['terminal-exited', 'terminal-failed']) {
    const calls = [];
    const { mount, mounted, timers } = await bootEntry(`?state=live-replay&step=${step}`, {
      hook: { openMultislot: () => calls.push('openMultislot') },
    });
    assert.equal(mount.textContent, '', step);
    assert.ok(mounted, step);
    assert.deepEqual(calls, ['openMultislot'], step);
    assert.ok(timers.some((timer) => timer.ms === 100), `${step} schedules the emit after bind`);
    assert.equal(mounted.props.terminal?.session, 'term-01', step);
  }
});

test('missing hook never breaks named mounts (negative control)', async () => {
  for (const step of ['propose-admitted', 'multislot-fold-acked', 'terminal-pending', 'terminal-failed']) {
    const { mount, mounted } = await bootEntry(`?state=live-replay&step=${step}`);
    assert.equal(mount.textContent, '', step);
    assert.ok(mounted, step);
    const rows = mounted.props.runtime.projectionView.getProjection()?.rows ?? [];
    assert.equal(rows[0]?.generation, 7, `${step} still shows full frames`);
  }
});

test('numeric steps never touch the hook', async () => {
  let hookCalls = 0;
  const hook = new Proxy({}, { get: () => () => { hookCalls += 1; } });
  for (const search of ['?state=live-replay', '?state=live-replay&step=0', '?state=live-replay&step=8']) {
    const { mount, mounted } = await bootEntry(search, { hook });
    assert.equal(mount.textContent, '', search);
    assert.ok(mounted, search);
  }
  assert.equal(hookCalls, 0, 'numeric steps drive no bench action');
});

test('live boot and other fixtures ignore named steps entirely', async () => {
  const host = { load: async () => null, save: async () => true };
  let hookCalls = 0;
  const hook = new Proxy({}, { get: () => () => { hookCalls += 1; } });
  const live = await bootEntry('?step=propose-admitted', { host, hook });
  assert.equal(live.mount.textContent, '');
  assert.ok(live.mounted);
  assert.equal(live.mounted.props.fixture, null);
  const other = await bootEntry('?state=four&step=terminal-failed', { hook });
  assert.equal(other.mount.textContent, '');
  assert.ok(other.mounted);
  assert.equal(other.mounted.props.authorityHost, null);
  assert.equal(other.mounted.props.terminalBroker, null);
  assert.equal(hookCalls, 0);
});

test('unknown named steps refuse boot with the fixed preview copy', async () => {
  for (const search of ['?state=live-replay&step=bogus', '?state=live-replay&step=verdict']) {
    const { mount, mounted } = await bootEntry(search);
    assert.equal(mounted, null, search);
    assert.equal(mount.textContent, FIXED_PREVIEW_COPY, search);
    assert.equal(mount.dataset.errorCode, 'ERR_INVALID_STEP_QUERY', search);
  }
});

test('boot keeps the closed stub-map import surface for the replay hook', () => {
  assert.ok(main.includes("import { parseStateQuery, resolveFixture } from './fixtures/resolveState.js';"));
  assert.ok(main.includes('createLiveReplayMount'));
  assert.ok(main.includes('ERR_INVALID_STEP_QUERY'));
  assert.ok(main.includes('ERR_UNKNOWN_STEP'));
  assert.ok(main.includes('driveReplayBench'), 'bench driver ships with the entry');
  assert.ok(main.includes('__metaviewerBench'), 'driver targets the fixture-only hook');
  assert.doesNotMatch(main, /from\s+['"]\.\/fixtures\/liveReplay\.js['"]/,
    'direct replay imports would break the closed boot stub maps');
});
