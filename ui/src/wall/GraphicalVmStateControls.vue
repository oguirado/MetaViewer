<script setup>
import {computed,inject,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {graphicalAction,graphicalCapabilities} from './graphicalStateControls.js';
const props=defineProps({snapshot:{type:Object,required:true},row:{type:Object,required:true}});
const emit=defineEmits(['action']);
const caps=computed(()=>graphicalCapabilities(props.snapshot,props.row));
const status=computed(()=>caps.value.uncertain?'Rewind outcome unknown':props.snapshot.busy?'Rewind pending':caps.value.code?`Checkpoints: ${caps.value.code}`:!props.snapshot.available?'Checkpoints unavailable':caps.value.phase&&caps.value.phase!=='ready'?`Checkpoints ${caps.value.phase}`:'');
const button=ref(/** @type {HTMLElement|null} */(null)),popup=ref(/** @type {HTMLElement|null} */(null)),open=ref(false);
const elapsed=ref(/** @type {number|null} */(0));
const overlays=/** @type {any} */(inject('overlayCoordinator',null)),owner={};
let observed=performance.now(),timer=/** @type {ReturnType<typeof setInterval>|undefined} */(undefined);
function close(){open.value=false;if(popup.value?.matches?.(':popover-open'))popup.value.hidePopover();overlays?.set(owner,false);}
watch(()=>props.snapshot,()=>{observed=performance.now();elapsed.value=0;close();});
const attachClick=computed(()=>{const action=graphicalAction(props.snapshot,props.row,'attach'),revision=props.snapshot.revision;return ()=>{if(action)emit('action',{action,revision});};});
const markClick=computed(()=>{const action=graphicalAction(props.snapshot,props.row,'mark'),revision=props.snapshot.revision;return ()=>{if(action)emit('action',{action,revision});};});
/** Each rendered handler retains its displayed tuple; App rechecks it before dispatch.
 * @param {string} pointId */
function restoreHandler(pointId){const action=graphicalAction(props.snapshot,props.row,'restore',pointId),revision=props.snapshot.revision;return ()=>{close();if(action)emit('action',{action,revision});};}
async function toggle(){
 if(open.value){close();return;}
 if(!caps.value.enabled||!caps.value.back.available)return;
 overlays?.set(owner,true);open.value=true;await nextTick();if(open.value)popup.value?.showPopover?.();
}
/** @param {string} pointId */
function age(pointId){const base=props.snapshot.point_ages_ms?.[pointId],delta=elapsed.value;return Number.isSafeInteger(base)&&base>=0&&delta!==null&&Number.isSafeInteger(base+delta)?`${Math.floor((base+delta)/1000)} s ago`:'Age unavailable';}
/** @param {Event} event */
function outside(event){const target=/** @type {Node|null} */(event.target);if(!button.value?.contains(target)&&!popup.value?.contains(target))close();}
/** @param {KeyboardEvent} event */
function key(event){if(open.value&&event.key==='Escape'){event.preventDefault();event.stopPropagation();close();button.value?.focus();}}
onMounted(()=>{timer=setInterval(()=>{const delta=Math.floor(performance.now()-observed);elapsed.value=Number.isSafeInteger(delta)&&delta>=0?delta:null;},1000);document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);});
onBeforeUnmount(()=>{close();clearInterval(timer);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true);});
</script>
<template>
 <div v-if="caps.visible" class="graphical-vm-state-controls" :data-semantic-anchor="`capsule/${row.id}/graphical/controls`">
  <button v-if="caps.attach.available" :id="`tile-${row.id}-graphical-enable`" type="button" :disabled="!caps.attach.enabled" :data-semantic-anchor="`tile-${row.id}-graphical-enable`" @click="attachClick">Enable checkpoints</button>
  <button v-if="caps.mark.available" :id="`tile-${row.id}-graphical-mark`" type="button" :disabled="!caps.enabled" :data-semantic-anchor="`tile-${row.id}-graphical-mark`" title="Mark a checkpoint" aria-label="Mark VM checkpoint" @click="markClick">Mark</button>
  <button v-if="caps.back.available" ref="button" class="graphical-vm-back" :id="`tile-${row.id}-graphical-back`" type="button" :disabled="!caps.enabled" :data-semantic-anchor="`tile-${row.id}-graphical-back`" title="Back to checkpoint" aria-label="Back to VM checkpoint" aria-haspopup="menu" :aria-expanded="open" @click="toggle"><span class="graphical-vm-rewind-icon" aria-hidden="true">⏪︎</span><span>Back</span></button>
  <span v-if="status" class="graphical-vm-state-status" :title="status" role="status" aria-live="polite">{{ status }}</span>
  <div ref="popup" popover="manual" :hidden="!open" class="graphical-vm-state-points" role="menu" aria-label="VM restore points">
   <button v-for="point in caps.points" :key="point.point_id" :id="`tile-${row.id}-graphical-restore-${point.point_id}`" :data-semantic-anchor="`tile-${row.id}-graphical-restore-${point.point_id}`" type="button" role="menuitem" :disabled="!caps.enabled" :aria-label="`Back to ${point.label || point.point_id}`" :onClick="restoreHandler(point.point_id)"><strong>{{ point.label || 'Checkpoint' }}</strong><span>{{ age(point.point_id) }}</span></button>
   <p>External effects are not rewound.</p>
  </div>
 </div>
