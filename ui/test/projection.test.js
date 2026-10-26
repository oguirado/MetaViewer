/**
 * Wall projection admission: strict decode, shared admit path, read-only view.
 *
 * The production decoder is owned by the contracts/shell units; this suite
 * injects a strict test decoder that proves the wrapper contract end to end:
 * UTF-8 bytes, duplicate keys refused before object construction, ingress
 * caps, closed wrapper and closed rows. Runs under plain node --test.
 *
 * @module projection.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWallProjection, selectWallSurface } from '../src/core/projection.js';

const SCHEMA = 'surface/v0.1';
const QUERY = 'wall/surfaces/v1';
const LIMITS = Object.freeze({
  maxBytes: 65536,
  maxDepth: 16,
  maxKeys: 1024,
  maxStringLength: 4096,
  maxBatchRows: 64,
});

/** Closed envelope keys, mirroring the kit coordinator set. */
const ENVELOPE_KEYS = new Set([
  'schema',
  'epoch',
  'revision',
  'durableRevision',
  'baseRevision',
  'mode',
  'query',
  'projection',
]);
const PROJECTION_KEYS = new Set(['rows', 'upsertRows', 'removeRowIds']);
const ROW_KEYS = new Set([
  'id',
  'surfaceId',
  'backendLifecycle',
  'generation',
  'visibility',
  'control',
  'title',
  'aiSessionActivity',
  'attachmentState',
  'dispatchOutcome',
  'refusal',
]);
// Closed value sets cited from the selected kit 5-axis enums.
const LIFECYCLES = new Set(['active', 'standby', 'ceded', 'destroyed', 'lost']);
const VISIBILITIES = new Set(['folded', 'unfolded', 'pinned']);
const CONTROLS = new Set(['agent', 'human', 'shared']);
const ACTIVITIES = new Set([
  'unknown',
  'ready',
  'busy',
  'waiting-input',
  'waiting-permission',
  'exited',
  'failed',
]);
const ATTACHMENTS = new Set(['detached', 'attaching', 'restoring', 'live', 'disconnected']);
const OUTCOMES = new Set([
  'none',
  'admitting',
  'accepted',
  'executing',
  'completed-unverified',
  'verified',
  'refused',
  'uncertain',
  'cancelled',
]);

/**
 * @param {string} code
 * @param {string} message
 */
function refused(code, message) {
  return { ok: false, error: { code, message } };
}

/** @param {unknown} value */
function isPlainTestObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {unknown} value */
function isNonNegInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strict JSON reader: duplicate keys refuse before construction, every
 * number must be an exact safe integer, caps enforced while reading.
 * @param {string} text
 * @param {typeof LIMITS} limits
 */
function parseStrictJson(text, limits) {
  let pos = 0;
  let keys = 0;
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  function skipWs() {
    while (pos < text.length) {
      const c = text[pos];
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') break;
      pos += 1;
    }
  }
  function parseValue(depth) {
    if (depth > limits.maxDepth) {
      return fail('ERR_DEPTH_EXCEEDED', `nesting depth exceeds ${limits.maxDepth}`);
    }
    skipWs();
    const c = text[pos];
    if (c === '{') return parseObject(depth);
    if (c === '[') return parseArray(depth);
    if (c === '"') return parseString();
    if (c === 't' || c === 'f' || c === 'n') return parseLiteral();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return parseNumber();
    return fail('ERR_MALFORMED_JSON', `unexpected character at offset ${pos}`);
  }
  function parseObject(depth) {
    pos += 1;
    const out = {};
    const seen = new Set();
    skipWs();
    if (text[pos] === '}') {
      pos += 1;
      return { ok: true, value: out };
    }
    for (;;) {
      skipWs();
      if (text[pos] !== '"') {
        return fail('ERR_MALFORMED_JSON', `object key must be a string at offset ${pos}`);
      }
      const key = parseString();
      if (!key.ok) return key;
      if (seen.has(key.value)) {
        return fail('ERR_DUPLICATE_KEY', `duplicate key "${key.value}" refused before construction`);
      }
      seen.add(key.value);
      keys += 1;
      if (keys > limits.maxKeys) {
        return fail('ERR_TOO_MANY_KEYS', `key count exceeds ${limits.maxKeys}`);
      }
      skipWs();
      if (text[pos] !== ':') return fail('ERR_MALFORMED_JSON', `missing colon at offset ${pos}`);
      pos += 1;
      const val = parseValue(depth + 1);
      if (!val.ok) return val;
      out[key.value] = val.value;
      skipWs();
      if (text[pos] === ',') {
        pos += 1;
        continue;
      }
      if (text[pos] === '}') {
        pos += 1;
        return { ok: true, value: out };
      }
      return fail('ERR_MALFORMED_JSON', `missing comma or brace at offset ${pos}`);
    }
  }
  function parseArray(depth) {
    pos += 1;
    const out = [];
    skipWs();
    if (text[pos] === ']') {
      pos += 1;
      return { ok: true, value: out };
    }
    for (;;) {
      const val = parseValue(depth + 1);
      if (!val.ok) return val;
      out.push(val.value);
      skipWs();
      if (text[pos] === ',') {
        pos += 1;
        continue;
      }
      if (text[pos] === ']') {
        pos += 1;
        return { ok: true, value: out };
      }
      return fail('ERR_MALFORMED_JSON', `missing comma or bracket at offset ${pos}`);
    }
  }
  function parseString() {
    pos += 1;
    let out = '';
    for (;;) {
      if (pos >= text.length) return fail('ERR_MALFORMED_JSON', 'unterminated string');
      const c = text[pos];
      if (c === '"') {
        pos += 1;
        break;
      }
      if (c === '\\') {
        const e = text[pos + 1];
        if (e === 'u') {
          const hex = text.slice(pos + 2, pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            return fail('ERR_MALFORMED_JSON', 'bad unicode escape');
          }
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 6;
        } else if (e === '"' || e === '\\' || e === '/') {
          out += e;
          pos += 2;
        } else if (e === 'b') {
          out += '\b';
          pos += 2;
        } else if (e === 'f') {
          out += '\f';
          pos += 2;
        } else if (e === 'n') {
          out += '\n';
          pos += 2;
        } else if (e === 'r') {
          out += '\r';
          pos += 2;
        } else if (e === 't') {
          out += '\t';
          pos += 2;
        } else {
          return fail('ERR_MALFORMED_JSON', `bad escape at offset ${pos}`);
        }
      } else {
        out += c;
        pos += 1;
      }
      if (out.length > limits.maxStringLength) {
        return fail('ERR_STRING_TOO_LONG', `string exceeds ${limits.maxStringLength} characters`);
      }
    }
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)) {
      return fail('ERR_MALFORMED_JSON', 'lone surrogate refused');
    }
    return { ok: true, value: out };
  }
  function parseNumber() {
    const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(pos));
    if (!match) return fail('ERR_MALFORMED_JSON', `bad number at offset ${pos}`);
    const token = match[0];
    pos += token.length;
    if (match[2] !== undefined || match[3] !== undefined) {
      return fail('ERR_INEXACT_INTEGER', `non-integer number ${token} refused`);
    }
    const num = Number(token);
    if (!Number.isSafeInteger(num)) {
      return fail('ERR_INEXACT_INTEGER', `number ${token} is not a safe integer`);
    }
    return { ok: true, value: num };
  }
  function parseLiteral() {
    if (text.startsWith('true', pos)) {
      pos += 4;
      return { ok: true, value: true };
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return { ok: true, value: false };
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return { ok: true, value: null };
    }
    return fail('ERR_MALFORMED_JSON', `bad literal at offset ${pos}`);
  }
  const root = parseValue(1);
  if (!root.ok) return root;
  skipWs();
  if (pos !== text.length) return fail('ERR_MALFORMED_JSON', 'trailing characters after document');
  return root;
}

