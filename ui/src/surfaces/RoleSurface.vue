<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
const props = defineProps({surfaceId:{type:String,required:true},control:{type:String,default:'agent'}});
const emit = defineEmits(['mode','reveal']);
const progress = ref(''), confirmed = ref(false);
const api = /** @type {any} */ (globalThis).metaviewerRoles;
const root = ref(/** @type {HTMLElement|null} */ (null));
const role = ref(api ? '' : 'agent'), watching = ref(false), error = ref('');
let ended = false;
let alive = true, mounted = false, busy = false, signature = '', shown = true;
const viewState = ref('closed');
let timer = /** @type {ReturnType<typeof setInterval>|undefined} */ (undefined);
const wanted = () => role.value === 'human' || role.value === 'agent' && watching.value && props.control === 'agent';
async function revoke() {
  mounted = false; signature = ''; shown = true;
  try { await api?.close(props.surfaceId); } catch { /* host window teardown also revokes */ }
}
async function sync() {
  if (!api || busy || !alive || ended || error.value || progress.value) return;
  busy = true;
  try {
    if (mounted) {
      const status = await api.status(props.surfaceId);
      if (status.ok === false) throw Error(status.code || 'XPRA_REFUSED');
      viewState.value = status.view?.state || 'ready';
      if (status.view?.state === 'error') throw Error(status.view.code);
    }
    const box = root.value?.getBoundingClientRect();
    // Clip the tile to the window instead of requiring full containment: a maximized or floating
    // tile that overhangs by a fraction of a pixel must stay visible (operator, 1 Nov 17:1x).
    const left = box ? Math.ceil(Math.max(0, box.x)) : 0, top = box ? Math.ceil(Math.max(0, box.y)) : 0;
    const right = box ? Math.floor(Math.min(innerWidth, box.x + box.width)) : 0, bottom = box ? Math.floor(Math.min(innerHeight, box.y + box.height)) : 0;
    const visible = !!box && right - left >= 1 && bottom - top >= 1 && !!root.value?.getClientRects().length;
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
    const bounds = {x:left,y:top,width:right - left,height:bottom - top};
    const next = JSON.stringify(bounds);
    if (mounted && next === signature) return;
    const reply = mounted ? await api.resize(props.surfaceId,bounds) : await api.mount(props.surfaceId,bounds);
    if (!alive || !wanted()) { await revoke(); return; }
    if (!reply.ok) throw Error(reply.code);
    mounted = true; signature = next; error.value = '';
  } catch (e) { error.value = /** @type {Error} */(e).message || 'XPRA_REFUSED'; await revoke(); }
  finally { busy = false; }
}
/** @param {string} operation */
async function lifecycle(operation) {
  if (progress.value) return;
  progress.value = operation === 'switchMode' ? 'Closing capsule, then reopening in the other mode…' : 'Stopping capsule…';
  error.value = '';
  try {
    while (busy && alive) await new Promise(resolve => setTimeout(resolve,10));
    await revoke();
    const result = await api[operation](props.surfaceId);
    if (!result.ok) throw Error(result.code);
    ended = true;
    if (result.surfaceId) emit('reveal', result.surfaceId);
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
    await sync();
    timer = setInterval(() => { void sync(); },100);
  } catch (e) { error.value = /** @type {Error} */(e).message; }
});
watch(() => props.control, () => { if (props.control !== 'agent') watching.value = false; void sync(); });
watch(watching, () => { void sync(); });
onBeforeUnmount(() => { alive = false; clearInterval(timer); void revoke(); });
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
