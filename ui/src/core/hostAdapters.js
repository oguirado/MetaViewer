import { createWallProjection } from './projection.js';
import { buildAuthorityIntent, createWallIntentBuilders } from './intents.js';

/** @typedef {{schema:'action_verdict/v0.2',proposal_id:string,core_seq:number,decision:'admitted'|'refused',reason_code?:string}} ActionVerdict */
/** @typedef {{createSurface?:()=>Promise<any>,propose?:(json:string)=>Promise<ActionVerdict>,intent?:(json:string)=>Promise<true>,subscribeFrames?:(callback:(notice:any)=>void)=>(()=>void)}} AuthorityPort */
/** @typedef {{command:string,args:readonly string[],cols:number,rows:number}} TerminalSpec */
/** @typedef {{open?:(spec:TerminalSpec)=>Promise<{session:string}>,setEnabled?:(enabled:boolean)=>Promise<true>,close?:(spec:{session:string})=>Promise<unknown>}} TerminalPort */
/** @typedef {{code:string,message:string,tone:'success'|'refusal'}} OutcomeRow */

/** Acknowledgements are literal true, never truthy coercions.
 * @param {unknown} reply */
export function requireAck(reply) {
  if (reply !== true) throw new Error('Host acknowledgement unavailable');
  return true;
}

const REASONS = Object.freeze({
  STALE_FRAME: 'The surface changed. Try again.',
  SURFACE_NOT_AGENT_CONTROLLED: 'Take control before proposing this action.',
  LOCKED_BY_OTHER: 'Another operator controls this surface.',
  BUDGET_EXCEEDED: 'The action exceeds the available budget.',
  OUT_OF_BOUNDS: 'The action is outside the surface.',
  POLICY: 'This action is unavailable under the current policy.',
});
/** @param {unknown} value @returns {OutcomeRow} */
export function verdictRow(value) {
  const v = /** @type {ActionVerdict|null} */ (value);
  if (v?.schema !== 'action_verdict/v0.2' || !v.proposal_id || !Number.isSafeInteger(v.core_seq) || v.core_seq < 1) {
    throw new Error('Invalid verdict');
  }
  if (v.decision === 'admitted') return { code: 'ACTION_ADMITTED', message: 'Action admitted.', tone: 'success' };
  if (v.decision !== 'refused' || !Object.hasOwn(REASONS, v.reason_code ?? '')) throw new Error('Invalid verdict');
  return { code: v.reason_code ?? 'POLICY', message: REASONS[/** @type {keyof typeof REASONS} */ (v.reason_code)], tone: 'refusal' };
}

/** Bind methods separately so partially upgraded hosts retain their old paths.
 * This module receives capabilities; only main.js reads the preload global.
 * @param {AuthorityPort|null|undefined} port */
export function createAuthorityAdapter(port) {
  const intent = typeof port?.intent === 'function' ? port.intent.bind(port) : null;
  const propose = typeof port?.propose === 'function' ? port.propose.bind(port) : null;
  const createSurface = typeof port?.createSurface === 'function' ? port.createSurface.bind(port) : null;
  return Object.freeze({
    createSurface: createSurface ? async () => {
      const reply = await createSurface();
      if (reply?.ok === true) return {code:'INTENT_ACKNOWLEDGED',message:'Request sent.',tone:/** @type {const} */ ('success')};
      const code = typeof reply?.code === 'string' ? reply.code : 'SURFACE_CREATE_FAILED';
      throw Object.assign(new Error(code), {code});
    } : null,
    intent: intent ? async (/** @type {unknown} */ body) => requireAck(await intent(JSON.stringify(buildAuthorityIntent(body)))) : null,
    propose: propose ? async (/** @type {unknown} */ body) => {
      assertProposalFrame(body);
      return verdictRow(await propose(JSON.stringify(body)));
    } : null,
  });
}

/** @param {TerminalPort|null|undefined} port */
export function createTerminalBroker(port) {
  const open = typeof port?.open === 'function' ? port.open.bind(port) : null;
  const close = typeof port?.close === 'function' ? port.close.bind(port) : null;
  const enable = typeof port?.setEnabled === 'function' ? port.setEnabled.bind(port) : null;
  if (!open && !enable) return null;
  return Object.freeze({
    open: open ? async (/** @type {TerminalSpec} */ spec) => {
      // The API accepts exactly these keys, with one positional argument.
      const reply = await open({ command: spec.command, args: [...spec.args], cols: spec.cols, rows: spec.rows });
      if (/** @type {any} */ (reply)?.code === 'TERMINAL_UNAVAILABLE') throw Object.assign(new Error('TERMINAL_UNAVAILABLE: terminal support is not bundled in this package'), {code:'TERMINAL_UNAVAILABLE'});
      if (!reply || typeof reply.session !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(reply.session)) throw new Error('Invalid terminal session');
      return reply;
    } : null,
    close: close ? (/** @type {{session:string}} */ spec) => close({ session: spec.session }) : null,
    setEnabled: enable ? async (/** @type {boolean} */ enabled) => requireAck(await enable(enabled)) : null,
  });
}

