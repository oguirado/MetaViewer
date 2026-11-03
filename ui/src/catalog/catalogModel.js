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
 * launcher. Carries the kind id, presentation placement and, for program
 * capsules, the requested binary name.
 * @property {string} type Always `'create-capsule'`.
 * @property {string} kind Known kind id.
 * @property {CatalogPlacement} placement Requested placement.
 * @property {string} [binary] Required binary name when `kind === 'program'`.
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
    kind: 'host-program', label: 'Host program', category: 'Programs',
    description: 'Runs on your computer — not isolated.', opensAs: 'tab', footprint: '',
    keywords: Object.freeze(['host', 'xpra', 'binary', 'browser']),
  }),
  Object.freeze({
    kind: 'desktop-window',
    label: 'Desktop window',
    category: 'Windows',
    description: 'Attach an open X11 desktop window into a capsule tile. Native Wayland windows are not listed.',
    opensAs: 'tab',
    footprint: '',
    keywords: Object.freeze(['window', 'desktop', 'host', 'attach']),
  }),
  Object.freeze({kind:'vm',label:'ARM64 Linux VM',category:'Virtual machines',
    description:'Open the configured graphical VM with verified frames. Requires host support.',
    opensAs:'tab',footprint:'',keywords:Object.freeze(['vm','linux','arm64'])}),
]);

/**
 * Kind ids in display order.
 * @type {ReadonlyArray<string>}
 */
export const CATALOG_KIND_IDS = Object.freeze(CATALOG_KINDS.map((entry) => entry.kind));

/** Static descriptors stay closed; runtime availability defaults to hidden.
 * @param {unknown} [vmAvailable]
 * @returns {ReadonlyArray<string>}
 */
export function availableCatalogKindIds(vmAvailable = false) {
  return Object.freeze(CATALOG_KIND_IDS.filter(kind => kind !== 'vm' || vmAvailable === true));
}

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
 * Malformed entries carry no raw kind, so they collapse to one shared
 * invalid-entry row by design; indexed suffixes disambiguate distinct
 * unknown kinds whose slugs collide.
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
 * Normalize one desktop window candidate from `srf-host-window list`.
 * Rejects missing/invalid xid, empty/>128-byte/NUL/whitespace witness,
 * >512-char or NUL title, and empty/>256-char or NUL program.
 * @param {unknown} raw
 * @returns {Readonly<{ xid: number, witness: string, title: string, program: string, width: number, height: number }> | null}
 */
export function normalizeWindowCandidate(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  let xid = 0;
  if (typeof r.xid === 'number' && Number.isInteger(r.xid)) {
    xid = r.xid;
  } else if (typeof r.xid === 'string' && /^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(r.xid.trim())) {
    xid = Number.parseInt(r.xid.trim(), r.xid.trim().toLowerCase().startsWith('0x') ? 16 : 10);
  }
  if (!Number.isInteger(xid) || xid < 1 || xid > 0xffffffff) return null;
  const rawWitness = typeof r.witness === 'string' ? r.witness : (typeof r.generation === 'string' ? r.generation : '');
  if (
    rawWitness.length < 1 ||
    rawWitness.length > 128 ||
    /[\0-\x20\x7f;|&$`<>(){}[\]!#*?~"'\\]/.test(rawWitness)
  ) {
    return null;
  }
  const rawTitle = typeof r.title === 'string' ? r.title : '';
  if (rawTitle.length > 512 || rawTitle.includes('\0')) return null;
  const trimmedTitle = rawTitle.trim();
  const title = trimmedTitle.length > 0 ? trimmedTitle : 'Untitled window';
  const rawProgram =
    typeof r.program === 'string'
      ? r.program
      : typeof r.executable === 'string'
        ? r.executable
        : typeof r.class === 'string'
          ? r.class
          : '';
  const program = rawProgram.trim();
  if (program.length < 1 || program.length > 256 || program.includes('\0')) return null;
  const rawW = typeof r.width === 'number' ? r.width : (typeof r.w === 'number' ? r.w : 1280);
  const rawH = typeof r.height === 'number' ? r.height : (typeof r.h === 'number' ? r.h : 900);
  if (!Number.isInteger(rawW) || rawW < 1 || rawW > 4096 || !Number.isInteger(rawH) || rawH < 1 || rawH > 4096) {
    return null;
  }
  return Object.freeze({
    xid,
    witness: rawWitness,
    title,
    program,
    width: rawW,
    height: rawH,
  });
}

/**
 * Whole-list fail-closed admission for desktop window candidates (Cafe select flow):
 * any invalid row or duplicate xid/witness rejects the entire list.
 * @param {unknown} entries
 * @returns {Readonly<{ ok: boolean, windows: ReadonlyArray<Readonly<{ xid: number, witness: string, title: string, program: string, width: number, height: number }>> }>}
 */
export function normalizeWindowList(entries) {
  if (!Array.isArray(entries)) {
    return Object.freeze({ ok: false, windows: Object.freeze([]) });
  }
  const windows = [];
  const seenXids = new Set();
  const seenWitnesses = new Set();
  for (const entry of entries) {
    const normalized = normalizeWindowCandidate(entry);
    if (!normalized || seenXids.has(normalized.xid) || seenWitnesses.has(normalized.witness)) {
      return Object.freeze({ ok: false, windows: Object.freeze([]) });
    }
    seenXids.add(normalized.xid);
    seenWitnesses.add(normalized.witness);
    windows.push(normalized);
  }
  return Object.freeze({ ok: true, windows: Object.freeze(windows) });
}

/**
 * Filter normalized window candidates by title or program search query.
 * @param {ReadonlyArray<{ xid: number, witness: string, title: string, program: string, width: number, height: number }>} windows
 * @param {unknown} query
 */
export function filterWindowCandidates(windows, query) {
  if (!Array.isArray(windows)) return Object.freeze([]);
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!needle) return Object.freeze([...windows]);
  return Object.freeze(
    windows.filter(
      (w) =>
        w &&
        (String(w.title || '').toLowerCase().includes(needle) ||
          String(w.program || '').toLowerCase().includes(needle)),
    ),
  );
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
  const placement = resolveCatalogPlacement(record.placement);
  if (record.kind === 'program' || record.kind === 'host-program') {
    const binary = typeof record.binary === 'string' ? record.binary.trim() : '';
    if (binary.length === 0) {
      return Object.freeze({ ok: false, error: invalidIntentRow() });
    }
    if (record.role !== undefined && record.role !== 'human' && record.role !== 'agent') {
      return Object.freeze({ ok: false, error: invalidIntentRow() });
    }
    return Object.freeze({
      ok: true,
      intent: Object.freeze({
        type: 'create-capsule',
        kind: record.kind,
        placement,
        binary,
        ...(record.role !== undefined ? { role: record.role } : {}),
      }),
    });
  }
  if (record.kind === 'desktop-window') {
    const win = normalizeWindowCandidate(record.window);
    if (!win) {
      return Object.freeze({ ok: false, error: invalidIntentRow() });
    }
    return Object.freeze({
      ok: true,
      intent: Object.freeze({
        type: 'create-capsule',
        kind: 'desktop-window',
        placement,
         window: win,
      }),
    });
  }
  return Object.freeze({
    ok: true,
    intent: Object.freeze({
      type: 'create-capsule',
      kind: record.kind,
      placement,
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
