/**
 * W1-WALL-INTENTS: closed, frozen intent builders for the capsule wall.
 *
 * Presentation only: builders validate closed inputs and delegate wire
 * encoding to injected host encoders, which own the surface-to-slot mapping
 * and request correlation. This module never touches disk, network, or
 * clipboard, never invents correlation ids, and offers no surface creation
 * or teardown path. Domain admission stays in the core.
 */

/**
 * @typedef {Readonly<{code: string, message: string}>} AdmissionError
 * @typedef {Readonly<{ok: true, id: string}> | Readonly<{ok: false, error: AdmissionError}>} CapsuleIdResult
 * @typedef {Readonly<{op: 'fold' | 'unfold' | 'pin', surfaceId: string, pinned?: boolean}>} UiIntentRequest
 * @typedef {Readonly<{op: 'take_control' | 'release_control', surfaceId: string}>} ControlRequest
 * @typedef {Readonly<Record<string, unknown>>} UiIntentBody
 * @typedef {Readonly<Record<string, unknown>>} SurfaceRequestBody
 * @typedef {Readonly<{type: 'close' | 'hide' | 'show' | 'float' | 'dock-back', capsuleId: string}>} LocalPresentationIntent
 */

/**
 * @typedef {object} WallIntentOptions
 * @property {(request: UiIntentRequest) => unknown} encodeUiIntent Host encoder for ui_intent/v0.2 bodies.
 * @property {(request: ControlRequest) => unknown} encodeControl Host encoder for surface_request/v0.2 bodies.
 */

/**
 * @typedef {object} WallIntentBuilders
 * @property {(input: unknown) => UiIntentBody} visibility Protocol visibility intents (fold, unfold, pin).
 * @property {(input: unknown) => SurfaceRequestBody} control Protocol control intents (take_control, release_control).
 * @property {(input: unknown) => LocalPresentationIntent} presentation Local-only workspace intents.
 */

/** @type {ReadonlyArray<'fold' | 'unfold' | 'pin'>} */
const VISIBILITY_VERBS = Object.freeze(['fold', 'unfold', 'pin']);

/** @type {ReadonlyArray<'take_control' | 'release_control'>} */
const CONTROL_VERBS = Object.freeze(['take_control', 'release_control']);

/** @type {ReadonlyArray<'close' | 'hide' | 'show' | 'float' | 'dock-back'>} */
const PRESENTATION_VERBS = Object.freeze(['close', 'hide', 'show', 'float', 'dock-back']);

/** @type {ReadonlyArray<string>} */
const REGISTRY_KEYS = Object.freeze(['windowId', 'epoch', 'generation']);

/** @type {ReadonlyArray<string>} */
const EXPORTER_KEYS = Object.freeze(['reviewedProducer', 'exporter', 'exportState', 'laneProducer', 'retailMode']);

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function throwIntentError(code, message) {
  const err = /** @type {Error & {code: string}} */ (new Error(`${code}: ${message}`));
  err.code = code;
  throw err;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {Record<string, unknown>} input
 * @param {ReadonlyArray<string>} allowed
 * @returns {void}
 */
function assertClosedKeys(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throwIntentError('ERR_UNKNOWN_INTENT_KEY', `unknown intent key "${key}"`);
    }
  }
}

/**
 * @template {string} T
 * @param {unknown} verb
 * @param {ReadonlyArray<T>} allowed
 * @param {string} what
 * @returns {T}
 */
function requireVerb(verb, allowed, what) {
  if (typeof verb !== 'string' || !/** @type {ReadonlyArray<string>} */ (allowed).includes(verb)) {
    throwIntentError('ERR_UNKNOWN_INTENT_TYPE', `${what} must be one of ${allowed.join('|')}`);
  }
  return /** @type {T} */ (verb);
}

