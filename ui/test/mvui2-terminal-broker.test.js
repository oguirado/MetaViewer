import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSideTerminalBrokerFacade } from '../src/terminal/sideTerminalFacade.js';
import * as sideTerminal from '../src/terminal/sideTerminalFacade.js';
import * as terminalProviders from '../src/terminal/providers.js';
import { compileSfc, mountComponent, nodes, flush, SidebarIcon } from './mvui2-terminal-mount.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** @param {Array<{ id: string, label: string, hint: string, argv: unknown, command: string }>} entries */
async function compileControls(entries) {
  return compileSfc('terminal/BrokerLaunchControls.vue', {
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
    '../multislot/multislotProviders.js': { toKitMenuProviders: () => entries },
    './sideTerminalFacade.js': sideTerminal,
    './providers.js': terminalProviders,
  });
}

const shellEntry = () => [{ id: 'shell', label: 'System shell', hint: '', argv: [], command: 'shell' }];

test('B1.1: broker open holds busy across the pending window', async () => {
  const gate = deferred();
  const seen = [];
  const broker = {
    open: async (spec) => { seen.push(spec); await gate.promise; return { session: 's1' }; },
    setEnabled: async () => {},
    close: () => {},
  };
  const facade = createSideTerminalBrokerFacade(broker);
  assert.equal(facade.state.enabled, false);
  await facade.setEnabled(true);
  assert.equal(facade.state.busy, false);
  const pending = facade.open({ command: 'shell', args: [], cols: 80, rows: 24 });
  assert.equal(facade.state.busy, true, 'open holds busy while pending');
  await assert.rejects(facade.open({ command: 'shell', args: [], cols: 80, rows: 24 }), /Terminal launch unavailable/);
  await assert.rejects(facade.setEnabled(false), /Terminal access unavailable/);
  gate.resolve();
  assert.deepEqual(await pending, { session: 's1' });
  assert.equal(facade.state.busy, false, 'busy releases after settle');
  assert.equal(seen.length, 1);
});

test('B1.1: busy releases when open rejects', async () => {
  const broker = { open: async () => { throw new Error('host refused'); } };
  const facade = createSideTerminalBrokerFacade(broker);
  assert.equal(facade.state.enabled, true, 'no opt-in method means already authorized');
  await assert.rejects(facade.open({ command: 'shell', args: [], cols: 80, rows: 24 }), /host refused/);
  assert.equal(facade.state.busy, false);
});

test('B1.2: a session resolving after disable is closed, never reported opened', async () => {
  const gate = deferred();
  const closed = [];
  const broker = { open: () => gate.promise, close: (p) => closed.push(p) };
  const Menu = await compileControls(shellEntry());
  const f = mountComponent(Menu, { broker });
  try {
    await flush();
    const button = nodes(f.root).find((n) => n.tag === 'button');
    const pending = button.props.onClick();
    await flush();
    createSideTerminalBrokerFacade(broker).state.enabled = false;
    gate.resolve({ session: 'late' });
    await pending;
    await flush();
    assert.deepEqual(closed, [{ session: 'late' }]);
    assert.equal(nodes(f.root).find((n) => n.props?.role === 'status'), undefined);
  } finally { f.app.unmount(); }
});

test('B1.2: an enabled broker reports the session opened (control)', async () => {
  const closed = [];
  const broker = { open: async () => ({ session: 'new' }), close: (p) => closed.push(p) };
  const Menu = await compileControls(shellEntry());
  const f = mountComponent(Menu, { broker });
  try {
    await flush();
    const button = nodes(f.root).find((n) => n.tag === 'button');
    await button.props.onClick();
    await flush();
    assert.deepEqual(closed, []);
    const status = nodes(f.root).find((n) => n.props?.role === 'status');
    assert.equal(status.props['data-outcome-code'], 'TERMINAL_OPENED');
  } finally { f.app.unmount(); }
});

