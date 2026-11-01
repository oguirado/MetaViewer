// One host-owned recovery flight per tile. Focus and visibility are not signals.
/** @param {number} attempt */
export const xpraRetryDelay = attempt => [500, 1000, 2000, 4000][attempt] ?? 5000;

/** @param {{isActive:()=>boolean,probe:()=>Promise<boolean>,reconnect:()=>Promise<void>,
 * onState:(state:'ready'|'reconnecting')=>void,
 * schedule?:(fn:()=>void,ms:number)=>any,cancel?:(timer:any)=>void}} options */
export function createXpraRecovery({isActive, probe, reconnect, onState,
  schedule = setTimeout, cancel = clearTimeout}) {
  let stopped = false, attempt = 0;
  let timer = /** @type {any} */ (null);
  const active = () => !stopped && isActive();
  /** @param {()=>Promise<void>} fn @param {number} delay */
  const later = (fn, delay) => {
    if (active()) timer = schedule(() => { timer = null; void fn(); }, delay);
  };
  async function retry() {
    if (!active()) return;
    try {
      await reconnect();
      if (!active()) return;
      attempt = 0;
      onState('ready');
      later(monitor, 250);
    } catch {
      // A refused/absent bridge is never a successful reconnect. Retry only
      // while the same main-process role lease remains authorized.
      later(retry, xpraRetryDelay(attempt++));
    }
  }
  async function monitor() {
    if (!active()) return;
    let healthy = false;
    try { healthy = await probe(); } catch { /* treat failed evaluation as lost */ }
    if (!active()) return;
    if (healthy) later(monitor, 250);
    else {
      onState('reconnecting');
      later(retry, xpraRetryDelay(attempt++));
    }
  }
  later(monitor, 250);
  return Object.freeze({stop() { stopped = true; cancel(timer); timer = null; }});
}
