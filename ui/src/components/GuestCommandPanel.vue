<script setup>
import {computed,ref,watch,onMounted,onUnmounted} from 'vue';
import {gcSnapshot,gcAction,gcObservationSnapshot} from '../../electron/guestCommandValues.js';
import {rewindHeaderCapabilities,rewindHeaderRestoreAction} from '../wall/rewindStateControls.js';
import {createRestoreDuration} from '../wall/restoreDuration.js';
const props=defineProps({snapshot:{type:Object,required:true},rewind:{type:Object,default:null},rewindPanel:{type:[Object,Function],default:null}});
const emit=defineEmits(['action','rewind-action']);
const command=ref('uname -m'),cwd=ref('');
const observation=ref(/** @type {any} */(null));
/** @type {(()=>void)|null} */ let stopObservation=null;
const transcript=computed(()=>observation.value?.active??observation.value?.history.at(-1)??null);
const headerCapabilities=computed(()=>rewindHeaderCapabilities(props.rewind,props.snapshot));
/** @param {string} point_id */
function restorePoint(point_id){const value=rewindHeaderRestoreAction(props.rewind,props.snapshot,point_id);if(value){restoreDuration.begin(value,props.rewind,props.snapshot);restoreMilliseconds.value=null;emit('rewind-action',value);}}
const restoreDuration=createRestoreDuration(),restoreMilliseconds=ref(/** @type {number|null} */(null));
watch([()=>props.rewind,()=>props.snapshot],()=>{restoreMilliseconds.value=restoreDuration.observe(props.rewind,props.snapshot);},{flush:'sync',deep:true});
const ageElapsed=ref(/** @type {number|null} */(0));
/** @type {number|null} */ let ageObserved=null;
/** @type {ReturnType<typeof setInterval>|null} */ let ageTimer=null;
watch(()=>props.rewind,()=>{const now=performance.now();ageObserved=Number.isFinite(now)&&now>=0?now:null;ageElapsed.value=ageObserved===null?null:0;},{immediate:true});
function updateAge(){const now=performance.now(),delta=ageObserved===null?NaN:Math.floor(now-ageObserved);ageElapsed.value=Number.isSafeInteger(delta)&&delta>=0?delta:null;}
onMounted(()=>{ageTimer=setInterval(updateAge,1000);const api=/** @type {any} */(globalThis.window)?.metaviewer?.guestCommand;if(typeof api?.onObservation==='function')stopObservation=api.onObservation((/** @type {any} */ value)=>{if(gcObservationSnapshot(value))observation.value=value;});});
onUnmounted(()=>{restoreDuration.clear();stopObservation?.();stopObservation=null;if(ageTimer!==null)clearInterval(ageTimer);ageTimer=null;});
/** @param {number|null} age */
const pointAge=age=>{const elapsed=ageElapsed.value;if(age===null||elapsed===null||!Number.isSafeInteger(age)||age<0||!Number.isSafeInteger(age+elapsed))return 'Age unavailable';return `${Math.floor((age+elapsed)/1000)} s ago`;};
const state=computed(()=>gcSnapshot(props.snapshot)?props.snapshot:{available:false,busy:false,canCancel:false,uncertain:true,code:'INVALID_STATE',session:null,stdout:'',stderr:''}),session=computed(()=>state.value.session);
const target=()=>({workload_id:session.value?.workload_id,generation:session.value?.generation});
const runAction=()=>({op:'run',...target(),command_utf8:command.value,cwd:cwd.value,stdin_b64:'',timeout_ms:30000});
const rewindAllows=computed(()=>!props.rewind?.available||!props.rewind.busy&&!props.rewind.uncertain&&(!props.rewind.session||props.rewind.session.phase==='ready'));
const canRun=computed(()=>rewindAllows.value&&session.value?.phase==='ready'&&!state.value.uncertain&&!state.value.busy&&gcAction(runAction()));
function run(){if(canRun.value)emit('action',runAction());}
function cancel(){if(state.value.canCancel)emit('action',{op:'cancel',...target(),job_id:session.value.job.job_id});}
function stop(){if(session.value?.ownership==='held'&&!session.value.controls?.stop)emit('action',{op:'stop',...(props.rewind?.stop_target??target())});}
</script>
<template>
 <section class="guest-command-panel" aria-labelledby="guest-command-title" data-semantic-anchor="capsule/microvm/commands">
  <div class="guest-command-panel__sticky">
  <slot name="header" :capabilities="headerCapabilities" :onRestore="restorePoint">
  <header><div><small>ARM64 MicroVM</small><h2 id="guest-command-title">Guest commands</h2></div>
   <details v-if="headerCapabilities.back.available" class="rewind-back" data-semantic-anchor="capsule/microvm/header/back">
    <summary aria-label="Back to checkpoint"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M11 5v14l-9-7zM22 5v14l-9-7z" fill="currentColor" /></svg><span>Back</span></summary>
    <ul aria-label="Available checkpoints"><li v-for="point in headerCapabilities.back.points" :key="point.point_id"><button type="button" @click="restorePoint(point.point_id)" :aria-label="`Back to ${point.label||'checkpoint'}`"><strong>{{ point.label||'Checkpoint' }}</strong><span>{{ pointAge(point.age_ms) }} · Guest counter {{ point.counter_value??'unknown' }}</span></button></li></ul>
   </details>
   <strong>{{ state.uncertain?'Outcome unknown':rewind?.session?.phase??session?.phase??'Creating' }}</strong>
  </header>
 </slot>
  <aside class="restore-response" aria-live="polite"><span>Restore response (observed)</span><strong data-testid="restore-duration">{{ restoreMilliseconds===null?'Unavailable':`${restoreMilliseconds.toFixed(1)} ms` }}</strong><small>Back click to confirmed Ready · includes pause and transport.</small></aside>
  </div>
  <p>Commands run inside the guest. This is a command log, not an interactive terminal.</p>
  <p role="status" aria-live="polite">{{ session?.ownership==='released'?'Stopped — native closure confirmed.':state.uncertain?'Ownership retained. Stop to reconcile the workload.':'Owned by this session.' }}</p>
  <component :is="rewindPanel" v-if="rewindPanel" :snapshot="rewind" :guest="state" @action="emit('rewind-action',$event)" />
  <form @submit.prevent="run"><label for="guest-command">Command</label><textarea id="guest-command" v-model="command" rows="3" spellcheck="false" :disabled="!canRun && state.busy" /><label for="guest-cwd">Working directory (relative to guest workspace)</label><input id="guest-cwd" v-model="cwd" :disabled="state.busy" placeholder="Workspace root" /><button type="submit" class="primary" :disabled="!canRun">Run command</button></form>
  <div class="controls"><button type="button" :disabled="!state.canCancel" @click="cancel">Cancel command</button><button type="button" class="danger" :disabled="session?.ownership!=='held'||session?.controls?.stop" @click="stop">Stop capsule</button></div>
  <section v-if="transcript" aria-label="Observed command"><h3>{{ transcript.requester.component==='agent'?'SDK':'UI' }} command · Generation {{ transcript.generation }}</h3><pre data-testid="observed-command">{{ transcript.command_utf8 }}</pre><p>{{ transcript.state }}</p></section>
  <h3>Standard output</h3><pre data-testid="guest-stdout">{{ state.stdout }}</pre><h3>Standard error</h3><pre data-testid="guest-stderr">{{ state.stderr }}</pre>
  <p v-if="session?.job">Job: {{ session.job.state }} · Exit: {{ session.job.exit_code??'—' }} · Signal: {{ session.job.signal??'—' }} · Output {{ session.job.output_complete?'complete':'not confirmed complete' }}</p>
  <p v-if="state.code" role="alert">{{ state.code }}</p>
 </section>
