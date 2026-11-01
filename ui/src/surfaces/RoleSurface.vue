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
/** @param {any} [doc] */
export function isModalActive(doc = globalThis.document) {
  const body = doc?.body;
  if (!body) return false;
  if (typeof body.hasAttribute === 'function' && body.hasAttribute('data-mv-modal')) return true;
  if (typeof body.getAttribute === 'function' && body.getAttribute('data-mv-modal') !== null) return true;
  if (body.dataset && body.dataset.mvModal !== undefined && body.dataset.mvModal !== 'false') return true;
  return Boolean(body.props?.['data-mv-modal']);
}
/** @param {any} el */
function collectClipRects(el) {
  const scrollAncestors = [];
  let wallViewport = null;
  const doc = globalThis.document;
  for (let cur = el?.parentElement ?? el?.parent; cur && cur !== doc?.body && cur !== doc?.documentElement; cur = cur.parentElement ?? cur.parent) {
    if (cur.tag === 'root' || typeof cur.getBoundingClientRect !== 'function') continue;
    const rect = cur.getBoundingClientRect();
    if (!rect) continue;
    const id = cur.id ?? cur.props?.id ?? '';
    const cls = typeof cur.className === 'string' ? cur.className : (typeof cur.props?.class === 'string' ? cur.props.class : '');
    if (id === 'shell-wall' || /\bwall-workspace\b/.test(cls)) wallViewport = rect;
    else scrollAncestors.push(rect);
  }
  if (!wallViewport && typeof doc?.getElementById === 'function') {
    const wallEl = doc.getElementById('shell-wall');
    if (wallEl && typeof wallEl.getBoundingClientRect === 'function') wallViewport = wallEl.getBoundingClientRect();
  }
  return {scrollAncestors, wallViewport};
}
</script>
<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
const props = defineProps({surfaceId:{type:String,required:true},control:{type:String,default:'agent'}});
const emit = defineEmits(['mode','reveal','stopped','lifecycle']);
const progress = ref(''), confirmed = ref(false);
const api = /** @type {any} */ (globalThis).metaviewerRoles;
const root = ref(/** @type {HTMLElement|null} */ (null));
const role = ref(api ? '' : 'agent'), watching = ref(false), error = ref('');
let ended = false, notifiedEnd = false, resync = false;
let alive = true, mounted = false, busy = false, signature = '', shown = true;
const viewState = ref('closed');
let timer = /** @type {ReturnType<typeof setInterval>|undefined} */ (undefined);
/** @type {Array<() => void>} */
const scrollCleanups = [];
const wanted = () => role.value === 'human' || role.value === 'agent' && watching.value && props.control === 'agent';
async function revoke() {
  mounted = false; signature = ''; shown = true;
  try { await api?.close(props.surfaceId); } catch { /* host window teardown also revokes */ }
}
async function sync() {
  if (ended) { if (!notifiedEnd) { notifiedEnd = true; emit('mode', {surfaceId:props.surfaceId,mode:'closed'}); } return; }
  if (!api || !alive || error.value || progress.value) return;
  if (busy) { resync = true; return; }
  busy = true;
  try {
    if (mounted) {
      const status = await api.status(props.surfaceId);
      if (status.ok === false) throw Error(status.code || 'XPRA_REFUSED');
      viewState.value = status.view?.state || 'ready';
      if (status.view?.state === 'error') throw Error(status.view.code);
    }
    const box = root.value?.getBoundingClientRect();
    const {scrollAncestors, wallViewport} = collectClipRects(root.value);
    const clipped = clipRoleBounds(box, scrollAncestors, wallViewport);
    const visible = clipped.visible && !isModalActive() && !!root.value?.getClientRects().length;
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
    const bounds = clipped.bounds;
    const next = JSON.stringify(bounds);
    if (mounted && next === signature) return;
    const reply = mounted ? await api.resize(props.surfaceId,bounds) : await api.mount(props.surfaceId,bounds);
    if (!alive || !wanted()) { await revoke(); return; }
    if (!reply.ok) throw Error(reply.code);
    mounted = true; signature = next; error.value = '';
  } catch (e) { error.value = /** @type {Error} */(e).message || 'XPRA_REFUSED'; await revoke(); }
  finally {
    busy = false;
    if (resync && alive && !ended && !error.value && !progress.value) { resync = false; void sync(); }
  }
}
function bindScrollListeners() {
  while (scrollCleanups.length) scrollCleanups.pop()?.();
  const onScroll = () => { void sync(); };
  const targets = new Set();
  if (typeof globalThis.window?.addEventListener === 'function') targets.add(globalThis.window);
  if (typeof globalThis.document?.addEventListener === 'function') targets.add(globalThis.document);
  for (let cur = /** @type {any} */ (root.value); cur; cur = cur.parentElement ?? cur.parent) {
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
/** @param {string} operation */
async function lifecycle(operation) {
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
  if (!api) return;
  try {
    const status = await api.status(props.surfaceId);
    if (!alive) return;
    if (!['human','agent'].includes(status.role)) throw Error(status.code || 'CAPSULE_ROLE_UNPROVEN');
    role.value = status.role; emit('mode', {surfaceId:props.surfaceId,mode:status.role});
    bindScrollListeners();
    await sync();
    timer = setInterval(() => { void sync(); },100);
  } catch (e) { error.value = /** @type {Error} */(e).message; }
});
watch(() => props.control, () => { if (props.control !== 'agent') watching.value = false; void sync(); });
watch(watching, () => { void sync(); });
watch(progress, () => { if (!progress.value && ended) void sync(); });
onBeforeUnmount(() => { alive = false; clearInterval(timer); while (scrollCleanups.length) scrollCleanups.pop()?.(); void revoke(); });
</script>
<template>
  <div class="mv-role-surface" :data-capsule-role="role || 'unproven'">
    <div v-if="api && role" class="mv-role-actions">
      <button type="button" :disabled="!!progress" @click="lifecycle('switchMode')">Switch to {{ role === 'human' ? 'agent' : 'human' }} mode</button>
      <button type="button" :disabled="!!progress" @click="lifecycle('stop')">Stop capsule</button>
      <button v-if="role === 'human'" type="button" :disabled="confirmed || !!progress" @click="confirmLogin">{{ confirmed ? 'Login confirmed' : 'I logged in' }}</button>
      <span v-if="progress" role="status">{{ progress }}</span>
    </div>
    <div v-if="role === 'agent' && api && control === 'agent'" class="mv-role-watch">
      <button type="button" :aria-pressed="watching" @click="watching = !watching">{{ watching ? 'Close watch' : 'Watch read-only' }}</button>
    </div>
    <div ref="root" class="mv-role-viewport">
      <div v-if="role === 'agent'" v-show="!watching" :inert="watching" class="mv-role-agent-canvas"><slot /></div>
      <button v-if="error" type="button" @click="error = ''; sync()">Reopen</button>
      <p v-if="role === 'human' || watching" class="mv-role-status" role="status">{{ error || (viewState === 'reconnecting' ? 'Reconnecting…' : role === 'human' ? 'Human capsule' : 'Read-only watch') }}</p>
      <p v-else-if="error" role="alert">{{ error }}</p>
    </div>
  </div>
</template>
<style scoped>
:global(.mv-tile:has([data-capsule-role="human"]) [data-semantic-anchor$="/control"]) { display:none; }
.mv-role-surface { display:flex; flex-direction:column; width:100%; height:100%; min-height:0; }
.mv-role-viewport { position:relative; flex:1; min-height:0; overflow:hidden; }
.mv-role-agent-canvas { width:100%; height:100%; }
.mv-role-status { pointer-events:none; }
.mv-role-actions { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.mv-role-watch { display:flex; justify-content:flex-end; }
</style>
