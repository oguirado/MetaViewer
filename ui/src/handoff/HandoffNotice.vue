<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { UiButton } from 'capsule-ui-kit/ui';
import { operatorHost } from '../operatorHost.js';
import { createHandoffModel } from './handoffModel.js';
const props=defineProps({host:{type:Object,default:operatorHost}});
const emit=defineEmits(['activity','take-control']);
const rows=ref(/** @type {any[]} */([])), error=ref('');
const model=createHandoffModel(props.host?.handoff,row=>emit('activity',{code:'CAPTCHA_HANDOFF',...row}));
let active=true;
/** @type {()=>void} */ let stop=()=>{};
function sync(){if(active)rows.value=model.rows();}
/** @param {any} row */
async function acknowledge(row){try{await model.acknowledge(row);error.value='';}catch{error.value='Acknowledgement could not be saved. The notice stays visible.';}sync();}
onMounted(async()=>{
  if(!props.host?.handoff)return;
  try{stop=props.host.handoff.subscribe((/** @type {any} */value)=>{model.receive(value);sync();});await model.load();sync();}
  catch{error.value='Handoff notifications unavailable.';}
});
onBeforeUnmount(()=>{active=false;stop();});
</script>
<template>
  <section v-if="rows.length || error" class="mv-activity" role="log" aria-label="Operator handoffs">
    <ol class="mv-activity__list">
    <li v-for="row in rows" :key="`${row.surface_id}:${row.step_index}`" class="mv-activity__row">
      CAPTCHA or bot check: solve it in the capsule, then re-run — {{ row.surface_id }}, step {{ row.step_index }}: {{ row.reason }} ({{ row.evidence_kinds.join(', ') }})
      <UiButton label="Take control" @click="emit('take-control',row.surface_id)" />
      <UiButton label="Acknowledge" @click="acknowledge(row)" />
    </li>
    </ol>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
