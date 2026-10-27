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
 * only from the closed map below; raw reason codes never become text.
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
  INTENT_ACKNOWLEDGED: Object.freeze({ type: 'intent-ack', tone: 'success', text: 'Request sent.' }),
  ACTION_ADMITTED: Object.freeze({ type: 'verdict-admitted', tone: 'success', text: 'Action admitted.' }),
  STALE_FRAME: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'The surface changed. Try again.' }),
  SURFACE_NOT_AGENT_CONTROLLED: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'Take control before proposing this action.' }),
  LOCKED_BY_OTHER: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'Another operator controls this surface.' }),
  BUDGET_EXCEEDED: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'The action exceeds the available budget.' }),
  OUT_OF_BOUNDS: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'The action is outside the surface.' }),
  POLICY: Object.freeze({ type: 'verdict-refused', tone: 'refusal', text: 'This action is unavailable under the current policy.' }),
  HOST_REQUEST_REFUSED: Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'This request is unavailable. Please try again.' }),
});

/**
 * Fail-closed row for unknown or missing codes: a generic refusal whose
 * text carries no raw code.
 * @type {Readonly<{type:string,tone:string,text:string}>}
 */
const ACTIVITY_FALLBACK = Object.freeze({ type: 'request-refused', tone: 'refusal', text: 'This request is unavailable. Please try again.' });

/**
 * A reported authority outcome awaiting normalization (feed sequence plus
 * the reported outcome code).
 * @typedef {Readonly<{seq:number,code:string}>} ActivityFeedItem
 */

/**
 * A normalized, renderable activity entry.
 * @typedef {Readonly<{seq:number,type:string,tone:string,text:string}>} ActivityEntry
 */

/**
 * Normalize one reported authority outcome into a frozen strip entry.
 * Malformed input (missing sequence, non-object) returns null and is
 * never rendered; unknown codes render as the generic refusal.
 * @param {unknown} input Reported outcome plus its feed sequence number.
 * @returns {ActivityEntry|null}
 */
export function normalizeActivityEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = /** @type {{seq?:unknown,code?:unknown}} */ (input);
  if (!Number.isSafeInteger(record.seq) || /** @type {number} */ (record.seq) < 1) return null;
  const seq = /** @type {number} */ (record.seq);
  const code = typeof record.code === 'string' ? record.code : '';
  const row = Object.hasOwn(ACTIVITY_ROWS, code)
    ? ACTIVITY_ROWS[/** @type {keyof typeof ACTIVITY_ROWS} */ (code)]
    : ACTIVITY_FALLBACK;
  return Object.freeze({ seq, type: row.type, tone: row.tone, text: row.text });
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