</template>
<style>
/* Kit scheme alias, local to this optional control; canonical dark token values. */
:root[data-theme-scheme="mv-dark"][data-theme-contrast="normal"] .graphical-vm-state-controls { --mv-semantic-surface-panel:var(--mv-primitive-color-neutral-950);--mv-semantic-surface-canvas:var(--mv-primitive-color-neutral-1000);--mv-semantic-text-primary:var(--mv-primitive-color-neutral-50);--mv-semantic-text-muted:var(--mv-primitive-color-neutral-400);--mv-semantic-border-default:var(--mv-primitive-color-neutral-500); }
:root[data-theme-scheme="mv-dark"][data-theme-contrast="high"] .graphical-vm-state-controls { --mv-semantic-surface-panel:var(--mv-primitive-color-neutral-1100);--mv-semantic-surface-canvas:var(--mv-primitive-color-neutral-1100);--mv-semantic-text-primary:var(--mv-primitive-color-neutral-0);--mv-semantic-text-muted:var(--mv-primitive-color-neutral-50);--mv-semantic-border-default:var(--mv-primitive-color-neutral-400); }
.graphical-vm-state-controls { display:inline-flex;align-items:center;gap:4px; }
.graphical-vm-state-controls > button { display:inline-flex;align-items:center;gap:4px;background:var(--mv-semantic-surface-panel);color:var(--mv-semantic-text-primary);border:1px solid var(--mv-semantic-border-default);font:inherit; }
.graphical-vm-state-status { max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--mv-semantic-text-muted); }
.graphical-vm-state-points { position:fixed;inset:auto;top:80px;right:8px;margin:4px 0 0;padding:8px;min-width:240px;max-width:280px;max-height:60vh;overflow:auto;border:1px solid var(--mv-semantic-border-default);border-radius:6px;background:var(--mv-semantic-surface-panel);color:var(--mv-semantic-text-primary); }
.graphical-vm-state-points[hidden] { display:none; }
.graphical-vm-state-points > button { display:grid;gap:4px;width:100%;padding:8px;text-align:left;background:var(--mv-semantic-surface-canvas);color:var(--mv-semantic-text-primary);border:1px solid var(--mv-semantic-border-default); }
.graphical-vm-state-points p,.graphical-vm-state-points span { font-size:11px; }
</style>

<style>
.graphical-vm-back { anchor-name:--graphical-vm-back; }
.graphical-vm-rewind-icon { font-size:16px;line-height:1;font-variant-emoji:text; }
@supports (position-anchor:--graphical-vm-back) { .graphical-vm-state-points { position-anchor:--graphical-vm-back;top:anchor(bottom);left:anchor(left);right:auto;position-try-fallbacks:flip-inline; } }
</style>
