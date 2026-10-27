/**
 * Lane M: mounted behaviour of the terminal lifecycle rows.
 *
 * Self-contained SFC harness (compile + custom renderer, no DOM), mirroring
 * the mvui-f1/mvui2 mount pattern. BrokerLaunchControls mounts with a scripted
 * broker; MultislotHost mounts with stubbed kit children, registry and pump
 * doubles plus the REAL lifecycle helpers. Real facade, gate, pump and
 * provider semantics stay covered by the existing mvui2-terminal-broker,
 * mvui-multislot-gate, mvui-multislot-attach and mvui-f1-lifecycle suites,
 * which re-run against these templates after integration.
 *
 * @module mvui5-terminal-panels.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { SidebarIcon, UiButton, rendererElement } from './mvui2-terminal-mount.mjs';
import * as sideTerminal from '../src/terminal/sideTerminalFacade.js';

let serial = 0;
const flush = async () => {
  for (let i = 0; i < 16; i++) {
    await Promise.resolve();
    await vue.nextTick();
  }
};
const text = (n) => [n.text ?? '', ...(n.children ?? []).map(text)].join(' ');
const nodes = (n) => [n, ...(n.children ?? []).flatMap(nodes)];
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** @param {string} file @param {Record<string, unknown>} deps */
async function compileSfc(file, deps) {
  const { descriptor } = parse(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'));
  let code = compileScript(descriptor, { id: 'mvui5t', inlineTemplate: true }).content;
  code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') {
      return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('vue')).href));
    }
    assert.ok(spec in deps, `Unmapped SFC dependency: ${spec}`);
    return `const ${bindings.trim()} = globalThis.__mvui5tDeps[${JSON.stringify(spec)}];`;
  });
  globalThis.__mvui5tDeps = deps;
  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
  } finally {
    delete globalThis.__mvui5tDeps;
  }
}

/** @param {string} name @param {Record<string, any>} children */
function childStub(name, children) {
  return vue.defineComponent({
    inheritAttrs: false,
    setup(_, ctx) {
      children[name] = ctx;
      return () => vue.h('section', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? []));
    },
  });
}

/** @param {any} component @param {Record<string, any>} initial */
function mountComponent(component, initial = {}) {
  const props = vue.reactive(initial);
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: rendererElement,
    createText: (t) => ({ text: t }),
    createComment: (t) => ({ text: t }),
    insert(node, parent) {
      node.parent = parent;
      parent.children.push(node);
    },
    remove(node) {
      const list = node.parent?.children;
      if (list) list.splice(list.indexOf(node), 1);
    },
    setText(n, t) {
      n.text = t;
    },
    setElementText(n, t) {
      n.text = t;
    },
    patchProp(n, k, _old, v) {
      n.props[k] = v;
    },
    parentNode: (n) => n.parent,
    nextSibling: () => null,
    setScopeId() {},
  });
  const app = renderer.createApp({ setup: () => () => vue.h(component, props) });
  app.mount(root);
  return { app, props, root };
}

const shellEntries = () => [{ id: 'shell', label: 'System shell', hint: '', argv: [], command: 'shell' }];

/** @param {{ openImpl: (spec: any) => Promise<any> }} hooks */
function brokerFacadeDouble(hooks) {
  const opened = [];
  const closed = [];
  return {
    opened,
    closed,
    facade: {
      state: { enabled: true, busy: false },
      canEnable: false,
      canOpen: true,
      setEnabled: async () => {},
      open: async (spec) => {
        opened.push(spec);
        return hooks.openImpl(spec);
      },
      close: (request) => {
        closed.push(request);
      },
    },
  };
}

async function compileControls(entries, hooks) {
  const doubles = brokerFacadeDouble(hooks);
  const component = await compileSfc('terminal/BrokerLaunchControls.vue', {
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
    '../multislot/multislotProviders.js': { toKitMenuProviders: () => entries },
    './sideTerminalFacade.js': { createSideTerminalBrokerFacade: () => doubles.facade },
    './providers.js': { SHELL_COMMAND: 'shell', PROVIDER_COMMAND: 'provider' },
  });
  return { component, doubles };
}

