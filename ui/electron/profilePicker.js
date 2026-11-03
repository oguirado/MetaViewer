// @ts-check
'use strict';

/**
 * MULTI-CAPSULE profile picker: chooses the browser profile for each additional
 * "Add capsule" create. Pure and synchronous at its core; every input (the
 * environment record, the live surface states, the identity names) is injected.
 * No filesystem, process, network or Electron access, and no identity contents.
 *
 * [TARGET, unit decision] Contract owned by this module:
 * - Candidates are the browser-kind entries of MV_SRF_PROFILES (insertion order,
 *   the MV_SRF_LIVE_PROFILE entry first, as in buildFirstSurfaceCreateRequest);
 *   with no usable map the single live profile (MV_SRF_LIVE_PROFILE or
 *   `mv-live-1`) is the only candidate.
 * - A profile bound to a live surface is never offered again.
 * - A profile is offered only when its identity already exists (names only, from
 *   the product's identity list). Nothing here creates or touches identities.
 * - At most MAX_CAPSULES (16) surfaces are live at once, matching the adapter
 *   MaxSurfaces ceiling [MEASURED]; each capsule's Docker limit is 4 GiB memory
 *   plus 2 GiB /dev/shm (6 GiB total) with no default CPU pinning unless the
 *   operator sets SRF_CPUSET [MEASURED: OpenSuperficies launch.go / surface.go].
 * - Before each create, host free memory is checked against one capsule's 6 GiB
 *   limit; below it, admission refuses with RAM_ADMISSION_REFUSED and a reason
 *   saying what to close.
 * - Typed refusals: CAPSULE_LIMIT_REACHED, RAM_ADMISSION_REFUSED,
 *   NO_FREE_PROFILE, NO_IDENTITY, IDENTITY_LIST_UNAVAILABLE,
 *   PICKER_INPUT_INVALID. Every refusal fails closed.
 * - The boot create keeps using buildFirstSurfaceCreateRequest (first profile).
 */

// [TARGET, unit decision] One creation flight per host state map, shared by
// boot, browser and role bridges before their first asynchronous admission read.
/** @type {WeakSet<object>} */
const creationFlights = new WeakSet();
/** @param {object} states @returns {(() => void) | null} */
export function acquireCapsuleCreation(states) {
  if (creationFlights.has(states)) return null;
  creationFlights.add(states);
  let released = false;
  return () => {
    if (!released) { released = true; creationFlights.delete(states); }
  };
}

/** Concurrent capsule ceiling matching the daemon-adapter MaxSurfaces limit [MEASURED]. */
export const MAX_CAPSULES = 16;

/** Per-capsule Docker memory limit (4 GiB) [MEASURED]. */
export const CAPSULE_DOCKER_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;

/** Per-capsule Docker shared-memory (/dev/shm) limit (2 GiB) [MEASURED]. */
export const CAPSULE_DOCKER_SHM_BYTES = 2 * 1024 * 1024 * 1024;

/** Host free memory required before admitting one capsule create (4 GiB RAM + 2 GiB shm = 6 GiB) [MEASURED]. */
export const CAPSULE_MEMORY_LIMIT_BYTES = CAPSULE_DOCKER_MEMORY_BYTES + CAPSULE_DOCKER_SHM_BYTES;

/** Same pattern the host request validator and the adapter admit. */
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAP_BYTES_MAX = 1048576;
const KINDS = Object.freeze(['desktop_capsule', 'browser', 'game_capsule', 'vm']);

/**
 * @typedef {Readonly<{
 *   schema: 'surface_request/v0.2',
 *   op: 'create',
 *   params: Readonly<{kind: string, geometry: Readonly<{w: number, h: number}>, profile_id: string, nested_depth?: number}>,
 * }>} CreateRequest
 * @typedef {Readonly<{id: string, request: CreateRequest}>} ProfileEntry
 * @typedef {Readonly<{
 *   ok: false,
 *   code: 'CAPSULE_LIMIT_REACHED' | 'RAM_ADMISSION_REFUSED' | 'NO_FREE_PROFILE' | 'NO_IDENTITY' | 'IDENTITY_LIST_UNAVAILABLE' | 'PICKER_INPUT_INVALID',
 *   configured: number,
 *   live: number,
 *   missing: ReadonlyArray<string>,
 *   freeMemoryBytes?: number | null,
 * }>} Refusal
 * @typedef {Readonly<{ok: true, profile_id: string, request: CreateRequest, configured: number}>} Pick
 */

