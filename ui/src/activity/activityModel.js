/**
 * MetaViewer authority-activity model (MVUI3 lane V): typed, bounded
 * receipts for propose verdicts and intent acknowledgements.
 *
 * Pure JavaScript with JSDoc; zero imports. The existing authority adapters
 * report each submission as exactly one outcome: intent calls resolve to a
 * literal true acknowledgement (observe -> dispatch -> receipt), propose
 * calls resolve to an action_verdict/v0.2 admission or refusal, and any
 * transport failure surfaces as a refused request. This module turns those
 * reported outcomes into closed, frozen strip entries. Visible text comes
 * only from the closed maps below; raw reason codes never become text,
 * except that human-input refusal rows name their closed contract code
 * (MVUI26B lane M) so the operator can see why input was refused.
 *
 * The human sentences mirror the closed literals in
 * `core/hostAdapters.js` (REASONS plus the two success messages), owned by
 * lane T. This lane keeps its own copy so the strip never trusts a message
 * received as a prop, exactly like `hostOutcomeFor`.
 *
 * @module activity/activityModel
 */

/**
 * Maximum retained entries; the strip shows the newest first bound.
 * App.vue enforces the same bound inline (stub harnesses never resolve
 * this module through App), and the activity app test pins both literals.
 * @type {number}
 */
export const MV_ACTIVITY_LIMIT = 8;

/**
 * Closed entry types: intent receipts, verdict receipts, refused requests.
 * @type {ReadonlyArray<string>}
 */
export const MV_ACTIVITY_TYPES = Object.freeze(['intent-ack', 'verdict-admitted', 'verdict-refused', 'request-refused']);

/**
 * Closed entry tones.
 * @type {ReadonlyArray<string>}
 */
export const MV_ACTIVITY_TONES = Object.freeze(['success', 'refusal']);

/**
 * Empty-strip copy: designed neutral text, never a placeholder.
 * @type {string}
 */
export const MV_ACTIVITY_EMPTY_TEXT = 'No authority activity yet.';

/**
 * Closed outcome rows keyed by reported outcome code. Success first, then
 * verdict refusals, then the transport refusal. No other key is admitted.
 * @type {Readonly<Record<string, Readonly<{type:string,tone:string,text:string}>>>}
 */