const SCHEMA = 'metaviewer.frame-wall/v1';
const QUERY = 'authority.frames';
/** Metadata-only feed into the existing core/projection.js admission path.
 * Epoch/revision here describe this renderer subscription, not a core sequence.
 * Frame bytes and ports never enter the projection or Vue state.
 * @param {AuthorityPort|null|undefined} port */
export function createAuthorityRuntime(port) {
  if (typeof port?.subscribeFrames !== 'function') return null;
  /** @type {Map<string,import('./projection.js').WallSurfaceRow>} */
  const rows = new Map();
  let revision = 0, disposed = false;
  const controller = createWallProjection({ allowedSchemas: [SCHEMA],
    limits: { maxBytes: 262144, maxDepth: 8, maxKeys: 64, maxStringLength: 65536, maxBatchRows: 256 },
    decode(raw) {
      const value = /** @type {any} */ (raw), f = value?.frame_ref, s = value?.surface;
      const invalid = () => ({ ok: /** @type {false} */ (false), error: { code: 'ERR_FRAME_NOTICE', message: 'Surface update unavailable.' } });
      const surfaceKeys = s !== null && typeof s === 'object' ? Object.keys(s).sort().join(',') : '';
      const fullSurfaceKeys = 'control,display,geometry,kind,profile_id,schema,state,surface_id,visibility';
      // Hosts that predate profile_id omit the key; the title then falls back
      // to the surface id. Every other surface key stays mandatory.
      const legacySurfaceKeys = 'control,display,geometry,kind,schema,state,surface_id,visibility';
      if (!value || Object.keys(value).sort().join(',') !== 'frame_ref,surface'
        || f?.schema !== 'frame_ref/v0.2' || s?.schema !== 'surface/v0.2'
        || Object.keys(f).sort().join(',') !== 'capture_us,format,generation,height,schema,sha256,surface_id,tick,ts_ns,width'
        || (surfaceKeys !== fullSurfaceKeys && surfaceKeys !== legacySurfaceKeys)
        || f.format !== 'rgb24' || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)
        || !['generation', 'width', 'height'].every(key => Number.isSafeInteger(f[key]) && f[key] > 0)
        || !['tick', 'ts_ns', 'capture_us'].every(key => Number.isSafeInteger(f[key]) && f[key] >= 0)
        || !['desktop_capsule', 'browser', 'game_capsule', 'vm'].includes(s.kind)
        || !s.geometry || Object.keys(s.geometry).sort().join(',') !== 'h,w'
        || !Number.isSafeInteger(s.geometry.w) || s.geometry.w < 1 || !Number.isSafeInteger(s.geometry.h) || s.geometry.h < 1
        || (s.profile_id !== undefined && s.profile_id !== '' && (typeof s.profile_id !== 'string' || s.profile_id.length > 128))
        || typeof s.surface_id !== 'string' || !s.surface_id.length || s.surface_id.length > 128
        || f.surface_id !== s.surface_id || !Number.isSafeInteger(f.generation) || f.generation < 1
        || !['active','standby','ceded','destroyed','lost'].includes(s.state)
        || !['folded','unfolded','pinned'].includes(s.visibility) || !['agent','human','shared'].includes(s.control)
        || typeof s.display !== 'string' || !s.display.length || s.display.length > 65536) return invalid();
      const previous = rows.get(s.surface_id);
      if (!previous && rows.size >= 256) return invalid();
      if (previous && previous.generation > f.generation) {
        // An older generation is a routine out-of-order duplicate: keep the
        // admitted row (domain state unchanged) without raising a snapshot
        // error, so one duplicate never flips every tile to the error state.
        // The revision still advances: the kit requires monotonic revisions.
        return { ok: true, value: { schema: SCHEMA, epoch: 1, revision: ++revision, query: QUERY,
          mode: 'snapshot', projection: { rows: Object.freeze([...rows.values()]) } } };
      }
      // Titles name the profile (the human-meaningful surface name); the raw
      // display locator (X11-style ':100') stays as secondary metadata. When
      // the host sends no profile, the surface id is the stable fallback and
      // the row keeps an empty profile_id instead of inventing one.
      // MVUI19 lane A (EVUI-08): '' counts as missing (surface-id title below), never malformed.
      const profileId = typeof s.profile_id === 'string' && s.profile_id.length > 0 ? s.profile_id : '';
      rows.set(s.surface_id, Object.freeze({ id: s.surface_id, surfaceId: s.surface_id,
        title: profileId.length > 0 ? profileId : s.surface_id,
        display: s.display, profile_id: profileId,
        generation: f.generation, backendLifecycle: s.state,
        visibility: s.visibility, control: s.control,
        // surface/v0.2 has no exclusive owner for shared control and no lease.
        // The kit's control button consumes this axis; focus leases stay absent.
        controlOwner: s.control === 'shared' ? 'none' : s.control, attachmentState: s.state === 'lost' ? 'disconnected' : s.state === 'destroyed' ? 'detached' : 'live' }));
      return { ok: true, value: { schema: SCHEMA, epoch: 1, revision: ++revision, query: QUERY,
        mode: 'snapshot', projection: { rows: Object.freeze([...rows.values()]) } } };
    },
  });
  const session = controller.beginSession({ query: QUERY, epoch: 1 });
  controller.markSubscriptionReady(session.generation);
  let initial = true;
  const stop = port.subscribeFrames(notice => {
    if (disposed) return;
    const outcome = initial ? controller.admitInitialResponse(notice, { generation: session.generation })
      : controller.admitPush(notice, { generation: session.generation });
    if (outcome.ok) initial = false;
  });
  if (typeof stop !== 'function') { controller.dispose(); throw new Error('Invalid frame subscription'); }
  const identity = (/** @type {unknown} */ request) => request;
  return Object.freeze({ projectionView: controller.getView(),
    intentBuilders: createWallIntentBuilders({ encodeUiIntent: identity, encodeControl: buildAuthorityIntent }),
    controlRegistry: Object.freeze({}), scheduler: Object.freeze({}),
    dispose() {
      if (disposed) return;
      disposed = true;
      try { stop(); } finally { controller.dispose(); rows.clear(); }
    },
  });
}

