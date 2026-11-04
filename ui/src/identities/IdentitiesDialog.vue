<script setup>
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue';
import { UiButton, UiTextInput } from 'capsule-ui-kit/ui';
import StoredDataSlots from './StoredDataSlots.vue';
import ConfirmDialog from '../../.kit/capsule-ui-kit/src/overlays/ConfirmDialog.vue';
import { operatorHost } from '../operatorHost.js';
import { identityErrorText, identityFormRequest, validLabel, validIdentityName, normalizeIdentityName, retainTypedIdentityName } from './identityForm.js';
import { isProtectedIdentity, isForeignIdentity } from '../../electron/identityProtection.js';
const props=defineProps({open:{type:Boolean,default:false},host:{type:Object,default:operatorHost},openProgram:{type:Function,default:null},initialProfile:{type:String,default:''},beforeDelete:{type:Function,default:null}});
const roleApi = /** @type {any} */(globalThis).metaviewerRoles;
const emit=defineEmits(['close','open-identity']);
const selectedSlots=ref(''), copyStatus=ref('');
const rows=ref(/** @type {any[]} */([])), id=ref(''), label=ref(''), domains=ref('');
const typedName=ref(''), labelEdited=ref(false), nameInput=ref(/** @type {{ $el?: HTMLInputElement }|null} */(null));
const displayName=computed({get:()=>labelEdited.value ? label.value : typedName.value,
  set:value=>{labelEdited.value=true;label.value=value;}});