test('broker launch shows pending mid-flight, then the typed opened outcome', async () => {
  const gate = deferred();
  const { component } = await compileControls(shellEntries(), { openImpl: () => gate.promise });
  const f = mountComponent(component, { broker: {} });
  try {
    await flush();
    assert.equal(nodes(f.root).find((n) => n.props?.role === 'status'), undefined, 'no status before launch');
    const button = nodes(f.root).find((n) => n.tag === 'button');
    const pending = button.props.onClick();
    await flush();
    const indicator = nodes(f.root).find((n) => n.props?.id === 'mv-terminal-broker-pending');
    assert.ok(indicator, 'pending row appears while open is in flight');
    assert.equal(indicator.props['data-semantic-anchor'], 'terminal/pending');
    assert.equal(indicator.props.role, 'status');
    assert.ok(text(f.root).includes('Starting session…'));
    gate.resolve({ session: 's1' });
    await pending;
    await flush();
    assert.equal(nodes(f.root).find((n) => n.props?.id === 'mv-terminal-broker-pending'), undefined, 'pending clears after settle');
    const outcome = nodes(f.root).find((n) => n.props?.id === 'mv-terminal-broker-outcome');
    assert.equal(outcome.props['data-outcome-code'], 'TERMINAL_OPENED');
    assert.equal(outcome.props.role, 'status');
  } finally {
    f.app.unmount();
  }
});

test('broker refusal is typed and never leaks raw host text', async () => {
  const raw = 'RAW-HOST-SECRET COMMAND_NOT_ALLOWED xyz';
  const { component } = await compileControls(shellEntries(), {
    openImpl: async () => {
      throw new Error(raw);
    },
  });
  const f = mountComponent(component, { broker: {} });
  try {
    await flush();
    await nodes(f.root).find((n) => n.tag === 'button').props.onClick();
    await flush();
    const outcome = nodes(f.root).find((n) => n.props?.id === 'mv-terminal-broker-outcome');
    assert.equal(outcome.props['data-outcome-code'], 'TERMINAL_LAUNCH_REFUSED');
    assert.ok(!text(f.root).includes('RAW-HOST-SECRET'), 'host text never reaches the row');
    assert.ok(!text(f.root).includes('COMMAND_NOT_ALLOWED'), 'host codes never reach the row');
    assert.equal(nodes(f.root).find((n) => n.props?.id === 'mv-terminal-broker-pending'), undefined);
  } finally {
    f.app.unmount();
  }
});

function sessionFacadeDouble(sessions) {
  const listeners = { data: new Set(), exit: new Set() };
  return {
    listeners,
    closed: [],
    facade: {
      capabilities: async () => ({ commands: [] }),
      attach: async () => ({ sessions }),
      onData: (fn) => {
        listeners.data.add(fn);
        return () => listeners.data.delete(fn);
      },
      onExit: (fn) => {
        listeners.exit.add(fn);
        return () => listeners.exit.delete(fn);
      },
      close: (request) => {},
      ack: () => {},
      write: () => {},
      dispose: () => {},
    },
  };
}

function pumpDoubleFactory(calls) {
  return (options) => {
    const attached = new Map();
    const pump = {
      attachSession: (item) => {
        if (!item || typeof item.session !== 'string' || item.session.length === 0) {
          throw new Error('Invalid terminal attachment');
        }
        calls.attached.push(item);
        attached.set(item.session, true);
        return item.session;
      },
      closeSession: (id) => {
        calls.closed.push(id);
        return attached.delete(id);
      },
      syncLease: () => {
        calls.leases += 1;
      },
      sessionIds: () => [...attached.keys()],
      dispose: () => {
        calls.disposed += 1;
      },
      fireExit: (sessionId, type) => options.onEvent({ type, sessionId }),
    };
    calls.pumps.push(pump);
    return pump;
  };
}