/**
 * Caps for pre-parsed object input; duplicate keys are unprovable there, so
 * production ingress takes raw bytes or text instead.
 * @param {unknown} value
 * @param {typeof LIMITS} limits
 */
function checkObjectCaps(value, limits) {
  let keys = 0;
  const seen = new WeakSet();
  function walk(node, depth) {
    if (depth > limits.maxDepth) {
      return refused('ERR_DEPTH_EXCEEDED', `nesting depth exceeds ${limits.maxDepth}`);
    }
    if (typeof node === 'string') {
      if (node.length > limits.maxStringLength) {
        return refused('ERR_STRING_TOO_LONG', `string exceeds ${limits.maxStringLength} characters`);
      }
      return { ok: true };
    }
    if (typeof node !== 'object' || node === null) {
      if (typeof node === 'number' && !Number.isSafeInteger(node)) {
        return refused('ERR_INEXACT_INTEGER', 'non-integer number refused');
      }
      if (typeof node !== 'number' && typeof node !== 'boolean' && node !== null) {
        return refused('ERR_INVALID_PAYLOAD_TYPE', `unsupported value type ${typeof node}`);
      }
      return { ok: true };
    }
    if (seen.has(node)) return refused('ERR_CIRCULAR_INPUT', 'circular input refused');
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const check = walk(item, depth + 1);
        if (!check.ok) return check;
      }
      return { ok: true };
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      return refused('ERR_INVALID_PAYLOAD_TYPE', 'non-plain object refused');
    }
    for (const key of Object.keys(node)) {
      keys += 1;
      if (keys > limits.maxKeys) {
        return refused('ERR_TOO_MANY_KEYS', `key count exceeds ${limits.maxKeys}`);
      }
      if (key.length > limits.maxStringLength) {
        return refused('ERR_STRING_TOO_LONG', 'object key exceeds string cap');
      }
      const check = walk(node[key], depth + 1);
      if (!check.ok) return check;
    }
    return { ok: true };
  }
  return walk(value, 1);
}

/**
 * @param {unknown} row
 * @param {number} index
 * @param {Set<string>} seenIds
 */
function validateTestRow(row, index, seenIds) {
  if (!isPlainTestObject(row)) return refused('ERR_MALFORMED_ROW', `row ${index} is not an object`);
  for (const key of Object.keys(row)) {
    if (!ROW_KEYS.has(key)) {
      return refused('ERR_UNKNOWN_ROW_KEY', `unknown row key "${key}" at index ${index}`);
    }
  }
  const id = row.id;
  if (typeof id !== 'string' || id.length === 0 || id !== id.trim() || /\s/.test(id)) {
    return refused('ERR_MALFORMED_ROW', `row ${index} id must be a token without whitespace`);
  }
  if (row.surfaceId !== id) {
    return refused('ERR_IDENTITY_MISMATCH', `row ${index} id and surfaceId diverge`);
  }
  if (seenIds.has(id)) {
    return refused('ERR_DUPLICATE_IDENTITY', `duplicate row id "${id}" at index ${index}`);
  }
  seenIds.add(id);
  if (!LIFECYCLES.has(row.backendLifecycle)) {
    return refused('ERR_MALFORMED_ROW', `row ${index} backendLifecycle refused`);
  }
  if (typeof row.generation !== 'number' || !Number.isSafeInteger(row.generation) || row.generation <= 0) {
    return refused('ERR_MALFORMED_ROW', `row ${index} generation must be a positive safe integer`);
  }
  if (!VISIBILITIES.has(row.visibility)) {
    return refused('ERR_MALFORMED_ROW', `row ${index} visibility refused`);
  }
  if (!CONTROLS.has(row.control)) {
    return refused('ERR_MALFORMED_ROW', `row ${index} control refused`);
  }
  if (row.title !== undefined && typeof row.title !== 'string') {
    return refused('ERR_MALFORMED_ROW', `row ${index} title must be a string`);
  }
  if (row.aiSessionActivity !== undefined && !ACTIVITIES.has(row.aiSessionActivity)) {
    return refused('ERR_MALFORMED_ROW', `row ${index} aiSessionActivity refused`);
  }
  if (row.attachmentState !== undefined && !ATTACHMENTS.has(row.attachmentState)) {
    return refused('ERR_MALFORMED_ROW', `row ${index} attachmentState refused`);
  }
  if (row.dispatchOutcome !== undefined && !OUTCOMES.has(row.dispatchOutcome)) {
    return refused('ERR_MALFORMED_ROW', `row ${index} dispatchOutcome refused`);
  }
  const refusal = row.refusal;
  if (refusal !== undefined && refusal !== null) {
    if (!isPlainTestObject(refusal)) {
      return refused('ERR_MALFORMED_ROW', `row ${index} refusal must be an object or null`);
    }
    const refusalKeys = Object.keys(refusal);
    if (
      refusalKeys.length !== 2 ||
      typeof refusal.code !== 'string' ||
      typeof refusal.message !== 'string'
    ) {
      return refused('ERR_MALFORMED_ROW', `row ${index} refusal must carry string code and message`);
    }
  }
  return { ok: true };
}