</template>
<style scoped>
.guest-command-panel{position:relative;width:100%;height:100%;box-sizing:border-box;padding:1.5rem;overflow:auto;border:1px solid var(--mv-semantic-border-default);border-radius:1rem;background:var(--mv-semantic-surface-canvas);color:var(--mv-semantic-text-primary)}
.guest-command-panel__sticky{position:sticky;top:-1.5rem;z-index:2;margin:-1.5rem -1.5rem 0;padding:1.5rem 1.5rem .5rem;background:var(--mv-semantic-surface-canvas);isolation:isolate}.guest-command-panel__sticky>header{position:relative;z-index:2}
header,.controls{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}h2{margin:.3rem 0}form{display:grid;gap:.6rem;margin-top:1rem}form .primary{justify-self:start}.controls{justify-content:flex-start;margin-top:.75rem;margin-bottom:1.25rem}.controls .danger{margin-left:auto}
button,input,textarea,:deep(.rewind-timeline button),:deep(.rewind-timeline input){font:inherit;padding:.6rem .85rem;border:1px solid var(--mv-semantic-border-default);border-radius:var(--mv-semantic-radius-md);background:var(--mv-semantic-surface-interactive);color:var(--mv-semantic-text-primary)}
input,textarea,:deep(.rewind-timeline input){background:var(--mv-semantic-surface-canvas);min-width:0}button,:deep(.rewind-timeline button){cursor:pointer;background:var(--mv-semantic-surface-elevated)}button:hover:not(:disabled),:deep(.rewind-timeline button:hover:not(:disabled)){border-color:var(--mv-semantic-accent-primary);background:var(--mv-semantic-surface-panel)}
button.primary{background:var(--mv-semantic-accent-primary);color:var(--mv-semantic-accent-primary-contrast);font-weight:700}button.danger{color:var(--mv-semantic-status-error-text);border-color:var(--mv-semantic-status-error-border)}button.danger:hover:not(:disabled){background:var(--mv-semantic-status-error-surface);border-color:var(--mv-semantic-status-error-border)}
button:disabled,:deep(.rewind-timeline button:disabled){opacity:1;cursor:not-allowed;color:var(--mv-semantic-text-disabled);background:var(--mv-semantic-surface-panel);border-color:var(--mv-semantic-border-subtle)}input:disabled,textarea:disabled,:deep(.rewind-timeline input:disabled){color:var(--mv-semantic-text-muted);opacity:1}
button:focus-visible,input:focus-visible,textarea:focus-visible,:deep(.rewind-timeline button:focus-visible),:deep(.rewind-timeline input:focus-visible){outline:3px solid var(--mv-semantic-focus-ring);outline-offset:3px}
textarea,pre{font-family:monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;min-height:2rem;max-height:14rem;overflow:auto;border:1px solid var(--mv-semantic-border-subtle);border-radius:var(--mv-semantic-radius-md);background:var(--mv-semantic-surface-panel);padding:.7rem}
.restore-response{display:grid;gap:.25rem;padding:1rem;margin:.75rem 0;border:1px solid var(--mv-semantic-border-default);border-radius:var(--mv-semantic-radius-md);background:var(--mv-semantic-surface-panel)}.restore-response strong{font-size:clamp(1.5rem,3vw,2.5rem);line-height:1.15;font-variant-numeric:tabular-nums}.restore-response small{color:var(--mv-semantic-text-muted)}
:deep(.rewind-timeline){background:var(--mv-semantic-surface-panel);border-color:var(--mv-semantic-border-default)}:deep(.rewind-timeline .rewind-controls){gap:.75rem}:deep(.rewind-timeline li){border-color:var(--mv-semantic-border-subtle)}
.rewind-back{position:relative}.rewind-back summary{display:flex;align-items:center;gap:.35rem;cursor:pointer}.rewind-back ul{position:absolute;top:100%;left:0;z-index:3;min-width:15rem;width:max-content;max-width:calc(100vw - 3rem);max-height:50vh;overflow:auto;list-style:none;margin:.5rem 0;padding:0;border:1px solid var(--mv-semantic-border-default);border-radius:.5rem;background:var(--mv-semantic-surface-panel)}.rewind-back li button{display:grid;gap:.25rem;width:100%;text-align:left}.rewind-back li span{font-size:.85em}.rewind-back summary:focus-visible{outline:3px solid var(--mv-semantic-focus-ring);outline-offset:3px}@media(max-width:650px){header{display:block}.controls .danger{margin-left:0}}
/* Local alias for the application scheme name; values mirror the product token authority. */
:root[data-theme-scheme="mv-dark"][data-theme-contrast="normal"] .guest-command-panel{
  color-scheme:dark;
  --mv-semantic-accent-primary: var(--mv-primitive-color-blue-300);
  --mv-semantic-accent-primary-contrast: var(--mv-primitive-color-neutral-1050);
  --mv-semantic-border-default: var(--mv-primitive-color-neutral-500);
  --mv-semantic-border-subtle: var(--mv-primitive-color-neutral-500);
  --mv-semantic-focus-ring: var(--mv-primitive-color-blue-300);
  --mv-semantic-status-error-border: var(--mv-primitive-color-red-700);
  --mv-semantic-status-error-surface: var(--mv-primitive-color-red-950);
  --mv-semantic-status-error-text: var(--mv-primitive-color-red-100);
  --mv-semantic-surface-canvas: var(--mv-primitive-color-neutral-1000);
  --mv-semantic-surface-elevated: var(--mv-primitive-color-slate-500);
  --mv-semantic-surface-interactive: var(--mv-primitive-color-slate-500);
  --mv-semantic-surface-panel: var(--mv-primitive-color-neutral-950);
  --mv-semantic-text-disabled: var(--mv-primitive-color-neutral-450);
  --mv-semantic-text-muted: var(--mv-primitive-color-neutral-400);
  --mv-semantic-text-primary: var(--mv-primitive-color-neutral-50);
}
:root[data-theme-scheme="mv-dark"][data-theme-contrast="high"] .guest-command-panel{
  color-scheme:dark;
  --mv-semantic-accent-primary: var(--mv-primitive-color-blue-100);
  --mv-semantic-accent-primary-contrast: var(--mv-primitive-color-neutral-1100);
  --mv-semantic-border-default: var(--mv-primitive-color-neutral-400);
  --mv-semantic-border-subtle: var(--mv-primitive-color-neutral-500);
  --mv-semantic-focus-ring: var(--mv-primitive-color-neutral-0);
  --mv-semantic-status-error-border: var(--mv-primitive-color-neutral-0);
  --mv-semantic-status-error-surface: var(--mv-primitive-color-neutral-1100);
  --mv-semantic-status-error-text: var(--mv-primitive-color-neutral-0);
  --mv-semantic-surface-canvas: var(--mv-primitive-color-neutral-1100);
  --mv-semantic-surface-elevated: var(--mv-primitive-color-neutral-1100);
  --mv-semantic-surface-interactive: var(--mv-primitive-color-neutral-1100);
  --mv-semantic-surface-panel: var(--mv-primitive-color-neutral-1100);
  --mv-semantic-text-disabled: var(--mv-primitive-color-neutral-100);
  --mv-semantic-text-muted: var(--mv-primitive-color-neutral-50);
  --mv-semantic-text-primary: var(--mv-primitive-color-neutral-0);
}
</style>