/** @param {unknown} v @returns {v is string} */
const validId = (v) => typeof v === 'string' && PROFILE_ID.test(v);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Parse `MemAvailable:` from `/proc/meminfo` text into bytes.
 * Pure helper: performs no filesystem or process access.
 * @param {unknown} meminfoText
 * @returns {number | null}
 */
export function parseMemAvailableBytes(meminfoText) {
  if (typeof meminfoText !== 'string' || meminfoText.length === 0) return null;
  const match = /^MemAvailable:\s*(\d+)\s*kB\s*$/m.exec(meminfoText);
  if (!match) return null;
  const kb = Number(match[1]);
  if (!Number.isSafeInteger(kb) || kb < 0) return null;
  const bytes = kb * 1024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Format the operator refusal sentence when the concurrent capsule ceiling is reached.
 * @param {number} [live]
 * @returns {string}
 */
export function formatCapsuleLimitReason(live = MAX_CAPSULES) {
  const openCount = Number.isSafeInteger(live) && live >= 0 ? live : MAX_CAPSULES;
  return `At most ${MAX_CAPSULES} capsules run at once (${openCount} of ${MAX_CAPSULES} open). Close a capsule to open another.`;
}

/**
 * Format the operator refusal sentence when no logical capsule slot is free.
 * @param {number} [live]
 * @returns {string}
 */
export function formatCapsuleSlotReason(live = MAX_CAPSULES) {
  const openCount = Number.isSafeInteger(live) && live >= 0 ? live : MAX_CAPSULES;
  return `No free capsule slot (${openCount} of ${MAX_CAPSULES} open; limit is ${MAX_CAPSULES}). Stop another capsule first.`;
}

/**
 * Format the operator refusal sentence when host free memory is below one capsule's 6 GiB limit.
 * @param {number | null | undefined} freeMemoryBytes
 * @param {number} [live]
 * @returns {string}
 */
export function formatMemoryRefusalReason(freeMemoryBytes, live = 0) {
  const openCount = Number.isSafeInteger(live) && live >= 0 ? live : 0;
  if (typeof freeMemoryBytes === 'number' && Number.isSafeInteger(freeMemoryBytes) && freeMemoryBytes >= 0) {
    const gib = (freeMemoryBytes / (1024 ** 3)).toFixed(1);
    return `Not enough free host memory (${gib} GiB available; one capsule needs 6 GiB: 4 GiB RAM + 2 GiB shm; ${openCount} of ${MAX_CAPSULES} open). Close an open capsule or other applications and try again.`;
  }
  return 'Host memory availability could not be read. No capsule was started. Check the host memory probe and restart MetaViewer before trying again (one capsule needs 6 GiB: 4 GiB RAM + 2 GiB shm).';
}

/**
 * @param {string} id
 * @param {unknown} entry
 * @returns {ProfileEntry}
 */
function entryFor(id, entry) {
  let kind = 'browser';
  let w = 1280;
  let h = 900;
  /** @type {number | undefined} */
  let nestedDepth;
  if (plain(entry)) {
    const rawKind = typeof entry.Kind === 'string' ? entry.Kind : typeof entry.kind === 'string' ? entry.kind : null;
    if (rawKind !== null && KINDS.includes(rawKind)) kind = rawKind;
    const rawW = Number.isSafeInteger(entry.Width) ? /** @type {number} */ (entry.Width)
      : Number.isSafeInteger(entry.width) ? /** @type {number} */ (entry.width) : null;
    if (rawW !== null && rawW >= 1 && rawW <= 16384) w = rawW;
    const rawH = Number.isSafeInteger(entry.Height) ? /** @type {number} */ (entry.Height)
      : Number.isSafeInteger(entry.height) ? /** @type {number} */ (entry.height) : null;
    if (rawH !== null && rawH >= 1 && rawH <= 16384) h = rawH;
    const rawDepth = Number.isSafeInteger(entry.NestedDepth) ? /** @type {number} */ (entry.NestedDepth)
      : Number.isSafeInteger(entry.nested_depth) ? /** @type {number} */ (entry.nested_depth) : null;
    if (kind === 'desktop_capsule' && (rawDepth === 0 || rawDepth === 1)) nestedDepth = rawDepth;
  }
  const geometry = Object.freeze({ w, h });
  const params = Object.freeze(nestedDepth !== undefined
    ? { kind, geometry, profile_id: id, nested_depth: nestedDepth }
    : { kind, geometry, profile_id: id });
  return Object.freeze({
    id,
    request: Object.freeze({ schema: /** @type {const} */ ('surface_request/v0.2'), op: /** @type {const} */ ('create'), params }),
  });
}

/**
 * Ordered browser-kind candidates. Mirrors the parse rules of
 * buildFirstSurfaceCreateRequest so the first candidate equals the boot create.
 * @param {Record<string, unknown>} envRec Environment record.
 * @returns {ReadonlyArray<ProfileEntry>}
 */
export function configuredProfiles(envRec) {
  const live = plain(envRec) && validId(envRec.MV_SRF_LIVE_PROFILE) ? envRec.MV_SRF_LIVE_PROFILE : null;
  const raw = plain(envRec) ? envRec.MV_SRF_PROFILES : undefined;
  /** @type {ProfileEntry[]} */
  const all = [];
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= MAP_BYTES_MAX) {
    try {
      const parsed = JSON.parse(raw);
      if (plain(parsed)) {
        const ids = Object.keys(parsed).filter((k) => validId(k) && Object.hasOwn(parsed, k));
        const ordered = live !== null && ids.includes(live) ? [live, ...ids.filter((k) => k !== live)] : ids;
        for (const id of ordered) all.push(entryFor(id, parsed[id]));
      }
    } catch {
      /* a malformed map falls back to the single live profile */
    }
  }
  if (all.length === 0) all.push(entryFor(live ?? 'mv-live-1', null));
  return Object.freeze(all.filter((p) => p.request.params.kind === 'browser'));
}

