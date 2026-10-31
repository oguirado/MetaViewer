<script setup>
import {ref,computed,watch,onUnmounted} from 'vue';
import {UiButton,UiTextInput} from 'capsule-ui-kit/ui';
import ConfirmDialog from '../../.kit/capsule-ui-kit/src/overlays/ConfirmDialog.vue';
import {operatorHost} from '../operatorHost.js';
const props=defineProps({open:{type:Boolean,default:false},host:{type:Object,default:operatorHost}});
const emit=defineEmits(['close']);
const rows=ref(/** @type {any[]} */([])),identity=ref(''),demo=ref(''),site=ref('');
const busy=ref(false),recording=ref(false),sealed=ref(''),url=ref(''),message=ref('');
// Ids mirror the host grammar (preload buttonId): demo <= 40, site <= 64; demo ids are single-use.
const ID=/^[a-z0-9][a-z0-9-]*$/,used=ref(/** @type {string[]} */([]));
const demoId=computed(()=>demo.value.trim()),siteId=computed(()=>site.value.trim());
const demoOk=computed(()=>demoId.value.length>0 && demoId.value.length<=40 && ID.test(demoId.value));
const siteOk=computed(()=>siteId.value.length>0 && siteId.value.length<=64 && ID.test(siteId.value));
const hint=computed(()=>{
  if(demo.value && !demoOk.value)return 'Demo id: use lowercase letters, digits and hyphens (up to 40), starting with a letter or digit.';
  if(site.value && !siteOk.value)return 'Site: use lowercase letters, digits and hyphens (up to 64), starting with a letter or digit.';
  if(demoOk.value && used.value.includes(demoId.value))return 'This demo id was already recorded: choose a new one.';
  return '';
});
const PUBLIC={
  DEMO_BUSY:'Another demo operation is still running.',
  DEMO_NOT_RECORDING:'No recording is running.',
  BUTTON_UNAVAILABLE:'The demo tool is unavailable: check that MV_OPERATOR_REPO points to the operator checkout.',
};
const REFUSED={
  start:'Start refused. Choose an unused demo id and an identity whose capsule is running.',
  stop:'The recording could not be sealed. Start again with a new demo id.',
  prompt:'Prompt refused. Record and stop this demo first, then check the MemoryWeb configuration.',
  check:'Check failed. The site folder must exist in the MemoryWeb home and pass the MemoryWeb index check.',
};
/** @param {string} verb @param {string} code */
const refusal=(verb,code)=>`${code}: ${/** @type {Record<string,string>} */(PUBLIC)[code]??/** @type {Record<string,string>} */(REFUSED)[verb]}`;
let unmounted=false;
onUnmounted(()=>{unmounted=true;if(recording.value)void props.host?.demo.stop().catch(()=>{});});
watch(()=>props.open,async open=>{
  if(!open)return;
  rows.value=[];message.value='';
  try{
    if(!props.host?.identity)throw new Error('IDENTITY_HOST_ABSENT');
    const result=await props.host.identity.list();if(!result.ok)throw new Error(result.code);
    rows.value=result.rows;
    if(!rows.value.length)message.value='No identities yet: create one in Identities first';
  }catch(reason){message.value=`The identity tool could not run: ${reason instanceof Error ? reason.message : 'AUSENTE — no reason supplied'}`;}
},{immediate:true});
/** @param {string} verb */
async function invoke(verb) {
  if(busy.value)return;
  busy.value=true;message.value='';
  try {
    const args=verb==='start'?[{identity:identity.value,demo:demoId.value}]:verb==='stop'?[]:verb==='prompt'?[{demo:demoId.value,site:siteId.value}]:[{site:siteId.value}];
    const result=await props.host?.demo[verb](...args);
    if(verb==='stop'){recording.value=false;url.value='';sealed.value='';}
    if(!result.ok){message.value=refusal(verb,result.code);return;}
    if(verb==='start'){if(unmounted){void props.host?.demo.stop().catch(()=>{});return;}recording.value=true;sealed.value='';url.value=result.url;used.value=[...used.value,demoId.value];}
    if(verb==='stop'){recording.value=false;sealed.value=demoId.value;url.value='';}
    message.value=verb==='prompt'?'Copied. Paste the prompt into your AI, then use Check site.':verb==='check'?'Site check: ok':verb==='stop'?`Recording saved to ~/.local/state/metaviewer/demos/${sealed.value} (or $XDG_STATE_HOME/metaviewer/demos/${sealed.value}). Private files: typed text is kept as length only; frames can show field contents.`:'Recording. Open the viewer URL to demonstrate, then press Stop.';
  }catch{message.value='Demo operation unavailable.';}
  finally{busy.value=false;}
}
</script>
<template>
  <ConfirmDialog class="mv-demo-dialog" id="demo-dialog" :open="open" title="Automate from a demo" description="Log in yourself before recording. Use dummy data: frames can show field contents. Recorded text contains lengths only." confirm-label="Close" back-label="Close" :confirm-disabled="busy || recording" :busy="busy" @confirm="!recording && emit('close')" @back="!recording && !busy && emit('close')">
    <p><label>Identity
      <select id="demo-identity" data-semantic-anchor="demo/identity" v-model="identity" :disabled="busy || recording" aria-label="Identity"><option value="" disabled>Choose an identity</option><option v-for="row in rows" :key="row.id" :value="row.id">{{ row.label }} ({{ row.id }})</option></select>
    </label></p>
    <p><label>Demo id<UiTextInput v-model="demo" label="Demo id" placeholder="pplx-ask-1" :disabled="busy || recording" /></label></p>
    <p><label>Site<UiTextInput v-model="site" label="Site name" placeholder="perplexity" :disabled="busy || recording" /></label></p>
    <UiButton id="demo-start" data-semantic-anchor="demo/start" label="Start" :disabled="busy || recording || !identity || !demoOk || used.includes(demoId)" @click="invoke('start')" />
    <UiButton id="demo-stop" data-semantic-anchor="demo/stop" label="Stop" :disabled="busy || !recording" @click="invoke('stop')" />
    <p v-if="url">Viewer URL: <a :href="url" target="_blank" rel="noreferrer">{{ url }}</a></p>
    <UiButton id="demo-prompt" data-semantic-anchor="demo/prompt" label="Copy prompt" :disabled="busy || recording || sealed!==demoId || !sealed || !siteOk" @click="invoke('prompt')" />
    <UiButton id="demo-check" data-semantic-anchor="demo/check" label="Check site" :disabled="busy || recording || !siteOk" @click="invoke('check')" />
    <p v-if="hint" id="demo-hint">{{ hint }}</p>
    <p role="status" aria-live="polite">{{ message }}</p>
  </ConfirmDialog>
</template>

<style scoped>
/* The kit confirmation pair keeps its Escape/back handler; expose one Close action. */
.mv-demo-dialog :deep(#demo-dialog-back) { display: none; }
</style>
