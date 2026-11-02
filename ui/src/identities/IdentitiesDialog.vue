<script setup>
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue';
import { UiButton, UiTextInput } from 'capsule-ui-kit/ui';
import ConfirmDialog from '../../.kit/capsule-ui-kit/src/overlays/ConfirmDialog.vue';
import { operatorHost } from '../operatorHost.js';
import { identityErrorText, identityFormRequest, validLabel, validIdentityName, normalizeIdentityName, retainTypedIdentityName } from './identityForm.js';
import { isProtectedIdentity, isForeignIdentity } from '../../electron/identityProtection.js';
const props=defineProps({hideForeign:{type:Boolean,default:false},open:{type:Boolean,default:false},host:{type:Object,default:operatorHost}});
const roleApi = /** @type {any} */(globalThis).metaviewerRoles;
const emit=defineEmits(['close','open-identity']);
const rows=ref(/** @type {any[]} */([])), id=ref(''), label=ref(''), domains=ref('');
// Identities owned by other projects stay in the store, untouched, and are simply not listed here.
const visibleRows=computed(()=>props.hideForeign?rows.value.filter(row=>!isForeignIdentity(row.id)):rows.value);
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
const modeFor = (/** @type {string} */ id) => modes.value.find(row => row.profileId === id);
const busy=ref(false), login=ref(false), error=ref(''), pendingDelete=ref('');
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
  error.value='';pendingDelete.value=name;
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
  busy.value=true;error.value='';login.value=method==='login';
  try {
    const api=props.host?.identity;if(!api)throw new Error('IDENTITY_HOST_ABSENT');
    const result=await (request===undefined?api[method]():api[method](request));
    if(!result.ok)throw new Error(result.code);
    const listed=method==='list'?result:await api.list();
    if(!listed.ok)throw new Error(listed.code);rows.value=listed.rows;
    const roleApi = /** @type {any} */(globalThis).metaviewerRoles;
    if (roleApi) {try {const result = await roleApi.choices(); if (Array.isArray(result)) modes.value = result;} catch {modes.value = [];} }
    if(method==='create'){id.value='';typedName.value='';labelEdited.value=false;label.value='';domains.value='';}
    pendingDelete.value='';
  }catch(reason){error.value=identityErrorText(reason instanceof Error ? reason.message : '',request?.id);}
  finally{busy.value=false;login.value=false;}
}
/** @param {string} profileId @param {string} role */
function openIdentity(profileId,role){
  if(isForeignIdentity(profileId)){error.value=identityErrorText('IDENTITY_PROTECTED',profileId);return;}
  if(rows.value.find(r=>r.id===profileId)?.browser==='program')return;
  emit('open-identity',{profileId,role});emit('close');
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
watch(()=>props.open,open=>{if(open)void invoke('list');},{immediate:true});
</script>
<template>
  <ConfirmDialog id="identities-dialog" :open="open" title="Identities" description="Keep a separate browser session for each account." confirm-label="Add identity" back-label="Close" :busy="busy" :confirm-disabled="!validForm" @confirm="create" @back="emit('close')">
    <p v-if="login" role="status">Operator login view is open. Agent input stays refused until it closes.</p>
    <p v-if="!visibleRows.length && !busy">No identities yet. Add your first identity below.</p>
    <ul class="identity-list" aria-label="Saved identities">
      <li v-for="row in visibleRows" :key="row.id" class="identity-row">
        <div class="identity-summary"><code>{{ row.id }}</code><strong>{{ row.label }}</strong>
          <span class="identity-mode">{{ row.browser === 'program' ? 'program' : (modeFor(row.id)?.currentMode || 'closed') }}</span>
          <span class="identity-last-login">Last login: {{ modeFor(row.id)?.lastLogin ? new Date(modeFor(row.id).lastLogin).toLocaleString() : 'Not recorded' }}</span>
        </div>
        <div class="identity-actions">
        <UiButton v-if="!roleApi" label="Log in" :disabled="busy || isForeignIdentity(row.id) || row.browser === 'program'" @click="invoke('login',{id:row.id})" />
        <UiButton label="Open as human" :disabled="busy || isForeignIdentity(row.id) || row.browser === 'program' || !modeFor(row.id)?.available || !!modeFor(row.id)?.busy" @click="openIdentity(row.id,'human')" />
        <UiButton label="Open as agent" :disabled="busy || isForeignIdentity(row.id) || row.browser === 'program' || !modeFor(row.id)?.available || !!modeFor(row.id)?.busy" @click="openIdentity(row.id,'agent')" />
        <UiButton label="Delete" :disabled="busy || isProtectedIdentity(row.id)" :title="isProtectedIdentity(row.id) ? 'Managed outside MetaViewer' : undefined" @click="askDelete(row.id)" />
        </div>
      </li>
    </ul>
    <section class="identity-add" aria-label="Add identity">
      <h4>Add identity</h4>
      <p><label>Name (required)<UiTextInput ref="nameInput" :model-value="id" @update:model-value="updateName" label="Name" placeholder="work-account" aria-describedby="identity-id-hint identity-name-error" :aria-invalid="!!nameError" :disabled="busy" /></label></p>
      <p v-if="labelError" role="alert">{{ labelError }}</p>
      <p id="identity-id-hint">lowercase letters, numbers and dashes</p>
      <p v-if="id" id="identity-normalized" role="status">Will be saved as {{ id }}</p>
      <p v-if="nameError" id="identity-name-error" role="alert">{{ nameError }}</p>
      <p><label>Display name (optional)<UiTextInput v-model="displayName" label="Display name" :placeholder="typedName || id || 'Work account'" :disabled="busy" /></label></p>
      <details><summary>Advanced</summary>
        <p><label>Allowed sites (optional)<UiTextInput v-model="domains" label="Allowed sites" placeholder="perplexity.ai, example.com" aria-describedby="identity-sites-hint" :disabled="busy" /></label></p>
        <p id="identity-sites-hint">Sites this identity may open, for example perplexity.ai. Leave empty to allow any site.</p>
      </details>
    </section>
    <p v-if="error" role="alert">{{ error }}</p>
  </ConfirmDialog>
  <ConfirmDialog id="identity-delete-dialog" :open="open && !!pendingDelete" title="Delete identity?" :description="`Delete ${pendingDelete} and its saved browser session? This cannot be undone.`" confirm-label="Delete identity" :busy="busy" @confirm="deleteIdentity" @back="pendingDelete=''" />
</template>
<style>
#identities-dialog.s1-confirm-panel{max-width:min(70rem,calc(100vw - 3rem));max-height:calc(100vh - 3rem);overflow:auto;}
.identity-list{list-style:none;padding:0;margin:0;max-height:35vh;overflow:auto;}
.identity-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0;border-bottom:1px solid var(--cuk-semantic-border-subtle);}
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
