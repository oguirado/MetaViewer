/** Count independent overlay owners; removing one must not uncover native views. */
export function createOverlayCoordinator(doc = globalThis.document) {
  const owners = new Set();
  const surfaceOwners = new Map();
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  const sync = () => {
    if (!doc?.body) return;
    if (owners.size) doc.body.setAttribute('data-mv-modal', 'open');
    else doc.body.removeAttribute('data-mv-modal');
  };
  return {
    /** @param {object} owner @param {boolean} open */
    set(owner, open) { if (open) owners.add(owner); else owners.delete(owner); sync(); },
    /** Tile-contained chrome occludes only the native view in that tile.
     * @param {object} owner @param {string} surfaceId @param {boolean} open */
    setSurface(owner, surfaceId, open) {
      if (open) surfaceOwners.set(owner, surfaceId); else surfaceOwners.delete(owner);
      notify();
    },
    /** @param {string} surfaceId */
    isSurfaceOccluded(surfaceId) { return [...surfaceOwners.values()].includes(surfaceId); },
    /** @param {()=>void} listener */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get count() { return owners.size; },
    dispose() { owners.clear(); surfaceOwners.clear(); sync(); notify(); listeners.clear(); },
  };
}

/** Cover kit dropdowns/popovers and native selects as well as app-owned menus. */
/** @param {ReturnType<typeof createOverlayCoordinator>} coordinator */
export function observeOverlays(coordinator, doc = globalThis.document) {
  if (!doc?.body || !globalThis.MutationObserver) return () => {};
  const owner = {}, selectOwner = {};
  const nativeOwners = new Set();
  const scan = () => {
    for (const element of nativeOwners) if (element.isConnected === false) {
      coordinator.set(element,false); nativeOwners.delete(element);
    }
    const nodes = doc.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],details[open],[data-state="open"],[popover]');
    coordinator.set(owner, [...nodes].some(el => {
      // Dockview floats are modeless dialogs. Treating them as a popup hides
      // their own native human view for the entire lifetime of the float.
      if (el.getAttribute('role') === 'dialog' && el.classList?.contains('dv-resize-container') && el.getAttribute('aria-modal') !== 'true') return false;
      // The sidebar's permanent navigation inventory also uses role=menu.
      // It is not a popup and must not occlude every native view at idle.
      if (el.getAttribute('role') === 'menu' && el.closest('aside,nav,[role="navigation"]')) return false;
      if (el.getAttribute('data-mv-overlay-scope') === 'terminal' && el.closest('.mv-terminal-deck')) return false;
      if (el.hasAttribute('popover') && !el.matches(':popover-open')) return false;
      return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    }));
  };
  const observer = new MutationObserver(scan);
  observer.observe(doc.body, {subtree:true,childList:true,attributes:true,attributeFilter:['open','hidden','class','style','aria-expanded','data-state']});
  /** @param {Event} event */
  const select = event => { if (/** @type {Element|null} */ (event.target)?.tagName === 'SELECT') coordinator.set(selectOwner,true); };
  const closeSelect = () => coordinator.set(selectOwner,false);
  /** @param {Event & {newState?:string}} event */
  const nativeToggle = event => {
    const element = /** @type {HTMLElement|null} */ (event.target);
    if (!element?.matches?.('[popover],details')) return;
    const open = event.newState === 'open';
    coordinator.set(element,open);
    if (open) nativeOwners.add(element); else nativeOwners.delete(element);
    scan();
  };
  /** @param {KeyboardEvent} event */
  const key = event => {
    if (['Escape','Enter','Tab'].includes(event.key)) closeSelect();
    else if (/** @type {Element|null} */ (event.target)?.tagName === 'SELECT' && [' ','ArrowDown','ArrowUp','F4'].includes(event.key)) select(event);
  };
  doc.addEventListener('pointerdown',select,true);
  doc.addEventListener('keydown',key,true);
  doc.addEventListener('beforetoggle',nativeToggle,true);
  doc.addEventListener('toggle',nativeToggle,true);
  for (const type of ['change','focusout']) doc.addEventListener(type,closeSelect,true);
  /** @param {Event} event */
  const outsideSelect = event => { if (/** @type {Element|null} */ (event.target)?.tagName !== 'SELECT') closeSelect(); };
  doc.addEventListener('pointerdown',outsideSelect,true);
  scan();
  return () => {
    observer.disconnect();
    doc.removeEventListener('pointerdown',select,true);
    doc.removeEventListener('pointerdown',outsideSelect,true);
    doc.removeEventListener('keydown',key,true);
    doc.removeEventListener('beforetoggle',nativeToggle,true);
    doc.removeEventListener('toggle',nativeToggle,true);
    for (const type of ['change','focusout']) doc.removeEventListener(type,closeSelect,true);
    coordinator.set(owner,false); coordinator.set(selectOwner,false);
    for (const element of nativeOwners) coordinator.set(element,false);
    nativeOwners.clear();
  };
}
