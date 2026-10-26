/** Renderer-only visual fixture: rows mirror the existing surfacePanel tests.
 * No core connection, backend intents, frame pixels or terminal sessions. */
import { createApp } from 'vue';
import App from '../src/App.vue';
import { installKitTheme } from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
import '../src/design/metaviewer.css';
import { createWallLayout, SCOPE } from '../src/wall/layout.js';
const rows = [
  { id: 'research', surfaceId: 'research', title: 'Research browser', backendLifecycle: 'active', generation: 1, visibility: 'unfolded', control: 'human', attachmentState: 'attaching' },
  { id: 'editor', surfaceId: 'editor', title: 'Project editor', backendLifecycle: 'active', generation: 1, visibility: 'unfolded', control: 'human', attachmentState: 'attaching' },
];
const snapshot = { status: 'live', stale: false, envelope: { schema: 'surface/v0.1', epoch: 3, revision: 7, query: 'wall', projection: { rows } }, error: null };
const projectionView = { getProjection: () => ({ rows }), getSnapshot: () => snapshot, subscribe: () => () => {} };
const app = createApp(App, { scope: SCOPE, layout: createWallLayout(SCOPE, rows),
  storage: { readRaw: async () => null, writeAtomic: async () => {} }, runtime: { projectionView } });
installKitTheme(app);
app.mount('#metaviewer-app');
