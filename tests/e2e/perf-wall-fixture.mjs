// [TARGET, unit decision] U03's missing capture handoff is synthetic RGB24 at
// 20 Hz [TARGET]. Wall layout, scheduler, canvas uploads, timestamps and pixels
// are real Chromium/product behavior. This does not qualify adapter cadence.
import { createApp, h, ref } from '../../ui/node_modules/vue/dist/vue.runtime.esm-bundler.js';
import { createControlRegistry } from 'capsule-ui-kit/registry';
import { createPresentationScheduler } from 'capsule-ui-kit/scheduler';
import { createDefaultLayoutProfile } from 'capsule-ui-kit/layout';
import { installKitTheme } from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
import { createTileScheduler } from '../../ui/src/surfaces/tileScheduler.js';
import WallWorkspace from '../../ui/src/wall/WallWorkspace.vue';

const ids = ['perf-a', 'perf-b', 'perf-c', 'perf-d'];
const rows = ids.map(id => ({ id, surfaceId: id, backendLifecycle: 'active',
  generation: 1, visibility: 'unfolded', control: 'human' }));
const budget = Object.freeze({ maxDrawsPerTick: 4, maxUploadBytesPerTick: 1048576,
  maxPresentMsPerTick: 16, maxWarmResourcesPerSurface: 1, maxDrainSteps: 4 });
const tiles = createTileScheduler({ budget, clock: () => performance.now() });
const canvases = new Map();
const binding = surfaceId => ({ surfaceId, surfaceGeneration: 1, epoch: 1, principal: 'perf-core' });
const need = result => { if (!result.ok) throw Error(`E2E_PERF: ${JSON.stringify(result)}`); };
for (const id of ids) need(tiles.registerSurface({ ...binding(id),
  captureLeaseId: `capture-${id}`, captureLeaseActive: true,
  state: { width: 160, height: 120, viewportIntersecting: true } }));
let markReady;
const ready = new Promise(resolve => { markReady = resolve; });
const snapshot = { status: 'live', stale: false, error: null,
  envelope: { epoch: 1, projection: { rows } } };
const scope = { product: 'metaviewer', profileId: 'perf', workspaceId: 'wall' };
const refuse = () => { throw Error('E2E_PERF: fixture has no host authority'); };
const app = createApp({ setup() {
  const wall = ref(null);
  return () => h(WallWorkspace, { ref: wall, scope,
    defaultProfile: createDefaultLayoutProfile(scope), ownerWindowId: 'perf',
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
    projectionView: { getProjection: () => ({ rows }), getSnapshot: () => snapshot,
      subscribe: () => () => {} },
    intentBuilders: { visibility: refuse, control: refuse, presentation: refuse },
    controlRegistry: createControlRegistry({ windowId: 'perf', epoch: 1 }),
    scheduler: createPresentationScheduler({ budget }), tileScheduler: tiles,
    onReady() {
      for (const id of ids) need(wall.value.revealSurface(id, 'split'));
      markReady();
    },
  }, { surface: ({ capsuleId }) => h('canvas', {
    'data-perf-id': capsuleId, width: 160, height: 120,
    ref(canvas) {
      if (!canvas) return;
      canvases.set(capsuleId, canvas);
      need(tiles.attachCanvas({ ...binding(capsuleId), canvas }));
    },
  }) });
} });
installKitTheme(app);
app.mount('#metaviewer-app');
document.documentElement.style.height = '100%';
document.body.style.cssText = 'margin:0;height:100vh';
document.querySelector('#metaviewer-app').style.height = '100%';

window.runPerfSoak = async ({ seconds, stallMs = 0 }) => {
  await ready;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  await pause(300);
  if (canvases.size !== ids.length || [...canvases.values()].some(c => !c.checkVisibility())) {
    throw Error('E2E_PERF: wall did not expose all canvases');
  }
  const colors = [[250, 20, 30], [10, 240, 40], [20, 30, 230], [200, 100, 50]];
  const samples = new Map(ids.map(id => [id, []]));
  let generation = 0, stopped = false, animation;
  const started = performance.now();
  const capture = setInterval(() => {
    generation += 1;
    for (const [index, id] of ids.entries()) {
      // Deliberate producer fault: other tiles keep advancing during the stall.
      const elapsed = performance.now() - started;
      if (index === 0 && elapsed >= 500 && elapsed < 500 + stallMs) continue;
      need(tiles.recordCaptureWitness({ ...binding(id), captureGeneration: generation,
        timestampMs: performance.now() }));
      const bytes = new Uint8Array(160 * 120 * 3);
      for (let i = 0; i < bytes.length; i += 3) bytes.set(colors[index], i);
      const result = tiles.submitFrame({ ...binding(id), frameGeneration: generation,
        leaseId: `${id}-${generation}`, width: 160, height: 120,
        bytes, byteLength: bytes.length, submittedAtMs: performance.now() });
      if (!result.ok && result.reason !== 'FOLDED_DISPLAY_DISABLED') need(result);
    }
  }, 50);
  const pump = () => {
    if (stopped) return;
    const tick = tiles.runTick();
    for (const present of tick.presented) samples.get(present.surfaceId).push(performance.now());
    animation = requestAnimationFrame(pump);
  };
  animation = requestAnimationFrame(pump);
  try {
    await pause(seconds * 1000);
    const ended = performance.now();
    const visible = ids.map((id, index) => ({ id, times: [...samples.get(id)],
      info: tiles.getInstrumentation(id),
      pixel: [...canvases.get(id).getContext('2d').getImageData(0, 0, 1, 1).data],
      expectedPixel: [...colors[index], 255] }));
    const foldedId = ids.at(-1);
    need(tiles.foldSurface(foldedId));
    canvases.get(foldedId).hidden = true;
    const before = tiles.getInstrumentation(foldedId);
    await pause(1000);
    const after = tiles.getInstrumentation(foldedId);
    return { schema: 'metaviewer.perf-wall/v1', capture: 'synthetic-rgb24',
      started, ended, visible, folded: { id: foldedId, before, after,
        hidden: !canvases.get(foldedId).checkVisibility() } };
  } finally {
    stopped = true;
    clearInterval(capture);
    cancelAnimationFrame(animation);
    tiles.destroy();
    app.unmount();
  }
};
