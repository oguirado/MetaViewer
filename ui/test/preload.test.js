/**
 * Tests for the bootstrap preload facade (`ui/electron/preload.js`).
 *
 * Runs under the repository `node --test` gate with fake transport/bridge
 * handles only; no Electron runtime is loaded. Each behaviour pairs a
 * positive witness with a negative control that must fail: malformed input
 * is refused before transport (zero fake calls) and inline mutant fixtures
 * fail the same inventory/parity assertions as a broken implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNELS,
  ContractError,
  FACADE_NAME,
  IPC_BOUNDS,
  PRELOAD_METHODS,
  assertFixedCall,
  createPreloadFacade,
  installPreload,
} from '../electron/preload.js';
import * as preloadModule from '../electron/preload.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = join(HERE, '..', 'electron', 'preload.js');
const MAIN_PATH = join(HERE, '..', 'electron', 'main.js');

/** Locked cap literal; must equal the implementation bound. */
const LOCKED_CAP = 262144;

/**
 * @typedef {object} FakeCall
 * @property {unknown} channel Recorded channel.
 * @property {unknown} args Recorded argument vector.
 * @property {unknown} receiver Recorded `this` at call time.
 */

/**
 * @typedef {object} FakeExposure
 * @property {unknown} name Recorded exposure name.
 * @property {unknown} api Recorded exposed object.
 * @property {unknown} receiver Recorded `this` at call time.
 */

/**
 * @param {unknown} reply Fixed reply, or a function producing one.
 * @returns {{ transport: { invoke: Function }, calls: Array<FakeCall> }}
 */
function makeFakeTransport(reply) {
  /** @type {Array<FakeCall>} */
  const calls = [];
  const transport = {
    /**
     * @param {unknown} channel Channel.
     * @param {unknown} args Argument vector.
     * @returns {Promise<unknown>} Fixed reply.
     */
    invoke(channel, args) {
      /** @type {FakeCall} */
      const record = { channel, args, receiver: this };
      calls.push(record);
      const outcome = typeof reply === 'function'
        ? /** @type {(channel: unknown, args: unknown) => unknown} */ (reply)(channel, args)
        : reply;
      return Promise.resolve(outcome);
    },
  };
  return { transport, calls };
}

/**
 * @returns {{ bridge: { exposeInMainWorld: Function }, exposures: Array<FakeExposure> }}
 */
function makeFakeBridge() {
  /** @type {Array<FakeExposure>} */
  const exposures = [];
  const bridge = {
    /**
     * @param {unknown} name Exposure name.
     * @param {unknown} api Exposed object.
     * @returns {void}
     */
    exposeInMainWorld(name, api) {
      exposures.push({ name, api, receiver: this });
    },
  };
  return { bridge, exposures };
}

/**
 * @param {unknown} reply Fake transport reply.
 * @returns {{ api: import('../electron/preload.js').MetaViewerFacade,
 *   transport: unknown, calls: Array<FakeCall>,
 *   bridge: unknown, exposures: Array<FakeExposure> }} Installed fakes.
 */
function installWithReply(reply) {
  const { transport, calls } = makeFakeTransport(reply);
  const { bridge, exposures } = makeFakeBridge();
  const api = createPreloadFacade({ transport, bridge });
  return { api, transport, calls, bridge, exposures };
}

/**
 * @param {Array<FakeCall>} calls Recorded calls.
 * @returns {FakeCall} The last recorded call.
 */
function lastCall(calls) {
  const found = calls[calls.length - 1];
  assert.ok(found);
  return found;
}

/**
 * @param {string} code Expected ContractError code.
 * @returns {(error: unknown) => boolean} Rejection/throw validator.
 */
function isCode(code) {
  return (/** @type {unknown} */ error) => error instanceof ContractError && error.code === code;
}