/**
 * @param {unknown} value
 * @param {typeof LIMITS} limits
 */
function validateTestEnvelope(value, limits) {
  if (!isPlainTestObject(value)) {
    return refused('ERR_INVALID_ENVELOPE', 'envelope must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.has(key)) {
      return refused('ERR_UNKNOWN_ENVELOPE_KEY', `unknown envelope key "${key}"`);
    }
  }
  if (typeof value.schema !== 'string' || value.schema.length === 0) {
    return refused('ERR_INVALID_SCHEMA', 'schema must be a non-empty string');
  }
  if (!isNonNegInt(value.epoch)) {
    return refused('ERR_INEXACT_INTEGER', 'epoch must be a non-negative safe integer');
  }
  if (!isNonNegInt(value.revision)) {
    return refused('ERR_INEXACT_INTEGER', 'revision must be a non-negative safe integer');
  }
  const durable = value.durableRevision;
  if (durable !== undefined && durable !== null) {
    if (!isNonNegInt(durable) || durable > value.revision) {
      return refused('ERR_INVALID_DURABLE_REVISION', 'durableRevision must not exceed revision');
    }
  }
  const base = value.baseRevision;
  if (base !== undefined && !isNonNegInt(base)) {
    return refused('ERR_INEXACT_INTEGER', 'baseRevision must be a non-negative safe integer');
  }
  const mode = value.mode ?? 'snapshot';
  if (mode !== 'snapshot' && mode !== 'delta') {
    return refused('ERR_INVALID_MODE', `mode ${String(value.mode)} refused`);
  }
  if (typeof value.query !== 'string' || value.query.length === 0) {
    return refused('ERR_INVALID_QUERY', 'query must be a non-empty string');
  }
  const projection = value.projection;
  if (!isPlainTestObject(projection)) {
    return refused('ERR_INVALID_PROJECTION', 'projection must be an object');
  }
  for (const key of Object.keys(projection)) {
    if (!PROJECTION_KEYS.has(key)) {
      return refused('ERR_UNKNOWN_PROJECTION_KEY', `unknown projection key "${key}"`);
    }
  }
  const seenIds = new Set();
  const rows = projection.rows;
  if (rows !== undefined) {
    if (!Array.isArray(rows)) return refused('ERR_INVALID_PROJECTION', 'rows must be an array');
    for (let i = 0; i < rows.length; i += 1) {
      const check = validateTestRow(rows[i], i, seenIds);
      if (!check.ok) return check;
    }
  }
  const upserts = projection.upsertRows;
  if (upserts !== undefined) {
    if (!Array.isArray(upserts)) {
      return refused('ERR_INVALID_PROJECTION', 'upsertRows must be an array');
    }
    for (let i = 0; i < upserts.length; i += 1) {
      const check = validateTestRow(upserts[i], i, seenIds);
      if (!check.ok) return check;
    }
  }
  const removals = projection.removeRowIds;
  if (removals !== undefined) {
    if (!Array.isArray(removals) || !removals.every((id) => typeof id === 'string' && id.length > 0)) {
      return refused('ERR_INVALID_PROJECTION', 'removeRowIds must hold non-empty strings');
    }
  }
  const batchRows = (rows?.length ?? 0) + (upserts?.length ?? 0);
  if (batchRows > limits.maxBatchRows) {
    return refused('ERR_BATCH_TOO_LARGE', `batch of ${batchRows} rows exceeds ${limits.maxBatchRows}`);
  }
  const normalized = {
    schema: value.schema,
    epoch: value.epoch,
    revision: value.revision,
    query: value.query,
    projection: {},
  };
  if (durable !== undefined && durable !== null) normalized.durableRevision = durable;
  if (base !== undefined) normalized.baseRevision = base;
  if (value.mode !== undefined) normalized.mode = value.mode;
  if (rows !== undefined) normalized.projection.rows = rows;
  if (upserts !== undefined) normalized.projection.upsertRows = upserts;
  if (removals !== undefined) normalized.projection.removeRowIds = removals;
  return { ok: true, value: normalized };
}

/**
 * Strict test decoder proving the injected-decode contract.
 * @param {unknown} raw
 * @param {typeof LIMITS} limits
 */
