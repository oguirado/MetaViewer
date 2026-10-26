<script>
/**
 * @fileoverview Wall tile canvas for one bound surface.
 * Hosts the live canvas element plus a read-only frame/generation/digest
 * witness strip. The `frame` prop is an opaque scheduler handle string;
 * pixel bytes never enter Vue reactivity. Drawing happens only inside a
 * scheduler turn through the injected scheduler; prop arrival never draws.
 * Plain JavaScript with JSDoc; no authored TypeScript.
 * @module surfaces/SurfaceCanvas
 */
</script>
<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  formatFrameStrip,
  normalizeSurfaceState,
  surfaceCanvasAccessibleName,
  surfaceCanvasAnchor,
  surfaceCanvasDomId,
} from './tileScheduler.js';

const props = defineProps({
  surfaceId: { type: String, required: true },
  generation: { type: [Number, String], default: '' },
  epoch: { type: [Number, String], default: '' },
  frame: { type: String, default: '' },
  digest: { type: String, default: '' },
  state: { type: String, default: 'empty' },
});

const emit = defineEmits(['canvas-ready', 'canvas-released']);

/** @type {{ attachCanvas: (args: any) => { ok: boolean }, detachCanvas: (id: string) => void } | null} */
const scheduler = /** @type {any} */ (inject('tileScheduler', null));

/** @type {{ value: HTMLCanvasElement | null }} */
const canvasRef = ref(/** @type {HTMLCanvasElement | null} */ (null));

// Live display requires a presented witness: a live claim with no frame
// handle degrades to connecting instead of rendering a fake-live tile.
const resolvedState = computed(() => {
  const normalized = normalizeSurfaceState(props.state);
  if (normalized === 'live' && props.frame.length === 0) {
    return 'connecting';
  }
  return normalized;
});

const strip = computed(() => formatFrameStrip({
  frame: props.frame,
  generation: props.generation,
  digest: props.digest,
}));

const domId = computed(() => surfaceCanvasDomId(props.surfaceId));
const anchor = computed(() => surfaceCanvasAnchor(props.surfaceId));
const accessibleName = computed(() => surfaceCanvasAccessibleName({
  surfaceId: props.surfaceId,
  state: resolvedState.value,
}));
const stripName = computed(() => {
  const parts = [];
  if (strip.value.frameText.length > 0) parts.push(`Frame ${strip.value.frameText}`);
  if (strip.value.generationText.length > 0) parts.push(`generation ${strip.value.generationText}`);
  if (strip.value.digestText.length > 0) parts.push(`digest ${strip.value.digestText}`);
  if (strip.value.readOnlyText.length > 0) parts.push(strip.value.readOnlyText);
  return parts.length > 0 ? parts.join(', ') : 'Frame state unavailable';
});

/** @param {number | string} value */
function bindingNumber(value) {
  if (value === '') return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : NaN;
}

function attachCanvas() {
  if (scheduler !== null && canvasRef.value !== null) {
    const result = scheduler.attachCanvas({ surfaceId: props.surfaceId,
      surfaceGeneration: bindingNumber(props.generation), epoch: bindingNumber(props.epoch), canvas: canvasRef.value });
    if (result?.ok === true) {
      emit('canvas-ready', { surfaceId: props.surfaceId });
      return;
    }
  }
  emit('canvas-released', { surfaceId: props.surfaceId });
}

onMounted(attachCanvas);

watch(() => [props.surfaceId, props.generation, props.epoch], (_current, previous) => {
  if (scheduler === null) return;
  scheduler.detachCanvas(String(previous[0]));
  attachCanvas();
});

onBeforeUnmount(() => {
  if (scheduler !== null) {
    scheduler.detachCanvas(props.surfaceId);
  }
  emit('canvas-released', { surfaceId: props.surfaceId });
});
</script>
<template>
  <section
    class="mv-surface"
    :id="domId"
    :data-anchor="anchor"
    :data-state="resolvedState"
    :aria-label="accessibleName"
  >
    <canvas ref="canvasRef" :hidden="resolvedState !== 'live' && resolvedState !== 'stale'" class="mv-surface__canvas" aria-hidden="true" />
    <div v-if="resolvedState !== 'live' && resolvedState !== 'stale'" class="mv-surface__waiting" role="status">
      <span class="mv-surface__connection-mark" aria-hidden="true">◌</span>
      <strong>{{ resolvedState === 'connecting' ? 'Connecting to surface' : 'Waiting for surface' }}</strong>
      <span>The surface will appear here when it is ready.</span>
    </div>
    <p v-if="props.frame" class="mv-surface__state" aria-hidden="true">{{ resolvedState }}</p>
    <div v-if="props.frame" class="mv-surface__strip" role="group" :aria-label="stripName">
      <span class="mv-surface__key">FRAME: {{ strip.frameText.length > 0 ? strip.frameText : '—' }}</span>
      <span class="mv-surface__key">GEN: {{ strip.generationText.length > 0 ? strip.generationText : '—' }}</span>
      <span class="mv-surface__key">SHA256: {{ strip.digestText.length > 0 ? strip.digestText : '—' }}</span>
      <span v-if="strip.readOnlyText.length > 0" class="mv-surface__guard">{{ strip.readOnlyText }}</span>
    </div>
  </section>
</template>
<style scoped>
.mv-surface {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  width: 100%;
  height: 100%;
  background: var(--cuk-semantic-surface-canvas);
  color: var(--cuk-semantic-text-primary);
}
.mv-surface__canvas {
  display: block;
  width: 100%;
  flex: 1;
  min-height: 0;
  object-fit: contain;
  background-color: var(--mv-primitive-color-neutral-1100, #000000);
}
.mv-surface__canvas[hidden] {
  display: none;
}
.mv-surface__waiting { flex:1; min-height:200px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--cuk-semantic-spacing-sm); padding:var(--cuk-semantic-spacing-lg); text-align:center; color:var(--cuk-semantic-text-muted); font-size:12px; }
.mv-surface__waiting strong { color:var(--cuk-semantic-text-primary); font-size:14px; font-weight:500; }
.mv-surface__connection-mark { font-size:32px; color:var(--cuk-semantic-accent-primary); }
.mv-surface__state {
  margin: 0;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--mv-primitive-color-neutral-300, #ced0d4);
}
.mv-surface__strip {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 22px;
  padding: 0 8px;
  overflow: hidden;
  white-space: nowrap;
  border-top: 1px solid var(--mv-primitive-color-neutral-600, #525b66);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--mv-primitive-color-neutral-400, #a9b2bc);
}
.mv-surface__key {
  overflow: hidden;
  text-overflow: ellipsis;
}
.mv-surface__guard {
  flex: none;
  margin-left: auto;
  font-weight: 600;
  color: var(--mv-primitive-color-amber-300, #f2c14e);
}
</style>
