/**
 * MetaViewer nested display-only mode helpers (AC-17): depth flag read
 * through an injected interface, clean-wall row filtering with no
 * self-capsule, and no error text on any path.
 *
 * Pure JavaScript with JSDoc; zero imports. The main-side retail gate
 * (`--nested-depth=1`) is the enforcement point; these helpers only adapt
 * the renderer: at depth 1 the wall is display-only and the self capsule
 * is removed from the row list. Unknown or unreadable depth resolves to
 * top-level mode without throwing so the wall never shows an error.
 *
 * @module nested/nested
 */

/**
 * Depth of a nested display-only window.
 * @type {number}
 */
export const NESTED_DISPLAY_DEPTH = 1;

/**
 * Depth of a top-level window.
 * @type {number}
 */
export const NESTED_TOP_DEPTH = 0;

/**
 * @typedef {object} NestedHost Injected nested-mode interface.
 * @property {() => number|string|null} getNestedDepth Current window depth, null when unknown.
 * @property {() => string|null} getSelfCapsuleId Host-issued id of the capsule containing this window, null when none.
 */

/**
 * @typedef {object} NestedMode Resolved nested mode.
 * @property {number} depth Resolved depth (0 when unknown or invalid).
 * @property {boolean} displayOnly True only at depth 1.
 * @property {boolean} known False when the host could not answer.
 * @property {string|null} selfCapsuleId Self capsule id, null when none.
 */

/**
 * Parse a raw depth value. Accepts 0/1 as a number or a bare digit
 * string; leading zeros are refused, mirroring the main-side retail
 * gate. Depth 2 and above is refused, never clamped.
 * @param {unknown} value
 * @returns {{ ok: true, depth: number } | { ok: false, error: { code: string, message: string } }}
 */
export function parseNestedDepth(value) {
  if (value === null || value === undefined || value === '') {
    return { ok: true, depth: NESTED_TOP_DEPTH };
  }
  if (typeof value === 'number') {
    if (value === 0 || value === 1) return { ok: true, depth: value };
    if (Number.isSafeInteger(value)) {
      return {
        ok: false,
        error: { code: 'NESTED_DEPTH', message: `Nested depth ${String(value)} is not supported` },
      };
    }
    return {
      ok: false,
      error: { code: 'NESTED_DEPTH_MALFORMED', message: 'Nested depth is malformed' },
    };
  }
  if (typeof value === 'string') {
    if (/^-?(0|[1-9][0-9]*)$/.test(value)) {
      const numeric = Number(value);
      if (numeric === 0 || numeric === 1) return { ok: true, depth: numeric };
      return {
        ok: false,
        error: { code: 'NESTED_DEPTH', message: `Nested depth ${value} is not supported` },
      };
    }
    return {
      ok: false,
      error: { code: 'NESTED_DEPTH_MALFORMED', message: `Nested depth is malformed: ${value}` },
    };
  }
  return {
    ok: false,
    error: { code: 'NESTED_DEPTH_MALFORMED', message: 'Nested depth is malformed' },
  };
}

/**
 * @param {unknown} depth
 * @returns {boolean} True only at depth 1.
 */
export function isNestedDisplayOnly(depth) {
  return depth === NESTED_DISPLAY_DEPTH;
}

/**
 * Resolve nested mode through the injected host. Never throws and never
 * surfaces host text: an unreadable depth or a throwing host resolves to
 * top-level mode with `known: false`.
 * @param {NestedHost|null|undefined} host
 * @returns {Readonly<NestedMode>}
 */
export function resolveNestedMode(host) {
  /** @type {unknown} */
  let rawDepth = null;
  /** @type {unknown} */
  let rawSelf = null;
  try {
    rawDepth = typeof host?.getNestedDepth === 'function' ? host.getNestedDepth() : null;
    rawSelf = typeof host?.getSelfCapsuleId === 'function' ? host.getSelfCapsuleId() : null;
  } catch {
    return Object.freeze({ depth: 0, displayOnly: false, known: false, selfCapsuleId: null });
  }
  if (rawDepth === null || rawDepth === undefined) {
    return Object.freeze({
      depth: 0,
      displayOnly: false,
      known: false,
      selfCapsuleId: typeof rawSelf === 'string' && rawSelf.length > 0 ? rawSelf : null,
    });
  }
  const parsed = parseNestedDepth(rawDepth);
  if (parsed.ok === false) {
    return Object.freeze({ depth: 0, displayOnly: false, known: false, selfCapsuleId: null });
  }
  return Object.freeze({
    depth: parsed.depth,
    displayOnly: isNestedDisplayOnly(parsed.depth),
    known: true,
    selfCapsuleId: typeof rawSelf === 'string' && rawSelf.length > 0 ? rawSelf : null,
  });
}

/**
 * Remove the self capsule from a wall row list. Matches `id` or
 * `surfaceId`; a missing self id returns a copy unchanged.
 * @param {unknown} rows
 * @param {unknown} selfCapsuleId
 * @returns {Array<Record<string, unknown>>}
 */
export function filterNestedRows(rows, selfCapsuleId) {
  if (!Array.isArray(rows)) return [];
  if (typeof selfCapsuleId !== 'string' || selfCapsuleId.length === 0) return rows.slice();
  return rows.filter(
    /** @param {unknown} row @returns {boolean} */
    (row) => {
      if (row === null || typeof row !== 'object') return true;
      const record = /** @type {Record<string, unknown>} */ (row);
      return record.id !== selfCapsuleId && record.surfaceId !== selfCapsuleId;
    },
  );
}

/**
 * Apply nested mode to a wall row list: display-only mode filters the
 * self capsule, every other mode returns the rows untouched.
 * @param {unknown} rows
 * @param {{ displayOnly?: unknown, selfCapsuleId?: unknown }|null|undefined} mode
 * @returns {Readonly<{ rows: Array<Record<string, unknown>>, displayOnly: boolean }>}
 */
export function applyNestedWall(rows, mode) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (mode === null || typeof mode !== 'object' || mode.displayOnly !== true) {
    return Object.freeze({ rows: list, displayOnly: false });
  }
  return Object.freeze({ rows: filterNestedRows(list, mode.selfCapsuleId), displayOnly: true });
}

/**
 * In-memory nested host double for tests and fixtures.
 * @param {{ depth?: number|string|null, selfCapsuleId?: string|null }} [initial]
 * @returns {NestedHost}
 */
export function createMemoryNestedHost(initial = {}) {
  const source = initial !== null && typeof initial === 'object' ? initial : {};
  /** @type {number|string|null} */
  let depth = Object.hasOwn(source, 'depth') ? /** @type {number|string|null} */ (source.depth) : null;
  /** @type {string|null} */
  let selfCapsuleId =
    typeof source.selfCapsuleId === 'string' && source.selfCapsuleId.length > 0 ? source.selfCapsuleId : null;
  return {
    getNestedDepth: () => depth,
    getSelfCapsuleId: () => selfCapsuleId,
  };
}
