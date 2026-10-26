/**
 * MetaViewer capsule catalog model: closed kind set, typed error rows and
 * create-intent builder for the New Capsule launcher (AC-03).
 *
 * Pure module: no DOM, no framework, no host calls. Unknown or malformed
 * entries resolve to frozen, typed error rows; nothing here throws.
 *
 * @module catalog/catalogModel
 */

/**
 * @typedef {'tab'|'split'|'floating'} CatalogPlacement Placement mode the
 * host opens the chosen capsule with.
 */

/**
 * @typedef {object} CatalogKind Closed descriptor for one capsule kind.
 * @property {string} kind Stable kind id (kebab-case slug).
 * @property {string} label Visible kind name.
 * @property {string} category Category label shown in the launcher rail.
 * @property {string} description One-line summary shown on the card.
 * @property {CatalogPlacement} opensAs Suggested placement for this kind.
 * @property {string} footprint Display footprint; empty when unestimated.
 * @property {ReadonlyArray<string>} keywords Extra match terms, never shown.
 */

/**
 * @typedef {object} CatalogDialogType Launcher card entry, matching the kit
 * NewCapsuleType shape (`id`, `label`, `category`, `description`,
 * `opensAs`, `footprint`, `keywords`).
 * @property {string} id Kind id, equal to `CatalogKind.kind`.
 * @property {string} label Visible kind name.
 * @property {string} category Category label shown in the launcher rail.
 * @property {string} description One-line summary shown on the card.
 * @property {CatalogPlacement} opensAs Suggested placement for this kind.
 * @property {string} footprint Display footprint; empty when unestimated.
 * @property {ReadonlyArray<string>} keywords Extra match terms, never shown.
 */

/**
 * @typedef {object} CatalogErrorRow Typed error row for one rejected entry.
 * @property {string} code Stable error code.
 * @property {string|null} kind Raw kind id when the entry carried a string
 * kind, otherwise null.
 * @property {string} message Renderable one-line explanation (plain text).
 * @property {string} key Stable kebab-case row key for ids and anchors.
 */

/**
 * @typedef {object} CatalogCreateIntent Create intent payload emitted by the
 * launcher. Carries the kind id and presentation placement only; the core
 * selects the allowlisted profile, never renderer executables or paths.
 * @property {string} type Always `'create-capsule'`.
 * @property {string} kind Known kind id.
 * @property {CatalogPlacement} placement Requested placement.
 */

/**
 * @typedef {object} CatalogResolveOk
 * @property {true} ok
 * @property {Readonly<CatalogDialogType>} type
 */
/**
 * @typedef {object} CatalogResolveFail
 * @property {false} ok
 * @property {Readonly<CatalogErrorRow>} error
 */
/** @typedef {CatalogResolveOk|CatalogResolveFail} CatalogResolveResult */
/**
 * @typedef {object} CatalogIntentOk
 * @property {true} ok
 * @property {Readonly<CatalogCreateIntent>} intent
 */
/**
 * @typedef {object} CatalogIntentFail
 * @property {false} ok
 * @property {Readonly<CatalogErrorRow>} error
 */
/** @typedef {CatalogIntentOk|CatalogIntentFail} CatalogIntentResult */
/**
 * @typedef {object} CatalogEntries
 * @property {ReadonlyArray<Readonly<CatalogDialogType>>} types
 * @property {ReadonlyArray<Readonly<CatalogErrorRow>>} errors
 */

/** Unknown kind id: typed error row, never a crash. */
export const CATALOG_UNKNOWN_KIND = 'ERR_CATALOG_UNKNOWN_KIND';
/** Malformed catalog entry (no usable string kind). */
export const CATALOG_INVALID_ENTRY = 'ERR_CATALOG_INVALID_ENTRY';
/** Malformed create-intent input. */
export const CATALOG_INVALID_INTENT = 'ERR_CATALOG_INVALID_INTENT';

/**
 * Closed capsule kind set for the MetaViewer launcher, in display order.
 * @type {ReadonlyArray<Readonly<CatalogKind>>}
 */