function decodeTestEnvelope(raw, limits) {
  let value;
  if (typeof raw === 'string') {
    const bytes = new TextEncoder().encode(raw).length;
    if (bytes > limits.maxBytes) {
      return refused('ERR_INPUT_TOO_LARGE', `input of ${bytes} bytes exceeds ${limits.maxBytes}`);
    }
    const parsed = parseStrictJson(raw, limits);
    if (!parsed.ok) return parsed;
    value = parsed.value;
  } else if (raw instanceof Uint8Array) {
    if (raw.byteLength > limits.maxBytes) {
      return refused(
        'ERR_INPUT_TOO_LARGE',
        `input of ${raw.byteLength} bytes exceeds ${limits.maxBytes}`,
      );
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return refused('ERR_MALFORMED_UTF8', 'input is not valid UTF-8');
    }
    const parsed = parseStrictJson(text, limits);
    if (!parsed.ok) return parsed;
    value = parsed.value;
  } else if (isPlainTestObject(raw)) {
    const caps = checkObjectCaps(raw, limits);
    if (!caps.ok) return caps;
    value = raw;
  } else {
    return refused('ERR_INVALID_ENVELOPE', 'envelope must be JSON text, UTF-8 bytes or an object');
  }
  return validateTestEnvelope(value, limits);
}

/** @param {Record<string, unknown>} [overrides] */
function makeController(overrides = {}) {
  return createWallProjection({
    allowedSchemas: [SCHEMA],
    limits: LIMITS,
    decode: decodeTestEnvelope,
    ...overrides,
  });
}

/**
 * @param {ReturnType<typeof makeController>} controller
 * @param {string} [query]
 * @param {number} [epoch]
 */
function startSession(controller, query = QUERY, epoch = 1) {
  const session = controller.beginSession({ query, epoch });
  const ready = controller.markSubscriptionReady(session.generation);
  assert.equal(ready.ok, true);
  return session;
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} [overrides]
 */
function wallRow(id, overrides = {}) {
  return {
    id,
    surfaceId: id,
    backendLifecycle: 'active',
    generation: 1,
    visibility: 'unfolded',
    control: 'human',
    ...overrides,
  };
}

/**
 * @param {number} revision
 * @param {unknown[]} rows
 * @param {Record<string, unknown>} [overrides]
 */
function wallEnvelope(revision, rows, overrides = {}) {
  return {
    schema: SCHEMA,
    epoch: 1,
    revision,
    query: QUERY,
    projection: { rows },
    ...overrides,
  };
}

describe('wall projection options', () => {
  it('throws when decode is missing', () => {
    assert.throws(() => makeController({ decode: undefined }), /DECODE/);
    assert.throws(() => makeController({ decode: 'nope' }), /DECODE/);
    assert.throws(
      () => createWallProjection({ allowedSchemas: [SCHEMA], limits: LIMITS }),
      /DECODE/,
    );
  });

  it('throws when allowedSchemas is empty or malformed', () => {
    assert.throws(() => makeController({ allowedSchemas: [] }), /SCHEMA/);
    assert.throws(() => makeController({ allowedSchemas: [''] }), /SCHEMA/);
    assert.throws(() => makeController({ allowedSchemas: 'surface/v0.1' }), /SCHEMA/);
    assert.throws(
      () => createWallProjection({ limits: LIMITS, decode: decodeTestEnvelope }),
      /SCHEMA/,
    );
  });

  it('throws when a limit is missing, zero or inexact', () => {
    for (const key of Object.keys(LIMITS)) {
      const { [key]: _drop, ...rest } = LIMITS;
      assert.throws(() => makeController({ limits: rest }), /LIMIT/, `missing ${key} must throw`);
    }
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '64', null]) {
      assert.throws(
        () => makeController({ limits: { ...LIMITS, maxBatchRows: bad } }),
        /LIMIT/,
        `limit ${String(bad)} must throw`,
      );
    }
    assert.throws(() => makeController({ limits: 'closed' }), /LIMIT/);
  });

  it('freezes the controller, the view and the admitted schemas', () => {
    const schemas = [SCHEMA];
    const controller = makeController({ allowedSchemas: schemas });
    assert.equal(Object.isFrozen(controller), true);
    const view = controller.getView();
    assert.equal(Object.isFrozen(view), true);
    assert.deepEqual(view.getAllowedSchemas(), [SCHEMA]);
    assert.equal(Object.isFrozen(view.getAllowedSchemas()), true);
    schemas.push('alien/v9');
    assert.deepEqual(view.getAllowedSchemas(), [SCHEMA]);
  });

  it('starts unavailable with null revisions', () => {
    const view = makeController().getView();
    assert.deepEqual(view.getSnapshot(), {
      status: 'unavailable',
      stale: false,
      ramRevision: null,
      durableRevision: null,
      envelope: null,
      error: null,
    });
    assert.equal(view.getProjection(), null);
  });
});

