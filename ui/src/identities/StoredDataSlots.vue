<script setup>
import { ref, watch } from 'vue';
import { UiButton, UiTextInput } from 'capsule-ui-kit/ui';
import ConfirmDialog from '../../.kit/capsule-ui-kit/src/overlays/ConfirmDialog.vue';
import { isProtectedIdentity, isForeignIdentity } from '../../electron/identityProtection.js';
// [TARGET, unit decision] Each profile owns its pending UI operation; no capture
// or unrelated surface waits for a save. All requests go through core admission.
const props=defineProps({profileId:{type:String,required:true},blocked:{type:Boolean,default:false},api:{type:Object,default:()=>/** @type {any} */(globalThis).metaviewer?.slots}});
const emit=defineEmits(['changed','copied']);
const rows=ref(/** @type {any[]} */([])), name=ref(''), destination=ref(''), busy=ref(false), error=ref(''), status=ref('');
const pending=ref(/** @type {{op:string,slot:string}|null} */(null));
const validId=(/** @type {string} */id)=>/^[a-z0-9][a-z0-9-]{1,39}$/.test(id);
const forbidden=()=>props.blocked || isProtectedIdentity(props.profileId) || isForeignIdentity(props.profileId);
/** @param {string} op @param {string} slot */
function ask(op,slot) {
  if (busy.value || forbidden()) return;
  if (!validId(slot)) {error.value='Use 2–40 lowercase letters, numbers and dashes for the slot name.';return;}
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
/** @param {string} code */
function refusal(code) {
  const messages=/** @type {Record<string,string>} */({
    SLOT_EXISTS:'That slot exists. Choose Overwrite to replace it.',
    IDENTITY_BOUND:'Stop the open capsule before changing its stored data.',
    LOGIN_IN_PROGRESS:'Close the login view before changing stored data.',
    IDENTITY_PROTECTED:'This profile is protected. Choose another identity.',
    POLICY:'This operation is not allowed. Check that the capsule is stopped and the profile is not protected.',
    SLOT_DISK_SPACE:'Disk space is too low. Free disk space, then retry.',
    SLOT_QUOTA:'Slot storage is full. Delete an unused slot or free disk space, then retry.',
    SLOT_LIST_LIMIT:'Too many saved slots. Delete an unused slot before saving again.',
    SLOT_BUSY:'Another stored-data operation is running. Wait, then refresh.',
    SLOT_NOT_FOUND:'That slot no longer exists. Refresh the list.',
    SLOT_INCOMPATIBLE:'This slot requires a compatible capsule image.',
    SLOT_RECONCILIATION_REQUIRED:'This slot needs recovery. Close and reopen MetaViewer before retrying.',
    SLOT_QUARANTINED:'Slot verification failed. The saved data has been retained for recovery.'
  });
  return messages[code] || `Stored data is unavailable (${code || 'SLOT_OPERATION_FAILED'}). Refresh to retry.`;
}
/** @param {unknown} error */
const errorCode=error=>error instanceof Error ? error.message : 'SLOT_OPERATION_FAILED';
/** @param {number|undefined} bytes */
const size=bytes=>bytes===undefined ? 'Size unavailable' : `${bytes.toLocaleString()} bytes`;
async function readRows() {
  const result=await request('list','list');
  if(result.event!=='completed') throw new Error(result.reason_code);
  if(!Array.isArray(result.slots)) throw new Error('SLOT_LIST_MISSING');
  rows.value=result.slots;
}
async function refresh() {
  if (busy.value || forbidden()) return;
  busy.value=true;error.value='';
  try {await readRows();}
  catch (reason) {error.value=refusal(errorCode(reason));}
  finally {busy.value=false;}
}
async function confirm() {
  if (!pending.value || busy.value || forbidden()) return;
  const {op,slot}=pending.value, copiedName=destination.value;
  busy.value=true;error.value='';
  const verbs=/** @type {Record<string,string>} */({save:'Saving',overwrite:'Overwriting',load:'Loading',copy:'Copying',delete:'Deleting'});
  status.value=`${verbs[op]} ${slot}… Keep MetaViewer open until this finishes.`;
  try {
    const result=await request(op,slot);
    pending.value=null;
    if(result.event!=='completed') {error.value=refusal(result.reason_code);status.value='';return;}
    const done=/** @type {Record<string,string>} */({save:`Saved ${slot}.`,overwrite:`Overwrote ${slot}.`,load:`Loaded ${slot} into ${props.profileId}.`,copy:`Copied ${slot} to ${copiedName}.`,delete:`Deleted ${slot}.`});
    status.value=done[op];
    if(op==='save') name.value='';
    // A failed refresh must not hide a completed write or invite a duplicate Save.
    try {await readRows();} catch(reason) {error.value=`${status.value} ${refusal(errorCode(reason))}`;}
    if(op==='copy'){destination.value='';emit('changed');emit('copied',copiedName);}
  } catch(reason) {pending.value=null;error.value=refusal(errorCode(reason));status.value='';}
  finally {busy.value=false;}
}
watch(()=>[props.profileId,props.blocked],()=>{rows.value=[];pending.value=null;name.value='';destination.value='';error.value='';status.value='';void refresh();},{immediate:true});
</script>
<template>
  <section class="stored-data-slots" :aria-label="`Stored data for ${profileId}`">
    <h4>Stored data slots · {{ profileId }}</h4>
    <p v-if="status" role="status" aria-live="polite">{{ status }}</p><p v-if="error" role="alert">{{ error }}</p>
    <p>Stored data, not open tabs. Identity metadata and allowed sites stay unchanged on Load.</p>
    <p v-if="isProtectedIdentity(profileId) || isForeignIdentity(profileId)" role="note">This profile is protected. Choose another identity to manage saved data.</p>
    <p v-else-if="blocked" role="note">Stop this capsule and close its login view before saving or loading.</p>
    <label>Slot name<UiTextInput v-model="name" label="Slot name" placeholder="before-update" :disabled="busy || forbidden()" /></label>
    <UiButton label="Save" :disabled="busy || forbidden() || !name.trim()" @click="ask('save',name)" />
    <UiButton label="Refresh slots" :disabled="busy || forbidden()" @click="refresh" />
    <p>Use 2–40 lowercase letters, numbers and dashes for names. The name clears after a successful Save.</p>
    <label>New capsule name for Copy<UiTextInput v-model="destination" label="New capsule name for Copy" placeholder="work-copy" :disabled="busy || forbidden()" /></label>
    <p v-if="!busy && !error && !forbidden() && !rows.length">No saved slots for {{ profileId }} yet. Save one before changing its stored data.</p>
    <p v-if="busy && !pending" role="status">Refreshing saved slots…</p>
    <ul aria-label="Stored data slots">
      <li v-for="slot in rows" :key="slot.slot_id">
        <strong>{{ slot.name }}</strong> <time :datetime="slot.saved_at">{{ new Date(slot.saved_at).toLocaleString() }}</time> <span class="slot-size">{{ size(slot.size_bytes) }}</span>
        <UiButton label="Overwrite" :disabled="busy || forbidden()" @click="ask('overwrite',slot.slot_id)" />
        <UiButton label="Load" :disabled="busy || forbidden()" @click="ask('load',slot.slot_id)" />
        <UiButton label="Copy to a new capsule" :disabled="busy || forbidden()" @click="ask('copy',slot.slot_id)" />
        <UiButton label="Delete slot" :disabled="busy || forbidden()" @click="ask('delete',slot.slot_id)" />
      </li>
    </ul>
    <ConfirmDialog :id="`stored-data-confirm-${profileId}`" :open="!!pending" :title="pending?.op==='overwrite'?'Overwrite stored data?':pending?.op==='delete'?'Delete stored data?':'Confirm stored data operation'"
      :description="busy ? status : pending?.op==='delete' ? `Delete slot ${pending.slot}? This cannot be undone.` : `Signed-in sessions travel with stored data. ${pending?.op==='copy' ? 'Copy into the new capsule '+destination : pending?.op==='overwrite' ? 'Replace slot '+pending.slot : pending?.op==='load' ? 'Replace stored data in '+profileId+' from '+pending.slot : 'Save stored data as '+pending?.slot}?`"
      :confirm-label="pending?.op==='delete'?'Delete slot':pending?.op==='overwrite'?'Overwrite — signed-in sessions travel':'Continue — signed-in sessions travel'" :busy="busy" @confirm="confirm" @back="pending=null" />
  </section>
</template>
<style scoped>
.stored-data-slots{width:100%;padding:1rem;border:1px solid var(--cuk-semantic-border-subtle);border-radius:.5rem;box-sizing:border-box;}.stored-data-slots h4{margin:.25rem 0;}.stored-data-slots li{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.5rem 0;}.stored-data-slots label{display:inline-block;margin:.25rem .5rem .25rem 0;}.stored-data-slots time{color:var(--cuk-semantic-text-muted);}
</style>