/** @param {string} value */
function updateName(value) {
  typedName.value=retainTypedIdentityName(typedName.value,value); id.value=normalizeIdentityName(value);
  // Also reconcile edits whose normalized value is unchanged (for example '!').
  void nextTick(()=>{if(nameInput.value?.$el)nameInput.value.$el.value=id.value;});
}
const modes=ref(/** @type {any[]} */ ([]));
const modesKnown=ref(!roleApi);
const modeFor = (/** @type {string} */ id) => modes.value.find(row => row.profileId === id);
let invocationGeneration=0;
let failedDelete='';
const busy=ref(false), login=ref(false), error=ref(''), pendingDelete=ref(''), pendingRelease=ref(/** @type {any} */ (null));
const form=computed(()=>identityFormRequest(id.value,displayName.value,domains.value));
const validForm=computed(()=>form.value!==null);
const labelError=computed(()=>id.value && !validLabel(displayName.value.trim() || id.value) ? 'Display name contains unsupported characters or is too long.' : '');
const nameError=computed(()=>id.value && !validIdentityName(id.value) ? 'Use 2–40 lowercase letters, numbers and dashes. Start with a letter or number; product and protected names are reserved.' : '');
const isOpen=(/** @type {string} */ name)=>{
  const mode=modeFor(name);return !!mode?.busy || !!mode?.surfaceId || ['human','agent'].includes(mode?.currentMode);
};
function askDelete(/** @type {string} */ name){
  if(isProtectedIdentity(name)){error.value=identityErrorText('IDENTITY_PROTECTED',name);return;}
  if(isOpen(name)){error.value=identityErrorText('IDENTITY_BOUND',name);return;}
  failedDelete='';error.value='';pendingDelete.value=name;
}
function deleteIdentity(){
  if(isProtectedIdentity(pendingDelete.value)){error.value=identityErrorText('IDENTITY_PROTECTED',pendingDelete.value);pendingDelete.value='';return;}
  if(isOpen(pendingDelete.value)){error.value=identityErrorText('IDENTITY_BOUND',pendingDelete.value);pendingDelete.value='';return;}
  void invoke('delete',{id:pendingDelete.value});
}
/** @param {string} method @param {any} [request] */
async function invoke(method,request) {
  if(busy.value)return;
  if(request?.id && isForeignIdentity(request.id)){error.value=identityErrorText('IDENTITY_PROTECTED',request.id);return;}
  const generation=invocationGeneration;
  busy.value=true;error.value=method==='list' ? failedDelete : '';login.value=method==='login';
  if (roleApi) modesKnown.value=false;
  try {
    const api=props.host?.identity;if(!api)throw new Error('IDENTITY_HOST_ABSENT');
    if(method==='delete' && props.beforeDelete)await props.beforeDelete(request.id);
    const result=await (request===undefined?api[method]():api[method](request));
    if(!result.ok)throw new Error(result.code);
    if(method==='delete'){pendingDelete.value='';failedDelete='';}
    if(generation!==invocationGeneration)return;
    const listed=method==='list'?result:await api.list();
    if(generation!==invocationGeneration)return;
    if(!listed.ok)throw new Error(listed.code);rows.value=listed.rows;
    const roleApi = /** @type {any} */(globalThis).metaviewerRoles;
    if (roleApi) {try {const result = await roleApi.choices(); if(generation!==invocationGeneration)return; if (Array.isArray(result)) {
      const programs = typeof roleApi.programs === 'function' ? await roleApi.programs() : [];
      if(generation!==invocationGeneration)return;
      modes.value = [...result, ...(Array.isArray(programs) ? programs : [])];
      modesKnown.value=true;
      for (const program of (Array.isArray(programs) ? programs : [])) if (program.hostXpra && !rows.value.some(row => row.id === program.profileId)) rows.value.push({id:program.profileId,label:program.profileId,browser:'program'});
    }} catch {if(generation!==invocationGeneration)return;error.value = 'Capsule status is unavailable. Previously known states are retained; refresh Identities before opening another capsule.';} }
    if(method==='create'){id.value='';typedName.value='';labelEdited.value=false;label.value='';domains.value='';}
  }catch(reason){
    const diagnostic=identityErrorText(reason instanceof Error ? reason.message : '',request?.id);
    if(method==='delete')failedDelete=diagnostic;
    if(generation===invocationGeneration)error.value=diagnostic;
  }
  finally{if(generation===invocationGeneration){busy.value=false;login.value=false;}}
}
/** @param {string} profileId @param {string} role */
async function openIdentity(profileId,role){
  if(isForeignIdentity(profileId)){error.value=identityErrorText('IDENTITY_PROTECTED',profileId);return;}
  if(busy.value)return;
  if(rows.value.find(r=>r.id===profileId)?.browser==='program') {
    const mode=modeFor(profileId);
    if (mode?.surfaceId) {
      if (mode.currentMode === 'lost') {error.value='Stop lost capsule before reopening this program.';return;}
      if (role !== mode.currentMode) {
        error.value=`This program is still open in ${mode.currentMode} mode. Stop the capsule before opening it in ${role} mode.`;
        return;
      }
      emit('open-identity',{profileId,surfaceId:mode.surfaceId,role:mode.currentMode});
      emit('close');return;
    }
    if(!mode?.available || mode.busy || !mode.binary || !roleApi?.createProgram) {
      error.value='Saved program binary unavailable. Open the program through Add capsule first.';return;
    }
    const generation=invocationGeneration;
    busy.value=true;error.value='';
    try {
      const choice={binary:mode.binary,role};
      if (mode.hostXpra) Object.assign(choice,{hostXpra:true});
      const reply=await (mode.identityBound && roleApi.open ? roleApi.open({profileId,role}) : props.openProgram ? props.openProgram(choice) : roleApi.createProgram(choice));
      if(generation!==invocationGeneration)return;
      if(reply?.ok!==true)throw Object.assign(Error(reply?.code || 'PROGRAM_OPEN_FAILED'),{reason:reply?.reason});
      if (mode.identityBound && roleApi.open) emit('open-identity',{profileId,surfaceId:reply.surfaceId,role});
      emit('close');
    } catch(reason) {
      if(generation!==invocationGeneration)return;
      const failure=/** @type {{reason?:unknown,message?:unknown}} */(reason);
      error.value=typeof failure?.reason === 'string' && failure.reason.trim()
        ? failure.reason : `Program could not be opened: ${typeof failure?.message === 'string' ? failure.message : 'PROGRAM_OPEN_FAILED'}. Try Add capsule to check the program setup.`;
    }
    finally {if(generation===invocationGeneration)busy.value=false;}
    return;
  }
  emit('open-identity',{profileId,role});emit('close');
}
/** @param {string} profileId */
async function copiedIdentity(profileId) {
  copyStatus.value=`Copied stored data to ${profileId}.`;
  await invoke('list');
  selectedSlots.value=profileId;
}
/** @param {string} profileId */
async function stopIdentity(profileId) {
  if (busy.value) return;
  if (isForeignIdentity(profileId)) { error.value=identityErrorText('IDENTITY_PROTECTED',profileId); return; }
  const surfaceId=modeFor(profileId)?.surfaceId;
  if (!surfaceId || !roleApi?.stop) return;
  busy.value=true;error.value='';
  try {
    const reply=await roleApi.stop(surfaceId);
    if (reply?.ok !== true) throw Error(reply?.code || 'CAPSULE_STOP_UNPROVEN');
    busy.value=false;
    await invoke('list');
  } catch (reason) {error.value=identityErrorText(reason instanceof Error ? reason.message : '',profileId);}
  finally {busy.value=false;}
}
// [TARGET, unit decision] Confirmation is host-local; holder is snapshotted
// and rechecked by the tool, never accepted as proof of dead-session custody.
async function releaseIdentity() {
  const choice=pendingRelease.value;
  if (!choice || busy.value) return;
  busy.value=true;error.value='';
  try {
    const reply=await roleApi.releaseIdentity({profileId:choice.profileId,holder:choice.holder});
    if(reply?.ok!==true)throw Error('IDENTITY_RELEASE_REFUSED');
    pendingRelease.value=null;
    busy.value=false;
    await invoke('list');
    copyStatus.value='Identity released. Choose Open as human or Open as agent.';
  } catch {error.value='Release could not be verified. A live session or missing ownership evidence still holds this identity.';}
  finally {busy.value=false;}
}
function create(){if(form.value)void invoke('create',form.value);}
// App owns the marker during normal use. Also cover isolated dialog mounts;
// release only a marker this component installed, leaving other modals alone.
let ownsModal=false;
function syncModal(/** @type {boolean} */ open){
  const body=globalThis.document?.body;if(!body?.setAttribute)return;
  if(open && !body.hasAttribute('data-mv-modal')){body.setAttribute('data-mv-modal','true');ownsModal=true;}
  if(!open && ownsModal){body.removeAttribute('data-mv-modal');ownsModal=false;}
}
watch(()=>props.open,open=>syncModal(open),{immediate:true,flush:'sync'});
onBeforeUnmount(()=>syncModal(false));
watch(()=>props.open,open=>{invocationGeneration++;busy.value=false;login.value=false;pendingRelease.value=null;if(open)void invoke('list');},{immediate:true,flush:'sync'});
// Open and selection props can arrive in either order; select after the props settle.
watch(()=>[props.open,props.initialProfile],([open,profile])=>{if(open)selectedSlots.value=String(profile);},{immediate:true,flush:'post'});
</script>
<template>
  <ConfirmDialog id="identities-dialog" :open="open" title="Identities" description="Accounts and saved data for each capsule" confirm-label="Add identity" back-label="Close" :busy="busy" :confirm-disabled="!validForm" @confirm="create" @back="emit('close')">
    <p v-if="login" role="status">Operator login view is open. Agent input stays refused until it closes.</p>
    <p v-if="!rows.length && !busy">No identities yet. Add your first identity below. No MetaViewer account is needed. For a browser identity, choose Log in to sign in to your site, then Open as human or Open as agent. If login reports a missing profile, ask the host operator to provision it using the reported instructions.</p>
    <ul class="identity-list" aria-label="Saved identities">
      <li v-for="row in rows" :key="row.id" class="identity-row">
        <div class="identity-summary"><code>{{ row.id }}</code><strong>{{ row.label }}</strong>
          <span class="identity-mode">{{ modeFor(row.id)?.currentMode || (row.browser === 'program' ? 'program' : 'closed') }}</span>
          <span v-if="row.browser === 'program' && !busy && !modeFor(row.id)?.available">Saved binary unavailable. Open through Add capsule first.</span>
          <span v-if="row.browser !== 'program'" class="identity-last-login">Last login: {{ modeFor(row.id)?.markerError || (modeFor(row.id)?.lastLogin ? new Date(modeFor(row.id).lastLogin).toLocaleString() : 'Not recorded') }}</span>
        </div>
        <p v-if="modeFor(row.id)?.held" role="status">Still held by a previous session</p>
        <div class="identity-actions">
        <UiButton v-if="modeFor(row.id)?.held" label="Release" :disabled="busy || isForeignIdentity(row.id)" @click="pendingRelease={profileId:row.id,holder:modeFor(row.id).holder}" />
        <UiButton v-if="!roleApi" label="Log in" :disabled="busy || isForeignIdentity(row.id) || row.browser === 'program'" @click="invoke('login',{id:row.id})" />
        <UiButton label="Open as human" :disabled="busy || isForeignIdentity(row.id) || !modeFor(row.id)?.available || !!modeFor(row.id)?.busy || modeFor(row.id)?.currentMode === 'lost'" @click="openIdentity(row.id,'human')" />
        <UiButton label="Open as agent" :disabled="busy || isForeignIdentity(row.id) || !modeFor(row.id)?.available || !!modeFor(row.id)?.busy || modeFor(row.id)?.currentMode === 'lost'" @click="openIdentity(row.id,'agent')" />
        <UiButton v-if="roleApi && modeFor(row.id)?.currentMode === 'lost' && modeFor(row.id)?.surfaceId" label="Stop lost capsule" :disabled="busy || isForeignIdentity(row.id)" @click="stopIdentity(row.id)" />
        <UiButton label="Delete" :disabled="busy || isProtectedIdentity(row.id)" :title="isProtectedIdentity(row.id) ? 'Managed outside MetaViewer' : undefined" @click="askDelete(row.id)" />
        </div>
        <UiButton label="Stored data" :aria-pressed="selectedSlots===row.id" :disabled="busy" @click="selectedSlots=row.id" />
      </li>
    </ul>
    <section class="identity-saved-data" aria-label="Saved data">
      <p v-if="copyStatus" role="status" aria-live="polite">{{ copyStatus }}</p>
      <StoredDataSlots v-if="selectedSlots && rows.some(row=>row.id===selectedSlots)" :key="selectedSlots" :profile-id="selectedSlots" :blocked="busy || !modesKnown || isOpen(selectedSlots)" @copied="copiedIdentity" />
      <p v-if="!selectedSlots && rows.length">Select Stored data on an identity to manage its saved slots.</p>
    </section>
    <section class="identity-add" aria-label="Add identity">
      <h4>Add identity</h4>
      <p><label>Name (required)<UiTextInput ref="nameInput" :model-value="id" @update:model-value="updateName" label="Name" placeholder="work-account" aria-describedby="identity-id-hint identity-name-error" :aria-invalid="!!nameError" :disabled="busy" /></label></p>
      <p v-if="labelError" role="alert">{{ labelError }}</p>
      <p id="identity-id-hint">lowercase letters, numbers and dashes</p>
      <p v-if="id" id="identity-normalized" role="status">Will be saved as {{ id }}</p>
      <p v-if="nameError" id="identity-name-error" role="alert">{{ nameError }}</p>
      <p><label>Display name (optional)<UiTextInput v-model="displayName" label="Display name" :placeholder="typedName || id || 'Work account'" :disabled="busy" /></label></p>
      <details><summary>Advanced</summary>
        <p><label>Allowed sites (optional)<UiTextInput v-model="domains" label="Allowed sites" placeholder="example.com, example.org" aria-describedby="identity-sites-hint" :disabled="busy" /></label></p>
        <p id="identity-sites-hint">Sites this identity may open, for example example.com. Leave empty to allow any site.</p>
      </details>
    </section>
    <p v-if="error" role="alert">{{ error }}</p>
  </ConfirmDialog>
  <ConfirmDialog id="identity-release-dialog" :open="open && !!pendingRelease" title="Release identity?" description="Remove the capsule left by the previous session? A live session will not be stopped. Saved browser data is retained." confirm-label="Release" :busy="busy" @confirm="releaseIdentity" @back="pendingRelease=null" />
  <ConfirmDialog id="identity-delete-dialog" :open="open && !!pendingDelete" title="Delete identity?" :description="`Delete ${pendingDelete} and its saved browser session? This cannot be undone.`" confirm-label="Delete identity" :busy="busy" @confirm="deleteIdentity" @back="pendingDelete=''" />
</template>
<style>
#identities-dialog.s1-confirm-panel{max-width:min(70rem,calc(100vw - 3rem));max-height:calc(100vh - 3rem);overflow:auto;}
.identity-list{list-style:none;padding:0;margin:0;max-height:24vh;overflow:auto;}
.identity-row{flex-wrap:wrap;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0;border-bottom:1px solid var(--cuk-semantic-border-subtle);}
.identity-summary{display:grid;grid-template-columns:minmax(8rem,auto) minmax(8rem,1fr) auto;gap:.4rem 1rem;align-items:baseline;}
.identity-last-login{grid-column:1/-1;color:var(--cuk-semantic-text-muted);}
.identity-mode{font-size:.85em;text-transform:capitalize;}
.identity-actions{display:flex;gap:.5rem;flex-wrap:wrap;}
.identity-add{margin-top:1.25rem;}
.identity-add h4{margin:0;}.identity-add p{margin:.5rem 0;}
.identity-add summary{cursor:pointer;margin-top:1rem;}
#identity-delete-dialog{position:relative;}
@media(max-width:800px){.identity-row{align-items:stretch;flex-direction:column;}.identity-summary{grid-template-columns:1fr auto;}.identity-summary code{grid-column:1/-1;}}
</style>
