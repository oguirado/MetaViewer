import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFixedCall,
  createPreloadFacade,
  CHANNELS,
  PRELOAD_METHODS,
  IPC_BOUNDS,
  ContractError,
} from '../electron/preload.js';

test('assertFixedCall refuses off-set channels, non-array args, and bounded save payloads', () => {
  // Positive witness for load
  const loadCall = assertFixedCall(CHANNELS.load, []);
  assert.equal(loadCall.channel, CHANNELS.load);
  assert.deepEqual(loadCall.args, []);

  // Positive witness for save
  const validSavePayload = JSON.stringify({ key: 'value' });
  const saveCall = assertFixedCall(CHANNELS.save, [validSavePayload]);
  assert.equal(saveCall.channel, CHANNELS.save);
  assert.deepEqual(saveCall.args, [validSavePayload]);

  // 1. Off-set channels
  for (const badChannel of ['metaviewer:invalid', 'metaviewer:layout.delete', '', 'LOAD', 'SAVE']) {
    assert.throws(
      () => assertFixedCall(badChannel, []),
      (err) => err instanceof ContractError && err.code === 'CHANNEL'
    );
  }

  // 2. Non-array args
  for (const badArgs of [null, undefined, 'not-an-array', 123, { 0: 'a', length: 1 }]) {
    assert.throws(
      () => assertFixedCall(CHANNELS.load, badArgs),
      (err) => err instanceof ContractError && err.code === 'ARGS'
    );
  }

  // Arity violations
  assert.throws(
    () => assertFixedCall(CHANNELS.load, ['extra']),
    (err) => err instanceof ContractError && err.code === 'ARGS'
  );
  assert.throws(
    () => assertFixedCall(CHANNELS.save, []),
    (err) => err instanceof ContractError && err.code === 'ARGS'
  );
  assert.throws(
    () => assertFixedCall(CHANNELS.save, ['p1', 'p2']),
    (err) => err instanceof ContractError && err.code === 'ARGS'
  );

  // 3. Save payload over 256KiB in bytes but under it in chars
  // 3 bytes per Euro symbol '€' (U+20AC).
  // 100,000 Euro chars = 100,000 length, but 300,000 UTF-8 bytes (> 256 * 1024 = 262,144 bytes).
  const multibyteOverCap = '€'.repeat(100000);
  assert.ok(multibyteOverCap.length < IPC_BOUNDS.maxLayoutBytes); // char count is 100,000 < 262,144
  assert.throws(
    () => assertFixedCall(CHANNELS.save, [multibyteOverCap]),
    (err) => err instanceof ContractError && err.code === 'PAYLOAD'
  );

  // 4. Lone surrogates handling
  const loneSurrogate = '\uD800';
  // Char count is 1, utf8Bytes produces 3 bytes, under 256KiB cap
  const surrogateCall = assertFixedCall(CHANNELS.save, [loneSurrogate]);
  assert.equal(surrogateCall.args[0], '\uD800');

  // Lone surrogate over cap
  const loneSurrogatesOverCap = '\uD800'.repeat(100000);
  assert.throws(
    () => assertFixedCall(CHANNELS.save, [loneSurrogatesOverCap]),
    (err) => err instanceof ContractError && err.code === 'PAYLOAD'
  );
});

test('createPreloadFacade refuses malformed deps and accessor tricks with zero transport calls', async () => {
  let transportCallCount = 0;
  const dummyTransport = {
    invoke: async () => {
      transportCallCount += 1;
      return true;
    },
  };

  // 5. Prototype-polluted and accessor deps
  const accessorDeps = Object.defineProperty({ bridge: { exposeInMainWorld() {} } }, 'transport', {
    get() {
      return dummyTransport;
    },
    enumerable: true,
  });

  assert.throws(
    () => createPreloadFacade(accessorDeps),
    (err) => err instanceof ContractError && err.code === 'DEPS'
  );

  // 6. Symbol keys in deps
  const symbolDeps = {
    transport: dummyTransport,
    bridge: { exposeInMainWorld() {} },
    [Symbol('extra')]: 'value',
  };

  assert.throws(
    () => createPreloadFacade(symbolDeps),
    (err) => err instanceof ContractError && err.code === 'DEPS'
  );

  assert.equal(transportCallCount, 0, 'Transport must never be invoked on malformed deps refusal');
});

test('PRELOAD exported constants are frozen and immutable', () => {
  // 7. Frozen-export mutation
  assert.throws(() => {
    // @ts-ignore
    CHANNELS.extra = 'widened';
  });
  assert.throws(() => {
    // @ts-ignore
    PRELOAD_METHODS.push('extra');
  });
  assert.throws(() => {
    // @ts-ignore
    IPC_BOUNDS.maxLayoutBytes = 1000000;
  });
});

test('createPreloadFacade load/save reply handling and zero transport call on invalid ingress', async () => {
  let invokeCalls = [];
  let invokeResult = null;

  const mockTransport = {
    invoke: async (channel, args) => {
      invokeCalls.push({ channel, args });
      if (invokeResult instanceof Error) {
        throw invokeResult;
      }
      return invokeResult;
    },
  };

  const mockBridge = {
    exposeInMainWorld() {},
  };

  const facade = createPreloadFacade({ transport: mockTransport, bridge: mockBridge });

  // Negative ingress check: invalid arg to save makes ZERO transport calls
  invokeCalls = [];
  assert.throws(
    // @ts-ignore
    () => facade.save(12345),
    (err) => err instanceof ContractError && err.code === 'PAYLOAD'
  );
  assert.equal(invokeCalls.length, 0, 'Zero transport calls on invalid ingress');

  // 8. Load replies: malformed responses (undefined, 0, {}, over-cap string)
  for (const badReply of [undefined, 0, 123, {}, [], true, false, '€'.repeat(100000)]) {
    invokeCalls = [];
    invokeResult = badReply;
    await assert.rejects(
      () => facade.load(),
      (err) => err instanceof ContractError && err.code === 'OUTCOME',
      `Load reply ${JSON.stringify(badReply)} must reject with OUTCOME`
    );
  }

  // Positive load reply
  invokeResult = '{"valid":"json"}';
  const loaded = await facade.load();
  assert.equal(loaded, '{"valid":"json"}');

  // Positive load reply null
  invokeResult = null;
  const loadedNull = await facade.load();
  assert.equal(loadedNull, null);

  // 9. Save replies: malformed responses (1, 'true', truthy objects, null)
  for (const badReply of [1, 'true', {}, [], '1', null, undefined, false]) {
    invokeCalls = [];
    invokeResult = badReply;
    await assert.rejects(
      () => facade.save('{"test":true}'),
      (err) => err instanceof ContractError && err.code === 'OUTCOME',
      `Save reply ${JSON.stringify(badReply)} must reject with OUTCOME`
    );
  }

  // Positive save reply
  invokeResult = true;
  const saved = await facade.save('{"test":true}');
  assert.equal(saved, true);
});
