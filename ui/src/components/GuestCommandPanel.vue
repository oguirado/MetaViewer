<script setup>
import {computed,ref} from 'vue';
import {gcSnapshot,gcAction} from '../../electron/guestCommandValues.js';
const props=defineProps({snapshot:{type:Object,required:true}});
const emit=defineEmits(['action']);
const command=ref('uname -m'),cwd=ref('');
const state=computed(()=>gcSnapshot(props.snapshot)?props.snapshot:{available:false,busy:false,canCancel:false,uncertain:true,code:'INVALID_STATE',session:null,stdout:'',stderr:''}),session=computed(()=>state.value.session);
const target=()=>({workload_id:session.value?.workload_id,generation:session.value?.generation});
const runAction=()=>({op:'run',...target(),command_utf8:command.value,cwd:cwd.value,stdin_b64:'',timeout_ms:30000});
const canRun=computed(()=>session.value?.phase==='ready'&&!state.value.uncertain&&!state.value.busy&&gcAction(runAction()));
function run(){if(canRun.value)emit('action',runAction());}
function cancel(){if(state.value.canCancel)emit('action',{op:'cancel',...target(),job_id:session.value.job.job_id});}
function stop(){if(session.value?.ownership==='held'&&!session.value.controls?.stop)emit('action',{op:'stop',...target()});}
</script>
<template>
 <section class="guest-command-panel" aria-labelledby="guest-command-title" data-semantic-anchor="capsule/microvm/commands">
  <header><div><small>ARM64 MicroVM</small><h2 id="guest-command-title">Guest commands</h2></div><strong>{{ state.uncertain?'Outcome unknown':session?.phase??'Creating' }}</strong></header>
  <p>Commands run inside the guest. This is a command log, not an interactive terminal.</p>
  <p role="status" aria-live="polite">{{ session?.ownership==='released'?'Stopped — native closure confirmed.':state.uncertain?'Ownership retained. Stop to reconcile the workload.':'Owned by this session.' }}</p>
  <form @submit.prevent="run"><label for="guest-command">Command</label><textarea id="guest-command" v-model="command" rows="3" spellcheck="false" :disabled="!canRun && state.busy" /><label for="guest-cwd">Working directory (relative to guest workspace)</label><input id="guest-cwd" v-model="cwd" :disabled="state.busy" placeholder="Workspace root" /><button type="submit" :disabled="!canRun">Run command</button></form>
  <div class="controls"><button type="button" :disabled="!state.canCancel" @click="cancel">Cancel command</button><button type="button" :disabled="session?.ownership!=='held'||session?.controls?.stop" @click="stop">Stop capsule</button></div>
  <h3>Standard output</h3><pre data-testid="guest-stdout">{{ state.stdout }}</pre><h3>Standard error</h3><pre data-testid="guest-stderr">{{ state.stderr }}</pre>
  <p v-if="session?.job">Job: {{ session.job.state }} · Exit: {{ session.job.exit_code??'—' }} · Signal: {{ session.job.signal??'—' }} · Output {{ session.job.output_complete?'complete':'not confirmed complete' }}</p>
  <p v-if="state.code" role="alert">{{ state.code }}</p>
 </section>
</template>
<style scoped>
.guest-command-panel{position:relative;width:100%;height:100%;box-sizing:border-box;padding:1.5rem;overflow:auto;border:1px solid var(--cuk-semantic-border-default,#64748b);border-radius:1rem;background:var(--cuk-semantic-surface-canvas,Canvas);color:var(--cuk-semantic-text-primary,CanvasText);box-shadow:0 1rem 3rem #0003}header,.controls{display:flex;justify-content:space-between;gap:1rem}h2{margin:.3rem 0}form{display:grid;gap:.6rem}button,input,textarea{font:inherit;padding:.6rem}textarea,pre{font-family:monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;min-height:2rem;max-height:14rem;overflow:auto;border:1px solid #8885;padding:.7rem}button:disabled{opacity:.5}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid Highlight;outline-offset:3px}@media(max-width:650px){header{display:block}}
</style>
