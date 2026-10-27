import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSideTerminalBrokerFacade } from '../src/terminal/sideTerminalFacade.js';

// Execute the actual fixture hook with a deferred broker acknowledgement.
// Its production component dependencies are irrelevant to this boundary.
const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const hook = source.match(/(?:async )?function toggleTerminal\(\) \{[\s\S]*?\n\}/)?.[0];
function bench(props, terminalOpen, didOpen) {
  assert.ok(hook, 'bench opener exists');
  const code = hook.replace("await import('./terminal/sideTerminalFacade.js')", 'facades');
  return new Function('props', 'terminalOpen', 'didOpen', 'creativeOpen', 'multislotOpen', 'settingsOpen', 'facades', `let terminalGeneration = 0, terminalOpening = false; const hostActive = true, hostOutcome = { value: null }; ${code}; return async () => { await toggleTerminal(); if (terminalOpen.value) didOpen(); };`)(
    props, terminalOpen, didOpen, { value: false }, { value: false }, { value: false }, { createSideTerminalBrokerFacade });
}

test('MV-11 replay opts into its fake broker before opening for the launch click', async () => {
  let acknowledge;
  const ack = new Promise(resolve => { acknowledge = resolve; });
  const calls = [];
  const broker = { setEnabled: async enabled => { calls.push(enabled); await ack; }, open: async () => ({ session: 's1' }) };
  const facade = createSideTerminalBrokerFacade(broker);
  let toggles = 0;
  const open = bench({ fixture: { key: 'live-replay' }, terminalBroker: broker }, { value: false }, () => { toggles++; });
  const pending = open();
  await Promise.resolve();
  assert.deepEqual(calls, [true]);
  assert.equal(toggles, 0);
  assert.equal(facade.state.enabled, false);
  acknowledge();
  await pending;
  assert.equal(toggles, 1);
  assert.equal(facade.state.enabled, true);
});

test('negative control: live and other fixture openers never opt into a broker', async () => {
  for (const fixture of [null, { key: 'side-terminal-open' }]) {
    const calls = [];
    const broker = { setEnabled: async enabled => calls.push(enabled), open: async () => ({ session: 's1' }) };
    let toggles = 0;
    await bench({ fixture, terminalBroker: broker }, { value: false }, () => { toggles++; })();
    assert.deepEqual(calls, []);
    assert.equal(createSideTerminalBrokerFacade(broker).state.enabled, false);
    assert.equal(toggles, 1);
  }
});

function raceBench(importFacade) {
  const state = { terminalOpen: { value: false }, creativeOpen: { value: false },
    multislotOpen: { value: false }, settingsOpen: { value: false }, hostOutcome: { value: null } };
  const code = source.slice(source.indexOf('let terminalGeneration ='), source.indexOf('\nconst terminalTop'))
    .replace("await import('./terminal/sideTerminalFacade.js')", 'await importFacade()');
  const actions = new Function('state', 'importFacade', `
    const { terminalOpen, creativeOpen, multislotOpen, settingsOpen, hostOutcome } = state;
    const props = { fixture: { key: 'live-replay' }, terminalBroker: {} };
    const hostActive = true, selectedSurface = { value: {} };
    ${code}; return { toggleTerminal, toggleCreative, toggleSettings, openMultislot };
  `)(state, importFacade);
  return { ...state, ...actions };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
for (const stage of ['import', 'enable']) {
  for (const action of ['toggleTerminal', 'toggleCreative', 'toggleSettings', 'openMultislot']) {
    test(`stale ${stage} completion cannot override newer ${action}`, async () => {
      const wait = deferred(); let enables = 0;
      const facades = { createSideTerminalBrokerFacade: () => ({ canEnable: true, state: { enabled: false },
        setEnabled: () => { enables++; return wait.promise; } }) };
      const app = raceBench(() => stage === 'import' ? wait.promise : Promise.resolve(facades));
      const pending = app.toggleTerminal(); await Promise.resolve(); await app[action]();
      const flags = [app.terminalOpen.value, app.creativeOpen.value, app.settingsOpen.value, app.multislotOpen.value];
      wait.resolve(facades); await pending;
      assert.deepEqual([app.terminalOpen.value, app.creativeOpen.value, app.settingsOpen.value, app.multislotOpen.value], flags);
      assert.equal(app.terminalOpen.value, false);
      assert.equal(enables, stage === 'import' ? 0 : 1);
      assert.equal(app.hostOutcome.value, null);
    });
  }
  test(`${stage} rejection is consumed and produces the typed refusal`, async () => {
    const app = raceBench(() => stage === 'import' ? Promise.reject(new Error('private import path')) : Promise.resolve({
      createSideTerminalBrokerFacade: () => ({ canEnable: true, state: { enabled: false }, setEnabled: async () => { throw new Error('private broker path'); } }),
    }));
    await assert.doesNotReject(app.toggleTerminal());
    assert.equal(app.terminalOpen.value, false);
    assert.deepEqual(app.hostOutcome.value, { code: 'HOST_REQUEST_REFUSED', message: 'This request is unavailable. Please try again.', tone: 'refusal' });
  });
  test(`stale ${stage} rejection leaves the newer screen untouched`, async () => {
    const wait = deferred();
    const app = raceBench(() => stage === 'import' ? wait.promise : Promise.resolve({
      createSideTerminalBrokerFacade: () => ({ canEnable: true, state: { enabled: false }, setEnabled: () => wait.promise }),
    }));
    const pending = app.toggleTerminal(); await Promise.resolve(); app.toggleSettings();
    wait.reject(new Error('private failure')); await assert.doesNotReject(pending);
    assert.equal(app.settingsOpen.value, true); assert.equal(app.hostOutcome.value, null);
  });
}
