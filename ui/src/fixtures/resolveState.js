/**
 * @file `?state=` query parser and fixture resolver (lane U5).
 * Total functions: every input shape becomes a typed result, never a throw.
 * Pure: no `window` access; callers pass the query string. Plain JavaScript
 * ES module with JSDoc types.
 */

import { FIXTURE_KEYS, FIXTURES } from './states.js';

/**
 * @typedef {Object} FixtureRefusal
 * @property {string} code - `ERR_MISSING_STATE_PARAM`, `ERR_UNKNOWN_FIXTURE_STATE`, or `ERR_INVALID_STATE_QUERY`.
 * @property {string} message
 */

/**
 * Lists the canonical fixture keys in room order.
 * @returns {readonly string[]}
 */
export function listFixtureKeys() {
  return FIXTURE_KEYS;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFixtureKey(value) {
  return typeof value === 'string' && Object.hasOwn(FIXTURES, value);
}

/**
 * Parses the `state` parameter from a URL query string. The first `state`
 * value wins; matching is exact and case-sensitive.
 * @param {unknown} search
 * @returns {{ ok: true, key: string }|{ ok: false, error: FixtureRefusal }}
 */
export function parseStateQuery(search) {
  if (typeof search !== 'string') {
    return {
      ok: false,
      error: Object.freeze({
        code: 'ERR_INVALID_STATE_QUERY',
        message: 'State query must be a string',
      }),
    };
  }
  let key = '';
  try {
    key = new URLSearchParams(search.startsWith('?') ? search : `?${search}`).get('state') ?? '';
  } catch {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_INVALID_STATE_QUERY', message: 'State query is malformed' }),
    };
  }
  if (key.length === 0) {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_MISSING_STATE_PARAM', message: 'Missing state parameter' }),
    };
  }
  if (!isFixtureKey(key)) {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_UNKNOWN_FIXTURE_STATE', message: `Unknown state ${key}` }),
    };
  }
  return { ok: true, key };
}

/**
 * Resolves a fixture key to its frozen fixture record.
 * @param {unknown} key
 * @returns {{ ok: true, fixture: import('./states.js').FixtureState }|{ ok: false, error: FixtureRefusal }}
 */
export function resolveFixture(key) {
  if (!isFixtureKey(key)) {
    return {
      ok: false,
      error: Object.freeze({
        code: 'ERR_UNKNOWN_FIXTURE_STATE',
        message: `Unknown state ${typeof key === 'string' ? key : typeof key}`,
      }),
    };
  }
  return { ok: true, fixture: FIXTURES[/** @type {string} */ (key)] };
}