describe('exposure inventory', () => {
  it('exposes once under the fixed name with exactly load/save, frozen', () => {
    const { api, exposures } = installWithReply(null);
    assert.equal(exposures.length, 1);
    const first = exposures[0];
    assert.ok(first);
    assert.equal(first.name, FACADE_NAME);
    assert.equal(FACADE_NAME, 'metaviewer');
    assert.equal(first.api, api);
    assert.deepEqual(Object.keys(api).sort(), ['load', 'save']);
    assert.deepEqual([...PRELOAD_METHODS].sort(), ['load', 'save']);
    assert.ok(Object.isFrozen(api));
    for (const value of Object.values(api)) {
      assert.equal(typeof value, 'function');
    }
  });

  it('NEGATIVE: mutant facades fail the same inventory assertions', () => {
    const { api } = installWithReply(null);
    const checkInventory = (/** @type {unknown} */ candidate) => {
      assert.deepEqual(Object.keys(/** @type {Record<string, unknown>} */ (candidate)).sort(),
        ['load', 'save']);
      assert.ok(Object.isFrozen(candidate));
    };
    checkInventory(api);
    assert.throws(() => checkInventory({ load() {}, save() {}, invoke() {} }));
    assert.throws(() => checkInventory(Object.freeze({ load() {} })));
    assert.throws(() => checkInventory(Object.freeze({})));
    assert.throws(() => checkInventory({ load() {}, save() {} }));
  });
});

describe('factory dependency validation', () => {
  it('installs with valid fakes and preserves receiver binding', async () => {
    const { api, transport, calls, bridge, exposures } = installWithReply(null);
    assert.equal(await api.load(), null);
    assert.equal(lastCall(calls).receiver, transport);
    const first = exposures[0];
    assert.ok(first);
    assert.equal(first.receiver, bridge);
  });

  it('NEGATIVE: malformed deps refused with DEPS and zero exposure/invoke', () => {
    const { transport, calls } = makeFakeTransport(null);
    const { bridge, exposures } = makeFakeBridge();
    const withSymbols = { transport, bridge };
    /** @type {Record<PropertyKey, unknown>} */ (withSymbols)[Symbol('smuggle')] = 1;
    const withAccessor = { transport, bridge };
    Object.defineProperty(withAccessor, 'transport', {
      enumerable: true,
      get: () => transport,
    });
    const withGetterInvoke = {
      transport: {
        get invoke() {
          return () => Promise.resolve(null);
        },
      },
      bridge,
    };
    const inherited = Object.create({ transport, bridge });
    /** @type {Array<unknown>} */
    const mutants = [
      null,
      undefined,
      0,
      'deps',
      [],
      {},
      { transport },
      { bridge },
      { transport, bridge, extra: 1 },
      { transport: null, bridge },
      { transport, bridge: null },
      { transport: {}, bridge },
      { transport, bridge: {} },
      { transport: { invoke: 42 }, bridge },
      { transport, bridge: { exposeInMainWorld: 'yes' } },
      withSymbols,
      withAccessor,
      withGetterInvoke,
      inherited,
    ];
    for (const deps of mutants) {
      assert.throws(() => createPreloadFacade(deps), isCode('DEPS'));
    }
    assert.equal(exposures.length, 0);
    assert.equal(calls.length, 0);
  });
});

describe('method, channel and arity lock', () => {
  it('invokes each method on its literal channel with the exact vector', async () => {
    const { api, calls } = installWithReply(true);
    const loaded = installWithReply('{"profile":1}');
    assert.equal(await loaded.api.load(), '{"profile":1}');
    assert.equal(lastCall(loaded.calls).channel, 'metaviewer:layout.load');
    assert.deepEqual(lastCall(loaded.calls).args, []);
    assert.equal(await api.save('{}'), true);
    assert.equal(lastCall(calls).channel, 'metaviewer:layout.save');
    assert.deepEqual(lastCall(calls).args, ['{}']);
    assert.equal(CHANNELS.load, 'metaviewer:layout.load');
    assert.equal(CHANNELS.save, 'metaviewer:layout.save');
  });

  it('NEGATIVE: arity/shape/channel violations refused before transport', () => {
    const { api, calls } = installWithReply(true);
    assert.throws(() => api.load('extra'), isCode('ARGS'));
    assert.throws(() => api.save(), isCode('ARGS'));
    assert.throws(() => api.save('a', 'b'), isCode('ARGS'));
    assert.throws(() => api.save(123), isCode('PAYLOAD'));
    assert.throws(() => api.save(null), isCode('PAYLOAD'));
    assert.throws(() => api.save({}), isCode('PAYLOAD'));
    assert.throws(() => api.save(['{}']), isCode('PAYLOAD'));
    assert.throws(() => assertFixedCall('unknown:channel', []), isCode('CHANNEL'));
    assert.throws(() => assertFixedCall(null, []), isCode('CHANNEL'));
    assert.throws(() => assertFixedCall(CHANNELS.load, 'not-array'), isCode('ARGS'));
    assert.throws(() => assertFixedCall(CHANNELS.save, []), isCode('ARGS'));
    assert.equal(calls.length, 0);
  });

  it('NEGATIVE: exported constants frozen; allowlist not widened by mutation', () => {
    assert.ok(Object.isFrozen(CHANNELS));
    assert.ok(Object.isFrozen(PRELOAD_METHODS));
    assert.ok(Object.isFrozen(IPC_BOUNDS));
    assert.throws(() => {
      /** @type {Record<string, unknown>} */ (CHANNELS).evil = 'metaviewer:evil';
    }, TypeError);
    assert.equal('evil' in CHANNELS, false);
    assert.throws(() => assertFixedCall('metaviewer:evil', []), isCode('CHANNEL'));
  });
});

