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

/** @type {{ attachCanvas: (args: any) => unknown, detachCanvas: (id: string) => void } | null} */
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

onMounted(() => {
  if (scheduler !== null && canvasRef.value !== null) {
    scheduler.attachCanvas({ surfaceId: props.surfaceId, surfaceGeneration: props.generation, epoch: props.epoch, canvas: canvasRef.value });
  }
  emit('canvas-ready', { surfaceId: props.surfaceId });
});

watch(() => [props.surfaceId, props.generation, props.epoch], (_current, previous) => {
  if (scheduler === null) return;
  scheduler.detachCanvas(String(previous[0]));
  if (canvasRef.value) scheduler.attachCanvas({ surfaceId: props.surfaceId,
    surfaceGeneration: props.generation, epoch: props.epoch, canvas: canvasRef.value });
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
    <canvas ref="canvasRef" class="mv-surface__canvas" aria-hidden="true" />
    <p class="mv-surface__state" aria-hidden="true">{{ resolvedState }}</p>
    <div class="mv-surface__strip" role="group" :aria-label="stripName">
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
  background-color: var(--mv-primitive-color-neutral-1000, #0a1317);
  border: 1px solid var(--mv-primitive-color-neutral-600, #525b66);
}
.mv-surface__canvas {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  background-color: var(--mv-primitive-color-neutral-1100, #000000);
}
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