/** Fixed copy for AC-06 placement refusals; codes stay in data attributes. */
export const LAYOUT_REFUSAL_COPY = Object.freeze({
  LAYOUT_UNKNOWN_SLOT: 'This slot is no longer available.',
  LAYOUT_ILLEGAL_TRANSITION: 'This placement change is unavailable.',
  LAYOUT_INPUT_MODE_READ: 'Placement is unavailable while the agent controls this slot.',
  ERR_INPUT_MODE_READ: 'Switch to WRITE mode to place this slot.',
  ERR_PLACEMENT_PENDING: 'Placement request pending.',
});

/** Closed renderer copy; outcome messages received as props are never trusted.
 * @param {OutcomeRow|null} row
 * @returns {OutcomeRow|null} */
export function hostOutcomeFor(row) {
  if (!row) return null;
  const success = { ACTION_ADMITTED: 'Action admitted.', INTENT_ACKNOWLEDGED: 'Request sent.' };
  if (Object.hasOwn(success, row.code)) return { code: row.code,
    message: success[/** @type {keyof typeof success} */ (row.code)], tone: 'success' };
  if (Object.hasOwn(LAYOUT_REFUSAL_COPY, row.code)) return { code: row.code,
    message: LAYOUT_REFUSAL_COPY[/** @type {keyof typeof LAYOUT_REFUSAL_COPY} */ (row.code)], tone: 'refusal' };
  if (row.code === 'NO_BROWSER_CAPSULE') return {code:row.code,message:'No browser capsule with a live frame.',tone:'refusal'};
  return { code: row.code, message: Object.hasOwn(REASONS, row.code)
    ? REASONS[/** @type {keyof typeof REASONS} */ (row.code)]
    : 'This request is unavailable. Please try again.', tone: 'refusal' };
}

/** @param {any} body */
export function assertProposalFrame(body) {
  if (body?.schema !== 'action_proposal/v0.2' || typeof body.surface_id !== 'string' || !body.surface_id.length
      || !Number.isSafeInteger(body.based_on_frame?.generation) || body.based_on_frame.generation < 1
      || typeof body.based_on_frame?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.based_on_frame.sha256)
      || !body.budget) throw Object.assign(new Error('NO_BROWSER_CAPSULE: no live browser capsule and frame'), {code:'NO_BROWSER_CAPSULE'});
}
