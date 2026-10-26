// [TARGET, unit decision] Build the real wall with a CI-owned projection seam.
// Product boot has no live feed handoff; this fixture grants no host authority.
import { build } from '../../ui/node_modules/vite/dist/node/index.js';
import config from '../../ui/vite.config.js';
import { fileURLToPath } from 'node:url';
const ui = fileURLToPath(new URL('../../ui/', import.meta.url));
await build({
  ...config,
  configFile: false,
  root: fileURLToPath(new URL('./', import.meta.url)),
  resolve: { ...config.resolve, alias: [
    ...config.resolve.alias,
    { find: /^vue$/, replacement: `${ui}node_modules/vue/dist/vue.runtime.esm-bundler.js` },
  ] },
  build: { outDir: process.env.MV_E2E_BUILD, emptyOutDir: true },
});
