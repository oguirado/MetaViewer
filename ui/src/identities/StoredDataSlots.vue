<script setup>
import { ref, watch } from 'vue';
import { UiButton, UiTextInput } from 'capsule-ui-kit/ui';
import ConfirmDialog from '../../.kit/capsule-ui-kit/src/overlays/ConfirmDialog.vue';
import { isProtectedIdentity, isForeignIdentity } from '../../electron/identityProtection.js';
// [TARGET, unit decision] Each profile owns its pending UI operation; no capture
// or unrelated surface waits for a save. All requests go through core admission.
const props=defineProps({profileId:{type:String,required:true},blocked:{type:Boolean,default:false},api:{type:Object,default:()=>/** @type {any} */(globalThis).metaviewer?.slots}});
const emit=defineEmits(['changed']);
const rows=ref(/** @type {any[]} */([])), name=ref(''), destination=ref(''), busy=ref(false), error=ref(''), status=ref('');
const pending=ref(/** @type {{op:string,slot:string}|null} */(null));
const validId=(/** @type {string} */id)=>/^[a-z0-9][a-z0-9-]{1,39}$/.test(id);
const forbidden=()=>props.blocked || isProtectedIdentity(props.profileId) || isForeignIdentity(props.profileId);
/** @param {string} op @param {string} slot */
function ask(op,slot) {
  if (busy.value || forbidden() || !validId(slot)) return;
  if (op==='copy' && (!validId(destination.value) || destination.value===props.profileId || isProtectedIdentity(destination.value) || isForeignIdentity(destination.value))) {
    error.value='Choose a new capsule name using lowercase letters, numbers and dashes.';return;
  }
  error.value='';pending.value={op,slot};
}
/** @param {string} op @param {string} slot */
async function request(op,slot) {
  if (!props.api?.request) throw new Error('SLOT_STORE_UNAVAILABLE');
  return props.api.request({schema:'capsule_state_request/v0.2',operation_id:globalThis.crypto.randomUUID(),op,
    profile_id:props.profileId,slot_id:slot,credential_copy_confirmed:true,
    ...(op==='copy'?{destination_profile_id:destination.value}:{})});
}
async function refresh() {
  if (busy.value || forbidden()) return;
  busy.value=true;error.value='';
  try {const result=await request('list','list');if(result.event!=='completed')throw new Error(result.reason_code);rows.value=result.slots ?? [];}
  catch {error.value='Stored data slots are unavailable. Refresh to retry.';}
  finally {busy.value=false;}
}
async function confirm() {
  if (!pending.value || busy.value || forbidden()) return;
  const {op,slot}=pending.value;
  busy.value=true;error.value='';status.value='Working on stored data… Other capsules remain available.';
  try {
    const result=await request(op,slot);
    if(result.event!=='completed') {
      const code=result.reason_code;
      error.value=code==='SLOT_EXISTS'?'That slot exists. Choose Overwrite to replace it.':
        code==='IDENTITY_BOUND'?'Stop the capsule before changing its stored data.':
        code==='LOGIN_IN_PROGRESS'?'Close the login view before changing stored data.':
        code==='SLOT_INCOMPATIBLE'?'This slot requires a compatible capsule image.':
        'Stored data operation refused. Refresh and check that the capsule is stopped.';
      status.value='';return;
    }
    pending.value=null;status.value='Stored data operation completed.';
    if(op==='copy'){destination.value='';emit('changed');}
    busy.value=false;await refresh();
  } catch {error.value='Stored data operation did not complete. Refresh before retrying.';status.value='';}
  finally {busy.value=false;}
}
watch(()=>props.profileId,()=>{rows.value=[];pending.value=null;void refresh();},{immediate:true});
</script>
<template>
  <section class="stored-data-slots" :aria-label="`Stored data for ${profileId}`">
    <h4>Stored data slots</h4>
    <p>Stored data, not open tabs. Identity metadata and allowed sites stay unchanged on Load.</p>
    <p v-if="blocked">Stop this capsule and close its login view before saving or loading.</p>
    <label>Slot name<UiTextInput v-model="name" label="Slot name" placeholder="before-update" :disabled="busy || forbidden()" /></label>
    <UiButton label="Save" :disabled="busy || forbidden() || !validId(name)" @click="ask('save',name)" />
    <UiButton label="Refresh slots" :disabled="busy || forbidden()" @click="refresh" />
    <p>Use lowercase letters, numbers and dashes for names.</p>
    <label>New capsule name for Copy<UiTextInput v-model="destination" label="New capsule name for Copy" placeholder="work-copy" :disabled="busy || forbidden()" /></label>
    <ul aria-label="Stored data slots">
      <li v-for="slot in rows" :key="slot.slot_id">
        <strong>{{ slot.name }}</strong> <time :datetime="slot.saved_at">{{ new Date(slot.saved_at).toLocaleString() }}</time>
        <UiButton label="Overwrite" :disabled="busy || forbidden()" @click="ask('overwrite',slot.slot_id)" />
        <UiButton label="Load" :disabled="busy || forbidden()" @click="ask('load',slot.slot_id)" />
        <UiButton label="Copy to a new capsule" :disabled="busy || forbidden()" @click="ask('copy',slot.slot_id)" />
        <UiButton label="Delete slot" :disabled="busy || forbidden()" @click="ask('delete',slot.slot_id)" />
      </li>
    </ul>
    <p v-if="status" role="status">{{ status }}</p><p v-if="error" role="alert">{{ error }}</p>
    <ConfirmDialog :id="`stored-data-confirm-${profileId}`" :open="!!pending" :title="pending?.op==='overwrite'?'Overwrite stored data?':pending?.op==='delete'?'Delete stored data?':'Confirm stored data operation'"
      :description="pending?.op==='delete' ? `Delete slot ${pending.slot}? This cannot be undone.` : `Signed-in sessions travel with stored data. ${pending?.op==='copy' ? 'Copy into the new capsule '+destination : pending?.op==='overwrite' ? 'Replace slot '+pending.slot : pending?.op==='load' ? 'Replace stored data in '+profileId+' from '+pending.slot : 'Save stored data as '+pending?.slot}?`"
      :confirm-label="pending?.op==='delete'?'Delete slot':pending?.op==='overwrite'?'Overwrite — signed-in sessions travel':'Continue — signed-in sessions travel'" :busy="busy" @confirm="confirm" @back="pending=null" />
  </section>
</template>
<style scoped>
.stored-data-slots{width:100%;padding:.75rem 0;}.stored-data-slots h4{margin:.25rem 0;}.stored-data-slots li{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.5rem 0;}.stored-data-slots label{display:inline-block;margin:.25rem .5rem .25rem 0;}.stored-data-slots time{color:var(--cuk-semantic-text-muted);}
</style>
