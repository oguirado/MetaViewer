/**
 * @file `?state=input-write` alias fixture (MVUI25 lane A): one
 * human-controlled wall tile in WRITE mode, so the tile's input path is
 * gated-in (control human + write) and the QA focus anchor renders.
 * Pure frozen data: no host calls, no dates, no random ids.
 *
 * NOT a FIXTURES key. Like `tile-chrome`, `live-replay` and
 * `layout-unavailable`, it travels as a `main.js` alias so the room's
 * exact key-set contract in `states.js` stays untouched. App reads
 * `ui.inputMode === 'WRITE'` for the app-level input mode initial value.
 *
 * Plain JavaScript ES module with JSDoc types. Zero imports.
 */

/**
 * Canonical `?state=` key for the input-write preview.
 * @type {string}
 */
export const INPUT_WRITE_KEY = 'input-write';

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
 * Shell chrome anchors verified in `ui/src/App.vue` (room-owned shell).
 * @returns {import('./states.js').FixtureAnchor[]}
 */
function chromeAnchors() {
  return [
    { anchor: 'settings/scheme', role: 'button' },
    { anchor: 'terminal/toggle', role: 'button' },
  ];
}

/**
 * Per-capsule wall anchors from the kit §9 families (row 2, 3, 5).
 * @param {string} id
 * @returns {import('./states.js').FixtureAnchor[]}
 */
function wallCapsuleAnchors(id) {
  return [
    { anchor: `capsule/${id}/panel`, role: 'region' },
    { anchor: `capsule/${id}/fold`, role: 'button', ifPresent: true },
    { anchor: `capsule/${id}/control`, role: 'button', ifPresent: true },
  ];
}

/** @type {import('./states.js').FixtureState} */
export const INPUT_WRITE_FIXTURE = deepFreeze({
  key: INPUT_WRITE_KEY,
  screen: 'wall',
  scheme: 'mv-light',
  density: 'compact',
  epoch: 1,
  revision: 13,
  capsules: [
    capsule('cap-01', { title: 'Human control tile', kind: 'program', control: 'human' }),
  ],
  ui: {
    launcherOpen: false,
    inputMode: 'WRITE',
  },
  expectedAnchors: [
    ...chromeAnchors(),
    ...wallCapsuleAnchors('cap-01'),
  ],
});