/**
 * Freezes before recursing so shared references terminate.
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  const record = /** @type {Record<PropertyKey, unknown>} */ (value);
  for (const key of Reflect.ownKeys(record)) deepFreeze(record[key]);
  return value;
}

/**
 * @param {Record<string, unknown>} value
 * @returns {Readonly<Record<string, unknown>>}
 */
function freezeOwnedCopy(value) {
  let owned;
  try {
    owned = structuredClone(value);
  } catch {
    throwIntentError('ERR_INVALID_INTENT_PAYLOAD', 'encoder result must be plain cloneable data');
  }
  return /** @type {Readonly<Record<string, unknown>>} */ (deepFreeze(owned));
}

/**
 * Validates a host-issued immutable capsule id: non-empty, no whitespace,
 * never a bare numeric index, never a display-number credential.
 * @param {unknown} value
 * @returns {CapsuleIdResult}
 */
export function validateCapsuleId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: 'ERR_INVENTED_CAPSULE_ID',
        message: 'capsuleId must be provided by the host; the UI never invents one',
      },
    };
  }
  if (value !== value.trim() || /\s/.test(value)) {
    return {
      ok: false,
      error: {
        code: 'ERR_INVALID_IDENTITY',
        message: `capsuleId must not contain whitespace: "${value}"`,
      },
    };
  }
  if (/^\d+$/.test(value)) {
    return {
      ok: false,
      error: {
        code: 'ERR_NUMERIC_INDEX_ID',
        message: `capsuleId must not be a bare numeric index: "${value}"`,
      },
    };
  }
  if (value.startsWith(':') || /^display=/i.test(value)) {
    return {
      ok: false,
      error: {
        code: 'ERR_DISPLAY_CREDENTIAL_ID',
        message: `capsuleId must not be a display-number credential: "${value}"`,
      },
    };
  }
  return { ok: true, id: value };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireCapsuleId(value) {
  const checked = validateCapsuleId(value);
  if (checked.ok === false) throwIntentError(checked.error.code, checked.error.message);
  return checked.id;
}

/**
 * Creates the closed wall intent builders. Both encoders are required: a
 * missing encoder blocks every effect instead of falling back.
 * @param {unknown} options
 * @returns {WallIntentBuilders}
 */