const ACTIVITY_ROWS = Object.freeze({
  CAPTCHA_HANDOFF: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'CAPTCHA or bot check: solve it in the capsule, then re-run' }),
  INTENT_ACKNOWLEDGED: Object.freeze({ type: 'intent-ack', tone: 'success', text: 'Request sent.' }),
  ACTION_ADMITTED: Object.freeze({ type: 'verdict-admitted', tone: 'success', text: 'Action admitted.' }),
  STALE_FRAME: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'The surface changed. Try again.' }),
  SURFACE_NOT_AGENT_CONTROLLED: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'Take control before proposing this action.' }),
  LOCKED_BY_OTHER: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'Another operator controls this surface.' }),
  BUDGET_EXCEEDED: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'The action exceeds the available budget.' }),
  OUT_OF_BOUNDS: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'The action is outside the surface.' }),
  POLICY: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'This action is unavailable under the current policy.' }),
  HOST_REQUEST_REFUSED: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'This request is unavailable. Please try again.' }),
  NO_BROWSER_CAPSULE: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'NO_BROWSER_CAPSULE: No browser capsule with a live frame.' }),
  CAPSULE_LIMIT_REACHED: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'CAPSULE_LIMIT_REACHED: At most 16 capsules run at once (16 of 16 open). Close a capsule to open another.' }),
  NO_FREE_PROFILE: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'NO_FREE_PROFILE: Every configured capsule profile is already in use. To run more capsules, add profiles to MV_SRF_PROFILES (up to 16 in total) and restart MetaViewer; see "More than one capsule" in the User Guide.' }),
  NO_IDENTITY: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'NO_IDENTITY: No free capsule profile has an identity yet. Create an identity (mv-live-2) whose id matches a profile in MV_SRF_PROFILES, then press Add capsule again.' }),
  IDENTITY_LIST_UNAVAILABLE: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'IDENTITY_LIST_UNAVAILABLE: The identity list could not be read, so no new capsule was opened. Open Identities to check the identity tool, then try again.' }),
  PICKER_INPUT_INVALID: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'PICKER_INPUT_INVALID: The capsule request could not be prepared. Please try again.' }),
  SURFACE_PROFILE_BOUND: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'SURFACE_PROFILE_BOUND: Every configured capsule profile is already bound to a running capsule. Close or reuse the existing capsule, or add another profile to MV_SRF_PROFILES.' }),
  PROFILE_ALREADY_BOUND: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'PROFILE_ALREADY_BOUND: The selected capsule profile is already bound to a running capsule. Close the running capsule or add another profile to MV_SRF_PROFILES.' }),
  CAPSULE_SLOT_UNAVAILABLE: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'No free capsule slot. Stop another capsule first (up to 16 run at once).' }),
  SURFACE_CAPACITY_OR_QUARANTINE: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'SURFACE_CAPACITY_OR_QUARANTINE: No capsule slot is free or the profile is quarantined. Close a capsule or clear the quarantined profile before trying again.' }),
  SURFACE_PROFILE_QUARANTINED: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'SURFACE_PROFILE_QUARANTINED: The capsule profile is quarantined after a previous failure. Clear the quarantine before opening a new capsule.' }),
  IDENTITY_UNAVAILABLE: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'IDENTITY_UNAVAILABLE: The capsule identity is unavailable or already held by another capsule. Check Identities and try again.' }),
  IDENTITY_REFUSED: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'IDENTITY_REFUSED: The capsule identity was refused by the host. Check Identities and try again.' }),
  RAM_ADMISSION_REFUSED: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'RAM_ADMISSION_REFUSED: Not enough free host memory to start another capsule (one capsule needs 6 GiB: 4 GiB RAM + 2 GiB shm). Close an open capsule or other applications and try again.' }),
  SURFACE_CREATE_BUSY: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'SURFACE_CREATE_BUSY: Another capsule is already starting. Wait for it to finish, then try again.' }),
  SURFACE_CREATE_TIMEOUT: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'SURFACE_CREATE_TIMEOUT: Starting the capsule timed out before it became ready. Try again.' }),
  SURFACE_CREATE_FAILED: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'SURFACE_CREATE_FAILED: The host could not start the capsule. If this is a core-only installation, install and configure the surface runtime, then restart MetaViewer. Otherwise check the host logs and choose Add capsule to try again.' }),
  SURFACE_CREATE_KIND_UNAVAILABLE: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'SURFACE_CREATE_KIND_UNAVAILABLE: Only browser capsules can be created on this host.' }),
  SURFACE_CREATE_INVALID: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'SURFACE_CREATE_INVALID: The capsule create request was rejected as invalid. Please try again.' }),
  DISPLAY_ONLY: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'DISPLAY_ONLY: Nested walls are display-only and cannot open new capsules.' }),
  ADAPTER_ERROR: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'ADAPTER_ERROR: The surface runtime could not open the capsule. Check that it is installed and configured, then choose Add capsule to try again. A core-only installation cannot run capsules.' }),
});

/**
 * Fail-closed row for unknown or missing codes: a generic refusal whose
 * text carries no raw code.
 * @type {Readonly<{type:string,tone:string,text:string}>}
 */
const ACTIVITY_FALLBACK = Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'This request is unavailable. Please try again.' });

/**
 * Closed human-input refusal copy (MVUI26B lane M): the surface_input/v1
 * refusal codes with their short human reasons. Own copy, never imported
 * from the input port, so the strip never trusts a message received as a
 * prop — the same rule as ACTIVITY_ROWS. Refusal rows reuse the
 * `request-refused` type and the `refusal` tone; their text names the
 * closed code plus a burst count when the feed coalesced repeats.
 * @type {Readonly<Record<string, string>>}
 */
const INPUT_REFUSAL_REASONS = Object.freeze({
  NOT_IN_CONTROL: 'control released',
  INPUT_MODE_READ: 'read-only mode',
  SURFACE_UNKNOWN: 'surface unavailable',
  STALE_STREAM: 'stream changed',
  LIMIT: 'too many requests',
  NESTED_DISPLAY_ONLY: 'display only',
  SCHEMA: 'invalid input',
  CORE_UNAVAILABLE: 'core unavailable',
});

/**
 * A reported authority outcome awaiting normalization (feed sequence plus
 * the reported outcome code). Human-input refusal rows carry an optional
 * burst count (MVUI26B lane M): consecutive same-code refusals coalesce
 * into one row, so the count is the only thing that grows.
 * @typedef {Readonly<{seq:number,code:string,count?:number}>} ActivityFeedItem
 */