describe('UTF-8 ingress bounds', () => {
  it('accepts strings at the cap and forwards them without coercion', async () => {
    assert.equal(IPC_BOUNDS.maxLayoutBytes, LOCKED_CAP);
    const { api, calls } = installWithReply(true);
    const exact = 'a'.repeat(LOCKED_CAP);
    assert.equal(await api.save(exact), true);
    assert.deepEqual(lastCall(calls).args, [exact]);
  });

  it('NEGATIVE: over-cap ASCII refused with zero transport calls', () => {
    const { api, calls } = installWithReply(true);
    assert.throws(() => api.save('a'.repeat(LOCKED_CAP + 1)), isCode('PAYLOAD'));
    assert.equal(calls.length, 0);
  });

  it('NEGATIVE: multibyte over-cap refused while its char count looks fine', async () => {
    const { api, calls } = installWithReply(true);
    const over = 'é'.repeat(131073);
    assert.ok(over.length <= LOCKED_CAP);
    assert.ok(Buffer.byteLength(over, 'utf8') > LOCKED_CAP);
    assert.throws(() => api.save(over), isCode('PAYLOAD'));
    assert.equal(calls.length, 0);
    const exact = 'é'.repeat(131072);
    assert.equal(Buffer.byteLength(exact, 'utf8'), LOCKED_CAP);
    assert.equal(await api.save(exact), true);
  });

  it('NEGATIVE: surrogate and astral boundaries match the platform counter', async () => {
    const { api, calls } = installWithReply(true);
    const loneTrailAtCap = `${'a'.repeat(LOCKED_CAP - 3)}\udc00`;
    assert.equal(Buffer.byteLength(loneTrailAtCap, 'utf8'), LOCKED_CAP);
    assert.equal(await api.save(loneTrailAtCap), true);
    const before = calls.length;
    const loneLeadOver = `${'a'.repeat(LOCKED_CAP - 1)}\ud800`;
    assert.ok(Buffer.byteLength(loneLeadOver, 'utf8') > LOCKED_CAP);
    assert.throws(() => api.save(loneLeadOver), isCode('PAYLOAD'));
    const astralAtCap = '\u{1F600}'.repeat(65536);
    assert.equal(Buffer.byteLength(astralAtCap, 'utf8'), LOCKED_CAP);
    assert.equal(await api.save(astralAtCap), true);
    assert.throws(() => api.save('\u{1F600}'.repeat(65537)), isCode('PAYLOAD'));
    assert.equal(calls.length, before + 1);
  });
});

describe('input/output isolation', () => {
  it('returns a fresh frozen vector, never the caller array', () => {
    const caller = ['{}'];
    const admitted = assertFixedCall(CHANNELS.save, caller);
    assert.notStrictEqual(admitted.args, caller);
    assert.ok(Object.isFrozen(admitted.args));
    assert.deepEqual(admitted.args, ['{}']);
    caller[0] = 'MUTATED';
    caller.push('extra');
    assert.deepEqual(admitted.args, ['{}']);
    const empty = assertFixedCall(CHANNELS.load, []);
    assert.ok(Object.isFrozen(empty.args));
    assert.deepEqual(empty.args, []);
  });
});

