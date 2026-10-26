<script setup>
/** [TARGET, unit decision] Missing live projection/gateway handoff: mount the
 * real wall against an unavailable view. No invented surfaces or generations.
 * Live capabilities remain unavailable until the conductor supplies the feed.
 */
import { markRaw, onBeforeUnmount, ref } from 'vue';
import WallWorkspace from './wall/WallWorkspace.vue';
import SurfaceCanvas from './surfaces/SurfaceCanvas.vue';
import TerminalView from './terminal/TerminalView.vue';
import { createTileScheduler } from './surfaces/tileScheduler.js';
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileEnvelope} LayoutProfile */
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileScope} LayoutScope */
/** @typedef {Pick<InstanceType<typeof WallWorkspace>['$props'], 'projectionView'|'intentBuilders'|'controlRegistry'|'scheduler'|'tileScheduler'>} WallRuntime */
/** @typedef {{readRaw:()=>Promise<string|null>,writeAtomic:(json:string)=>Promise<void>}} LayoutStorage */
const props = defineProps({
  runtime: { type: /** @type {import('vue').PropType<WallRuntime|null>} */ (Object), default: null },
  terminal: { type: /** @type {import('vue').PropType<{session:string,port:MessagePort}|null>} */ (Object), default: null },
  layout: { type: /** @type {import('vue').PropType<LayoutProfile>} */ (Object), required: true },
  scope: { type: /** @type {import('vue').PropType<LayoutScope>} */ (Object), required: true },
  storage: { type: /** @type {import('vue').PropType<LayoutStorage>} */ (Object), required: true },
});
const settled = ref(false);
const unavailable = Object.freeze({ status: 'unavailable', stale: true, envelope: null,
  error: Object.freeze({ code: 'PROJECTION_UNAVAILABLE', message: 'Authoritative surface feed unavailable' }) });
const projectionView = markRaw({
  getProjection: () => null,
  getSnapshot: () => unavailable,
  subscribe: () => () => {},
});
function refuseAuthority() { throw new Error('Authoritative intent gateway unavailable'); }
const intentBuilders = markRaw({ visibility: refuseAuthority, control: refuseAuthority, presentation: refuseAuthority });
const controlRegistry = markRaw({});
const scheduler = markRaw({});
const tileScheduler = markRaw(createTileScheduler({ budget: Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
}) }));
onBeforeUnmount(() => tileScheduler.destroy());
</script>
<template>
  <div class="metaviewer" :data-wall-settled="String(settled)">
    <main aria-label="MetaViewer capsule wall">
      <WallWorkspace :scope="props.scope" :default-profile="props.layout" :storage="props.storage"
        owner-window-id="main-wall" :projection-view="props.runtime?.projectionView ?? projectionView" :intent-builders="props.runtime?.intentBuilders ?? intentBuilders"
        :control-registry="props.runtime?.controlRegistry ?? controlRegistry" :scheduler="props.runtime?.scheduler ?? scheduler" :tile-scheduler="props.runtime?.tileScheduler ?? tileScheduler"
        @wall-settled="settled = true">
        <template #surface="{ surface, capsuleId }">
          <SurfaceCanvas v-if="surface" :surface-id="capsuleId" :generation="surface.generation" :epoch="props.runtime?.projectionView.getSnapshot()?.envelope?.epoch ?? ''" state="connecting" />
        </template>
      </WallWorkspace>
    </main>
    <details><summary>Session terminal</summary><TerminalView :session="props.terminal?.session ?? ''" :port="props.terminal?.port ?? null" /></details>
    <footer role="status">{{ settled ? (props.runtime ? 'Wall ready.' : 'Wall ready. Authoritative surface feed unavailable.') : 'Opening wall…' }}</footer>
  </div>
</template>
<style>
.metaviewer {
  height: 100dvh;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto;
}
.metaviewer main {
  min-height: 0;
  min-width: 0;
}
.metaviewer footer {
  padding: 8px 16px;
  font-size: 12px;
}
body {
  margin: 0;
}
</style>
