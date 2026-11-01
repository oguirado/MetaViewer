<script setup>
import { computed, ref, watch } from 'vue';
import { UiButton, UiTextInput } from 'capsule-ui-kit/ui';
import ConfirmDialog from '../../.kit/capsule-ui-kit/src/overlays/ConfirmDialog.vue';
import { operatorHost } from '../operatorHost.js';
import { identityErrorText, normalizeDomains, validDomains, validLabel } from './identityForm.js';
const props=defineProps({open:{type:Boolean,default:false},host:{type:Object,default:operatorHost}});
const roleApi = /** @type {any} */(globalThis).metaviewerRoles;
const emit=defineEmits(['close','open-identity']);
const rows=ref(/** @type {any[]} */([])), id=ref(''), label=ref(''), domains=ref('');
const modes=ref(/** @type {any[]} */ ([]));
const modeFor = (/** @type {string} */ id) => modes.value.find(row => row.profileId === id);
const busy=ref(false), login=ref(false), error=ref(''), pendingDelete=ref('');
const validId=computed(()=>/^[a-z0-9][a-z0-9-]{1,39}$/.test(id.value));
const cleanLabel=computed(()=>label.value.trim());
const cleanDomains=computed(()=>normalizeDomains(domains.value));
const validForm=computed(()=>validId.value && validLabel(cleanLabel.value) && validDomains(cleanDomains.value));
/** @param {string} method @param {any} [request] */
async function invoke(method,request) {
  if(busy.value)return;
  busy.value=true;error.value='';login.value=method==='login';
  try {
    const api=props.host?.identity;if(!api)throw new Error('IDENTITY_HOST_ABSENT');
    const result=await (request===undefined?api[method]():api[method](request));
    if(!result.ok)throw new Error(result.code);
    const listed=method==='list'?result:await api.list();
    if(!listed.ok)throw new Error(listed.code);rows.value=listed.rows;
    const roleApi = /** @type {any} */(globalThis).metaviewerRoles;
    if (roleApi) { const result = await roleApi.choices(); if (Array.isArray(result)) modes.value = result; }
    if(method==='create'){id.value='';label.value='';domains.value='';}
    pendingDelete.value='';
  }catch(reason){error.value=identityErrorText(reason instanceof Error ? reason.message : '',request?.id);}
  finally{busy.value=false;login.value=false;}
}
function create(){if(!validForm.value)return;void invoke('create',{id:id.value,label:cleanLabel.value,domains:cleanDomains.value});}
watch(()=>props.open,open=>{if(open)void invoke('list');},{immediate:true});
</script>
<template>
  <ConfirmDialog id="identities-dialog" :open="open" title="Identities" description="Several accounts per site are allowed. Enter credentials only in the operator login view." confirm-label="Create identity" back-label="Close" :busy="busy" :confirm-disabled="!validForm" @confirm="create" @back="emit('close')">
    <p v-if="login" role="status">Operator login view is open. Agent input stays refused until it closes.</p>
    <ul aria-label="Saved identities">
      <li v-for="row in rows" :key="row.id">
        {{ row.label }} ({{ row.id }}) — {{ row.domains.join(', ') }} — Mode: {{ modeFor(row.id)?.currentMode || 'closed' }} — Last login: {{ modeFor(row.id)?.lastLogin ? new Date(modeFor(row.id).lastLogin).toLocaleString() : 'Not confirmed' }}
        <UiButton v-if="!roleApi" label="Log in" :disabled="busy" @click="invoke('login',{id:row.id})" />
        <UiButton label="Open as human" :disabled="busy || !modeFor(row.id)?.available || !!modeFor(row.id)?.busy" @click="emit('open-identity',{profileId:row.id,role:'human'}); emit('close')" />
        <UiButton label="Open as agent" :disabled="busy || !modeFor(row.id)?.available || !!modeFor(row.id)?.busy" @click="emit('open-identity',{profileId:row.id,role:'agent'}); emit('close')" />
        <UiButton label="Delete" :disabled="busy" @click="pendingDelete=row.id" />
      </li>
    </ul>
    <p><label>Identity id<UiTextInput v-model="id" label="Identity id" placeholder="perplexity-main" aria-describedby="identity-id-hint" /></label></p>
    <p id="identity-id-hint">2–40 chars: a–z/0–9 first, then a–z/0–9/-.</p>
    <p><label>Label<UiTextInput v-model="label" label="Account label" placeholder="Perplexity main" /></label></p>
    <p><label>Domains (comma separated)<br /><UiTextInput v-model="domains" label="Domains (comma separated)" placeholder="perplexity.ai" /></label></p>
    <p v-if="error" role="alert">{{ error }}</p>
  </ConfirmDialog>
  <ConfirmDialog id="identity-delete-dialog" :open="!!pendingDelete" title="Delete identity?" :description="pendingDelete" confirm-label="Delete identity" :busy="busy" @confirm="invoke('delete',{id:pendingDelete})" @back="pendingDelete=''" />
</template>