describe('wall projection sessions', () => {
  it('requires subscription readiness before admission', () => {
    const controller = makeController();
    const view = controller.getView();
    const session = controller.beginSession({ query: QUERY, epoch: 1 });
    assert.equal(controller.canRequestSnapshot(session.generation), false);
    const early = controller.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(early.ok, false);
    assert.equal(early.error.code, 'ERR_SUBSCRIPTION_NOT_READY');
    assert.equal(controller.markSubscriptionReady(session.generation).ok, true);
    assert.equal(controller.canRequestSnapshot(session.generation), true);
    const admitted = controller.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(admitted.ok, true);
    assert.equal(view.getSnapshot().ramRevision, 1);
  });

  it('refuses admission without an active session', () => {
    const controller = makeController();
    const outcome = controller.admitPush(wallEnvelope(1, [wallRow('a')]), { generation: 1 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'ERR_STALE_GENERATION');
    assert.equal(controller.getView().getSnapshot().ramRevision, null);
  });

  it('rejects readiness for a stale generation', () => {
    const controller = makeController();
    const first = controller.beginSession({ query: QUERY, epoch: 1 });
    controller.beginSession({ query: QUERY, epoch: 1 });
    const stale = controller.markSubscriptionReady(first.generation);
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'ERR_STALE_GENERATION');
  });

  it('refuses admission for a stale generation without state change', () => {
    const controller = makeController();
    const first = startSession(controller);
    const admitted = controller.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: first.generation,
    });
    assert.equal(admitted.ok, true);
    const second = controller.beginSession({ query: QUERY, epoch: 1 });
    controller.markSubscriptionReady(second.generation);
    const late = controller.admitPush(wallEnvelope(2, [wallRow('a')]), {
      generation: first.generation,
    });
    assert.equal(late.ok, false);
    assert.equal(late.error.code, 'ERR_STALE_GENERATION');
    assert.equal(controller.getView().getSnapshot().ramRevision, 1);
  });

  it('refuses a stale query and a stale epoch', () => {
    const controller = makeController();
    const session = startSession(controller, 'wall/other/v1', 2);
    const query = controller.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(query.ok, false);
    assert.equal(query.error.code, 'ERR_STALE_QUERY');
    const epoch = controller.admitPush(
      wallEnvelope(1, [wallRow('a')], { query: 'wall/other/v1', epoch: 1 }),
      { generation: session.generation },
    );
    assert.equal(epoch.ok, false);
    assert.equal(epoch.error.code, 'ERR_STALE_EPOCH');
    assert.equal(controller.getView().getSnapshot().envelope, null);
  });

  it('invalidates sessions with a new generation and runs unsubscribe', () => {
    const controller = makeController();
    let released = 0;
    const session = controller.beginSession({
      query: QUERY,
      epoch: 1,
      onUnsubscribe: () => {
        released += 1;
      },
    });
    controller.markSubscriptionReady(session.generation);
    const next = controller.invalidateSession('route left');
    assert.equal(next, session.generation + 1);
    assert.equal(released, 1);
    const late = controller.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(late.ok, false);
    assert.equal(late.error.code, 'ERR_STALE_GENERATION');
  });

  it('refuses malformed admit meta instead of guessing', () => {
    const controller = makeController();
    const session = startSession(controller);
    const valid = wallEnvelope(1, [wallRow('a')]);
    assert.throws(() => controller.admitPush(valid, undefined), /META/);
    assert.throws(() => controller.admitPush(valid, {}), /META/);
    assert.throws(() => controller.admitPush(valid, { generation: 1.5 }), /META/);
    assert.throws(() => controller.admitInitialResponse(valid, { generation: '1' }), /META/);
    assert.equal(controller.getView().getSnapshot().envelope, null);
    assert.equal(session.generation, 1);
  });
});