/**
 * Count live surfaces and collect the profiles they hold. A surface without a
 * readable profile_id still counts toward the ceiling.
 * @param {Iterable<unknown> | Map<string, unknown> | null | undefined} surfaces Host surface states.
 * @returns {{live: number, bound: Set<string>}}
 */
export function summarizeSurfaces(surfaces) {
  const bound = new Set();
  let live = 0;
  if (surfaces === null || surfaces === undefined) return { live, bound };
  const states = surfaces instanceof Map ? surfaces.values() : surfaces;
  for (const state of states) {
    if (!plain(state)) continue;
    // A lost browser still pins its profile until an explicit destroy proves release.
    if (state.state === 'lost' && state.kind === 'browser' && validId(state.profile_id)) bound.add(state.profile_id);
    if (state.state === 'destroyed' || state.state === 'lost') continue;
    live += 1;
    if (validId(state.profile_id)) bound.add(state.profile_id);
  }
  return { live, bound };
}

/**
 * Identity names from public identity rows (`{id,...}`). Only `id` strings that
 * pass the profile pattern are kept; labels, domains and everything else are dropped.
 * @param {unknown} rows
 * @returns {Set<string>}
 */
export function identityIds(rows) {
  const ids = new Set();
  if (!Array.isArray(rows)) return ids;
  for (const row of rows) if (plain(row) && validId(row.id)) ids.add(row.id);
  return ids;
}

/**
 * @param {Refusal['code']} code
 * @param {Partial<Omit<Refusal, 'ok' | 'code'>>} [extra]
 * @returns {Refusal}
 */
function refuse(code, extra = {}) {
  return Object.freeze({
    ok: /** @type {const} */ (false),
    code,
    configured: extra.configured ?? 0,
    live: extra.live ?? 0,
    missing: Object.freeze([...(extra.missing ?? [])]),
    ...(extra.freeMemoryBytes !== undefined ? { freeMemoryBytes: extra.freeMemoryBytes } : {}),
  });
}

/**
 * Pick the first free browser profile whose identity exists.
 * @param {{
 *   env: Record<string, unknown>,
 *   live: number,
 *   bound: ReadonlySet<string>,
 *   identities: ReadonlySet<string> | null,
 *   freeMemoryBytes?: number | null,
 * }} input
 * @returns {Pick | Refusal}
 */