export function createWallIntentBuilders(options) {
  if (!isPlainObject(options)) {
    throwIntentError('ERR_INVALID_INTENT_PAYLOAD', 'intent options must be an object');
  }
  assertClosedKeys(options, ['encodeUiIntent', 'encodeControl']);
  const encodeUiIntent = options.encodeUiIntent;
  const encodeControl = options.encodeControl;
  if (typeof encodeUiIntent !== 'function') {
    throwIntentError('ERR_INTENT_ENCODER_MISSING', 'encodeUiIntent encoder is required');
  }
  if (typeof encodeControl !== 'function') {
    throwIntentError('ERR_INTENT_ENCODER_MISSING', 'encodeControl encoder is required');
  }

  /**
   * @param {unknown} input
   * @returns {UiIntentBody}
   */
  function visibility(input) {
    if (!isPlainObject(input)) {
      throwIntentError('ERR_INVALID_INTENT_PAYLOAD', 'visibility intent must be an object');
    }
    const verb = requireVerb(input.verb, VISIBILITY_VERBS, 'visibility verb');
    assertClosedKeys(input, verb === 'pin' ? ['capsuleId', 'verb', 'pinned'] : ['capsuleId', 'verb']);
    const surfaceId = requireCapsuleId(input.capsuleId);
    /** @type {UiIntentRequest} */
    let request;
    if (verb === 'pin') {
      if (typeof input.pinned !== 'boolean') {
        throwIntentError('ERR_INVALID_INTENT_PAYLOAD', 'pin requires pinned:boolean');
      }
      request = Object.freeze({ op: verb, surfaceId, pinned: input.pinned });
    } else {
      request = Object.freeze({ op: verb, surfaceId });
    }
    const encoded = /** @type {(request: UiIntentRequest) => unknown} */ (encodeUiIntent)(request);
    if (!isPlainObject(encoded)) {
      throwIntentError('ERR_INVALID_INTENT_PAYLOAD', 'ui_intent encoder must return a plain object');
    }
    return freezeOwnedCopy(encoded);
  }

  /**
   * @param {unknown} input
   * @returns {SurfaceRequestBody}
   */
  function control(input) {
    if (!isPlainObject(input)) {
      throwIntentError('ERR_INVALID_INTENT_PAYLOAD', 'control intent must be an object');
    }
    const verb = requireVerb(input.verb, CONTROL_VERBS, 'control verb');
    assertClosedKeys(input, ['capsuleId', 'verb']);
    const surfaceId = requireCapsuleId(input.capsuleId);
    const request = Object.freeze({ op: verb, surfaceId });
    const encoded = /** @type {(request: ControlRequest) => unknown} */ (encodeControl)(request);
    if (!isPlainObject(encoded)) {
      throwIntentError('ERR_INVALID_INTENT_PAYLOAD', 'control encoder must return a plain object');
    }
    return freezeOwnedCopy(encoded);
  }

  /**
   * @param {unknown} input
   * @returns {LocalPresentationIntent}
   */
  function presentation(input) {
    if (!isPlainObject(input)) {
      throwIntentError('ERR_INVALID_INTENT_PAYLOAD', 'presentation intent must be an object');
    }
    const verb = requireVerb(input.verb, PRESENTATION_VERBS, 'presentation verb');
    assertClosedKeys(input, ['capsuleId', 'verb']);
    return Object.freeze({ type: verb, capsuleId: requireCapsuleId(input.capsuleId) });
  }

  return Object.freeze({ visibility, control, presentation });
}

/**
 * Creates a retail-scoped control registry through an injected kit factory.
 * The factory is injected because the kit subpath resolves only through the
 * host build; a missing factory blocks creation instead of faking a registry.
 * Retail mode is forced and no producer contract is ever forwarded.
 * @param {unknown} config
 * @param {unknown} [dependencies]
 * @returns {unknown} The kit-owned registry, opaque to the wall.
 */
export function createWallControlRegistry(config, dependencies) {
  if (!isPlainObject(config)) {
    throwIntentError('ERR_INVALID_REGISTRY_CONFIG', 'registry config must be an object');
  }
  for (const key of Object.keys(config)) {
    if (EXPORTER_KEYS.includes(key)) {
      throwIntentError('ERR_REGISTRY_EXPORTER_FORBIDDEN', `registry key "${key}" would enable review export`);
    }
    if (!REGISTRY_KEYS.includes(key)) {
      throwIntentError('ERR_UNKNOWN_INTENT_KEY', `unknown registry key "${key}"`);
    }
  }
  const windowId = config.windowId;
  if (typeof windowId !== 'string' || windowId.length === 0 || /\s/.test(windowId)) {
    throwIntentError('ERR_INVALID_REGISTRY_CONFIG', 'windowId must be a non-empty string without whitespace');
  }
  const epoch = config.epoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
    throwIntentError('ERR_INVALID_REGISTRY_CONFIG', 'epoch must be a non-negative safe integer');
  }
  const generation = config.generation;
  if (generation === undefined) {
    throwIntentError('ERR_INVALID_REGISTRY_CONFIG', 'explicit current generation is required');
  }
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
    throwIntentError('ERR_STALE_GENERATION', 'generation must be a positive safe integer');
  }
  const factory = isPlainObject(dependencies) ? dependencies.createControlRegistry : undefined;
  if (typeof factory !== 'function') {
    throwIntentError('ERR_REGISTRY_UNAVAILABLE', 'kit control-registry factory is required');
  }
  return /** @type {(config: object) => unknown} */ (factory)(
    Object.freeze({ windowId, epoch, generation, retailMode: true }),
  );
}