describe('wall snapshot admission', () => {
  it('admits a valid snapshot and publishes exactly once', () => {
    const controller = makeController();
    const session = startSession(controller);
    const view = controller.getView();
    const seen = [];
    const stop = view.subscribe((snapshot) => seen.push(snapshot));
    const outcome = controller.admitPush(wallEnvelope(1, [wallRow('a'), wallRow('b')]), {
      generation: session.generation,
    });
    assert.equal(outcome.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(outcome.snapshot, seen[0]);
    assert.equal(outcome.snapshot.status, 'live');
    assert.equal(outcome.snapshot.stale, false);
    assert.equal(outcome.snapshot.ramRevision, 1);
    assert.equal(outcome.snapshot.error, null);
    assert.deepEqual(
      outcome.snapshot.envelope.projection.rows.map((row) => row.id),
      ['a', 'b'],
    );
    assert.equal(Object.isFrozen(outcome.snapshot), true);
    assert.equal(Object.isFrozen(outcome.snapshot.envelope), true);
    assert.equal(Object.isFrozen(outcome.snapshot.envelope.projection), true);
    assert.equal(Object.isFrozen(outcome.snapshot.envelope.projection.rows), true);
    assert.equal(Object.isFrozen(outcome.snapshot.envelope.projection.rows[0]), true);
    stop();
  });

  it('admits an initial response through the same gate', () => {
    const controller = makeController();
    const session = startSession(controller);
    const seen = [];
    controller.getView().subscribe((snapshot) => seen.push(snapshot));
    const outcome = controller.admitInitialResponse(wallEnvelope(1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(outcome.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, 'live');
  });

  it('admits JSON text and byte input identically', () => {
    const raw = JSON.stringify(wallEnvelope(1, [wallRow('a', { title: 'Desk' })]));
    const fromText = makeController();
    const textSession = startSession(fromText);
    const textOutcome = fromText.admitPush(raw, { generation: textSession.generation });
    const fromBytes = makeController();
    const byteSession = startSession(fromBytes);
    const byteOutcome = fromBytes.admitPush(new TextEncoder().encode(raw), {
      generation: byteSession.generation,
    });
    assert.equal(textOutcome.ok, true);
    assert.equal(byteOutcome.ok, true);
    assert.deepEqual(byteOutcome.snapshot, textOutcome.snapshot);
  });

  it('never rolls back a newer push with a late initial response', () => {
    const controller = makeController();
    const session = startSession(controller);
    const pushed = controller.admitPush(wallEnvelope(2, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(pushed.ok, true);
    const late = controller.admitInitialResponse(wallEnvelope(1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(late.ok, false);
    assert.equal(late.error.code, 'ERR_STALE_REVISION');
    const snapshot = controller.getView().getSnapshot();
    assert.equal(snapshot.ramRevision, 2);
    assert.equal(snapshot.envelope.revision, 2);
  });

  it('refuses a stale revision and keeps last-good visibly stale', () => {
    const controller = makeController();
    const session = startSession(controller);
    const view = controller.getView();
    const seen = [];
    view.subscribe((snapshot) => seen.push(snapshot));
    assert.equal(
      controller.admitPush(wallEnvelope(1, [wallRow('a')]), { generation: session.generation }).ok,
      true,
    );
    const repeat = controller.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(repeat.ok, false);
    assert.equal(repeat.error.code, 'ERR_STALE_REVISION');
    assert.equal(seen.length, 2);
    const snapshot = view.getSnapshot();
    assert.equal(snapshot.status, 'stale');
    assert.equal(snapshot.stale, true);
    assert.equal(snapshot.ramRevision, 1);
    assert.equal(snapshot.envelope.revision, 1);
    assert.equal(snapshot.error.code, 'ERR_STALE_REVISION');
  });

  it('refuses an unknown schema without touching state', () => {
    const controller = makeController();
    const session = startSession(controller);
    const view = controller.getView();
    const seen = [];
    view.subscribe((snapshot) => seen.push(snapshot));
    const outcome = controller.admitPush(wallEnvelope(1, [wallRow('a')], { schema: 'alien/v9' }), {
      generation: session.generation,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'ERR_UNKNOWN_SCHEMA');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, 'unavailable');
    assert.equal(seen[0].error.code, 'ERR_UNKNOWN_SCHEMA');
    assert.equal(view.getSnapshot().envelope, null);
  });

  it('refuses unknown envelope keys with the decoder error', () => {
    const controller = makeController();
    const session = startSession(controller);
    const view = controller.getView();
    const seen = [];
    view.subscribe((snapshot) => seen.push(snapshot));
    const outcome = controller.admitPush(
      { ...wallEnvelope(1, [wallRow('a')]), bogus: 1 },
      { generation: session.generation },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'ERR_UNKNOWN_ENVELOPE_KEY');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].envelope, null);
    assert.equal(seen[0].error.code, 'ERR_UNKNOWN_ENVELOPE_KEY');
    assert.equal(view.getSnapshot().ramRevision, null);
  });

  it('refuses inexact integers in text and object input', () => {
    const controller = makeController();
    const session = startSession(controller);
    const fractional = controller.admitPush(
      JSON.stringify(wallEnvelope(1, [wallRow('a')])).replace('"epoch":1', '"epoch":1.5'),
      { generation: session.generation },
    );
    assert.equal(fractional.ok, false);
    assert.equal(fractional.error.code, 'ERR_INEXACT_INTEGER');
    const unsafe = controller.admitPush(wallEnvelope(Number.MAX_SAFE_INTEGER + 1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.error.code, 'ERR_INEXACT_INTEGER');
    assert.equal(controller.getView().getSnapshot().envelope, null);
  });

  it('refuses a durable revision above revision', () => {
    const controller = makeController();
    const session = startSession(controller);
    const outcome = controller.admitPush(
      wallEnvelope(3, [wallRow('a')], { durableRevision: 5 }),
      { generation: session.generation },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'ERR_INVALID_DURABLE_REVISION');
    assert.equal(controller.getView().getSnapshot().envelope, null);
  });

  it('refuses forbidden hidden keys at row and projection level', () => {
    const controller = makeController();
    const session = startSession(controller);
    const hiddenRow = controller.admitPush(
      wallEnvelope(1, [wallRow('a', { secret: 1 })]),
      { generation: session.generation },
    );
    assert.equal(hiddenRow.ok, false);
    assert.equal(hiddenRow.error.code, 'ERR_UNKNOWN_ROW_KEY');
    const hiddenProjection = controller.admitPush(
      {
        schema: SCHEMA,
        epoch: 1,
        revision: 1,
        query: QUERY,
        projection: { rows: [wallRow('a')], hidden: true },
      },
      { generation: session.generation },
    );
    assert.equal(hiddenProjection.ok, false);
    assert.equal(hiddenProjection.error.code, 'ERR_UNKNOWN_PROJECTION_KEY');
    assert.equal(controller.getView().getSnapshot().envelope, null);
  });

  it('tracks durable and RAM revisions distinctly', () => {
    const controller = makeController();
    const session = startSession(controller);
    const view = controller.getView();
    const first = controller.admitPush(wallEnvelope(5, [wallRow('a')], { durableRevision: 3 }), {
      generation: session.generation,
    });
    assert.equal(first.ok, true);
    assert.equal(first.snapshot.ramRevision, 5);
    assert.equal(first.snapshot.durableRevision, 3);
    const second = controller.admitPush(wallEnvelope(6, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(second.ok, true);
    assert.equal(second.snapshot.ramRevision, 6);
    assert.equal(second.snapshot.durableRevision, 3);
    assert.equal(view.getSnapshot().durableRevision, 3);
  });

  it('deep-freezes published data and ignores caller aliases', () => {
    const controller = makeController();
    const session = startSession(controller);
    const input = wallEnvelope(1, [
      wallRow('a', { refusal: { code: 'LOCKED_BY_OTHER', message: 'held' } }),
    ]);
    const outcome = controller.admitPush(input, { generation: session.generation });
    assert.equal(outcome.ok, true);
    const row = outcome.snapshot.envelope.projection.rows[0];
    assert.throws(() => {
      row.generation = 99;
    }, TypeError);
    assert.throws(() => {
      row.refusal.code = 'POLICY';
    }, TypeError);
    assert.throws(() => {
      outcome.snapshot.envelope.projection.rows.push(wallRow('b'));
    }, TypeError);
    input.projection.rows[0].generation = 999;
    input.projection.rows.push(wallRow('b'));
    const current = controller.getView().getProjection();
    assert.equal(current.rows.length, 1);
    assert.equal(current.rows[0].generation, 1);
  });
});

describe('wall whole-batch refusal', () => {
  it('refuses the entire batch on a malformed final row', () => {
    const controller = makeController();
    const session = startSession(controller);
    const view = controller.getView();
    const seen = [];
    view.subscribe((snapshot) => seen.push(snapshot));
    const outcome = controller.admitPush(
      wallEnvelope(1, [wallRow('a'), wallRow('b'), wallRow('c', { visibility: 'sideways' })]),
      { generation: session.generation },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'ERR_MALFORMED_ROW');
    assert.equal(view.getSnapshot().envelope, null);
    assert.equal(view.getProjection(), null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].envelope, null);
    const repair = controller.admitPush(wallEnvelope(1, [wallRow('a'), wallRow('b')]), {
      generation: session.generation,
    });
    assert.equal(repair.ok, true);
    assert.equal(view.getProjection().rows.length, 2);
  });

  it('refuses duplicate row identities with nothing published', () => {
    const controller = makeController();
    const session = startSession(controller);
    const outcome = controller.admitPush(wallEnvelope(1, [wallRow('a'), wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'ERR_DUPLICATE_IDENTITY');
    assert.equal(controller.getView().getSnapshot().envelope, null);
  });

  it('refuses duplicate raw JSON keys before construction', () => {
    const controller = makeController();
    const session = startSession(controller);
    const raw = JSON.stringify(wallEnvelope(1, [wallRow('a')])).replace(
      '"visibility":"unfolded"',
      '"visibility":"unfolded","visibility":"folded"',
    );
    const outcome = controller.admitPush(raw, { generation: session.generation });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'ERR_DUPLICATE_KEY');
    assert.equal(controller.getView().getSnapshot().envelope, null);
  });

  it('refuses malformed UTF-8 bytes', () => {
    const controller = makeController();
    const session = startSession(controller);
    const outcome = controller.admitPush(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), {
      generation: session.generation,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'ERR_MALFORMED_UTF8');
    assert.equal(controller.getView().getSnapshot().envelope, null);
  });

  it('refuses over-cap input on every ingress rail', () => {
    const tight = Object.freeze({
      maxBytes: 96,
      maxDepth: 4,
      maxKeys: 8,
      maxStringLength: 8,
      maxBatchRows: 1,
    });
    const big = makeController({ limits: tight });
    const bigSession = startSession(big);
    const tooBig = big.admitPush(JSON.stringify(wallEnvelope(1, [wallRow('a')])), {
      generation: bigSession.generation,
    });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.error.code, 'ERR_INPUT_TOO_LARGE');

    const wide = makeController({ limits: { ...LIMITS, maxBatchRows: 1 } });
    const wideSession = startSession(wide);
    const tooWide = wide.admitPush(wallEnvelope(1, [wallRow('a'), wallRow('b')]), {
      generation: wideSession.generation,
    });
    assert.equal(tooWide.ok, false);
    assert.equal(tooWide.error.code, 'ERR_BATCH_TOO_LARGE');

    const deep = makeController({ limits: { ...LIMITS, maxDepth: 2 } });
    const deepSession = startSession(deep);
    const tooDeep = deep.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: deepSession.generation,
    });
    assert.equal(tooDeep.ok, false);
    assert.equal(tooDeep.error.code, 'ERR_DEPTH_EXCEEDED');

    const long = makeController({ limits: { ...LIMITS, maxStringLength: 4 } });
    const longSession = startSession(long);
    const tooLong = long.admitPush(wallEnvelope(1, [wallRow('a', { title: 'toolong' })]), {
      generation: longSession.generation,
    });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.error.code, 'ERR_STRING_TOO_LONG');

    const many = makeController({ limits: { ...LIMITS, maxKeys: 10 } });
    const manySession = startSession(many);
    const tooMany = many.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: manySession.generation,
    });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error.code, 'ERR_TOO_MANY_KEYS');
  });
});

describe('wall delta admission', () => {
  it('admits a delta on the exact resident base', () => {
    const controller = makeController();
    const session = startSession(controller);
    const first = controller.admitPush(wallEnvelope(5, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(first.ok, true);
    const delta = controller.admitPush(
      {
        schema: SCHEMA,
        epoch: 1,
        revision: 6,
        baseRevision: 5,
        mode: 'delta',
        query: QUERY,
        projection: {
          upsertRows: [wallRow('a', { generation: 2, visibility: 'pinned' }), wallRow('b')],
        },
      },
      { generation: session.generation },
    );
    assert.equal(delta.ok, true);
    assert.equal(delta.snapshot.ramRevision, 6);
    const rows = delta.snapshot.envelope.projection.rows;
    assert.deepEqual(
      rows.map((row) => [row.id, row.generation, row.visibility]),
      [
        ['a', 2, 'pinned'],
        ['b', 1, 'unfolded'],
      ],
    );
  });

  it('refuses a delta on the wrong base and keeps last-good', () => {
    const controller = makeController();
    const session = startSession(controller);
    assert.equal(
      controller.admitPush(wallEnvelope(5, [wallRow('a')]), { generation: session.generation }).ok,
      true,
    );
    const delta = controller.admitPush(
      {
        schema: SCHEMA,
        epoch: 1,
        revision: 6,
        baseRevision: 4,
        mode: 'delta',
        query: QUERY,
        projection: { upsertRows: [wallRow('b')] },
      },
      { generation: session.generation },
    );
    assert.equal(delta.ok, false);
    assert.equal(delta.error.code, 'ERR_WRONG_DELTA_BASE');
    const snapshot = controller.getView().getSnapshot();
    assert.equal(snapshot.status, 'stale');
    assert.equal(snapshot.ramRevision, 5);
    assert.deepEqual(
      snapshot.envelope.projection.rows.map((row) => row.id),
      ['a'],
    );
  });

  it('removes rows through removeRowIds', () => {
    const controller = makeController();
    const session = startSession(controller);
    assert.equal(
      controller.admitPush(wallEnvelope(5, [wallRow('a'), wallRow('b')]), {
        generation: session.generation,
      }).ok,
      true,
    );
    const delta = controller.admitPush(
      {
        schema: SCHEMA,
        epoch: 1,
        revision: 6,
        baseRevision: 5,
        mode: 'delta',
        query: QUERY,
        projection: { removeRowIds: ['a'] },
      },
      { generation: session.generation },
    );
    assert.equal(delta.ok, true);
    assert.deepEqual(
      delta.snapshot.envelope.projection.rows.map((row) => row.id),
      ['b'],
    );
  });
});

describe('wall row identity', () => {
  it('selects only the exact requested surface', () => {
    const controller = makeController();
    const session = startSession(controller);
    const outcome = controller.admitPush(wallEnvelope(1, [wallRow('a'), wallRow('b')]), {
      generation: session.generation,
    });
    assert.equal(outcome.ok, true);
    const found = selectWallSurface(outcome.snapshot, 'a');
    assert.equal(found.ok, true);
    assert.equal(found.value.id, 'a');
    assert.equal(found.value.surfaceId, 'a');
    assert.equal(Object.isFrozen(found.value), true);
    const missing = selectWallSurface(outcome.snapshot, 'c');
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'ERR_UNKNOWN_SURFACE');
  });

  it('refuses cross-surface addressing between tiles', () => {
    const controller = makeController();
    const session = startSession(controller);
    const outcome = controller.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(outcome.ok, true);
    const cross = selectWallSurface(outcome.snapshot, 'b');
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, 'ERR_UNKNOWN_SURFACE');
  });

  it('refuses rows whose id and surfaceId diverge', () => {
    const snapshot = {
      status: 'live',
      stale: false,
      ramRevision: 1,
      durableRevision: null,
      envelope: {
        schema: SCHEMA,
        epoch: 1,
        revision: 1,
        query: QUERY,
        projection: { rows: [wallRow('a', { surfaceId: 'b' })] },
      },
      error: null,
    };
    const outcome = selectWallSurface(snapshot, 'a');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'ERR_MALFORMED_ROW');
  });

  it('refuses rows missing lifecycle or allocation instead of defaulting', () => {
    const base = {
      status: 'live',
      stale: false,
      ramRevision: 1,
      durableRevision: null,
      error: null,
    };
    const withoutGeneration = { ...wallRow('a') };
    delete withoutGeneration.generation;
    assert.equal(
      selectWallSurface(
        { ...base, envelope: { projection: { rows: [withoutGeneration] } } },
        'a',
      ).error.code,
      'ERR_MALFORMED_ROW',
    );
    const zeroGeneration = wallRow('a', { generation: 0 });
    assert.equal(
      selectWallSurface(
        { ...base, envelope: { projection: { rows: [zeroGeneration] } } },
        'a',
      ).error.code,
      'ERR_MALFORMED_ROW',
    );
    const withoutLifecycle = { ...wallRow('a') };
    delete withoutLifecycle.backendLifecycle;
    assert.equal(
      selectWallSurface(
        { ...base, envelope: { projection: { rows: [withoutLifecycle] } } },
        'a',
      ).error.code,
      'ERR_MALFORMED_ROW',
    );
  });

  it('returns unavailable for missing snapshots and bad ids', () => {
    assert.equal(selectWallSurface(null, 'a').error.code, 'ERR_PROJECTION_UNAVAILABLE');
    assert.equal(
      selectWallSurface({ status: 'unavailable', envelope: null }, 'a').error.code,
      'ERR_PROJECTION_UNAVAILABLE',
    );
    assert.equal(
      selectWallSurface({ envelope: { projection: {} } }, 'a').error.code,
      'ERR_PROJECTION_UNAVAILABLE',
    );
    const live = { envelope: { projection: { rows: [wallRow('a')] } } };
    assert.equal(selectWallSurface(live, '').error.code, 'ERR_INVALID_CAPSULE_ID');
    assert.equal(selectWallSurface(live, 7).error.code, 'ERR_INVALID_CAPSULE_ID');
  });

  it('never invents defaults for omitted optional fields', () => {
    const controller = makeController();
    const session = startSession(controller);
    const outcome = controller.admitPush(wallEnvelope(1, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(outcome.ok, true);
    const found = selectWallSurface(outcome.snapshot, 'a');
    assert.equal(found.ok, true);
    assert.deepEqual(Object.keys(found.value).sort(), [
      'backendLifecycle',
      'control',
      'generation',
      'id',
      'surfaceId',
      'visibility',
    ]);
  });

  it('refuses null or zero generation instead of coercing to zero', () => {
    const controller = makeController();
    const session = startSession(controller);
    const nulled = controller.admitPush(wallEnvelope(1, [wallRow('a', { generation: null })]), {
      generation: session.generation,
    });
    assert.equal(nulled.ok, false);
    assert.equal(nulled.error.code, 'ERR_MALFORMED_ROW');
    const zeroed = controller.admitPush(wallEnvelope(1, [wallRow('a', { generation: 0 })]), {
      generation: session.generation,
    });
    assert.equal(zeroed.ok, false);
    assert.equal(zeroed.error.code, 'ERR_MALFORMED_ROW');
    assert.equal(controller.getView().getSnapshot().envelope, null);
  });
});

describe('wall selection and disposal', () => {
  it('reconciles selection against admitted rows', () => {
    const controller = makeController();
    const session = startSession(controller);
    const view = controller.getView();
    assert.deepEqual(view.reconcileSelection(['a']), { validIds: [], removedIds: ['a'] });
    assert.equal(
      controller.admitPush(wallEnvelope(1, [wallRow('a'), wallRow('b')]), {
        generation: session.generation,
      }).ok,
      true,
    );
    assert.deepEqual(view.reconcileSelection(['a', 'c', 'a']), {
      validIds: ['a'],
      removedIds: ['c'],
    });
  });

  it('blocks late admission after dispose without publication', () => {
    const controller = makeController();
    const session = startSession(controller);
    const view = controller.getView();
    const seen = [];
    view.subscribe(() => seen.push(0));
    assert.equal(
      controller.admitPush(wallEnvelope(1, [wallRow('a')]), { generation: session.generation }).ok,
      true,
    );
    assert.equal(seen.length, 1);
    controller.dispose();
    const late = controller.admitPush(wallEnvelope(2, [wallRow('a')]), {
      generation: session.generation,
    });
    assert.equal(late.ok, false);
    assert.equal(late.error.code, 'ERR_DISPOSED');
    assert.equal(seen.length, 1);
    assert.throws(() => controller.beginSession({ query: QUERY, epoch: 1 }), /DISPOSED/);
    assert.throws(() => view.subscribe(() => {}), /DISPOSED/);
    const snapshot = view.getSnapshot();
    assert.equal(snapshot.ramRevision, 1);
    assert.equal(snapshot.envelope.revision, 1);
  });
});
