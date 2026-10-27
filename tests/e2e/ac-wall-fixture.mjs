// [TARGET, unit decision] Only the projection and frame source are synthetic;
// the workspace, panels, kit restore barrier and rendering run in Chromium.
import { createApp, h, ref, reactive } from '../../ui/node_modules/vue/dist/vue.runtime.esm-bundler.js';
import { createControlRegistry } from 'capsule-ui-kit/registry';
import { createPresentationScheduler } from 'capsule-ui-kit/scheduler';
import { createTileScheduler } from '../../ui/src/surfaces/tileScheduler.js';
import { createWallIntentBuilders, buildAuthorityIntent } from '../../ui/src/core/intents.js';
import WallWorkspace from '../../ui/src/wall/WallWorkspace.vue';
import 'capsule-ui-kit/theme.css';
import { createDefaultLayoutProfile } from 'capsule-ui-kit/layout';
import { installKitTheme } from 'capsule-ui-kit/theme';

const { capsules, crossRoute } = window.e2eFixture;
const rows = reactive(capsules.map(({ capsuleId }) => ({ id: capsuleId, surfaceId: capsuleId,
  backendLifecycle: 'active', generation: 7, visibility: 'unfolded', control: 'agent' })));
const listeners = new Set();
const budget = Object.freeze({ maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216,
  maxPresentMsPerTick: 8, maxWarmResourcesPerSurface: 1, maxDrainSteps: 4 });
const controlRegistry = createControlRegistry({ windowId: 'e2e', epoch: 1 });
const scheduler = createPresentationScheduler({ budget });
const tileScheduler = createTileScheduler({ budget });
let snapshot = { status: 'live', stale: false, error: null,
  envelope: { epoch: 1, projection: { rows } } };
const projectionView = { getProjection: () => ({ rows }), getSnapshot: () => snapshot,
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
const scope = { product: 'metaviewer', profileId: 'e2e', workspaceId: 'wall' };
// [TARGET, unit decision] Only this fixture host changes projection state.
// Actual cancellation/admission/fresh-frame semantics are exercised against Rust
// by ac04_control.test.js; this host exercises the real UI event round trip.
const intentBuilders = createWallIntentBuilders({
  encodeUiIntent: (input) => input, encodeControl: buildAuthorityIntent,
});
function acceptControl(intent) {
  const row = rows.find((item) => item.id === intent.params.surface_id);
  if (!row || !['take_control', 'release_control'].includes(intent.op)) {
    throw new Error('Unsupported fixture intent');
  }
  row.control = intent.op === 'take_control' ? 'human' : 'agent';
  if (intent.op === 'release_control') row.generation += 1;
  snapshot = { ...snapshot, envelope: { ...snapshot.envelope,
    revision: (snapshot.envelope.revision ?? 0) + 1, projection: { rows: rows.map(row => ({ ...row })) } } };
  for (const listener of listeners) listener(snapshot);
}

const app = createApp({ setup() {
  const wall = ref(null);
  return () => h(WallWorkspace, { ref: wall, scope,
    defaultProfile: createDefaultLayoutProfile(scope), ownerWindowId: 'e2e',
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
    projectionView, intentBuilders, onSubmitIntent: acceptControl,
    controlRegistry, scheduler, tileScheduler,
    onReady: () => {
      for (const { capsuleId } of capsules) {
        const result = wall.value.revealSurface(capsuleId, 'split');
        if (!result.ok) throw new Error(JSON.stringify(result));
      }
    },
  }, { surface: ({ capsuleId }) => h('canvas', {
    'data-frame-tag': `frame-${crossRoute ? capsules[0].capsuleId : capsuleId}-gen${rows.find(row => row.id === capsuleId).generation}`,
    width: 160, height: 120,
  }) });
} });
installKitTheme(app);
app.mount('#metaviewer-app');
document.documentElement.style.height = '100%';
document.body.style.cssText = 'margin:0;height:100vh';
document.querySelector('#metaviewer-app').style.height = '100%';