/** @param {{ sessions?: any[], openImpl?: ((spec: any) => Promise<any>) | null }} options */
async function mountHost(options = {}) {
  const children = {};
  const calls = { attached: [], closed: [], leases: 0, disposed: 0, pumps: [], brokerClosed: [] };
  const session = sessionFacadeDouble(
    options.sessions ?? [
      { session: 'one', command: 'session' },
      { session: 'two', command: 'session' },
    ],
  );
  const brokerDouble =
    options.openImpl === undefined
      ? null
      : {
          state: { enabled: true, busy: false },
          canOpen: true,
          open: (spec) => options.openImpl(spec),
          close: (request) => calls.brokerClosed.push(request),
        };
  const component = await compileSfc('multislot/MultislotHost.vue', {
    'capsule-ui-kit/ui': { UiButton },
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
    '@xterm/xterm': { Terminal: class {} },
    '@xterm/addon-fit': { FitAddon: class {} },
    '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue': childStub('slot', children),
    '/.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue': childStub('bar', children),
    'capsule-ui-kit/TerminalView': {
      createStreamRegistry: () => ({
        createSession() {},
        beginAttach() {},
        applyRestoreSnapshot() {},
        writeOutputChunk() {},
        setControlLease() {},
        disposeSession() {},
        forgetSession() {},
      }),
    },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
    '../terminal/BrokerLaunchControls.vue': childStub('broker', children),
    '../terminal/sideTerminalFacade.js': {
      createSideTerminalFacade: () => session.facade,
      createSideTerminalBrokerFacade: () => brokerDouble,
      normalizeTerminalOutcome: sideTerminal.normalizeTerminalOutcome,
      terminalLifecycleRefs: sideTerminal.terminalLifecycleRefs,
      toPaneSession: sideTerminal.toPaneSession,
    },
    './multislotInputGate.js': {
      normalizeMultislotInputMode: (mode) => (mode === 'write' ? 'write' : 'read'),
      leaseForInputMode: (mode) => mode === 'write',
      createGatedTerminalWriter: ({ facade }) => ({
        write: (input) => {
          facade.write(input);
          return { delivered: true, reason: '' };
        },
      }),
      buildMultislotFoldIntent: (op, id) => ({ op, slot: id }),
    },
    './multislotAttach.js': {
      MULTISLOT_ATTACH_EPOCH: 1,
      MULTISLOT_ATTACH_GENERATION: 1,
      createMultislotPump: pumpDoubleFactory(calls),
    },
    './multislotProviders.js': {
      CUSTOM_LAUNCH_ENTRY_ID: 'custom',
      LAUNCH_REFUSALS: {
        COMMAND_UNAVAILABLE: 'ERR_LAUNCH_COMMAND_UNAVAILABLE',
        ENTRY_UNKNOWN: 'ERR_LAUNCH_ENTRY_UNKNOWN',
        ARGV_REJECTED: 'ERR_LAUNCH_ARGV_REJECTED',
        NO_BROKER: 'ERR_LAUNCH_NO_BROKER',
      },
      PROVIDER_DATA_REFUSAL: 'ERR_PROVIDER_DATA_REJECTED',
      toKitMenuProviders: () => [{ id: 'shell', label: 'System shell', hint: '', argv: [], command: 'shell' }],
      validateLaunchRequest: (payload) =>
        payload?.command === 'session'
          ? { ok: true, launch: { entryId: 'shell', command: 'session', args: [], title: '', kind: '' } }
          : { ok: false, refusal: { code: 'ERR_LAUNCH_ENTRY_UNKNOWN', message: 'Unknown launch entry.' } },
    },
    './multislotCopy.js': { createCopyCapsuleId: () => ({ copy: async () => ({ state: 'copied', reason: '' }) }) },
  });
  return { component, children, calls };
}

const binding = () => ({ session: 'one', port: {} });

