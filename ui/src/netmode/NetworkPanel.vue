<script setup>
import { ref, watch } from 'vue';
import { UiButton } from 'capsule-ui-kit/ui';
import ConfirmDialog from '../../.kit/capsule-ui-kit/src/overlays/ConfirmDialog.vue';
import { operatorHost } from '../operatorHost.js';
const props=defineProps({open:{type:Boolean,default:false},displayOnly:{type:Boolean,default:false},capsuleId:{type:String,default:''},identity:{type:String,default:''},refusalCode:{type:String,default:''},host:{type:Object,default:operatorHost}});
const emit=defineEmits(['close','open']);
const mode=ref('open'), domains=ref(''), netMode=ref(''), error=ref(''), busy=ref(false), loaded=ref(false), reason=ref(''), confirmOpen=ref(false);
/** @type {Record<string,string>} */
const reasonWords={binary_missing:'capability binary missing',timeout:'capability probe timed out',oversize:'capability reply too large',malformed:'invalid capability reply',ok:'Open unavailable in declared network modes'};
/** @param {string} value */
function plainReason(value) { return reasonWords[value] ?? (/^exit_/.test(value)?`capability probe exited with status ${value.slice(5)}`:'capability probe unavailable'); }
let generation=0;
/** @param {string} method */
async function request(method, confirm=false) {
  const current=++generation, identity=props.identity;
  busy.value=true;error.value='';if(method==='get'){loaded.value=false;confirmOpen.value=false;}
  try {
    if(!identity || !props.host?.egress)throw new Error();
    const record={schema:'metaviewer.capsule_egress/v1',mode:mode.value,domains:mode.value==='open'?[]:domains.value.split('\n').map(x=>x.trim()).filter(Boolean)};
    const result=await props.host.egress[method](method==='get'?{identity}:{identity,record,...(confirm?{confirm:true}:{})});
    if(current!==generation)return;
    if(!result.ok) {
      confirmOpen.value=result.code==='NET_OPEN_PREREQ';
      error.value=result.code==='NET_PROXIED_UNSUPPORTED'?'NET_PROXIED_UNSUPPORTED: Dedicated proxy requires a deployment with proxied network support.':result.code==='NET_OPEN_PREREQ'?'NET_OPEN_PREREQ: Open requires identity image 0.2.0 and the final OpenSuperficies pin (morning report, step 0).':'Network configuration unavailable.';
      return;
    }
    confirmOpen.value=false;reason.value=result.reason;mode.value=result.record.mode;domains.value=result.record.domains.join('\n');netMode.value=result.net_mode;loaded.value=true;
  }catch{if(current===generation)error.value='Network configuration unavailable: this capsule needs an admitted profile identity and private adapter state.';}
  finally{if(current===generation)busy.value=false;}
}
watch(()=>[mode.value,domains.value],()=>{confirmOpen.value=false;});
watch(()=>[props.open,props.identity],()=>{if(props.open)void request('get');else generation++;},{immediate:true});
</script>
<template>
  <div :hidden="displayOnly" role="toolbar" aria-label="Capsule network actions">
    <UiButton :id="`capsule-network-${capsuleId}`" :data-semantic-anchor="`capsule/${capsuleId}/network`" label="Network" :aria-expanded="open" @click="emit('open')" />
  </div>
  <ConfirmDialog id="capsule-network-dialog" :open="open" title="Network" description="Per capsule; applies on the next start. Open requires identity image 0.2.0 and the final OpenSuperficies pin (morning report, step 0)." confirm-label="Save network" back-label="Close" :busy="busy" :confirm-disabled="!loaded || confirmOpen" @confirm="request('set')" @back="emit('close')">
    <p v-if="refusalCode==='NET_OPEN_PREREQ'" role="alert">NET_OPEN_PREREQ: Open requires identity image 0.2.0 and the final OpenSuperficies pin (morning report, step 0).</p>
    <p v-if="refusalCode==='NET_PROXIED_UNSUPPORTED'" role="alert">NET_PROXIED_UNSUPPORTED: Dedicated proxy requires a deployment with proxied network support.</p>
    <p v-if="netMode==='legacy'" role="status">legacy: {{ plainReason(reason) }}</p>
    <div role="radiogroup" aria-label="Capsule network">
      <label><input v-model="mode" type="radio" value="open" :disabled="busy || !loaded" />Open (default)</label>
      <label><input v-model="mode" type="radio" value="allowlisted" :disabled="busy || !loaded" />Dedicated proxy with allowlist</label>
    </div>
    <label v-if="mode==='allowlisted'">Exact hostnames, one per line (1–256)<textarea v-model="domains" aria-label="Domain allowlist" :disabled="busy || !loaded" /></label>
    <UiButton v-if="confirmOpen" label="Confirm save for next start anyway" :disabled="busy" @click="request('set',true)" />
    <p v-if="confirmOpen">Nothing has been saved. Close to keep the current record, or explicitly confirm saving for a future start once Open is available.</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </ConfirmDialog>
</template>
