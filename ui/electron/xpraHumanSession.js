// Immutable role lifetime. Emergency agent Control/Release lives elsewhere.
/** @param {{role:'human'|'agent',setReadonly:(value:boolean)=>Promise<boolean>,
 * openBridge:()=>Promise<any>,showView:(bridge:any)=>Promise<any>,closeTrace:()=>void}} host */
export function createXpraHumanSession(host) {
  if (!['human', 'agent'].includes(host.role) ||
      ['setReadonly', 'openBridge', 'showView', 'closeTrace'].some(k => typeof /** @type {any} */ (host)[k] !== 'function')) {
    throw Error('XPRA_CAPABILITIES_ABSENT');
  }
  let revoked = false;
  let bridge = /** @type {any} */ (null), tile = /** @type {any} */ (null);
  let opening = /** @type {Promise<void>|null} */ (null);
  async function cleanup() {
    const failures = [];
    try { await tile?.close(); } catch (e) { failures.push(e); }
    tile = null;
    try { await bridge?.close(); } catch (e) { failures.push(e); }
    bridge = null;
    try { host.closeTrace(); } catch (e) { failures.push(e); }
    if (failures.length) throw new AggregateError(failures, 'XPRA_CLOSE_FAILED');
  }
  const check = () => { if (revoked) throw Error('XPRA_SESSION_CLOSED'); };
  return Object.freeze({
    role: host.role,
    get active() { return !revoked && tile !== null; },
    open() {
      if (opening) return opening;
      opening = (async () => {
        try {
          check();
          if (await host.setReadonly(host.role === 'agent') !== true) throw Error('XPRA_MODE_UNPROVEN');
          check();
          bridge = await host.openBridge();
          check();
          tile = await host.showView(bridge);
          check();
        } catch (e) { revoked = true; await cleanup(); throw e; }
      })();
      return opening;
    },
    /** @param {any} bounds */
    resize(bounds) { check(); if (!tile) throw Error('XPRA_VIEW_ABSENT'); tile.resize(bounds); },
    async close() {
      revoked = true;
      try { await opening; } catch { /* failed open already cleans up */ }
      await cleanup();
    },
  });
}
