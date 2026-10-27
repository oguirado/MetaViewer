/**
 * @file `?state=tile-chrome` alias fixture (MVUI9 lane A): per-tile
 * capsule chrome preview. Four wall tiles: one recording (seeded, elapsed
 * shown), one with a fresh screenshot (seeded), one in human control, one
 * idle. Pure frozen data: no host calls, no dates, no random ids.
 *
 * NOT a FIXTURES key. Like `live-replay` and `layout-unavailable`, it
 * travels as a `main.js` alias so the room's exact key-set contract in
 * `states.js` stays untouched. Seeding is declared in `ui.capture` and
 * applied by the entry through `fixtureCaptureSeed()`; this module never
 * touches the capture port itself.
 *
 * Plain JavaScript ES module with JSDoc types. Zero imports.
 */

/**
 * Canonical `?state=` key for the tile-chrome preview.
 * @type {string}
 */
export const TILE_CHROME_KEY = 'tile-chrome';

/**
 * Recursively freezes plain data.
 * @param {any} value
 * @returns {any}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const entry of value) deepFreeze(entry);
    } else {
      for (const entry of Object.values(value)) deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * @param {string} id
 * @param {Partial<import('./states.js').FixtureCapsule>} [over]
 * @returns {import('./states.js').FixtureCapsule}
 */
function capsule(id, over = {}) {
  const row = {
    id,
    surfaceId: id,
    title: `Capsule ${id}`,
    kind: 'program',
    backendLifecycle: 'active',
    generation: 1,
    visibility: 'unfolded',
    control: 'shared',
    controlOwner: 'none',
    folded: false,
    refusal: null,
    readinessError: null,
    attachmentState: 'live',
    aiSessionActivity: 'ready',
    dispatchOutcome: 'none',
    ...over,
  };
  row.controlOwner = row.control === 'shared' ? 'none' : row.control;
  row.folded = row.visibility === 'folded';
  return row;
}

/**
 * Per-capsule wall anchors from the kit §9 families, plus the MVUI9 tile
 * chrome anchors (`tile-<surface>-record-ai`, `tile-<surface>-screenshot`,
 * `tile-<surface>-recording-badge`).
 * @param {string} id
 * @returns {import('./states.js').FixtureAnchor[]}
 */
function tileChromeCapsuleAnchors(id) {
  return [
    { anchor: `capsule/${id}/panel`, role: 'region' },
    { anchor: `capsule/${id}/fold`, role: 'button', ifPresent: true },
    { anchor: `capsule/${id}/control`, role: 'button', ifPresent: true },
    { anchor: `tile-${id}-record-ai`, role: 'button' },
    { anchor: `tile-${id}-screenshot`, role: 'button' },
    { anchor: `tile-${id}-recording-badge`, role: 'status' },
  ];
}

/** @type {import('./states.js').FixtureState} */
export const TILE_CHROME_FIXTURE = deepFreeze({
  key: TILE_CHROME_KEY,
  screen: 'wall',
  scheme: 'mv-light',
  density: 'compact',
  epoch: 1,
  revision: 12,
  capsules: [
    capsule('cap-01', { title: 'Capture session', kind: 'program' }),
    capsule('cap-02', { title: 'Snapshot review', kind: 'identity-browser' }),
    capsule('cap-03', { title: 'Human control tile', kind: 'holdings-app', control: 'human' }),
    capsule('cap-04', { title: 'Idle tile', kind: 'desktop' }),
  ],
  ui: {
    launcherOpen: false,
    capture: {
      recording: ['cap-01'],
      screenshot: ['cap-02'],
    },
  },
  expectedAnchors: [
    { anchor: 'settings/scheme', role: 'button' },
    { anchor: 'terminal/toggle', role: 'button' },
    ...tileChromeCapsuleAnchors('cap-01'),
    ...tileChromeCapsuleAnchors('cap-02'),
    ...tileChromeCapsuleAnchors('cap-03'),
    ...tileChromeCapsuleAnchors('cap-04'),
  ],
});

/**
 * Capture seed plan for a fixture: which surfaces the entry records and
 * screenshots through the fixture double before mount. Total function:
 * every input shape becomes a frozen plan, never a throw. A fixture
 * declares its plan in `ui.capture` (`recording`/`screenshot` string
 * lists); the legacy `recording` screen keeps its recorded first capsule
 * without touching the pinned `states.js` record.
 * @param {unknown} fixture
 * @returns {Readonly<{ record: ReadonlyArray<string>, shots: ReadonlyArray<string> }>}
 */
export function fixtureCaptureSeed(fixture) {
  const empty = Object.freeze({ record: Object.freeze([]), shots: Object.freeze([]) });
  if (!fixture || typeof fixture !== 'object') return empty;
  const source = /** @type {{ key?: unknown, capsules?: unknown, ui?: unknown }} */ (fixture);
  /** @type {string[]} */
  const record = [];
  /** @type {string[]} */
  const shots = [];
  /**
   * @param {unknown} value
   * @param {string[]} into
   */
  const collect = (value, into) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.length > 0 && entry === entry.trim() && !into.includes(entry)) {
        into.push(entry);
      }
    }
  };
  const ui = source.ui && typeof source.ui === 'object' ? source.ui : null;
  const spec = ui && typeof /** @type {{ capture?: unknown }} */ (ui).capture === 'object'
    && /** @type {{ capture?: unknown }} */ (ui).capture !== null
    ? /** @type {{ recording?: unknown, screenshot?: unknown }} */ (/** @type {{ capture?: unknown }} */ (ui).capture)
    : null;
  if (spec) {
    collect(spec.recording, record);
    collect(spec.screenshot, shots);
    return Object.freeze({ record: Object.freeze(record), shots: Object.freeze(shots) });
  }
  if (source.key === 'recording' && Array.isArray(source.capsules) && source.capsules.length > 0) {
    const first = source.capsules[0];
    const id = first && typeof first === 'object'
      ? /** @type {{ surfaceId?: unknown, id?: unknown }} */ (first).surfaceId
        ?? /** @type {{ surfaceId?: unknown, id?: unknown }} */ (first).id
      : null;
    if (typeof id === 'string' && id.length > 0 && id === id.trim()) record.push(id);
  }
  return Object.freeze({ record: Object.freeze(record), shots: Object.freeze(shots) });
}
