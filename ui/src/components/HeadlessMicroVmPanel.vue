<script setup>
import {computed,ref} from 'vue';
import {validN,validSnapshot} from '../../electron/headlessValues.js';
const props=defineProps({snapshot:{type:Object,required:true}});
const emit=defineEmits(['run','stop']);
const n=ref('10');
const state=computed(()=>validSnapshot(props.snapshot)?props.snapshot:null);
const session=computed(()=>state.value?.session);
const number=computed(()=>/^\d{1,5}$/.test(n.value)?Number(n.value):NaN);
const canRun=computed(()=>state.value && !state.value.busy && !state.value.uncertain && session.value?.phase==='ready' && session.value.job===null && validN(number.value));
const canStop=computed(()=>state.value && !state.value.busy && session.value?.ownership==='held' && (state.value.uncertain || ['ready','completed','uncertain'].includes(session.value.phase)));
function run(){if(canRun.value)emit('run',number.value);}
function stop(){if(canStop.value)emit('stop');}
</script>
<template>
  <section class="headless-panel" aria-labelledby="headless-title" data-semantic-anchor="capsule/microvm">
    <header><div><small>ARM64 MicroVM</small><h2 id="headless-title">Fixed guest command check</h2></div><strong>{{ state?.uncertain ? 'Outcome unknown' : session?.phase ?? (state?.busy ? 'Creating' : 'Not created') }}</strong></header>
    <p>Compute the sum of squares from 1 to n. One job per capsule; no shell or desktop.</p>
    <p role="status" aria-live="polite">{{ state?.busy ? 'Waiting for core confirmation…' : state?.uncertain ? 'Ownership retained. Confirm Stop before another workload.' : session?.ownership==='released' ? 'Stopped — backend closure confirmed.' : session ? 'Owned by this session.' : 'No confirmed workload yet.' }}</p>
    <form @submit.prevent="run">
      <label for="headless-n">n (0–10000)</label>
      <input id="headless-n" v-model="n" inputmode="numeric" :disabled="!session || session.phase!=='ready' || state?.busy || state?.uncertain" />
      <button data-semantic-anchor="capsule/microvm/run" type="submit" :disabled="!canRun">Run fixed command</button>
    </form>
    <output v-if="session?.job?.status==='completed'" aria-live="polite">SUMSQ({{ session.job.n }}) = {{ session.job.value }}</output>
    <p v-if="state?.code" role="alert">{{ state.code }}</p>
    <button data-semantic-anchor="capsule/microvm/stop" type="button" :disabled="!canStop" @click="stop">Stop capsule</button>
  </section>
</template>
<style scoped>
.headless-panel{position:fixed;z-index:30;inset:18% max(1rem,20%) auto;padding:1.5rem;border:1px solid var(--cuk-semantic-border-default,#64748b);border-radius:1rem;background:var(--cuk-semantic-surface-canvas,Canvas);color:var(--cuk-semantic-text-primary,CanvasText);box-shadow:0 1rem 3rem #0003;max-height:70vh;overflow:auto}
header{display:flex;align-items:start;justify-content:space-between;gap:1rem}h2{margin:.3rem 0}small{letter-spacing:.08em}form{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin:1.25rem 0}input{max-width:7rem}button,input{font:inherit;padding:.6rem .8rem}button:focus-visible,input:focus-visible{outline:3px solid Highlight;outline-offset:3px}output{display:block;font:600 1.4rem monospace;margin:1rem 0}button:disabled{opacity:.5}@media(max-width:600px){.headless-panel{inset:12% 1rem auto}header{display:block}}
</style>