test('exited sessions keep removal semantics and raise a typed status notice', async () => {
  const { component, children, calls } = await mountHost();
  const f = mountComponent(component, { capsuleId: 'cap-01', terminalBinding: binding() });
  try {
    await flush();
    assert.deepEqual(children.slot.attrs.sessions.map((s) => s.sessionId), ['one', 'two']);
    assert.equal(nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-01-session-notice'), undefined);
    calls.pumps[0].fireExit('one', 'exited');
    await flush();
    assert.deepEqual(children.slot.attrs.sessions.map((s) => s.sessionId), ['two']);
    const notice = nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-01-session-notice');
    assert.ok(notice, 'exit raises the typed notice row');
    assert.equal(notice.props['data-semantic-anchor'], 'capsule/cap-01/session-notice');
    assert.equal(notice.props['data-outcome-code'], 'TERMINAL_SESSION_EXITED');
    assert.equal(notice.props.role, 'status');
    assert.ok(text(f.root).includes('Session ended.'));
    assert.ok(!text(f.root).includes('TERMINAL_'), 'codes stay in data attributes');
    const dismiss = nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-01-session-notice-dismiss');
    assert.equal(dismiss.props['data-semantic-anchor'], 'capsule/cap-01/session-notice-dismiss');
    assert.equal(dismiss.props['aria-label'], 'Dismiss session notice');
    await dismiss.props.onClick();
    await flush();
    assert.equal(nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-01-session-notice'), undefined);
  } finally {
    f.app.unmount();
  }
});

test('failed sessions raise a typed alert notice with designed text only', async () => {
  const { component, children, calls } = await mountHost();
  const f = mountComponent(component, { capsuleId: 'cap-01', terminalBinding: binding() });
  try {
    await flush();
    calls.pumps[0].fireExit('two', 'failed');
    await flush();
    const notice = nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-01-session-notice');
    assert.equal(notice.props.role, 'alert');
    assert.equal(notice.props['data-outcome-code'], 'TERMINAL_SESSION_FAILED');
    assert.ok(text(f.root).includes('Session ended unexpectedly.'));
    assert.deepEqual(children.slot.attrs.sessions.map((s) => s.sessionId), ['one']);
  } finally {
    f.app.unmount();
  }
});

test('launch shows pending, then attaches the broker session verbatim', async () => {
  const gate = deferred();
  const { component, children, calls } = await mountHost({ openImpl: () => gate.promise });
  const f = mountComponent(component, {
    capsuleId: 'cap-01',
    terminalBinding: binding(),
    terminalBroker: {},
    brokerCommands: ['session'],
  });
  try {
    await flush();
    children.slot.emit('launch-request', { entryId: 'shell', command: 'session', args: [] });
    await flush();
    const pending = nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-01-launch-pending');
    assert.ok(pending, 'pending row covers the launch window');
    assert.equal(pending.props['data-semantic-anchor'], 'capsule/cap-01/launch-pending');
    assert.equal(pending.props.role, 'status');
    gate.resolve({ session: 'sess-9' });
    await flush();
    await flush();
    assert.equal(nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-01-launch-pending'), undefined);
    assert.deepEqual(children.slot.attrs.sessions.map((s) => s.sessionId), ['one', 'two', 'sess-9']);
    assert.deepEqual(children.slot.attrs.sessions[2], {
      sessionId: 'sess-9',
      title: 'sess-9',
      kind: '',
      activity: 'unknown',
    });
    assert.deepEqual(calls.attached[calls.attached.length - 1], { session: 'sess-9', command: 'session' });
  } finally {
    f.app.unmount();
  }
});

test('attached records keep broker titles and kinds, falling back to the id', async () => {
  const { component, children } = await mountHost({
    sessions: [{ session: 'sess-9', command: 'session', title: 'Shell', kind: 'shell' }],
  });
  const f = mountComponent(component, { capsuleId: 'cap-01', terminalBinding: binding() });
  try {
    await flush();
    assert.deepEqual(children.slot.attrs.sessions, [
      { sessionId: 'sess-9', title: 'Shell', kind: 'shell', activity: 'unknown' },
    ]);
  } finally {
    f.app.unmount();
  }
});

test('READ mode projects no control lease, WRITE mode projects the lease', async () => {
  const { component, children } = await mountHost();
  const f = mountComponent(component, { capsuleId: 'cap-01', inputMode: 'read' });
  try {
    await flush();
    assert.equal(children.slot.attrs['has-control-lease'], false);
    f.props.inputMode = 'write';
    await flush();
    assert.equal(children.slot.attrs['has-control-lease'], true);
    f.props.inputMode = 'WRITE';
    await flush();
    assert.equal(children.slot.attrs['has-control-lease'], false, 'unknown modes fail closed to READ');
  } finally {
    f.app.unmount();
  }
});
