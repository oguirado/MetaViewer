<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
const props = defineProps({surfaceId:{type:String,required:true},control:{type:String,default:'agent'}});
const api = /** @type {any} */ (globalThis).metaviewerRoles;
const root = ref(/** @type {HTMLElement|null} */ (null));
const role = ref(api ? '' : 'agent'), watching = ref(false), error = ref('');
let alive = true, mounted = false, busy = false, signature = '';
let timer = /** @type {ReturnType<typeof setInterval>|undefined} */ (undefined);
const wanted = () => role.value === 'human' || role.value === 'agent' && watching.value && props.control === 'agent';
async function revoke() {
  mounted = false; signature = '';
  try { await api?.close(props.surfaceId); } catch { /* host window teardown also revokes */ }
}
async function sync() {
  if (!api || busy || !alive) return;
  const box = root.value?.getBoundingClientRect();
  const visible = box && box.width >= 1 && box.height >= 1 && box.x >= 0 && box.y >= 0 &&
    box.right <= innerWidth && box.bottom <= innerHeight && root.value?.getClientRects().length;
  if (!wanted() || !visible) { if (mounted) await revoke(); return; }
  const bounds = {x:Math.round(box.x),y:Math.round(box.y),width:Math.floor(box.width),height:Math.floor(box.height)};
  const next = JSON.stringify(bounds);
  if (mounted && next === signature) return;
  busy = true;
  try {
    const reply = mounted ? await api.resize(props.surfaceId,bounds) : await api.mount(props.surfaceId,bounds);
    if (!alive || !wanted()) { await revoke(); return; }
    if (!reply.ok) throw Error(reply.code);
    mounted = true; signature = next; error.value = '';
  } catch (e) { error.value = /** @type {Error} */(e).message || 'XPRA_REFUSED'; await revoke(); }
  finally { busy = false; }
}
onMounted(async () => {
  if (!api) return;
  try {
    const status = await api.status(props.surfaceId);
    if (!alive) return;
    if (!['human','agent'].includes(status.role)) throw Error(status.code || 'CAPSULE_ROLE_UNPROVEN');
    role.value = status.role;
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
    <div v-if="role === 'agent' && api && control === 'agent'" class="mv-role-watch">
      <button type="button" :aria-pressed="watching" @click="watching = !watching">{{ watching ? 'Close watch' : 'Watch read-only' }}</button>
    </div>
    <div ref="root" class="mv-role-viewport">
      <div v-if="role === 'agent'" v-show="!watching" :inert="watching" class="mv-role-agent-canvas"><slot /></div>
      <p v-if="role === 'human' || watching" class="mv-role-status" role="status">{{ error || (role === 'human' ? 'Human capsule' : 'Read-only watch') }}</p>
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
.mv-role-watch { display:flex; justify-content:flex-end; }
</style>
