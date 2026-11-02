<script>
/** @param {any} rect */
function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x ?? rect.left ?? 0), y = Number(rect.y ?? rect.top ?? 0);
  const width = Number(rect.width ?? (rect.right !== undefined ? Number(rect.right) - x : 0));
  const height = Number(rect.height ?? (rect.bottom !== undefined ? Number(rect.bottom) - y : 0));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {x, y, width, height};
}
/**
 * Clips the tile rect to the intersection of the tile rect, every scrolling/clipping
 * ancestor rect, the wall viewport, and the window viewport.
 * @param {any} tileRect
 * @param {any[]} [scrollAncestors]
 * @param {any} [wallViewport]
 * @param {{width?:number,height?:number}} [windowViewport]
 */
export function clipRoleBounds(tileRect, scrollAncestors = [], wallViewport = null, windowViewport = undefined) {
  const tile = normalizeRect(tileRect);
  if (!tile) return {visible:false, bounds:{x:0, y:0, width:0, height:0}};
  const winW = Number.isFinite(windowViewport?.width) ? Number(windowViewport?.width) : (Number.isFinite(globalThis.innerWidth) ? globalThis.innerWidth : Infinity);
  const winH = Number.isFinite(windowViewport?.height) ? Number(windowViewport?.height) : (Number.isFinite(globalThis.innerHeight) ? globalThis.innerHeight : Infinity);
  let left = Math.max(0, tile.x), top = Math.max(0, tile.y);
  let right = Math.min(winW, tile.x + tile.width), bottom = Math.min(winH, tile.y + tile.height);
  const clips = [...(Array.isArray(scrollAncestors) ? scrollAncestors : []), ...(wallViewport ? [wallViewport] : [])];
  for (const raw of clips) {
    const clip = normalizeRect(raw);
    if (!clip) continue;
    left = Math.max(left, clip.x); top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.width); bottom = Math.min(bottom, clip.y + clip.height);
  }
  const x = Math.ceil(left), y = Math.ceil(top), r = Math.floor(right), b = Math.floor(bottom);
  const width = Math.max(0, r - x), height = Math.max(0, b - y);
  return {visible:width >= 1 && height >= 1, bounds:{x, y, width, height}};
}
/** Subtract floating windows. Native views can paint only one rectangle.
 * @param {{x:number,y:number,width:number,height:number}} bounds @param {Array<any>} occluders */
export function subtractRoleOccluders(bounds, occluders = []) {
  const hidden = {visible:false,bounds:{...bounds,width:0,height:0}};
  if (occluders.length > 64) return hidden;
  let pieces = [bounds];
  for (const raw of occluders) {
    const original = normalizeRect(raw);
    if (!original) continue;
    const cut = {x:Math.floor(original.x),y:Math.floor(original.y),width:Math.ceil(original.x+original.width)-Math.floor(original.x),height:Math.ceil(original.y+original.height)-Math.floor(original.y)};
    pieces = pieces.flatMap(r => {
      const l = Math.max(r.x,cut.x), t = Math.max(r.y,cut.y);
      const right = Math.min(r.x+r.width,cut.x+cut.width), bottom = Math.min(r.y+r.height,cut.y+cut.height);
      if (l >= right || t >= bottom) return [r];
      return [{x:r.x,y:r.y,width:r.width,height:t-r.y},
        {x:r.x,y:bottom,width:r.width,height:r.y+r.height-bottom},
        {x:r.x,y:t,width:l-r.x,height:bottom-t},
        {x:right,y:t,width:r.x+r.width-right,height:bottom-t}].filter(p=>p.width>0 && p.height>0);
    });
    if (!pieces.length || pieces.length > 256) return hidden;
  }
  const x=Math.min(...pieces.map(r=>r.x)), y=Math.min(...pieces.map(r=>r.y));
  const right=Math.max(...pieces.map(r=>r.x+r.width)), bottom=Math.max(...pieces.map(r=>r.y+r.height));
  if (pieces.reduce((sum,r)=>sum+r.width*r.height,0) !== (right-x)*(bottom-y)) return hidden;
  return {visible:true,bounds:{x,y,width:right-x,height:bottom-y}};
}
/** DOM stacking authority includes the whole floating window, including chrome.
 * @param {any} el @param {any} [doc] @param {(el:any)=>any} [styleOf] */