/**
 * A normalized, renderable activity entry.
 * @typedef {Readonly<{seq:number,type:string,tone:string,text:string}>} ActivityEntry
 */

/**
 * Normalize one reported authority outcome into a frozen strip entry.
 * Malformed input (missing sequence, non-object) returns null and is
 * never rendered; unknown codes render as the generic refusal.
 * Human-input refusal codes (MVUI26B lane M) render as typed refusal rows
 * that name the closed code, with a burst count suffix when the feed
 * coalesced consecutive repeats (a malformed count reads as one). The
 * count is ignored for every other code, so authority rows keep their
 * exact historical shape.
 * @param {unknown} input Reported outcome plus its feed sequence number.
 * @returns {ActivityEntry|null}
 */
export function normalizeActivityEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = /** @type {{seq?:unknown,code?:unknown,count?:unknown}} */ (input);
  if (!Number.isSafeInteger(record.seq) || /** @type {number} */ (record.seq) < 1) return null;
  const seq = /** @type {number} */ (record.seq);
  const code = typeof record.code === 'string' ? record.code : '';
  if (Object.hasOwn(INPUT_REFUSAL_REASONS, code)) {
    const reason = INPUT_REFUSAL_REASONS[/** @type {keyof typeof INPUT_REFUSAL_REASONS} */ (code)];
    const repeats = Number.isSafeInteger(record.count) && /** @type {number} */ (record.count) > 1
      ? /** @type {number} */ (record.count)
      : 1;
    const text = repeats > 1
      ? `Input refused: ${reason} (${code}) ×${repeats}.`
      : `Input refused: ${reason} (${code}).`;
    return Object.freeze({ seq, type: 'request-refused', tone: 'refusal', text });
  }
  const missingMatch = (/^NO_IDENTITY__([A-Z0-9_]{1,48})$/.exec(code)?.[1]?.toLowerCase().replace(/__/g, '\0').replace(/_/g, '-').replace(/\0/g, '_'))
    ?? (/^NO_IDENTITY:([a-z0-9][a-z0-9-]{0,63})$/.exec(code)?.[1])
    ?? (code === 'NO_IDENTITY' && typeof (/** @type {{missingId?:unknown}} */ (record)).missingId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(/** @type {string} */ ((/** @type {{missingId?:unknown}} */ (record)).missingId)) ? /** @type {string} */ ((/** @type {{missingId?:unknown}} */ (record)).missingId) : null);
  if (missingMatch) {
    return Object.freeze({
      seq,
      type: 'request-refused',
      tone: 'refusal',
      text: `NO_IDENTITY: No free capsule profile has an identity yet. Create an identity (${missingMatch}) whose id matches a profile in MV_SRF_PROFILES, then press Add capsule again.`,
    });
  }
  const rawReason = typeof (/** @type {{reason?:unknown}} */ (record)).reason === 'string'
    ? /** @type {string} */ ((/** @type {{reason?:unknown}} */ (record)).reason).trim()
    : '';
  if (rawReason.length > 0 && rawReason.length <= 256 && !/[\x00-\x1f\x7f]/.test(rawReason)
      && /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(code) && !code.startsWith('ERR_') && !code.startsWith('LAYOUT_')) {
    const text = rawReason.startsWith(`${code}:`) ? rawReason : `${code}: ${rawReason}`;
    return Object.freeze({ seq, type: 'request-refused', tone: 'refusal', text });
  }
  if (Object.hasOwn(ACTIVITY_ROWS, code)) {
    const row = ACTIVITY_ROWS[/** @type {keyof typeof ACTIVITY_ROWS} */ (code)];
    return Object.freeze({ seq, type: row.type, tone: row.tone, text: row.text });
  }
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(code) && !code.startsWith('ERR_') && !code.startsWith('LAYOUT_')) {
    return Object.freeze({ seq, type: 'request-refused', tone: 'refusal', text: `${code}: ${ACTIVITY_FALLBACK.text}` });
  }
  return Object.freeze({ seq, type: ACTIVITY_FALLBACK.type, tone: ACTIVITY_FALLBACK.tone, text: ACTIVITY_FALLBACK.text });
}