describe('load outcomes', () => {
  it('passes null and bounded strings through unchanged', async () => {
    assert.equal(await installWithReply(null).api.load(), null);
    assert.equal(await installWithReply('{"a":1}').api.load(), '{"a":1}');
  });

  it('NEGATIVE: malformed replies never become null; failures reject', async () => {
    for (const bad of [undefined, 0, 42, true, false, {}, [], 'b'.repeat(LOCKED_CAP + 1)]) {
      await assert.rejects(installWithReply(bad).api.load(), isCode('OUTCOME'));
    }
    const boom = new Error('storage down');
    await assert.rejects(
      installWithReply(() => Promise.reject(boom)).api.load(),
      (/** @type {unknown} */ error) => error === boom,
    );
  });
});

describe('save acknowledgement', () => {
  it('resolves only after the real acknowledgement settles', async () => {
    /** @type {(value: unknown) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { api } = installWithReply(() => gate);
    let settled = false;
    const pending = api.save('{}').then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    assert.equal(settled, false);
    release(true);
    assert.equal(await pending, true);
  });

  it('NEGATIVE: non-true replies and rejection never become success', async () => {
    for (const bad of [false, null, undefined, 0, 1, 'true', {}, []]) {
      await assert.rejects(installWithReply(bad).api.save('{}'), isCode('OUTCOME'));
    }
    const boom = new Error('storage down');
    await assert.rejects(
      installWithReply(() => Promise.reject(boom)).api.save('{}'),
      (/** @type {unknown} */ error) => error === boom,
    );
  });
});

describe('capability confinement', () => {
  it('exposes no forbidden key on the object or its chain', () => {
    const { api } = installWithReply(null);
    const forbidden = ['invoke', 'send', 'sendSync', 'channel', 'transport', 'bridge',
      'path', 'handle', 'require', 'process', 'pid'];
    for (const key of forbidden) {
      assert.equal(key in api, false);
      assert.equal(Object.prototype.hasOwnProperty.call(api, key), false);
    }
    assert.equal(Object.getPrototypeOf(api), Object.prototype);
  });

  it('NEGATIVE: mutation and reference replacement reveal no transport', async () => {
    const { api, transport, calls, exposures } = installWithReply(null);
    assert.throws(() => {
      /** @type {Record<string, unknown>} */ (api).transport = transport;
    }, TypeError);
    assert.equal('transport' in api, false);
    assert.equal(calls.length, 0);
    /** @type {unknown} */
    let rendererRef = api;
    rendererRef = { load: () => Promise.resolve('spoofed') };
    assert.equal(calls.length, 0);
    assert.equal(exposures.length, 1);
    assert.notStrictEqual(rendererRef, api);
    assert.equal(await api.load(), null);
  });
});