export function pickProfile(input) {
  const { env, live, bound, identities, freeMemoryBytes } = input ?? /** @type {any} */ ({});
  if (!plain(env) || !Number.isSafeInteger(live) || live < 0 || !(bound instanceof Set)
      || (identities !== null && !(identities instanceof Set))
      || (freeMemoryBytes !== undefined && freeMemoryBytes !== null && (!Number.isSafeInteger(freeMemoryBytes) || freeMemoryBytes < 0))) {
    return refuse('PICKER_INPUT_INVALID');
  }
  const profiles = configuredProfiles(env);
  const configured = profiles.length;
  if (live >= MAX_CAPSULES) return refuse('CAPSULE_LIMIT_REACHED', { configured, live });
  if (freeMemoryBytes !== undefined && (freeMemoryBytes === null || freeMemoryBytes < CAPSULE_MEMORY_LIMIT_BYTES)) {
    return refuse('RAM_ADMISSION_REFUSED', { configured, live, freeMemoryBytes });
  }
  const free = profiles.filter((p) => !bound.has(p.id));
  if (free.length === 0) return refuse('NO_FREE_PROFILE', { configured, live });
  if (identities === null) return refuse('IDENTITY_LIST_UNAVAILABLE', { configured, live });
  const ready = free.find((p) => identities.has(p.id));
  if (ready === undefined) return refuse('NO_IDENTITY', { configured, live, missing: free.map((p) => p.id) });
  return Object.freeze({ ok: /** @type {const} */ (true), profile_id: ready.id, request: ready.request, configured });
}

/**
 * Hook for authorityWire createSurface: summarize the live surfaces, check host
 * free memory when supplied, ask for the identity names, then pick. A failing
 * identity list or memory probe is a typed refusal, never a silent fallback.
 * @param {{
 *   env: Record<string, unknown>,
 *   surfaces: Iterable<unknown> | Map<string, unknown> | null | undefined,
 *   listIdentities: () => Promise<{ok?: unknown, rows?: unknown} | null | undefined>,
 *   freeMemoryBytes?: number | null,
 *   readFreeMemoryBytes?: () => number | null | Promise<number | null>,
 * }} input
 * @returns {Promise<Pick | Refusal>}
 */
export async function pickCreateRequest(input) {
  const { env, surfaces, listIdentities, freeMemoryBytes, readFreeMemoryBytes } = input ?? /** @type {any} */ ({});
  if (typeof listIdentities !== 'function') return refuse('PICKER_INPUT_INVALID');
  if (readFreeMemoryBytes !== undefined && typeof readFreeMemoryBytes !== 'function') return refuse('PICKER_INPUT_INVALID');
  const { live, bound } = summarizeSurfaces(surfaces);
  /** @type {number | null | undefined} */
  let resolvedFreeBytes = freeMemoryBytes;
  if (typeof readFreeMemoryBytes === 'function') {
    try {
      const measured = await readFreeMemoryBytes();
      resolvedFreeBytes = Number.isSafeInteger(measured) && /** @type {number} */ (measured) >= 0 ? /** @type {number} */ (measured) : null;
    } catch {
      resolvedFreeBytes = null;
    }
  }
  /** @type {Set<string> | null} */
  let identities = null;
  try {
    const reply = await listIdentities();
    if (plain(reply) && reply.ok === true) identities = identityIds(reply.rows);
  } catch {
    identities = null;
  }
  return pickProfile({
    env,
    live,
    bound,
    identities,
    ...(resolvedFreeBytes !== undefined ? { freeMemoryBytes: resolvedFreeBytes } : {}),
  });
}

/**
 * Renderer copy for each refusal [TARGET, unit decision]. Static text only: it
 * never embeds profile ids, paths or environment values. `action` is an optional
 * button the renderer shows next to the message.
 */