export const CATALOG_KINDS = Object.freeze([
  Object.freeze({
    kind: 'identity-browser',
    label: 'Identity browser',
    category: 'Browse',
    description: 'Open a web identity in its own capsule.',
    opensAs: 'tab',
    footprint: '',
    keywords: Object.freeze(['web', 'browser', 'identity', 'site']),
  }),
  Object.freeze({
    kind: 'program',
    label: 'Program',
    category: 'Programs',
    description: 'Run a program in its own capsule.',
    opensAs: 'tab',
    footprint: '',
    keywords: Object.freeze(['program', 'run', 'app']),
  }),
  Object.freeze({
    kind: 'holdings-app',
    label: 'Holdings app',
    category: 'Programs',
    description: 'Open a Holdings app in its own capsule.',
    opensAs: 'tab',
    footprint: '',
    keywords: Object.freeze(['holdings', 'app']),
  }),
  Object.freeze({
    kind: 'desktop',
    label: 'Desktop',
    category: 'Desktops',
    description: 'Open a full desktop in its own capsule.',
    opensAs: 'tab',
    footprint: '',
    keywords: Object.freeze(['desktop', 'screen']),
  }),
]);

/**
 * Kind ids in display order.
 * @type {ReadonlyArray<string>}
 */
export const CATALOG_KIND_IDS = Object.freeze(CATALOG_KINDS.map((entry) => entry.kind));

/** @type {ReadonlyMap<string, Readonly<CatalogKind>>} */
const BY_KIND = new Map(CATALOG_KINDS.map((entry) => [entry.kind, entry]));

/**
 * @param {unknown} value
 * @returns {boolean} True only for an exact known kind id.
 */
export function isKnownCatalogKind(value) {
  return typeof value === 'string' && BY_KIND.has(value);
}

/**
 * Slugify free text into a kebab-case id segment.
 * @param {unknown} value Raw text.
 * @returns {string} Lowercase slug; `'unknown'` for non-strings and empties.
 */
export function slugifyCatalogKey(value) {
  if (typeof value !== 'string') return 'unknown';
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'unknown' : slug;
}

/**
 * @param {Readonly<CatalogKind>} entry
 * @returns {Readonly<CatalogDialogType>} Frozen kit-compatible card entry.
 */
function toDialogType(entry) {
  return Object.freeze({
    id: entry.kind,
    label: entry.label,
    category: entry.category,
    description: entry.description,
    opensAs: entry.opensAs,
    footprint: entry.footprint,
    keywords: Object.freeze([...entry.keywords]),
  });
}

/**
 * @param {string} kind Raw unknown kind id.
 * @returns {Readonly<CatalogErrorRow>} Frozen typed error row.
 */
function unknownKindRow(kind) {
  return Object.freeze({
    code: CATALOG_UNKNOWN_KIND,
    kind,
    message: `Unknown capsule kind: ${JSON.stringify(kind)}.`,
    key: `unknown-kind-${slugifyCatalogKey(kind)}`,
  });
}

/** @returns {Readonly<CatalogErrorRow>} Frozen typed error row. */
function invalidEntryRow() {
  return Object.freeze({
    code: CATALOG_INVALID_ENTRY,
    kind: null,
    message: 'Invalid catalog entry.',
    key: 'invalid-entry-unknown',
  });
}

/** @returns {Readonly<CatalogErrorRow>} Frozen typed error row. */
function invalidIntentRow() {
  return Object.freeze({
    code: CATALOG_INVALID_INTENT,
    kind: null,
    message: 'Invalid create intent.',
    key: 'invalid-intent',
  });
}

/**
 * Resolve one kind id to a launcher card entry or a typed error row.
 * @param {unknown} value Candidate kind id.
 * @returns {CatalogResolveResult} Frozen result; never throws.
 */
export function resolveCatalogKind(value) {
  if (typeof value !== 'string') {
    return Object.freeze({ ok: false, error: invalidEntryRow() });
  }
  const found = BY_KIND.get(value);
  if (!found) {
    return Object.freeze({ ok: false, error: unknownKindRow(value) });
  }
  return Object.freeze({ ok: true, type: toDialogType(found) });
}

