// Immutable role lifetime. Emergency agent Control/Release lives elsewhere.
/** @param {{role:'human'|'agent',setReadonly:(value:boolean)=>Promise<boolean>,
 * openBridge:()=>Promise<any>,showView:(bridge:any,recoverBridge:()=>Promise<any>)=>Promise<any>,closeTrace:()=>void}} host */
export function createXpraHumanSession(host) {
  if (!['human', 'agent'].includes(host.role) ||
      ['setReadonly', 'openBridge', 'showView', 'closeTrace'].some(k => typeof /** @type {any} */ (host)[k] !== 'function')) {
    throw Error('XPRA_CAPABILITIES_ABSENT');
  }
  let revoked = false;
  let bridge = /** @type {any} */ (null), tile = /** @type {any} */ (null);
  let opening = /** @type {Promise<void>|null} */ (null);
  let recovering = /** @type {Promise<any>|null} */ (null);
  let cleaning = /** @type {Promise<void>|null} */ (null), closing = /** @type {Promise<void>|null} */ (null), traceClosed = false;
  function cleanup() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      const failures = [];
      try { await tile?.close(); tile = null; } catch (e) { failures.push(e); }
      try { await bridge?.close(); bridge = null; } catch (e) { failures.push(e); }
      if (!traceClosed) try { host.closeTrace(); traceClosed = true; } catch (e) { failures.push(e); }
      if (failures.length) throw new AggregateError(failures, 'XPRA_CLOSE_FAILED');
    })().finally(() => {cleaning = null;});
    return cleaning;
  }
  const check = () => { if (revoked) throw Error('XPRA_SESSION_CLOSED'); };
  function recoverBridge() {
    if (recovering) return recovering;
    recovering = (async () => {
      check();
      if (await bridge?.isHealthy?.() === true) { check(); return bridge; }
      check();
      await bridge?.close();
      bridge = null;
      check();
      const replacement = await host.openBridge();
      if (revoked) {
        bridge = replacement;
        try { await replacement.close(); bridge = null; } finally { check(); }
      }
      bridge = replacement;
      return bridge;
    })().finally(() => { recovering = null; });
    return recovering;
  }
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
          tile = await host.showView(bridge, recoverBridge);
          check();
        } catch (e) { revoked = true; await cleanup(); throw e; }
      })();
      return opening;
    },
    /** @param {any} bounds */
    resize(bounds) { check(); if (!tile) throw Error('XPRA_VIEW_ABSENT'); tile.resize(bounds); },
    bringToFront() { check(); tile?.bringToFront?.(); },
    /** @param {boolean} visible */
    setVisible(visible) { check(); tile?.setVisible(visible); },
    async preview() {
      check(); if (!tile?.preview) throw Error('PREVIEW_UNAVAILABLE');
      const image=await tile.preview(); check(); return image;
    },
    /** @param {{background:string,foreground:string}} theme */
    async setTheme(theme) {
      check(); if (!tile?.setTheme) throw Error('NATIVE_THEME_UNAVAILABLE');
      await tile.setTheme(theme); check();
    },
    close() {
      if (closing) return closing;
      revoked = true;
      closing = (async () => {
        try { await opening; } catch { /* failed open already attempted cleanup */ }
        try { await recovering; } catch { /* retained failed replacement is retried below */ }
        await cleanup();
      })().finally(() => {closing = null;});
      return closing;
    },
  });
}