describe('native entry qualification', () => {
  it('installs on electron handles with spread native invoke', async () => {
    /** @type {Array<FakeCall>} */
    const nativeCalls = [];
    /** @type {Array<FakeExposure>} */
    const exposures = [];
    /** @type {{ next: unknown }} */
    const state = { next: null };
    const contextBridge = {
      /**
       * @param {unknown} name Exposure name.
       * @param {unknown} api Exposed object.
       * @returns {void}
       */
      exposeInMainWorld(name, api) {
        exposures.push({ name, api, receiver: this });
      },
    };
    const ipcRenderer = {
      /**
       * @param {unknown} channel Channel.
       * @param {...unknown} args Spread arguments.
       * @returns {Promise<unknown>} Queued reply.
       */
      invoke(channel, ...args) {
        nativeCalls.push({ channel, args, receiver: this });
        return Promise.resolve(state.next);
      },
    };
    const api = installPreload({ contextBridge, ipcRenderer });
    assert.equal(exposures.length, 1);
    const first = exposures[0];
    assert.ok(first);
    assert.equal(first.name, 'metaviewer');
    assert.equal(first.api, api);
    state.next = '{"k":1}';
    assert.equal(await api.load(), '{"k":1}');
    assert.equal(nativeCalls.length, 1);
    const loadCall = nativeCalls[0];
    assert.ok(loadCall);
    assert.equal(loadCall.channel, 'metaviewer:layout.load');
    assert.deepEqual(loadCall.args, []);
    state.next = true;
    assert.equal(await api.save('{"k":1}'), true);
    assert.equal(nativeCalls.length, 2);
    const saveCall = nativeCalls[1];
    assert.ok(saveCall);
    assert.equal(saveCall.channel, 'metaviewer:layout.save');
    assert.deepEqual(saveCall.args, ['{"k":1}']);
    assert.equal(saveCall.receiver, ipcRenderer);
  });

  it('NEGATIVE: malformed electron handles refused before exposure', () => {
    const working = () => ({
      contextBridge: { exposeInMainWorld() {} },
      ipcRenderer: { invoke: () => Promise.resolve(null) },
    });
    const withGetter = working();
    Object.defineProperty(withGetter, 'contextBridge', {
      enumerable: true,
      get: () => working().contextBridge,
    });
    /** @type {Array<unknown>} */
    const mutants = [
      null,
      {},
      { contextBridge: working().contextBridge },
      { ipcRenderer: working().ipcRenderer },
      { contextBridge: {}, ipcRenderer: working().ipcRenderer },
      { contextBridge: working().contextBridge, ipcRenderer: {} },
      { contextBridge: working().contextBridge, ipcRenderer: { invoke: 42 } },
      withGetter,
    ];
    for (const electron of mutants) {
      assert.throws(() => installPreload(electron), isCode('DEPS'));
    }
  });

  it('ESM import has no installation side effects', () => {
    assert.equal(/** @type {Record<string, unknown>} */ (globalThis).metaviewer, undefined);
  });

  it('source hygiene: guarded entry, single exposure, no host handles', () => {
    const source = readFileSync(PRELOAD_PATH, 'utf8');
    assert.ok(source.includes("require('electron')"));
    assert.equal(source.match(/require\s*\(/g)?.length ?? 0, 1);
    assert.ok(source.indexOf('typeof require') < source.indexOf("require('electron')"));
    assert.ok(source.indexOf('typeof module') < source.indexOf("require('electron')"));
    assert.equal(source.match(/\.exposeInMainWorld\(/g)?.length ?? 0, 1);
    for (const token of ['from \'electron\'', 'from "electron"', 'import(', 'TextEncoder',
      '__dirname', '__filename', 'child_process']) {
      assert.equal(source.includes(token), false, `forbidden token: ${token}`);
    }
    for (const token of [/\bprocess\b/, /\bBuffer\b/, /\beval\s*\(/]) {
      assert.equal(token.test(source), false, `forbidden token: ${token}`);
    }
  });
});

describe('main parity', () => {
  it('matches the isolated main registry fixture; mutants fail', () => {
    const mainRegistry = Object.freeze({
      channels: Object.freeze({ load: 'metaviewer:layout.load', save: 'metaviewer:layout.save' }),
      maxLayoutBytes: 262144,
    });
    assert.deepEqual(CHANNELS, mainRegistry.channels);
    assert.equal(IPC_BOUNDS.maxLayoutBytes, mainRegistry.maxLayoutBytes);
    assert.throws(() => assert.deepEqual(CHANNELS,
      { load: 'metaviewer:layout.load', save: 'metaviewer:layout.store' }));
    assert.throws(() => assert.equal(IPC_BOUNDS.maxLayoutBytes, 1024));
  });

  it('no preload-to-main load; post-merge disk literals agree', () => {
    const source = readFileSync(PRELOAD_PATH, 'utf8');
    assert.equal(source.includes('./main'), false);
    assert.equal(source.includes('../main'), false);
    if (existsSync(MAIN_PATH)) {
      const main = readFileSync(MAIN_PATH, 'utf8');
      assert.ok(main.includes('metaviewer:layout.load'));
      assert.ok(main.includes('metaviewer:layout.save'));
      assert.ok(main.includes('262144') || main.includes('256 * 1024'));
    } else {
      assert.ok(true, 'main.js absent pre-merge; parity enforced via inline fixture');
    }
  });
});

describe('receiver handoff', () => {
  it('forwards opaque bounded strings without judging payload semantics', async () => {
    const { api, calls } = installWithReply(true);
    assert.equal(await api.save('not json {{{'), true);
    assert.deepEqual(lastCall(calls).args, ['not json {{{']);
  });
});

describe('export inventory', () => {
  it('exports exactly the specified surface', () => {
    assert.deepEqual(Object.keys(preloadModule).sort(), ['CHANNELS', 'ContractError',
      'FACADE_NAME', 'IPC_BOUNDS', 'PRELOAD_METHODS', 'assertFixedCall',
      'createPreloadFacade', 'installPreload']);
  });
});
