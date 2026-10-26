/**
 * @file Deterministic `?state=` fixture data for MetaViewer screens (lane U5).
 * Pure frozen data: no host calls, no dates, no random ids. Every screen
 * state of the mvui1 room is reachable through these ten fixtures.
 * Plain JavaScript ES module with JSDoc types.
 */

/**
 * @typedef {Object} FixtureCapsule
 * @property {string} id - Immutable capsule identity (`cap-NN`).
 * @property {string} surfaceId - Bound surface identity (mirrors `id`).
 * @property {string} title - Display title.
 * @property {string} kind - Catalog kind (`identity-browser`, `program`, `holdings-app`, `desktop`).
 * @property {string} backendLifecycle - `active`, `standby`, or `lost`.
 * @property {number} generation - Immutable surface generation.
 * @property {string} visibility - `folded` or `unfolded`.
 * @property {string} control - `human`, `agent`, or `shared`.
 * @property {string} attachmentState - `attaching`, `live`, or `disconnected`.
 * @property {string} aiSessionActivity - `unknown`, `ready`, `busy`, or `failed`.
 * @property {string} dispatchOutcome - `none`, `verified`, or `refused`.
 */

/**
 * @typedef {Object} FixtureAnchor
 * @property {string} anchor - Expected concrete semantic anchor.
 * @property {string} role - Expected effective role.
 */

/**
 * @typedef {Object} FixtureState
 * @property {string} key - Canonical `?state=` key.
 * @property {string} screen - Screen label (`wall`, `multislot`, `settings`, `nested`).
 * @property {string} scheme - `mv-light` or `mv-dark`.
 * @property {string} density - `compact`.
 * @property {number} epoch
 * @property {number} revision
 * @property {readonly FixtureCapsule[]} capsules
 * @property {Readonly<Record<string, unknown>>} ui - Screen-specific flags.
 * @property {readonly FixtureAnchor[]} expectedAnchors - Anchors the lane snapshot should find.
 */

/** Canonical `?state=` keys in room order. */
export const FIXTURE_KEYS = Object.freeze([
  'empty',
  'one',
  'four',
  'nine',
  'tile-states',
  'multislot',
  'side-terminal-open',
  'recording',
  'settings-dark',
  'nested',
]);

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
 * @param {Partial<FixtureCapsule>} [over]
 * @returns {FixtureCapsule}
 */
function capsule(id, over = {}) {
  return {
    id,
    surfaceId: id,
    title: `Capsule ${id}`,
    kind: 'program',
    backendLifecycle: 'active',
    generation: 1,
    visibility: 'unfolded',
    control: 'human',
    attachmentState: 'live',
    aiSessionActivity: 'ready',
    dispatchOutcome: 'none',
    ...over,
  };
}

/**
 * Shell chrome anchors verified in `ui/src/App.vue` (room-owned shell).
 * @returns {FixtureAnchor[]}
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
 * @param {boolean} [withControl]
 * @returns {FixtureAnchor[]}
 */
function wallCapsuleAnchors(id, withControl = true) {
  const rows = [
    { anchor: `capsule/${id}/panel`, role: 'region' },
    { anchor: `capsule/${id}/slot`, role: 'region' },
    { anchor: `capsule/${id}/fold`, role: 'button' },
  ];
  if (withControl) rows.push({ anchor: `capsule/${id}/control`, role: 'button' });
  return rows;
}

/**
 * @param {readonly FixtureCapsule[]} capsules
 * @param {boolean} [withControl]
 * @returns {FixtureAnchor[]}
 */
function wallAnchors(capsules, withControl = true) {
  const rows = chromeAnchors();
  for (const row of capsules) rows.push(...wallCapsuleAnchors(row.id, withControl));
  return rows;
}

