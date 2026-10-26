// Native assertions for the inherited theme oracle; no external test runtime.
import assert from 'node:assert/strict';

/** @param {any} actual */
export function expect(actual) {
  /** @param {boolean} negative */
  const matchers = (negative) => {
    /** @param {() => void} check */
    const verify = (check) => {
      if (negative) assert.throws(check, assert.AssertionError);
      else check();
    };
    return {
      /** @param {unknown} expected */
      toBe: (expected) => verify(() => assert.equal(actual, expected)),
      /** @param {unknown} expected */
      toEqual: (expected) => verify(() => assert.deepEqual(actual, expected)),
      /** @param {any} expected */
      toContain: (expected) => verify(() => assert.ok(actual.includes(expected))),
      /** @param {number} expected */
      toHaveLength: (expected) => verify(() => assert.equal(actual.length, expected)),
      /** @param {RegExp} expected */
      toMatch: (expected) => verify(() => assert.match(actual, expected)),
      /** @param {RegExp} [expected] */
      toThrow: (expected) => {
        if (negative) assert.doesNotThrow(actual);
        else if (expected) assert.throws(actual, expected);
        else assert.throws(actual);
      },
      /** @param {number} expected */
      toBeGreaterThan: (expected) => verify(() => assert.ok(actual > expected)),
      /** @param {number} expected */
      toBeGreaterThanOrEqual: (expected) => verify(() => assert.ok(actual >= expected)),
      /** @param {number} expected @param {number} digits */
      toBeCloseTo: (expected, digits) => verify(() => assert.ok(Math.abs(actual - expected) < 0.5 * 10 ** -digits)),
    };
  };
  return { ...matchers(false), not: matchers(true) };
}
