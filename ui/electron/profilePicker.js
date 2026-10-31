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
 * - At most MAX_CAPSULES (4) surfaces are live at once [TARGET]: each capsule
 *   shares cpuset 10-14 and takes up to 4 GiB + 2 GiB shm.
 * - Typed refusals: CAPSULE_LIMIT_REACHED, NO_FREE_PROFILE, NO_IDENTITY,
 *   IDENTITY_LIST_UNAVAILABLE, PICKER_INPUT_INVALID. Every refusal fails closed.
 * - The boot create keeps using buildFirstSurfaceCreateRequest (first profile).
 */

/** Concurrent capsule ceiling [TARGET]. */
export const MAX_CAPSULES = 4;

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
 *   code: 'CAPSULE_LIMIT_REACHED' | 'NO_FREE_PROFILE' | 'NO_IDENTITY' | 'IDENTITY_LIST_UNAVAILABLE' | 'PICKER_INPUT_INVALID',
 *   configured: number,
 *   live: number,
 *   missing: ReadonlyArray<string>,
 * }>} Refusal
 * @typedef {Readonly<{ok: true, profile_id: string, request: CreateRequest, configured: number}>} Pick
 */

/** @param {unknown} v @returns {v is string} */
const validId = (v) => typeof v === 'string' && PROFILE_ID.test(v);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
  });
}

/**
 * Pick the first free browser profile whose identity exists.
 * @param {{
 *   env: Record<string, unknown>,
 *   live: number,
 *   bound: ReadonlySet<string>,
 *   identities: ReadonlySet<string> | null,
 * }} input
 * @returns {Pick | Refusal}
 */
export function pickProfile(input) {
  const { env, live, bound, identities } = input ?? /** @type {any} */ ({});
  if (!plain(env) || !Number.isSafeInteger(live) || live < 0 || !(bound instanceof Set)
      || (identities !== null && !(identities instanceof Set))) {
    return refuse('PICKER_INPUT_INVALID');
  }
  const profiles = configuredProfiles(env);
  const configured = profiles.length;
  if (live >= MAX_CAPSULES) return refuse('CAPSULE_LIMIT_REACHED', { configured, live });
  const free = profiles.filter((p) => !bound.has(p.id));
  if (free.length === 0) return refuse('NO_FREE_PROFILE', { configured, live });
  if (identities === null) return refuse('IDENTITY_LIST_UNAVAILABLE', { configured, live });
  const ready = free.find((p) => identities.has(p.id));
  if (ready === undefined) return refuse('NO_IDENTITY', { configured, live, missing: free.map((p) => p.id) });
  return Object.freeze({ ok: /** @type {const} */ (true), profile_id: ready.id, request: ready.request, configured });
}

/**
 * Hook for authorityWire createSurface: summarize the live surfaces, ask for the
 * identity names, then pick. A failing identity list is a typed refusal, never a
 * silent fallback to an unchecked profile.
 * @param {{
 *   env: Record<string, unknown>,
 *   surfaces: Iterable<unknown> | Map<string, unknown> | null | undefined,
 *   listIdentities: () => Promise<{ok?: unknown, rows?: unknown} | null | undefined>,
 * }} input
 * @returns {Promise<Pick | Refusal>}
 */
export async function pickCreateRequest(input) {
  const { env, surfaces, listIdentities } = input ?? /** @type {any} */ ({});
  if (typeof listIdentities !== 'function') return refuse('PICKER_INPUT_INVALID');
  const { live, bound } = summarizeSurfaces(surfaces);
  /** @type {Set<string> | null} */
  let identities = null;
  try {
    const reply = await listIdentities();
    if (plain(reply) && reply.ok === true) identities = identityIds(reply.rows);
  } catch {
    identities = null;
  }
  return pickProfile({ env, live, bound, identities });
}

/**
 * Renderer copy for each refusal [TARGET, unit decision]. Static text only: it
 * never embeds profile ids, paths or environment values. `action` is an optional
 * button the renderer shows next to the message.
 */
export const REFUSAL_COPY = Object.freeze({
  CAPSULE_LIMIT_REACHED: Object.freeze({
    message: `At most ${MAX_CAPSULES} capsules run at once because they share the same CPU cores: frame rate drops as more run. Close a capsule to open another.`,
    action: null,
  }),
  NO_FREE_PROFILE: Object.freeze({
    message: 'Every configured capsule profile is already in use. To run more capsules, add profiles to MV_SRF_PROFILES (up to 4 in total) and restart MetaViewer; see "More than one capsule" in the User Guide.',
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
  return Object.freeze({
    ok: /** @type {const} */ (false),
    code: Object.hasOwn(REFUSAL_COPY, refusal.code) ? refusal.code : 'PICKER_INPUT_INVALID',
    message: 'count' in copy && copy.count === true && Number.isSafeInteger(refusal.configured)
      ? `${refusal.configured} configured capsule profile${refusal.configured === 1 ? ' is' : 's are'} all in use. ${copy.message.replace(/^Every configured capsule profile is already in use\. /, '')}`
      : copy.message,
    action: copy.action,
  });
}
