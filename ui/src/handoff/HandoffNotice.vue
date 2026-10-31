<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { UiButton } from 'capsule-ui-kit/ui';
import { operatorHost } from '../operatorHost.js';
import { createHandoffModel, describeHandoff } from './handoffModel.js';
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
  try{const off=props.host.handoff.subscribe((/** @type {any} */value)=>{model.receive(value);sync();});if(typeof off==='function')stop=off;await model.load();sync();}
  catch{error.value='Handoff notifications unavailable.';}
});
onBeforeUnmount(()=>{active=false;stop();});
</script>
<template>
  <section v-if="rows.length || error" class="mv-handoff" role="log" aria-label="Operator handoffs">
    <ol v-if="rows.length" class="mv-handoff__list">
    <li v-for="row in rows" :key="`${row.surface_id}:${row.step_index}`" class="mv-handoff__row" data-handoff-tone="refusal">
      <strong>{{ describeHandoff(row).headline }}</strong> — {{ describeHandoff(row).detail }}
      <ol class="mv-handoff__steps"><li v-for="step in describeHandoff(row).steps" :key="step">{{ step }}</li></ol>
      <div class="mv-handoff__actions">
        <UiButton label="Take control" @click="emit('take-control',row.surface_id)" />
        <UiButton label="Acknowledge" @click="acknowledge(row)" />
      </div>
    </li>
    </ol>
    <p v-if="error" class="mv-handoff__error" role="alert">{{ error }}</p>
  </section>
</template>
<style src="./handoff.css"></style>
