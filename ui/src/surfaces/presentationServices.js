import { createOverlayCoordinator, observeOverlays } from './overlayCoordinator.js';
import { createHiddenSessionPool, DEFAULT_HIDDEN_SESSION_LIMIT } from './hiddenSessions.js';

/** Install renderer services through the existing entry/runtime module seam.
 * @param {any} application @param {Document} doc @param {Storage|null|undefined} preferences
 */
export function installSurfacePresentation(application, doc, preferences) {
  const storedLimit = preferences?.getItem('mv.hiddenLiveSessionLimit');
  if (storedLimit !== null && storedLimit !== undefined && !/^(0|[1-9]\d*)$/.test(storedLimit)) throw Error('HIDDEN_SESSION_LIMIT_INVALID');
  const hiddenLimit = storedLimit === null || storedLimit === undefined ? DEFAULT_HIDDEN_SESSION_LIMIT : Number(storedLimit);
  const hiddenSessionPool = createHiddenSessionPool(hiddenLimit);
  const overlays = createOverlayCoordinator(doc);
  const stopOverlays = observeOverlays(overlays, doc);
  application.provide('overlayCoordinator', overlays);
  application.provide('hiddenSessionPool', hiddenSessionPool);
  application.provide('hiddenSessionSettings', {
    get: () => hiddenSessionPool.limit,
    set: (/** @type {number} */ value) => {
      if (!Number.isSafeInteger(value) || value < 0) throw Error('HIDDEN_SESSION_LIMIT_INVALID');
      preferences?.setItem('mv.hiddenLiveSessionLimit', String(value));
      hiddenSessionPool.setLimit(value);
    },
  });
  application.onUnmount?.(() => { stopOverlays(); overlays.dispose(); });
}