test('B1.3: launch forwards [] for a row with missing argv instead of throwing', async () => {
  const opened = [];
  const broker = { open: async (spec) => { opened.push(spec); return { session: 's9' }; }, close: () => {} };
  const Menu = await compileControls([{ id: 'broken', label: 'Broken', hint: '', argv: undefined, command: 'provider' }]);
  const f = mountComponent(Menu, { broker });
  try {
    await flush();
    const button = nodes(f.root).find((n) => n.tag === 'button');
    assert.equal(button.props.disabled, false);
    await button.props.onClick();
    await flush();
    assert.deepEqual(opened, [{ command: 'provider', args: [], cols: 80, rows: 24 }]);
    const status = nodes(f.root).find((n) => n.props?.role === 'status');
    assert.equal(status.props['data-outcome-code'], 'TERMINAL_OPENED');
  } finally { f.app.unmount(); }
});

test('B1.3: well-formed rows still forward their argv (control)', async () => {
  const opened = [];
  const broker = { open: async (spec) => { opened.push(spec); return { session: 's9' }; }, close: () => {} };
  const Menu = await compileControls([{ id: 'pro', label: 'Pro', hint: '', argv: ['exe', '--x'], command: 'provider' }]);
  const f = mountComponent(Menu, { broker });
  try {
    await flush();
    const button = nodes(f.root).find((n) => n.tag === 'button');
    await button.props.onClick();
    await flush();
    assert.deepEqual(opened, [{ command: 'provider', args: ['exe', '--x'], cols: 80, rows: 24 }]);
  } finally { f.app.unmount(); }
});

test('B1.3: the legacy spread throws on the same row (negative control)', () => {
  const entry = { id: 'broken', argv: undefined };
  assert.throws(() => [...entry.argv], TypeError);
});

test('B1.4: a broker swap mid-enable leaves the previous outcome untouched', async () => {
  const gate = deferred();
  const brokerA = { setEnabled: () => gate.promise, open: async () => { throw new Error('nope'); }, close: () => {} };
  const brokerB = { setEnabled: async () => {}, open: async () => ({ session: 'b' }), close: () => {} };
  const Menu = await compileControls(shellEntry());
  const f = mountComponent(Menu, { broker: brokerA });
  try {
    await flush();
    const button = nodes(f.root).find((n) => n.tag === 'button');
    await button.props.onClick();
    await flush();
    assert.equal(nodes(f.root).find((n) => n.props?.role === 'status').props['data-outcome-code'], 'TERMINAL_LAUNCH_REFUSED');
    const input = nodes(f.root).find((n) => n.tag === 'input');
    const enabling = input.props.onChange({ target: { checked: true } });
    await flush();
    f.props.broker = brokerB;
    await flush();
    gate.resolve();
    await enabling;
    await flush();
    const status = nodes(f.root).find((n) => n.props?.role === 'status');
    assert.equal(status.text, 'This terminal launch is unavailable.', 'stale enable must not clear the refusal');
  } finally { f.app.unmount(); }
});

test('B1.4: enable without a swap clears the outcome (control)', async () => {
  const broker = { setEnabled: async () => {}, open: async () => { throw new Error('nope'); }, close: () => {} };
  const Menu = await compileControls(shellEntry());
  const f = mountComponent(Menu, { broker });
  try {
    await flush();
    const button = nodes(f.root).find((n) => n.tag === 'button');
    await button.props.onClick();
    await flush();
    assert.ok(nodes(f.root).find((n) => n.props?.role === 'status'));
    const input = nodes(f.root).find((n) => n.tag === 'input');
    await input.props.onChange({ target: { checked: true } });
    await flush();
    assert.equal(nodes(f.root).find((n) => n.props?.role === 'status'), undefined);
    assert.equal(nodes(f.root).find((n) => n.tag === 'input').props.checked, true);
  } finally { f.app.unmount(); }
});

test('launch controls keep the narrow provider import contract', () => {
  const controls = readFileSync(new URL('../src/terminal/BrokerLaunchControls.vue', import.meta.url), 'utf8');
  assert.ok(controls.includes("from './providers.js'"));
  assert.ok(!controls.includes('resolveBrokerLaunchArgs'), 'no new provider import: w-host stubs only SHELL/PROVIDER_COMMAND');
});
