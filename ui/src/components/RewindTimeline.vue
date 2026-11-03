<script setup>
import {computed,ref,onMounted,onUnmounted,watch} from 'vue';
import {rewindAction,rewindSnapshot} from '../../electron/rewindValues.js';
const props=defineProps({snapshot:{type:Object,default:null},guest:{type:Object,required:true}});
const emit=defineEmits(['action']);
const label=ref(''),elapsed=ref(0);
/** @type {ReturnType<typeof setInterval>|null} */ let timer=null;
let observed=0;
watch(()=>props.snapshot,()=>{observed=performance.now();elapsed.value=0;},{immediate:true});
onMounted(()=>{timer=setInterval(()=>{elapsed.value=Math.max(0,performance.now()-observed);},1000);});
onUnmounted(()=>{if(timer!==null)clearInterval(timer);});
const state=computed(()=>rewindSnapshot(props.snapshot)?props.snapshot:null);
const session=computed(()=>state.value?.session);
const phase=computed(()=>session.value?.phase??props.guest?.session?.phase??'initializing');
const blocked=computed(()=>!state.value?.available||state.value.busy||props.guest?.busy||props.guest?.uncertain);
const target=()=>({workload_id:session.value?.workload_id??props.guest?.session?.workload_id,generation:session.value?.generation??props.guest?.session?.generation,authority_epoch:session.value?.authority_epoch??1});
/** @param {string} op @param {Record<string,any>} [extra] */
function action(op,extra={}){const value={op,...target(),...extra};if(rewindAction(value))emit('action',value);}
/** @param {any} point */
function age(point){const initial=state.value?.point_ages_ms?.[point.point_id];return initial===null||initial===undefined?'Age unavailable':`${Math.floor((initial+elapsed.value)/1000)} s ago`;}
</script>
<template>
 <section v-if="state?.available" class="rewind-timeline" aria-label="MicroVM rewind" data-semantic-anchor="capsule/microvm/rewind">
  <header><h3>Rewind</h3><strong role="status" aria-live="polite">{{ phase==='restoring'?'Rewinding…':phase }}</strong></header>
  <p>Full memory checkpoints include the guest’s RAM workspace. External effects are not rewound.</p>
  <p v-if="session?.guest_counter!==null&&session?.guest_counter!==undefined" data-testid="rewind-counter">Last confirmed guest counter: {{ session.guest_counter }}</p>
  <div class="rewind-controls">
   <button type="button" :disabled="blocked||state.uncertain||phase!=='ready'" data-semantic-anchor="capsule/microvm/rewind/pause" @click="action('pause')">Pause</button>
   <button type="button" :disabled="blocked||state.uncertain||phase!=='paused'" data-semantic-anchor="capsule/microvm/rewind/resume" @click="action('resume')">Resume</button>
   <label>Checkpoint label <input v-model="label" maxlength="80" :disabled="blocked" placeholder="Optional label" /></label>
   <button type="button" :disabled="blocked||state.uncertain||!['ready','paused'].includes(phase)||!rewindAction({op:'mark',...target(),label})" data-semantic-anchor="capsule/microvm/rewind/mark" @click="action('mark',{label})">Mark</button>
  </div>
  <ol aria-label="RAM checkpoints">
   <li v-for="point in session?.points??[]" :key="point.point_id">
    <div><strong>{{ point.label||`Checkpoint ${point.created_order}` }}</strong><span>{{ age(point) }} · Guest counter {{ point.counter_value??'unknown' }}</span><small v-if="point.active_references">Memory retained by the current MicroVM</small></div>
    <button type="button" :disabled="blocked||!['ready','paused','recoverable'].includes(phase)||point.status!=='usable'||(phase==='recoverable'&&point.point_id!==session.last_good_usable)||(state.uncertain&&phase!=='recoverable')" :aria-label="`Rewind to ${point.label||'checkpoint '+point.created_order}`" data-semantic-anchor="capsule/microvm/rewind/restore" @click="action('restore',{point_id:point.point_id})">Rewind here</button>
   </li>
  </ol>
  <p v-if="!session?.points?.length">No checkpoints yet. Mark creates a checkpoint in the bounded RAM ring.</p>
  <p v-if="state.uncertain||phase==='recoverable'" role="alert">Restore was not confirmed. {{ session?.last_good_usable?'The last verified checkpoint is retained.':'Ownership is retained.' }} {{ phase==='recoverable'?'The failed native attempt is closed. Choose a retained checkpoint to try a new restore.':'Stop to reconcile resources before another action.' }}</p>
  <p v-if="state.code" role="alert">{{ state.code }}</p>
 </section>
</template>
<style scoped>
.rewind-timeline{border:1px solid var(--cuk-semantic-border-default,#64748b);border-radius:.7rem;padding:1rem;margin:1rem 0}.rewind-timeline header,.rewind-controls,li{display:flex;gap:.7rem;align-items:center;justify-content:space-between;flex-wrap:wrap}.rewind-controls label{display:grid;gap:.3rem;flex:1;min-width:10rem}h3{margin:0}ol{padding:0;list-style:none}li{padding:.7rem 0;border-top:1px solid #8885}li div{display:grid;gap:.25rem}span,small{font-size:.85rem}button,input{font:inherit;padding:.5rem}button:disabled{opacity:.5}button:focus-visible,input:focus-visible{outline:3px solid Highlight;outline-offset:3px}
</style>
