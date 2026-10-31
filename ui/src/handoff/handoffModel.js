// @ts-check
/** Plain-language wording per closed `reason` of metaviewer.handoff/v1. */
const REASON_LABELS=Object.freeze({
  google_sorry:'Google unusual-traffic page',recaptcha_v2:'reCAPTCHA',turnstile_challenge:'Cloudflare Turnstile',
  cloudflare_challenge:'Cloudflare challenge',unusual_traffic:'unusual-traffic page',login_wall:'login wall',captcha_wall:'CAPTCHA',
});
/** What the operator must do, in order. The agent never solves, signs in or
 * evades; control, WRITE mode and release are the operator's explicit gestures.
 * [TARGET, unit decision] Wall tiles accept typing only under human control
 * plus WRITE (App inputEnabledFor), and WRITE is set in multislot. */
export const HANDOFF_STEPS=Object.freeze([
  'Press Take control. The agent stops acting on this capsule.',
  'Select the capsule, press Open in multislot and set input to WRITE, then click the capsule and type.',
  'Solve the check or sign in yourself. The agent never does it for you.',
  'Release control on the capsule.',
  'Re-run the workflow. Acknowledge only hides this notice; it does not resume the run.',
]);
/** @param {any} row */
export function describeHandoff(row) {
  const login=row?.reason==='login_wall';
  return {
    headline:login?'Login required: sign in yourself in the capsule, then re-run':'CAPTCHA or bot check: solve it in the capsule, then re-run',
    detail:`${row.surface_id}, step ${row.step_index}: ${/** @type {Record<string,string>} */(REASON_LABELS)[row.reason]??'stop for the operator'}`,
    steps:HANDOFF_STEPS,
  };
}
/** [TARGET, unit decision] Presentation is additive until an explicit successful
 * acknowledgement. Empty snapshots, missing files and transport failure never
 * dismiss a row. The owner has no resume ABI: re-run requires operator action.
 * @param {any} host @param {(row:any)=>void} [activity] */
export function createHandoffModel(host,activity=()=>{}) {
  /** @type {Map<string,any>} */ const pending=new Map();
  const seen=new Set(), acknowledged=new Set();
  /** @param {any} row */
  const key=row=>`${row.surface_id}:${row.step_index}`;
  /** @param {any} state */
  function receive(state) {
    if(!state?.ok || !Array.isArray(state.rows))return;
    for(const row of state.rows) {
      const id=key(row);if(acknowledged.has(id))continue;
      pending.set(id,row);if(!seen.has(id)){seen.add(id);activity(row);}
    }
  }
  return {receive,rows:()=>[...pending.values()],
    /** A failed list is typed unavailable, never an empty list; held rows stay. */
    async load(){const state=await host.list();if(!state?.ok||!Array.isArray(state.rows))throw new Error('HANDOFF_UNAVAILABLE');receive(state);},
    /** @param {any} row */
    async acknowledge(row){
      const result=await host.ack({surface_id:row.surface_id,step_index:row.step_index,gesture:'operator-acknowledge'});
      if(!result.ok)throw new Error('HANDOFF_UNAVAILABLE');
      acknowledged.add(key(row));pending.delete(key(row));
    },
  };
}