/** @type {Readonly<Record<string, FixtureState>>} */
export const FIXTURES = deepFreeze({
  empty: {
    key: 'empty',
    screen: 'wall',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 1,
    capsules: [],
    ui: { launcherOpen: false },
    expectedAnchors: [...chromeAnchors(), { anchor: 'wall/add-capsule', role: 'button' }],
  },
  one: {
    key: 'one',
    screen: 'wall',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 2,
    capsules: [capsule('cap-01', { title: 'Research browser', kind: 'identity-browser' })],
    ui: { launcherOpen: false },
    expectedAnchors: wallAnchors([capsule('cap-01')]),
  },
  four: {
    key: 'four',
    screen: 'wall',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 3,
    capsules: [
      capsule('cap-01', { title: 'Research browser', kind: 'identity-browser' }),
      capsule('cap-02', { title: 'Project editor', kind: 'program' }),
      capsule('cap-03', { title: 'Holdings board', kind: 'holdings-app' }),
      capsule('cap-04', { title: 'Team desktop', kind: 'desktop' }),
    ],
    ui: { launcherOpen: false },
    expectedAnchors: wallAnchors([
      capsule('cap-01'),
      capsule('cap-02'),
      capsule('cap-03'),
      capsule('cap-04'),
    ]),
  },
  nine: {
    key: 'nine',
    screen: 'wall',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 4,
    capsules: [
      capsule('cap-01', { title: 'Research browser', kind: 'identity-browser' }),
      capsule('cap-02', { title: 'Project editor', kind: 'program' }),
      capsule('cap-03', { title: 'Holdings board', kind: 'holdings-app' }),
      capsule('cap-04', { title: 'Team desktop', kind: 'desktop' }),
      capsule('cap-05', { title: 'Review notes', kind: 'program' }),
      capsule('cap-06', { title: 'Inbox triage', kind: 'identity-browser' }),
      capsule('cap-07', { title: 'Release console', kind: 'program' }),
      capsule('cap-08', { title: 'Design review', kind: 'desktop' }),
      capsule('cap-09', { title: 'On-call board', kind: 'holdings-app' }),
    ],
    ui: { launcherOpen: false },
    expectedAnchors: wallAnchors([
      capsule('cap-01'),
      capsule('cap-02'),
      capsule('cap-03'),
      capsule('cap-04'),
      capsule('cap-05'),
      capsule('cap-06'),
      capsule('cap-07'),
      capsule('cap-08'),
      capsule('cap-09'),
    ]),
  },
  'tile-states': {
    key: 'tile-states',
    screen: 'wall',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 5,
    capsules: [
      capsule('cap-01', { title: 'Connecting tile', attachmentState: 'attaching', aiSessionActivity: 'unknown' }),
      capsule('cap-02', { title: 'Live tile' }),
      capsule('cap-03', { title: 'Folded tile', visibility: 'folded' }),
      capsule('cap-04', { title: 'Human control tile', control: 'human' }),
      capsule('cap-05', { title: 'Agent acting tile', control: 'agent', aiSessionActivity: 'busy' }),
      capsule('cap-06', { title: 'Lost tile', backendLifecycle: 'lost', attachmentState: 'disconnected', aiSessionActivity: 'unknown' }),
      capsule('cap-07', { title: 'Error tile', aiSessionActivity: 'failed', dispatchOutcome: 'refused' }),
    ],
    ui: { launcherOpen: false },
    expectedAnchors: wallAnchors([
      capsule('cap-01'),
      capsule('cap-02'),
      capsule('cap-03'),
      capsule('cap-04'),
      capsule('cap-05'),
      capsule('cap-06'),
      capsule('cap-07'),
    ]),
  },
  multislot: {
    key: 'multislot',
    screen: 'multislot',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 6,
    capsules: [
      capsule('cap-01', {
        title: 'Assisted editor',
        control: 'shared',
        aiSessionActivity: 'busy',
        dispatchOutcome: 'verified',
      }),
    ],
    ui: {
      provider: 'claude',
      inputMode: 'READ',
      terminalAttached: true,
      terminalSession: 'term-01',
    },
    expectedAnchors: [
      ...wallAnchors([capsule('cap-01')]),
      { anchor: 'capsule/cap-01/input-mode', role: 'switch' },
      { anchor: 'capsule/cap-01/copy-id', role: 'button' },
      { anchor: 'capsule/cap-01/terminal', role: 'region' },
    ],
  },
  'side-terminal-open': {
    key: 'side-terminal-open',
    screen: 'wall',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 7,
    capsules: [capsule('cap-01', { title: 'Project editor' })],
    ui: { sideTerminal: { open: true, width: 420, overlay: true } },
    expectedAnchors: [
      ...wallAnchors([capsule('cap-01')]),
      { anchor: 'terminal/overlay', role: 'complementary' },
    ],
  },
  recording: {
    key: 'recording',
    screen: 'wall',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 8,
    capsules: [capsule('cap-01', { title: 'Demo capture' })],
    ui: {
      recording: {
        ram: true,
        screenshotArmed: true,
        disk: { configured: false },
      },
    },
    expectedAnchors: [
      ...wallAnchors([capsule('cap-01')]),
      { anchor: 'recording/cap-01/toggle', role: 'button' },
      { anchor: 'recording/cap-01/phase', role: 'status' },
    ],
  },
  'settings-dark': {
    key: 'settings-dark',
    screen: 'settings',
    scheme: 'mv-dark',
    density: 'compact',
    epoch: 1,
    revision: 9,
    capsules: [],
    ui: { settings: { density: 'compact' } },
    expectedAnchors: [
      ...chromeAnchors(),
      { anchor: 'settings/density', role: 'generic' },
    ],
  },
  nested: {
    key: 'nested',
    screen: 'nested',
    scheme: 'mv-light',
    density: 'compact',
    epoch: 1,
    revision: 10,
    capsules: [
      capsule('cap-01', { title: 'Nested browser', kind: 'identity-browser', control: 'shared' }),
      capsule('cap-02', { title: 'Nested editor', kind: 'program', control: 'shared' }),
    ],
    ui: { nested: { depth: 1, displayOnly: true } },
    expectedAnchors: wallAnchors([capsule('cap-01'), capsule('cap-02')], false),
  },
});