export const REFUSAL_COPY = Object.freeze({
  CAPSULE_LIMIT_REACHED: Object.freeze({
    message: `At most ${MAX_CAPSULES} capsules run at once (${MAX_CAPSULES} of ${MAX_CAPSULES} open). Close a capsule to open another.`,
    action: null,
  }),
  RAM_ADMISSION_REFUSED: Object.freeze({
    message: 'Not enough free host memory to start another capsule (one capsule needs 6 GiB: 4 GiB RAM + 2 GiB shm). Close an open capsule or other applications and try again.',
    action: null,
  }),
  NO_FREE_PROFILE: Object.freeze({
    message: `Every configured capsule profile is already in use. To run more capsules, add profiles to MV_SRF_PROFILES (up to ${MAX_CAPSULES} in total) and restart MetaViewer; see "More than one capsule" in the User Guide.`,
    action: null,
    count: true,
  }),
  NO_IDENTITY: Object.freeze({
    message: 'No free capsule profile has an identity yet. Create an identity whose id matches a profile in MV_SRF_PROFILES, then press Add capsule again.',
    action: Object.freeze({ id: 'open-identities', label: 'Create identity…' }),
  }),
  IDENTITY_LIST_UNAVAILABLE: Object.freeze({
    message: 'The identity list could not be read, so no new capsule was opened. Open Identities to check the identity tool, then try again.',
    action: Object.freeze({ id: 'open-identities', label: 'Open Identities…' }),
  }),
  PICKER_INPUT_INVALID: Object.freeze({
    message: 'The capsule request could not be prepared. Please try again.',
    action: null,
  }),
});

/**
 * Reply shape for createSurface when the picker refuses. `ok:false` plus `code`
 * match the existing wire; `message` and `action` are the additive fields the
 * renderer hook reads.
 * @param {Refusal} refusal
 * @returns {Readonly<{ok: false, code: string, message: string, action: Readonly<{id: string, label: string}> | null}>}
 */
export function refusalReply(refusal) {
  const copy = REFUSAL_COPY[refusal.code] ?? REFUSAL_COPY.PICKER_INPUT_INVALID;
  /** @type {string} */
  let message = copy.message;
  if ('count' in copy && copy.count === true && Number.isSafeInteger(refusal.configured)) {
    message = `${refusal.configured} configured capsule profile${refusal.configured === 1 ? ' is' : 's are'} all in use. ${copy.message.replace(/^Every configured capsule profile is already in use\. /, '')}`;
  } else if (refusal.code === 'CAPSULE_LIMIT_REACHED' && Number.isSafeInteger(refusal.live)) {
    message = formatCapsuleLimitReason(refusal.live);
  } else if (refusal.code === 'RAM_ADMISSION_REFUSED' && 'freeMemoryBytes' in refusal && refusal.freeMemoryBytes !== undefined) {
    message = formatMemoryRefusalReason(refusal.freeMemoryBytes, refusal.live);
  }
  return Object.freeze({
    ok: /** @type {const} */ (false),
    code: Object.hasOwn(REFUSAL_COPY, refusal.code) ? refusal.code : 'PICKER_INPUT_INVALID',
    message,
    action: copy.action,
  });
}

/**
 * Operator sentences for every create-path refusal code [TARGET, unit decision].
 * Reuses the picker copy above and names the default second profile (`mv-live-2`)
 * for `NO_IDENTITY` when no specific missing profile id is supplied.
 */