export function floatingPresentation(el, doc = globalThis.document, styleOf = globalThis.getComputedStyle) {
  let own = el?.closest?.('.dv-resize-container');
  const floats = [...(doc?.querySelectorAll?.('.dv-resize-container') || [])].filter(node => {
    const style=styleOf?.(node);
    const rect = normalizeRect(node.getBoundingClientRect());
    return rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && !['hidden','collapse'].includes(style?.visibility);
  });
  const z = (/** @type {any} */ node) => {
    let value=0; const seen=new Set();
    for (let cur=node;cur && !seen.has(cur) && seen.size<MAX_ANCESTORS;cur=cur.parentElement) {
      seen.add(cur);const n=Number(styleOf?.(cur)?.zIndex);if(Number.isFinite(n))value=Math.max(value,n);
    }
    return value;
  };
  // Dockview portals the content beside its floating chrome. The portal is
  // exactly one native stacking level above its own resize container.
  const portal = !own && el?.closest?.('.dv-render-overlay-float');
  if (portal) {
    const portalZ = z(portal);
    const matches = floats.filter(node=>z(node)+1 === portalZ);
    if (matches.length === 1) own = matches[0];
  }
  const stack = floats.map((node,index)=>({node,index,z:z(node)})).sort((a,b)=>a.z-b.z || a.index-b.index);
  const index = stack.findIndex(item=>item.node===own);
  return {front:index >= 0 && index === stack.length-1,occluders:stack.slice(index+1).map(item=>item.node.getBoundingClientRect())};
}
/** @param {any} [doc] */
export function isModalActive(doc = globalThis.document) {
  const body = doc?.body;
  if (!body) return false;
  if (typeof body.hasAttribute === 'function' && body.hasAttribute('data-mv-modal')) return true;
  if (typeof body.getAttribute === 'function' && body.getAttribute('data-mv-modal') !== null) return true;
  if (body.dataset && body.dataset.mvModal !== undefined && body.dataset.mvModal !== 'false') return true;
  return Boolean(body.props?.['data-mv-modal']);
}
/** Dockview retains inactive tabs with visibility:hidden and nonempty rects.
 * Such a tab must retain its session while hiding its native view.
 * @param {any} el */
