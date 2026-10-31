<script setup>
import { ref, watch } from 'vue';
import { UiButton, UiTextInput } from 'capsule-ui-kit/ui';
import ConfirmDialog from '../../.kit/capsule-ui-kit/src/overlays/ConfirmDialog.vue';
import { operatorHost } from '../operatorHost.js';
import { allowlistProblem, hostHasEgress, legacyExplanation, parseAllowlist, plainReason, refusalText, storedAllowlistWarning } from './networkCopy.js';
const props=defineProps({open:{type:Boolean,default:false},displayOnly:{type:Boolean,default:false},capsuleId:{type:String,default:''},identity:{type:String,default:''},refusalCode:{type:String,default:''},host:{type:Object,default:operatorHost}});
const emit=defineEmits(['close','open']);
const mode=ref('open'), domains=ref(''), netMode=ref(''), error=ref(''), busy=ref(false), loaded=ref(false), reason=ref(''), stored=ref(''), confirmOpen=ref(false), saved=ref(false);
let generation=0, applied='';
/** @param {string} method */
async function request(method, confirm=false) {
  const current=++generation, identity=props.identity;
  busy.value=true;error.value='';saved.value=false;
  if(method==='get'){loaded.value=false;confirmOpen.value=false;netMode.value='';reason.value='';stored.value='';mode.value='open';domains.value='';applied=JSON.stringify(['open','']);}
  try {
    if(!identity){error.value='Network configuration unavailable: this capsule has no admitted profile identity.';return;}
    if(!hostHasEgress(props.host,method)){error.value='Network configuration unavailable: this build has no operator network channel.';return;}
    /** @type {Record<string,unknown>} */
    let payload={identity};
    if(method==='set'){
      const list=mode.value==='open'?[]:parseAllowlist(domains.value), problem=mode.value==='open'?'':allowlistProblem(list);
      if(problem){error.value=problem;return;}
      payload={identity,record:{schema:'metaviewer.capsule_egress/v1',mode:mode.value,domains:list},...(confirm?{confirm:true}:{})};
    }
    const result=await /** @type {any} */ (props.host).egress[method](payload);
    if(current!==generation)return;
    if(!result.ok) {
      confirmOpen.value=method==='set' && result.code==='NET_OPEN_PREREQ';
      error.value=refusalText(result.code,netMode.value==='legacy'?reason.value:undefined);
      return;
    }
    confirmOpen.value=false;reason.value=result.reason;mode.value=result.record.mode;domains.value=result.record.domains.join(', ');applied=JSON.stringify([mode.value,domains.value]);netMode.value=result.net_mode;stored.value=result.record.mode;loaded.value=true;saved.value=method==='set';
  }catch{if(current===generation)error.value='Network configuration request failed before the adapter answered; nothing was saved.';}
  finally{if(current===generation)busy.value=false;}
}
/** @param {string} next */
function choose(next){if(!busy.value&&loaded.value)mode.value=next;}
watch(()=>[mode.value,domains.value],()=>{if(JSON.stringify([mode.value,domains.value])!==applied){confirmOpen.value=false;saved.value=false;}});
watch(()=>[props.open,props.identity],()=>{if(props.open)void request('get');else generation++;},{immediate:true});
</script>
<template>
  <div :hidden="displayOnly" role="toolbar" aria-label="Capsule network actions">
    <UiButton :id="`capsule-network-${capsuleId}`" :data-semantic-anchor="`capsule/${capsuleId}/network`" label="Network" :aria-expanded="open" @click="emit('open')" />
  </div>
  <ConfirmDialog id="capsule-network-dialog" :open="open" title="Network" description="Per capsule; applies on the next start." confirm-label="Save network" back-label="Close" :busy="busy" :confirm-disabled="!loaded || confirmOpen" @confirm="request('set')" @back="emit('close')">
    <p v-if="refusalCode==='NET_OPEN_PREREQ'" role="alert">NET_OPEN_PREREQ: Open requires identity image 0.2.0 and the final OpenSuperficies pin (morning report, step 0).</p>
    <p v-if="refusalCode==='NET_PROXIED_UNSUPPORTED'" role="alert">NET_PROXIED_UNSUPPORTED: Dedicated proxy requires a deployment with proxied network support.</p>
    <template v-if="netMode==='legacy'">
      <p role="status">legacy: {{ plainReason(reason) }}</p>
      <p data-netcopy="legacy-explanation">{{ legacyExplanation(reason) }}</p>
      <p v-if="stored==='allowlisted'" role="alert" data-netcopy="stored-allowlist">{{ storedAllowlistWarning }}</p>
    </template>
    <div role="group" aria-label="Capsule network">
      <UiButton label="Open (default)" :intent="mode==='open'?'primary':'neutral'" :aria-pressed="mode==='open'" :disabled="busy || !loaded" @click="choose('open')" />
      <UiButton label="Dedicated proxy with allowlist" :intent="mode==='allowlisted'?'primary':'neutral'" :aria-pressed="mode==='allowlisted'" :disabled="busy || !loaded" @click="choose('allowlisted')" />
    </div>
    <p v-if="mode==='allowlisted'"><label>Exact hostnames, separated by commas or spaces (1–256)<UiTextInput v-model="domains" label="Domain allowlist" :disabled="busy || !loaded" /></label></p>
    <UiButton v-if="confirmOpen" label="Confirm save for next start anyway" :disabled="busy" @click="request('set',true)" />
    <p v-if="confirmOpen">Nothing has been saved. Close to keep the current record, or explicitly confirm saving for a future start once Open is available.</p>
    <p v-if="saved" role="status">Saved. Applies on the next start of this capsule.</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </ConfirmDialog>
</template>
