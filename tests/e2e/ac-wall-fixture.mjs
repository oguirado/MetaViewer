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

const { capsules, crossRoute, stalledTile, advancingFrames, unpaintedTile } = window.e2eFixture;
const canvases = new Map();
function paintTileCanvas(capsuleId, generation) {
  if (capsuleId === unpaintedTile) return;
  const canvas = canvases.get(capsuleId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const idx = capsules.findIndex(c => c.capsuleId === capsuleId);
  const r = ((idx + 1) * 53 + generation * 29) % 200 + 30;
  const g = ((idx + 1) * 97 + generation * 43) % 200 + 30;
  const b = ((idx + 1) * 137 + generation * 61) % 200 + 30;
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
const rows = reactive(capsules.map(({ capsuleId }) => ({ id: capsuleId, surfaceId: capsuleId,
  backendLifecycle: 'active', generation: 7, visibility: 'unfolded', control: 'agent', controlOwner: 'agent' })));
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
function publishProjection(traceControl = false) {
  snapshot = { ...snapshot, envelope: { ...snapshot.envelope,
    revision: (snapshot.envelope.revision ?? 0) + 1, projection: { rows: rows.map(row => ({ ...row })) } } };
  if (traceControl) console.log('AC04_TRACE ' + JSON.stringify({ phase: 'authoritative-frame', rows: snapshot.envelope.projection.rows }));
  for (const listener of listeners) listener(snapshot);
}
function acceptControl(intent) {
  const refuse = () => {
    const error = new TypeError('Malformed or unsupported fixture intent');
    error.code = 'E2E_FIXTURE_INTENT';
    throw error;
  };
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return refuse();
  const visibility = intent.op === 'fold' || intent.op === 'unfold';
  const control = intent.op === 'take_control' || intent.op === 'release_control';
  if (!visibility && !control) return refuse();
  const keys = visibility ? ['op', 'surfaceId'] : ['schema', 'request_id', 'op', 'params'];
  if (Object.keys(intent).length !== keys.length || keys.some(key => !Object.hasOwn(intent, key))) return refuse();
  if (control && (intent.schema !== 'ui_intent/v0.2' || typeof intent.request_id !== 'string'
      || intent.request_id.length === 0 || !intent.params || typeof intent.params !== 'object'
      || Array.isArray(intent.params) || Object.keys(intent.params).length !== 1
      || !Object.hasOwn(intent.params, 'surface_id'))) return refuse();
  const surfaceId = visibility ? intent.surfaceId : intent.params.surface_id;
  const row = rows.find(item => item.id === surfaceId);
  if (!row) return refuse();
  if (visibility) row.visibility = intent.op === 'fold' ? 'folded' : 'unfolded';
  else {
    console.log('AC04_TRACE ' + JSON.stringify({ phase: 'intent', intent }));
    // [TARGET, unit decision] Replay the core POLICY refusal while work drains.
    if (intent.op === 'release_control' && window.ac04RefuseRelease === true) {
      console.log('AC04_TRACE ' + JSON.stringify({ phase: 'ack', op: intent.op, ok: false, code: 'POLICY' }));
      console.log('AC04_TRACE ' + JSON.stringify({ phase: 'authoritative-frame', rows: rows.map(row => ({ ...row })) }));
      console.error('INTENT_REFUSED:POLICY');
      return;
    }
    row.control = intent.op === 'take_control' ? 'human' : 'agent';
    // Match production: the kit reads controlOwner; the wall reads control.
    row.controlOwner = row.control;
    if (intent.op === 'release_control') {
      row.generation += 1;
      if (row.visibility !== 'folded') paintTileCanvas(row.id, row.generation);
    }
    console.log('AC04_TRACE ' + JSON.stringify({ phase: 'ack', op: intent.op, ok: true }));
  }
  publishProjection(control);
}

// [TARGET, unit decision] Deliver at fixed deadlines, skipping missed slots
// rather than adding render work to each interval or replaying a catch-up burst.
// Capture is independent of visibility and authority; only the explicit mutant
// stalls a tile. Each actual delivery advances its frame identity exactly once.
const framePeriodMs = 40;
let nextFrameAt = performance.now() + framePeriodMs;
let deliveryTimer;
function deliverFrames() {
  for (const row of rows) {
    if (row.id !== stalledTile) {
      row.generation += 1;
      if (row.visibility !== 'folded') paintTileCanvas(row.id, row.generation);
    }
  }
  publishProjection();
  const now = performance.now();
  do { nextFrameAt += framePeriodMs; } while (nextFrameAt <= now);
  deliveryTimer = setTimeout(deliverFrames, Math.max(0, nextFrameAt - now));
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
    ref(canvas) {
      if (!canvas) {
        canvases.delete(capsuleId);
        return;
      }
      const prev = canvases.get(capsuleId);
      canvases.set(capsuleId, canvas);
      if (prev !== canvas) {
        const row = rows.find(item => item.id === capsuleId);
        if (row && row.visibility !== 'folded') paintTileCanvas(capsuleId, row.generation);
      }
    },
  }) });
} });
installKitTheme(app);
app.mount('#metaviewer-app');
document.documentElement.style.height = '100%';
document.body.style.cssText = 'margin:0;height:100vh';
document.querySelector('#metaviewer-app').style.height = '100%';

// [TARGET, unit decision] AC-02 opts into telemetry; other journeys retain fixed publications.
if (advancingFrames) deliveryTimer = setTimeout(deliverFrames, Math.max(0, nextFrameAt - performance.now()));
window.addEventListener('pagehide', () => clearTimeout(deliveryTimer), { once: true });