export function isRoleElementPainted(el) {
  if (!el?.getClientRects?.().length) return false;
  const style = typeof globalThis.getComputedStyle === 'function' ? globalThis.getComputedStyle(el) : null;
  return style?.visibility !== 'hidden' && style?.visibility !== 'collapse' && style?.display !== 'none';
}
/** Ancestor walks stop here, and on a cycle, so a malformed tree cannot spin. */
export const MAX_ANCESTORS = 64;
/** @param {any} el */
export function collectClipRects(el) {
  const scrollAncestors = [];
  let wallViewport = null;
  const doc = globalThis.document;
  const floating = Boolean(el?.closest?.('.dv-resize-container, .dv-render-overlay-float'));
  const seen = new Set();
  for (let cur = el?.parentElement ?? el?.parent; cur && cur !== doc?.body && cur !== doc?.documentElement && !seen.has(cur) && seen.size < MAX_ANCESTORS; cur = cur.parentElement ?? cur.parent) {
    seen.add(cur);
    if (cur.tag === 'root' || typeof cur.getBoundingClientRect !== 'function') continue;
    const rect = cur.getBoundingClientRect();
    if (!rect) continue;
    const id = cur.id ?? cur.props?.id ?? '';
    const cls = typeof cur.className === 'string' ? cur.className : (typeof cur.props?.class === 'string' ? cur.props.class : '');
    if (floating && /\b(?:dv-resize-container|dv-render-overlay-float)\b/.test(cls)) break;
    if (id === 'shell-wall' || /\bwall-workspace\b/.test(cls)) { if (!floating) wallViewport = rect; }
    else {
      const style = typeof globalThis.getComputedStyle === 'function' ? globalThis.getComputedStyle(cur) : null;
      if (!style || /hidden|clip|auto|scroll/.test([style.overflow,style.overflowX,style.overflowY].join(' '))) scrollAncestors.push(rect);
    }
  }
  if (!floating && !wallViewport && typeof doc?.getElementById === 'function') {
    const wallEl = doc.getElementById('shell-wall');
    if (wallEl && typeof wallEl.getBoundingClientRect === 'function') wallViewport = wallEl.getBoundingClientRect();
  }
  return {scrollAncestors, wallViewport};
}
</script>
<script setup>
import { onMounted, onBeforeUnmount, computed, ref, watch, inject, nextTick } from 'vue';
const props = defineProps({surfaceId:{type:String,required:true},label:{type:String,default:''},control:{type:String,default:'agent'},canTakeControl:{type:Boolean,default:false},presentationActive:{type:Boolean,default:true}});
const emit = defineEmits(['mode','reveal','stopped','lifecycle','take-control']);
const progress = ref(''), confirmed = ref(false), recordingPaused = ref(false);
const overlays = /** @type {ReturnType<typeof import('./overlayCoordinator.js').createOverlayCoordinator>|null} */ (inject('overlayCoordinator', null));
const hiddenSessions = /** @type {ReturnType<typeof import('./hiddenSessions.js').createHiddenSessionPool>|null} */ (inject('hiddenSessionPool', null));
const menuOpen = ref(false), menuHost = ref(/** @type {HTMLElement|null} */ (null)), headerTarget = ref(/** @type {Element|null} */ (null)), resourceReleased = ref(false);
const menuOwner = {};
const tileLayout = /** @type {any} */ (inject('tileLayoutActions',null));
const destinations = computed(() => tileLayout?.desktops(props.surfaceId) || []);
const sizeControls = [{action:'wider',label:'⇆ +',title:'Wider (Ctrl+Alt+Right)'},{action:'narrower',label:'⇆ −',title:'Narrower (Ctrl+Alt+Left)'},{action:'taller',label:'⇅ +',title:'Taller (Ctrl+Alt+Down)'},{action:'shorter',label:'⇅ −',title:'Shorter (Ctrl+Alt+Up)'},{action:'fit',label:'Fit',title:'Equalise row and column'}];
function resizeTile(/** @type {string} */ action) { tileLayout?.resize(props.surfaceId,action); }
async function moveTile(/** @type {number|'new'} */ desktop, follow = false) {
  menuOpen.value = false;
  const result = await tileLayout?.move(props.surfaceId,desktop,follow);
  if (!result?.ok) error.value = 'Desktop move is unavailable.';
}
let stopNativeFocus = /** @type {(()=>void)|undefined} */ (undefined);
const menuPopup = ref(/** @type {HTMLElement|null} */ (null));
watch(menuOpen, async open => {
  if (!open) { if (menuPopup.value?.matches?.(':popover-open')) menuPopup.value.hidePopover(); return; }
  await nextTick();
  if (menuOpen.value) /** @type {any} */ (menuPopup.value)?.showPopover?.({source:menuHost.value?.querySelector?.('button')});
});
watch(menuOpen, open => overlays?.set(menuOwner, open), {flush:'sync'});
/** @param {Event} event */
function closeMenu(event) { if (!menuHost.value?.contains(/** @type {Node|null} */ (event.target))) menuOpen.value = false; }
/** @param {()=>void} action */
function runMenu(action) { menuOpen.value = false; action(); }
function isGeometricallyShown() {
  if (!props.presentationActive) return false;
  const {scrollAncestors, wallViewport} = collectClipRects(root.value);
  return clipRoleBounds(root.value?.getBoundingClientRect(), scrollAncestors, wallViewport).visible && isRoleElementPainted(root.value);
}
function releaseHiddenSession() {
  resourceReleased.value = true;
  void revoke();
}
function reconnectReleased() { resourceReleased.value = false; void sync(); }

