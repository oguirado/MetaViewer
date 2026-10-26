/**
 * W1-WALL-INTENTS suite: closed frozen intent builders plus retail registry.
 *
 * Runs under plain Node (`node --test`): no Electron, no kit import, no
 * network. Encoders and the kit factory arrive as injected stubs, so every
 * guard in `ui/src/core/intents.js` is proved without a backend.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWallControlRegistry,
  createWallIntentBuilders,
  validateCapsuleId,
} from '../src/core/intents.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(join(HERE, rel), 'utf8'));
const readSource = () => readFileSync(join(HERE, '../src/core/intents.js'), 'utf8');

function catchError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a coded error');
}

function stubEncoder(result) {
  const calls = [];
  const fn = (request) => {
    calls.push(request);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}

function stubRegistryFactory(sentinel) {
  const calls = [];
  const fn = (config) => {
    calls.push(config);
    return sentinel;
  };
  fn.calls = calls;
  return fn;
}

const uiIntentExample = readJson('../../contracts/examples/v0.2/ui_intent.valid.json');
const surfaceRequestExample = readJson('../../contracts/examples/v0.2/surface_request.valid.json');
const uiIntentSchema = readJson('../../contracts/v0.2/ui_intent.schema.json');
const surfaceRequestSchema = readJson('../../contracts/v0.2/surface_request.schema.json');
const schemaOps = (schema) => schema.oneOf.map((branch) => branch.properties.op.const);

const FOLD_BODY = {
  schema: 'ui_intent/v0.2',
  request_id: 'req-fold-1',
  op: 'fold',
  params: { slot_id: 'slot-7' },
};
const PIN_BODY = {
  schema: 'ui_intent/v0.2',
  request_id: 'req-pin-1',
  op: 'pin',
  params: { slot_id: 'slot-7', pinned: true },
};
const TAKE_BODY = {
  schema: 'surface_request/v0.2',
  op: 'take_control',
  params: { surface_id: 'surf-1', owner: 'human' },
};
const RELEASE_BODY = {
  schema: 'surface_request/v0.2',
  op: 'release_control',
  params: { surface_id: 'surf-1' },
};

describe('validateCapsuleId', () => {
  it('accepts a host-issued id', () => {
    assert.deepEqual(validateCapsuleId('surf-1'), { ok: true, id: 'surf-1' });
  });

  it('refuses empty and non-string ids without inventing one', () => {
    for (const value of ['', '   ', 7, null, undefined, {}, ['surf-1']]) {
      const result = validateCapsuleId(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_INVENTED_CAPSULE_ID');
    }
  });

  it('refuses leading, trailing, and internal whitespace', () => {
    for (const value of [' surf-1', 'surf-1 ', 'surf 1', 'surf\t1']) {
      const result = validateCapsuleId(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_INVALID_IDENTITY');
    }
  });

  it('refuses bare numeric indexes', () => {
    for (const value of ['0', '007', '42']) {
      const result = validateCapsuleId(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_NUMERIC_INDEX_ID');
    }
  });

  it('refuses display-number credentials', () => {
    for (const value of [':0', 'display=:0', 'DISPLAY=:1']) {
      const result = validateCapsuleId(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_DISPLAY_CREDENTIAL_ID');
    }
  });
});

describe('createWallIntentBuilders', () => {
  it('returns a frozen builders object with exactly three methods', () => {
    const builders = createWallIntentBuilders({
      encodeUiIntent: stubEncoder(FOLD_BODY),
      encodeControl: stubEncoder(TAKE_BODY),
    });
    assert.ok(Object.isFrozen(builders));
    assert.deepEqual(Object.keys(builders).sort(), ['control', 'presentation', 'visibility']);
  });

  it('blocks every effect when an encoder is missing', () => {
    for (const options of [{}, { encodeUiIntent: stubEncoder(FOLD_BODY) }, {
      encodeUiIntent: stubEncoder(FOLD_BODY),
      encodeControl: 'take',
    }]) {
      const err = catchError(() => createWallIntentBuilders(options));
      assert.equal(err.code, 'ERR_INTENT_ENCODER_MISSING');
    }
    const badShape = catchError(() => createWallIntentBuilders(null));
    assert.equal(badShape.code, 'ERR_INVALID_INTENT_PAYLOAD');
    const badKey = catchError(() => createWallIntentBuilders({
      encodeUiIntent: stubEncoder(FOLD_BODY),
      encodeControl: stubEncoder(TAKE_BODY),
      encodeDestroy: stubEncoder({}),
    }));
    assert.equal(badKey.code, 'ERR_UNKNOWN_INTENT_KEY');
  });

  it('builds a frozen fold body through the ui_intent encoder', () => {
    const encodeUiIntent = stubEncoder(structuredClone(FOLD_BODY));
    const builders = createWallIntentBuilders({
      encodeUiIntent,
      encodeControl: stubEncoder(TAKE_BODY),
    });
    const out = builders.visibility({ capsuleId: 'surf-1', verb: 'fold' });
    assert.deepEqual(out, FOLD_BODY);
    assert.ok(Object.isFrozen(out));
    assert.ok(Object.isFrozen(out.params));
    assert.deepEqual(encodeUiIntent.calls, [{ op: 'fold', surfaceId: 'surf-1' }]);
    assert.ok(Object.isFrozen(encodeUiIntent.calls[0]));
  });

  it('passes pin through only with a boolean flag', () => {
    const encodeUiIntent = stubEncoder(structuredClone(PIN_BODY));
    const builders = createWallIntentBuilders({
      encodeUiIntent,
      encodeControl: stubEncoder(TAKE_BODY),
    });
    const out = builders.visibility({ capsuleId: 'surf-1', verb: 'pin', pinned: true });
    assert.deepEqual(out, PIN_BODY);
    assert.deepEqual(encodeUiIntent.calls, [{ op: 'pin', surfaceId: 'surf-1', pinned: true }]);
    for (const input of [
      { capsuleId: 'surf-1', verb: 'pin' },
      { capsuleId: 'surf-1', verb: 'pin', pinned: 'yes' },
      { capsuleId: 'surf-1', verb: 'pin', pinned: 1 },
    ]) {
      const err = catchError(() => builders.visibility(input));
      assert.equal(err.code, 'ERR_INVALID_INTENT_PAYLOAD');
    }
    assert.equal(encodeUiIntent.calls.length, 1);
  });

  it('rejects unknown visibility verbs before encoding', () => {
    const encodeUiIntent = stubEncoder(FOLD_BODY);
    const builders = createWallIntentBuilders({
      encodeUiIntent,
      encodeControl: stubEncoder(TAKE_BODY),
    });
    for (const verb of ['destroy', 'create', 'move', 'tab', 'float', 'close', 'hide', 'show', 'dock-back', '']) {
      const err = catchError(() => builders.visibility({ capsuleId: 'surf-1', verb }));
      assert.equal(err.code, 'ERR_UNKNOWN_INTENT_TYPE');
    }
    assert.equal(encodeUiIntent.calls.length, 0);
  });

  it('rejects unknown visibility keys and bad ids before encoding', () => {
    const encodeUiIntent = stubEncoder(FOLD_BODY);
    const builders = createWallIntentBuilders({
      encodeUiIntent,
      encodeControl: stubEncoder(TAKE_BODY),
    });
    const badKey = catchError(() => builders.visibility({ capsuleId: 'surf-1', verb: 'fold', request_id: 'req-9' }));
    assert.equal(badKey.code, 'ERR_UNKNOWN_INTENT_KEY');
    const badId = catchError(() => builders.visibility({ capsuleId: '  ', verb: 'fold' }));
    assert.equal(badId.code, 'ERR_INVENTED_CAPSULE_ID');
    const badShape = catchError(() => builders.visibility('fold'));
    assert.equal(badShape.code, 'ERR_INVALID_INTENT_PAYLOAD');
    assert.equal(encodeUiIntent.calls.length, 0);
  });

  it('refuses non-object encoder results and never downgrades on encoder failure', () => {
    const badResult = stubEncoder('ok');
    const builders = createWallIntentBuilders({
      encodeUiIntent: badResult,
      encodeControl: stubEncoder(TAKE_BODY),
    });
    const err = catchError(() => builders.visibility({ capsuleId: 'surf-1', verb: 'fold' }));
    assert.equal(err.code, 'ERR_INVALID_INTENT_PAYLOAD');
    const mappingError = new Error('no surface-to-slot mapping');
    const failing = stubEncoder(mappingError);
    const blocked = createWallIntentBuilders({
      encodeUiIntent: failing,
      encodeControl: stubEncoder(TAKE_BODY),
    });
    assert.strictEqual(
      catchError(() => blocked.visibility({ capsuleId: 'surf-1', verb: 'fold' })),
      mappingError,
    );
  });

  it('returns an owned deep copy that the encoder cannot mutate later', () => {
    const mutable = structuredClone(FOLD_BODY);
    const builders = createWallIntentBuilders({
      encodeUiIntent: stubEncoder(mutable),
      encodeControl: stubEncoder(TAKE_BODY),
    });
    const out = builders.visibility({ capsuleId: 'surf-1', verb: 'fold' });
    mutable.params.slot_id = 'slot-9';
    mutable.params.injected = true;
    assert.deepEqual(out, FOLD_BODY);
    assert.throws(() => {
      out.params.slot_id = 'slot-9';
    }, TypeError);
  });

  it('builds take_control and release_control without renderer-supplied owner', () => {
    const encodeControl = stubEncoder(structuredClone(TAKE_BODY));
    const builders = createWallIntentBuilders({
      encodeUiIntent: stubEncoder(FOLD_BODY),
      encodeControl,
    });
    const take = builders.control({ capsuleId: 'surf-1', verb: 'take_control' });
    assert.deepEqual(take, TAKE_BODY);
    assert.ok(Object.isFrozen(take.params));
    assert.deepEqual(encodeControl.calls, [{ op: 'take_control', surfaceId: 'surf-1' }]);
    const releaseEncoder = stubEncoder(structuredClone(RELEASE_BODY));
    const releaseBuilders = createWallIntentBuilders({
      encodeUiIntent: stubEncoder(FOLD_BODY),
      encodeControl: releaseEncoder,
    });
    const release = releaseBuilders.control({ capsuleId: 'surf-1', verb: 'release_control' });
    assert.deepEqual(release, RELEASE_BODY);
    assert.deepEqual(releaseEncoder.calls, [{ op: 'release_control', surfaceId: 'surf-1' }]);
  });

  it('offers no create or teardown control path', () => {
    const encodeControl = stubEncoder(TAKE_BODY);
    const builders = createWallIntentBuilders({
      encodeUiIntent: stubEncoder(FOLD_BODY),
      encodeControl,
    });
    assert.ok(!('create' in builders) && !('destroy' in builders));
    for (const verb of ['create', 'destroy', 'fold', 'pin']) {
      const err = catchError(() => builders.control({ capsuleId: 'surf-1', verb }));
      assert.equal(err.code, 'ERR_UNKNOWN_INTENT_TYPE');
    }
    const badKey = catchError(() => builders.control({ capsuleId: 'surf-1', verb: 'take_control', owner: 'human' }));
    assert.equal(badKey.code, 'ERR_UNKNOWN_INTENT_KEY');
    assert.equal(encodeControl.calls.length, 0);
  });

  it('builds local presentation intents that never reach an encoder', () => {
    const encodeUiIntent = stubEncoder(FOLD_BODY);
    const encodeControl = stubEncoder(TAKE_BODY);
    const builders = createWallIntentBuilders({ encodeUiIntent, encodeControl });
    for (const verb of ['close', 'hide', 'show', 'float', 'dock-back']) {
      const out = builders.presentation({ capsuleId: 'surf-1', verb });
      assert.deepEqual(out, { type: verb, capsuleId: 'surf-1' });
      assert.ok(Object.isFrozen(out));
      assert.ok(!('op' in out) && !('schema' in out) && !('params' in out));
    }
    assert.equal(encodeUiIntent.calls.length, 0);
    assert.equal(encodeControl.calls.length, 0);
    for (const verb of ['fold', 'pin', 'take_control', 'move', 'tab', 'destroy']) {
      const err = catchError(() => builders.presentation({ capsuleId: 'surf-1', verb }));
      assert.equal(err.code, 'ERR_UNKNOWN_INTENT_TYPE');
    }
    const badKey = catchError(() => builders.presentation({ capsuleId: 'surf-1', verb: 'close', force: true }));
    assert.equal(badKey.code, 'ERR_UNKNOWN_INTENT_KEY');
    const badId = catchError(() => builders.presentation({ capsuleId: '42', verb: 'close' }));
    assert.equal(badId.code, 'ERR_NUMERIC_INDEX_ID');
  });

  it('matches the ratified v0.2 contract examples and op vocabulary', () => {
    assert.equal(uiIntentExample.schema, 'ui_intent/v0.2');
    assert.equal(surfaceRequestExample.schema, 'surface_request/v0.2');
    assert.equal(FOLD_BODY.schema, uiIntentExample.schema);
    assert.equal(PIN_BODY.schema, uiIntentExample.schema);
    assert.equal(TAKE_BODY.schema, surfaceRequestExample.schema);
    assert.equal(RELEASE_BODY.schema, surfaceRequestExample.schema);
    const uiOps = schemaOps(uiIntentSchema);
    for (const verb of ['fold', 'unfold', 'pin']) assert.ok(uiOps.includes(verb));
    const requestOps = schemaOps(surfaceRequestSchema);
    assert.ok(requestOps.includes('take_control'));
    assert.ok(requestOps.includes('release_control'));
  });

  it('contains no legacy wire target or teardown path', () => {
    const source = readSource();
    assert.ok(!source.includes('v0.1'));
    assert.ok(!source.includes('destroy'));
  });
});

describe('createWallControlRegistry', () => {
  it('delegates to the kit factory with retail mode forced', () => {
    const sentinel = Object.freeze({ windowId: 'window-main' });
    const factory = stubRegistryFactory(sentinel);
    const registry = createWallControlRegistry(
      { windowId: 'window-main', epoch: 3, generation: 2 },
      { createControlRegistry: factory },
    );
    assert.strictEqual(registry, sentinel);
    assert.deepEqual(factory.calls, [{
      windowId: 'window-main',
      epoch: 3,
      generation: 2,
      retailMode: true,
    }]);
    assert.deepEqual(Object.keys(factory.calls[0]).sort(), ['epoch', 'generation', 'retailMode', 'windowId']);
    assert.ok(Object.isFrozen(factory.calls[0]));
  });

  it('accepts the minimal epoch and generation', () => {
    const factory = stubRegistryFactory(Object.freeze({}));
    createWallControlRegistry(
      { windowId: 'window-main', epoch: 0, generation: 1 },
      { createControlRegistry: factory },
    );
    assert.equal(factory.calls.length, 1);
  });

  it('refuses exporter attempts and unknown keys before touching the kit', () => {
    const factory = stubRegistryFactory(Object.freeze({}));
    const deps = { createControlRegistry: factory };
    for (const extra of [
      { reviewedProducer: { reviewed: true } },
      { exporter: true },
      { retailMode: false },
    ]) {
      const err = catchError(() => createWallControlRegistry(
        { windowId: 'window-main', epoch: 0, generation: 1, ...extra },
        deps,
      ));
      assert.equal(err.code, 'ERR_REGISTRY_EXPORTER_FORBIDDEN');
    }
    const badKey = catchError(() => createWallControlRegistry(
      { windowId: 'window-main', epoch: 0, generation: 1, storage: {} },
      deps,
    ));
    assert.equal(badKey.code, 'ERR_UNKNOWN_INTENT_KEY');
    const badShape = catchError(() => createWallControlRegistry('window-main', deps));
    assert.equal(badShape.code, 'ERR_INVALID_REGISTRY_CONFIG');
    assert.equal(factory.calls.length, 0);
  });

  it('refuses missing and stale generations', () => {
    const factory = stubRegistryFactory(Object.freeze({}));
    const deps = { createControlRegistry: factory };
    const missing = catchError(() => createWallControlRegistry({ windowId: 'window-main', epoch: 0 }, deps));
    assert.equal(missing.code, 'ERR_INVALID_REGISTRY_CONFIG');
    for (const generation of [0, -1, 2.5, '2', Number.NaN]) {
      const err = catchError(() => createWallControlRegistry(
        { windowId: 'window-main', epoch: 0, generation },
        deps,
      ));
      assert.equal(err.code, 'ERR_STALE_GENERATION');
    }
    assert.equal(factory.calls.length, 0);
  });

  it('refuses bad window and epoch identity', () => {
    const factory = stubRegistryFactory(Object.freeze({}));
    const deps = { createControlRegistry: factory };
    for (const windowId of ['', 'has space', 42, null]) {
      const err = catchError(() => createWallControlRegistry({ windowId, epoch: 0, generation: 1 }, deps));
      assert.equal(err.code, 'ERR_INVALID_REGISTRY_CONFIG');
    }
    for (const epoch of [-1, 1.5, '3', Number.NaN]) {
      const err = catchError(() => createWallControlRegistry(
        { windowId: 'window-main', epoch, generation: 1 },
        deps,
      ));
      assert.equal(err.code, 'ERR_INVALID_REGISTRY_CONFIG');
    }
    assert.equal(factory.calls.length, 0);
  });

  it('blocks registry creation when the kit factory is absent', () => {
    const config = { windowId: 'window-main', epoch: 0, generation: 1 };
    for (const deps of [undefined, {}, { createControlRegistry: null }, { createControlRegistry: 'kit' }, 'kit']) {
      const err = catchError(() => createWallControlRegistry(config, deps));
      assert.equal(err.code, 'ERR_REGISTRY_UNAVAILABLE');
    }
  });
});