export const CREATE_REFUSAL_REASONS = Object.freeze({
  CAPSULE_SLOT_UNAVAILABLE: `No free capsule slot. Stop another capsule first (up to ${MAX_CAPSULES} run at once).`,
  NO_BROWSER_CAPSULE: 'No browser capsule with a live frame.',
  CAPSULE_LIMIT_REACHED: REFUSAL_COPY.CAPSULE_LIMIT_REACHED.message,
  NO_FREE_PROFILE: REFUSAL_COPY.NO_FREE_PROFILE.message,
  NO_IDENTITY: 'No free capsule profile has an identity yet. Create an identity (mv-live-2) whose id matches a profile in MV_SRF_PROFILES, then press Add capsule again.',
  IDENTITY_LIST_UNAVAILABLE: REFUSAL_COPY.IDENTITY_LIST_UNAVAILABLE.message,
  PICKER_INPUT_INVALID: REFUSAL_COPY.PICKER_INPUT_INVALID.message,
  SURFACE_PROFILE_BOUND: 'Every configured capsule profile is already bound to a running capsule. Close or reuse the existing capsule, or add another profile to MV_SRF_PROFILES.',
  PROFILE_ALREADY_BOUND: 'The selected capsule profile is already bound to a running capsule. Close the running capsule or add another profile to MV_SRF_PROFILES.',
  SURFACE_CAPACITY_OR_QUARANTINE: 'No capsule slot is free or the profile is quarantined. Close a capsule or clear the quarantined profile before trying again.',
  SURFACE_PROFILE_QUARANTINED: 'The capsule profile is quarantined after a previous failure. Clear the quarantine before opening a new capsule.',
  IDENTITY_UNAVAILABLE: 'The capsule identity is unavailable or already held by another capsule. Check Identities and try again.',
  IDENTITY_REFUSED: 'The capsule identity was refused by the host. Check Identities and try again.',
  RAM_ADMISSION_REFUSED: REFUSAL_COPY.RAM_ADMISSION_REFUSED.message,
  SURFACE_CREATE_BUSY: 'Another capsule is already starting. Wait for it to finish, then try again.',
  SURFACE_CREATE_TIMEOUT: 'Starting the capsule timed out before it became ready. Try again.',
  SURFACE_CREATE_FAILED: 'The host could not start the capsule. If this is a core-only installation, install and configure the surface runtime with bash scripts/judge/metaviewer-judge.sh install --capsules, then restart MetaViewer. Otherwise check the host logs and choose Add capsule to try again.',
  SURFACE_CREATE_KIND_UNAVAILABLE: 'Only browser capsules can be created on this host.',
  SURFACE_CREATE_INVALID: 'The capsule create request was rejected as invalid. Please try again.',
  DISPLAY_ONLY: 'Nested walls are display-only and cannot open new capsules.',
  ADAPTER_SETUP: 'The surface runtime needs setup. Run bash scripts/judge/metaviewer-judge.sh doctor --capsules, then follow its guidance and restart MetaViewer.',
  ADAPTER_ERROR: 'The surface runtime could not open the capsule. Check that it is installed and configured, then choose Add capsule to try again. A core-only installation cannot run capsules.',
});

/**
 * Resolve the actionable operator sentence for a create refusal code.
 * @param {string} code
 * @param {string} [missingId]
 * @returns {string}
 */
export function createRefusalReason(code, missingId = 'mv-live-2') {
  if (code === 'NO_IDENTITY') {
    const target = typeof missingId === 'string' && validId(missingId) ? missingId : 'mv-live-2';
    return `No free capsule profile has an identity yet. Create an identity (${target}) whose id matches a profile in MV_SRF_PROFILES, then press Add capsule again.`;
  }
  return Object.hasOwn(CREATE_REFUSAL_REASONS, code)
    ? CREATE_REFUSAL_REASONS[/** @type {keyof typeof CREATE_REFUSAL_REASONS} */ (code)]
    : 'This request is unavailable. Please try again.';
}


/** VM creation uses an explicitly configured agent template, never browser defaults.
 * @param {Record<string, any>} env @param {string} arch
 * @returns {ReadonlyArray<ProfileEntry & {configuration:string}>}
 */
export function configuredVMProfiles(env, arch) {
  if (arch !== 'arm64' || typeof env.MV_SRF_PROFILES !== 'string' || env.MV_SRF_PROFILES.length > MAP_BYTES_MAX) return [];
  let rows;
  try { rows = JSON.parse(env.MV_SRF_PROFILES); } catch { return []; }
  if (!plain(rows)) return [];
  const result = [];
  for (const [id, raw] of Object.entries(rows)) {
    if (!validId(id) || !plain(raw)) continue;
    const w = raw.Width, h = raw.Height;
    const mode = raw.default_mode || raw.role || 'agent';
    if (raw.Kind !== 'vm' || raw.NativeKind !== 'vm' || raw.Program !== 'notepad-vm' || mode !== 'agent'
        || typeof w !== 'number' || typeof h !== 'number' || !Number.isSafeInteger(w) || !Number.isSafeInteger(h)
        || w < 1 || h < 1 || w > 8192 || h > 8192
        || typeof raw.Display !== 'string' || !/^:[0-9]+$/.test(raw.Display)
        || typeof raw.RAMRoot !== 'string' || !raw.RAMRoot.startsWith('/') || raw.RAMRoot.includes('\0')) continue;
    result.push(Object.freeze({id, configuration:JSON.stringify(raw), request:Object.freeze({schema:'surface_request/v0.2',op:'create',
      params:Object.freeze({kind:'vm',profile_id:id,geometry:Object.freeze({w,h})})})}));
    if (result.length > MAX_CAPSULES) return [];
  }
  return Object.freeze(result);
}