const api = /** @type {any} */ (globalThis).metaviewerRoles;
const root = ref(/** @type {HTMLElement|null} */ (null));
const role = ref(api ? '' : 'agent'), watching = ref(false), error = ref('');
const hostWindow = ref(/** @type {any} */ (null));
let ended = false, notifiedEnd = false, resync = false;
let transferring = false;
let alive = true, mounted = false, busy = false, signature = '', shown = true;
const viewState = ref('closed'), hasConnected = ref(false);
let timer = /** @type {ReturnType<typeof setInterval>|undefined} */ (undefined);
/** @type {Array<() => void>} */
const scrollCleanups = [];
const wanted = () => role.value === 'human' || role.value === 'agent' && watching.value && props.control === 'agent';
async function revoke() {
  hiddenSessions?.remove(props.surfaceId);
  mounted = false; signature = ''; shown = true; hasConnected.value = false; viewState.value = 'closed';
  try { await api?.close(props.surfaceId); } catch { /* host window teardown also revokes */ }
}
async function sync() {
  if (ended) { if (!notifiedEnd) { notifiedEnd = true; emit('mode', {surfaceId:props.surfaceId,mode:'closed'}); } return; }
  if (!api || !alive || error.value || progress.value || resourceReleased.value) return;
  if (busy) { resync = true; return; }
  busy = true;
  try {
    if (mounted || hostWindow.value) {
      const status = await api.status(props.surfaceId);
      if (status.ok === false) throw Error(status.code || 'XPRA_REFUSED');
      if (status.hostWindow !== undefined) {
        hostWindow.value = status.hostWindow || null;
        if (status.hostWindow?.state === 'lost') {
          error.value = status.hostWindow.lostReason || 'Window closed — capsule tile ended.';
          return;
        }
      }
      if (mounted) {
        viewState.value = status.view?.state || 'ready';
        recordingPaused.value = status.view?.recording === 'paused_size_limit';
        if (viewState.value === 'ready') hasConnected.value = true;
        if (status.view?.state === 'error') throw Error(status.view.code);
      }
    }
    const box = root.value?.getBoundingClientRect();
    const {scrollAncestors, wallViewport} = collectClipRects(root.value);
    const floating = floatingPresentation(root.value);
    const baseClip = clipRoleBounds(box, scrollAncestors, wallViewport);
    const clipped = baseClip.visible ? subtractRoleOccluders(baseClip.bounds,floating.occluders) : baseClip;
    const geometricallyShown = props.presentationActive && baseClip.visible && isRoleElementPainted(root.value);
    const visible = geometricallyShown && clipped.visible && !isModalActive();
    if (mounted) hiddenSessions?.update(props.surfaceId, geometricallyShown, releaseHiddenSession, isGeometricallyShown);
    if (resourceReleased.value) return;
    if (!wanted()) { if (mounted) await revoke(); return; }
    // Temporary clipping, docking and window visibility must not revoke the
    // authenticated session. Hide the native view and retain its connection.
    if (!visible) {
      if (mounted && shown) {
        const reply = await api.visibility(props.surfaceId,false);
        if (!reply.ok) throw Error(reply.code);
        shown = false;
      }
      return;
    }
    if (mounted && !shown) {
      const reply = await api.visibility(props.surfaceId,true);
      if (!reply.ok) throw Error(reply.code);
      shown = true;
    }
    if (mounted && floating.front) await api.raise?.(props.surfaceId);
    const bounds = clipped.bounds;
    const next = JSON.stringify(bounds);
    if (mounted && next === signature) return;
    const attaching = !mounted;
    if (attaching) viewState.value = 'connecting';
    const reply = mounted ? await api.resize(props.surfaceId,bounds) : await api.mount(props.surfaceId,bounds);
    if (!alive || !wanted()) { if (!transferring) await revoke(); return; }
    if (!reply.ok) throw Error(reply.code);
    mounted = true; signature = next; error.value = '';
    if (attaching) {
      viewState.value = 'ready'; hasConnected.value = true;
      // Native role views stay hidden through their initial async mount.
      // Reconcile against the current modal/geometry state before exposing one.
      if (reply.visible === false) { shown = false; resync = true; }
    }
    hiddenSessions?.update(props.surfaceId, true, releaseHiddenSession, isGeometricallyShown);
  } catch (e) { error.value = /** @type {Error} */(e).message || 'XPRA_REFUSED'; await revoke(); }
  finally {
    busy = false;
    if (resync && alive && !ended && !error.value && !progress.value) { resync = false; void sync(); }
  }
}
function onGeometryChange() { void sync(); }
function bindScrollListeners() {
  while (scrollCleanups.length) scrollCleanups.pop()?.();
  const onScroll = () => { void sync(); };
  const targets = new Set();
  if (typeof globalThis.window?.addEventListener === 'function') targets.add(globalThis.window);
  if (typeof globalThis.document?.addEventListener === 'function') targets.add(globalThis.document);
  const seen = new Set();
  for (let cur = /** @type {any} */ (root.value); cur && !seen.has(cur) && seen.size < MAX_ANCESTORS; cur = cur.parentElement ?? cur.parent) {
    seen.add(cur);
    if (typeof cur.addEventListener === 'function') targets.add(cur);
  }
  const wallEl = typeof globalThis.document?.getElementById === 'function' ? globalThis.document.getElementById('shell-wall') : null;
  if (wallEl && typeof wallEl.addEventListener === 'function') targets.add(wallEl);
  for (const target of targets) {
    target.addEventListener('scroll', onScroll, true);
    scrollCleanups.push(() => target.removeEventListener?.('scroll', onScroll, true));
  }
  if (typeof globalThis.MutationObserver === 'function' && globalThis.document?.body) {
    try {
      const obs = new globalThis.MutationObserver(onScroll);
      obs.observe(globalThis.document.body, {attributes:true, attributeFilter:['data-mv-modal']});
      scrollCleanups.push(() => obs.disconnect());
    } catch { /* non-DOM test body */ }
  }
}
async function detachHostWindow() {
  if (ended) return;
  menuOpen.value = false;
  progress.value = 'Detaching window…';
  error.value = '';
  try {
    await revoke();
    const detachFn = typeof api?.detachWindow === 'function' ? api.detachWindow.bind(api) : api?.stop?.bind(api);
    const completion = detachFn ? detachFn(props.surfaceId) : Promise.resolve({ok:true});
    emit('lifecycle', {surfaceId:props.surfaceId,completion});
    const result = await completion;
    if (!result?.ok) throw Error(result?.reason || result?.code || 'HOST_WINDOW_DETACH_FAILED');
    ended = true;
    emit('stopped', props.surfaceId);
  } catch (reason) {
    error.value = /** @type {Error} */(reason).message;
  } finally {
    progress.value = '';
  }
}
/** @param {string} operation */
async function lifecycle(operation) {
  if (operation === 'stop' && hostWindow.value) {
    await detachHostWindow();
    return;
  }
  if (progress.value) return;
  progress.value = operation === 'switchMode' ? `Switching to ${role.value === 'human' ? 'agent' : 'human'}…` : 'Stopping capsule…';
  error.value = '';
  try {
    while (busy && alive) await new Promise(resolve => setTimeout(resolve,10));
    await revoke();
    const completion = api[operation](props.surfaceId);
    // Agent departure can unmount this tile before the destroy/create reply.
    // Its persistent parent must own presentation cleanup of that completion.
    emit('lifecycle', {surfaceId:props.surfaceId,completion});
    const result = await completion;
    if (!result.ok) throw Error(result.code);
    ended = true;
    // Start reveal before retiring this component: closing its pane can unmount
    // it synchronously, after which Vue suppresses further emitted events.
    if (result.surfaceId) emit('reveal', result.surfaceId);
    emit('stopped', props.surfaceId);
  } catch (reason) { error.value = /** @type {Error} */(reason).message; }
  finally { progress.value = ''; }
}
async function confirmLogin() {
  try { const result = await api.confirmLogin(props.surfaceId); if (!result.ok) throw Error(result.code); confirmed.value = true; }
  catch (reason) { error.value = /** @type {Error} */(reason).message; }
}
onMounted(async () => {
  stopNativeFocus = api?.onFocus?.((/** @type {string} */ id) => {if(id === props.surfaceId) {tileLayout?.focus?.(id);void sync();}});
  headerTarget.value = root.value?.closest?.('.mv-tile')?.querySelector('.cuk-capsule-panel__actions') ?? null;
  globalThis.document?.addEventListener?.('pointerdown', closeMenu, true);
  globalThis.window?.addEventListener?.('pointermove', onGeometryChange, true);
  globalThis.window?.addEventListener?.('resize', onGeometryChange);
  if (!api) return;
  try {
    const status = await api.status(props.surfaceId);
    if (!alive) return;
    if (!['human','agent'].includes(status.role)) throw Error(status.code || 'CAPSULE_ROLE_UNPROVEN');
    if (status.hostWindow) {
      hostWindow.value = status.hostWindow;
      if (status.hostWindow.state === 'lost') {
        error.value = status.hostWindow.lostReason || 'Window closed — capsule tile ended.';
      }
    }
    const transfer = tileLayout?.transfers.get(props.surfaceId);
    tileLayout?.transfers.delete(props.surfaceId);
    if (transfer?.watching) watching.value = true;
    if (transfer?.mounted && status.view?.state && status.view.state !== 'closed') { mounted = true; shown = false; hasConnected.value = status.view.state === 'ready'; }
    role.value = status.role; emit('mode', {surfaceId:props.surfaceId,mode:status.role});
    bindScrollListeners();
    await sync();
    if (!alive) return; // An in-flight native mount may finish after unmount.
    timer = setInterval(() => { void sync(); },100);
  } catch (e) { error.value = /** @type {Error} */(e).message; }
});
watch(() => props.control, () => { if (props.control !== 'agent') watching.value = false; void sync(); });
// Menu closure and the canvas visibility update must settle before measuring.
watch(watching, () => { void sync(); }, {flush:'post'});
watch(progress, () => { if (!progress.value && ended) void sync(); });
watch(() => props.presentationActive, () => { menuOpen.value = false; void sync(); }, {flush:'sync'});
onBeforeUnmount(() => { stopNativeFocus?.(); overlays?.set(menuOwner, false); globalThis.window?.removeEventListener?.('pointermove', onGeometryChange, true); globalThis.window?.removeEventListener?.('resize', onGeometryChange); globalThis.document?.removeEventListener?.('pointerdown', closeMenu, true); transferring = tileLayout?.transfers.has(props.surfaceId) === true; if (transferring) Object.assign(tileLayout.transfers.get(props.surfaceId),{watching:watching.value,mounted}); alive = false; clearInterval(timer); while (scrollCleanups.length) scrollCleanups.pop()?.(); if (!transferring) void revoke(); });
</script>
<template>
  <div class="mv-role-surface" :data-capsule-role="role || 'unproven'">
    <Teleport v-if="api && role" :to="headerTarget || 'body'" :disabled="!headerTarget">
      <div ref="menuHost" class="mv-role-menu-host" @keydown.esc="menuOpen = false">
        <div v-if="tileLayout" class="mv-tile-size-controls" aria-label="Tile size">
          <button v-for="control in sizeControls" :key="control.action" type="button" :id="`tile-size-${control.action}-${surfaceId}`" :title="control.title" :aria-label="control.title" @pointerdown.stop @click.stop="resizeTile(control.action)">{{ control.label }}</button>
        </div>
        <span class="mv-role-mode-badge">{{ role }}</span>
        <span v-if="hostWindow" :id="`tile-host-indicator-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/host-window-indicator`" class="mv-host-window-badge" :title="`${hostWindow.title} — ${hostWindow.program}. This tile is attached to a real window on your desktop, not an isolated container.`">Real desktop — not isolated</span>
        <button v-if="hostWindow" type="button" :id="`tile-host-stop-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/host-window-stop`" class="mv-host-window-stop" @click.stop="detachHostWindow">Stop</button>
        <span v-if="recordingPaused" role="status">Recording paused (size limit)</span>
        <button type="button" :id="`tile-menu-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/menu`" class="mv-role-menu-button" :aria-label="`${label || surfaceId}: ${role} tile menu`" aria-haspopup="menu" :aria-controls="`tile-actions-${surfaceId}`" :aria-expanded="menuOpen" :disabled="!!progress" @click="menuOpen = !menuOpen">⋮</button>
        <div v-if="menuOpen" ref="menuPopup" :id="`tile-actions-${surfaceId}`" popover="manual" class="mv-menu-popover" role="menu" :aria-label="`${role} tile actions`">
          <button :id="`tile-switch-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/mode/switch`" role="menuitem" type="button" :disabled="!!progress" @click="runMenu(() => lifecycle('switchMode'))">Switch to {{ role === 'human' ? 'agent' : 'human' }} mode</button>
          <button v-if="role === 'human'" role="menuitem" :id="`tile-login-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/login/confirm`" title="Remembers that this identity has a signed-in session; shown as Last login in Identities." type="button" :disabled="confirmed || !!progress" @click="runMenu(confirmLogin)">{{ confirmed ? 'Marked as logged in' : 'Mark as logged in' }}</button>
          <button v-if="role === 'agent' && control === 'agent'" role="menuitem" :id="`tile-watch-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/watch`" type="button" @click="runMenu(() => watching = !watching)">{{ watching ? 'Close watch' : 'Watch read-only' }}</button>
          <template v-if="tileLayout">
            <hr role="separator">
            <span class="mv-desktop-menu-title">Move to desktop ▸</span>
            <div v-for="desktop in destinations" :key="desktop.id" class="mv-desktop-menu-row">
              <span>Desktop {{ desktop.id }}{{ desktop.current ? ' (current)' : '' }}</span>
              <button role="menuitem" type="button" :disabled="desktop.current" :id="`tile-move-${surfaceId}-${desktop.id}`" @click="moveTile(desktop.id)">Move</button>
              <button role="menuitem" type="button" :disabled="desktop.current" :id="`tile-move-go-${surfaceId}-${desktop.id}`" @click="moveTile(desktop.id,true)">Move and go</button>
            </div>
            <div class="mv-desktop-menu-row"><span>New desktop</span><button role="menuitem" type="button" :id="`tile-move-new-${surfaceId}`" @click="moveTile('new')">Move</button><button role="menuitem" type="button" :id="`tile-move-go-new-${surfaceId}`" @click="moveTile('new',true)">Move and go</button></div>
          </template>
          <button :id="`tile-stop-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/stop`" role="menuitem" type="button" :disabled="!!progress" @click="runMenu(() => lifecycle('stop'))">Stop capsule</button>
          <template v-if="role === 'agent'"><hr role="separator"><button :aria-label="`Take control of ${label || surfaceId} (emergency)`" :id="`tile-take-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/control/emergency`" role="menuitem" type="button" :disabled="!canTakeControl" @click="runMenu(() => emit('take-control'))">Take control (emergency)</button></template>
        </div>
      </div>
    </Teleport>
    <span v-if="progress" role="status">{{ progress }}</span>
    <div ref="root" class="mv-role-viewport">
      <div v-if="role === 'agent'" :style="{visibility: (watching || hostWindow?.minimized || hostWindow?.state === 'lost') ? 'hidden' : undefined}" :inert="watching || Boolean(hostWindow?.minimized) || hostWindow?.state === 'lost'" class="mv-role-agent-canvas"><slot /></div>
      <button v-if="resourceReleased" :id="`tile-reconnect-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/reconnect`" type="button" @click="reconnectReleased">Disconnected to save resources, click to reconnect</button>
      <button v-if="error && !hostWindow" type="button" @click="error = ''; sync()">Reopen</button>
      <p v-if="hostWindow?.minimized && !error && hostWindow?.state !== 'lost'" :id="`tile-host-minimized-${surfaceId}`" :data-semantic-anchor="`capsule/${surfaceId}/host-window-minimized`" class="mv-role-status" role="status">Window minimized — waiting for window to be restored</p>
      <p v-else-if="role === 'human' || watching" class="mv-role-status" role="status">{{ error || (resourceReleased ? 'Disconnected to save resources, click to reconnect' : viewState === 'reconnecting' && hasConnected ? 'Reconnecting…' : viewState === 'connecting' || !mounted ? 'Connecting…' : role === 'human' ? 'Human capsule' : 'Read-only watch') }}</p>
      <p v-else-if="error" :id="hostWindow ? `tile-host-lost-${surfaceId}` : undefined" role="alert">{{ error }}</p>
    </div>
  </div>