/**
 * @param {unknown} value Raw catalog entry.
 * @returns {value is { kind: string }} True for `{ kind: string }` objects.
 */
function isKindCarrier(value) {
  if (typeof value !== 'object' || value === null) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.kind === 'string';
}

/**
 * Normalize a host catalog into launcher card entries plus typed error
 * rows. Entries are kind-id strings or `{ kind }` objects. Valid kinds are
 * deduplicated by kind id (first wins); errors are deduplicated by raw kind
 * (first wins); colliding slugs receive unique indexed suffixes.
 * @param {unknown} entries Raw host catalog.
 * @returns {Readonly<CatalogEntries>} Frozen `{ types, errors }`.
 */
export function normalizeCatalogEntries(entries) {
  if (!Array.isArray(entries)) {
    return Object.freeze({ types: Object.freeze([]), errors: Object.freeze([]) });
  }
  /** @type {Array<Readonly<CatalogDialogType>>} */
  const types = [];
  /** @type {Array<Readonly<CatalogErrorRow>>} */
  const errors = [];
  const seenTypes = new Set();
  const seenErrors = new Set();
  const usedKeys = new Set();
  for (const entry of entries) {
    const candidate = typeof entry === 'string' ? entry : (isKindCarrier(entry) ? entry.kind : null);
    const result = resolveCatalogKind(candidate);
    if (result.ok) {
      if (seenTypes.has(result.type.id)) continue;
      seenTypes.add(result.type.id);
      types.push(result.type);
    } else {
      const identity = result.error.kind;
      if (seenErrors.has(identity)) continue;
      seenErrors.add(identity);
      const base = result.error.key;
      let key = base, suffix = 2;
      while (usedKeys.has(key)) key = `${base}-${suffix++}`;
      usedKeys.add(key);
      errors.push(Object.freeze({ ...result.error, key }));
    }
  }
  return Object.freeze({ types: Object.freeze(types), errors: Object.freeze(errors) });
}

/**
 * @param {unknown} value Raw placement preference.
 * @returns {CatalogPlacement} Supported placement; `'tab'` unless the input
 * is exactly `'split'` or `'floating'`.
 */
export function resolveCatalogPlacement(value) {
  if (value === 'split' || value === 'floating') return value;
  return 'tab';
}

/**
 * Build the create intent payload for one launcher choice. Unknown kinds
 * and malformed inputs resolve to frozen typed errors, never throws.
 * @param {unknown} input Raw `{ kind, placement }` choice.
 * @returns {CatalogIntentResult} Frozen result.
 */
export function buildCreateIntent(input) {
  if (typeof input !== 'object' || input === null) {
    return Object.freeze({ ok: false, error: invalidIntentRow() });
  }
  const record = /** @type {Record<string, unknown>} */ (input);
  if (typeof record.kind !== 'string') {
    return Object.freeze({ ok: false, error: invalidIntentRow() });
  }
  if (!BY_KIND.has(record.kind)) {
    return Object.freeze({ ok: false, error: unknownKindRow(record.kind) });
  }
  return Object.freeze({
    ok: true,
    intent: Object.freeze({
      type: 'create-capsule',
      kind: record.kind,
      placement: resolveCatalogPlacement(record.placement),
    }),
  });
}

/**
 * Invoker focus capture for dialog focus return. The launcher captures the
 * focused element on open and restores it on close.
 * @returns {{ capture: (node: unknown) => void, restore: () => boolean }}
 * Capture stores the invoker; restore focuses it when still connected and
 * reports whether it focused.
 */
export function createInvokerFocus() {
  /** @type {unknown} */
  let invoker = null;
  return {
    /** @param {unknown} node */
    capture(node) {
      invoker = node;
    },
    /** @returns {boolean} */
    restore() {
      const target = /** @type {{ focus?: unknown, isConnected?: unknown } | null} */ (invoker);
      invoker = null;
      if (typeof target !== 'object' || target === null) return false;
      if (typeof target.focus !== 'function') return false;
      if (target.isConnected === false) return false;
      target.focus();
      return true;
    },
  };
}