/**
 * Recover the live total of recorded authority outcomes from a (possibly
 * windowed) feed (MVUI17 lane A, L2-6). App.vue caps the feed to the
 * newest MV_ACTIVITY_LIMIT rows but keeps their feed sequences, which
 * recordActivity assigns contiguously from 1, so the maximum valid
 * sequence equals the true total. Malformed rows are ignored; an empty
 * or fully malformed feed totals 0.
 * @param {unknown} feed Reported feed rows (ActivityFeedItem[]).
 * @returns {number} Total recorded outcomes, or 0 when unreadable.
 */
export function mvActivityFeedTotal(feed) {
  if (!Array.isArray(feed)) return 0;
  let total = 0;
  for (const item of feed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const seq = /** @type {{seq?:unknown}} */ (item).seq;
    if (Number.isSafeInteger(seq) && /** @type {number} */ (seq) > total) total = /** @type {number} */ (seq);
  }
  return total;
}

/**
 * Visible count copy (MVUI17 lane A, L2-6): the plain shown number while
 * the whole history fits, otherwise the bounded-window label
 * `latest S of N` so the count keeps moving once the feed is windowed.
 * @param {unknown} shown Rendered row count.
 * @param {unknown} total Live total from mvActivityFeedTotal.
 * @returns {string} Human count copy carrying no raw code.
 */
export function mvActivityCountText(shown, total) {
  const visible = Number.isSafeInteger(shown) && /** @type {number} */ (shown) >= 0 ? /** @type {number} */ (shown) : 0;
  const all = Number.isSafeInteger(total) && /** @type {number} */ (total) >= 0 ? /** @type {number} */ (total) : 0;
  if (all > visible) return `latest ${visible} of ${all}`;
  return String(visible);
}

/**
 * @param {unknown} seq Feed sequence number.
 * @returns {number} Safe positive sequence, or 0 when unreadable.
 */
function activitySeqSegment(seq) {
  return Number.isSafeInteger(seq) && /** @type {number} */ (seq) > 0 ? /** @type {number} */ (seq) : 0;
}

/**
 * @returns {string} Stable DOM id for the activity strip.
 */
export function mvActivityStripDomId() {
  return 'mv-activity-strip';
}

/**
 * @returns {string} Semantic anchor for the activity strip.
 */
export function mvActivityStripAnchor() {
  return 'activity/strip';
}

/**
 * @returns {string} Stable accessible name for the activity strip (agent_lane/v1).
 */
export function mvActivityStripAccessibleName() {
  return 'Authority activity';
}

/**
 * @returns {string} Stable DOM id for the strip toggle.
 */
export function mvActivityToggleDomId() {
  return 'mv-activity-toggle';
}

/**
 * @returns {string} Semantic anchor for the strip toggle.
 */
export function mvActivityToggleAnchor() {
  return 'activity/toggle';
}

/**
 * @returns {string} Stable DOM id for the outcomes list.
 */
export function mvActivityListDomId() {
  return 'mv-activity-list';
}

/**
 * @returns {string} Semantic anchor for the outcomes list.
 */
export function mvActivityListAnchor() {
  return 'activity/list';
}

/**
 * @param {unknown} count Rendered row count.
 * @param {unknown} [total] Live total; when it exceeds `count` the name
 * carries the same bounded-window label as the visible count (MVUI17 lane
 * A, L2-6). Omitted, the name keeps its historical single-count shape.
 * @returns {string} Stable accessible name for the outcomes list (agent_lane/v1).
 */
export function mvActivityListAccessibleName(count, total) {
  const shown = Number.isSafeInteger(count) && /** @type {number} */ (count) >= 0 ? /** @type {number} */ (count) : 0;
  const all = Number.isSafeInteger(total) && /** @type {number} */ (total) >= 0 ? /** @type {number} */ (total) : shown;
  if (all > shown) return `Latest authority outcomes, latest ${shown} of ${all}`;
  return `Latest authority outcomes, ${shown} shown`;
}

/**
 * @param {unknown} seq Feed sequence number of the row.
 * @returns {string} Stable DOM id for one activity row.
 */
export function mvActivityRowDomId(seq) {
  return `mv-activity-row-${activitySeqSegment(seq)}`;
}

/**
 * @param {unknown} seq Feed sequence number of the row.
 * @returns {string} Semantic anchor for one activity row.
 */
export function mvActivityRowAnchor(seq) {
  return `activity/row-${activitySeqSegment(seq)}`;
}