</template>
<style scoped>
.mv-role-menu-host { position:relative; display:flex; align-items:center; gap:6px; }
.mv-tile-size-controls { display:flex; gap:2px; }
.mv-tile-size-controls button { padding:2px 4px; min-height:26px; white-space:nowrap; }
.mv-desktop-menu-title { padding:4px 8px; font-weight:600; }
.mv-desktop-menu-row { display:flex; align-items:center; gap:6px; padding:2px 8px; }
.mv-desktop-menu-row > span { flex:1; white-space:nowrap; }
.mv-role-mode-badge { font-size:11px; text-transform:capitalize; }
.mv-role-menu-button { min-width:28px; min-height:28px; }
.mv-role-menu-host hr { width:100%; }
:global(.mv-tile:has([data-capsule-role="human"]) [data-semantic-anchor$="/control"]) { display:none; }
.mv-role-surface { flex:1 1 auto; display:flex; flex-direction:column; width:100%; height:100%; min-height:0; }
.mv-role-viewport { position:relative; flex:1; min-height:0; overflow:hidden; }
.mv-role-agent-canvas { width:100%; height:100%; }
.mv-role-status { position:absolute; top:0; left:0; pointer-events:none; }
.mv-role-actions { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.mv-role-watch { display:flex; justify-content:flex-end; }
</style>
