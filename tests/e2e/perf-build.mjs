// [TARGET, unit decision] Synthetic capture drives the product wall and tile
// scheduler. Build into caller-owned scratch; never replace the shared fixture.
import { build } from '../../ui/node_modules/vite/dist/node/index.js';
import config from '../../ui/vite.config.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const ui = fileURLToPath(new URL('../../ui/', import.meta.url));
const fixture = fileURLToPath(new URL('./wall-fixture.mjs', import.meta.url));
assert.ok(process.env.MV_E2E_BUILD, 'E2E_PREREQ: scratch build destination required');
await build({
  ...config, configFile: false, root: fileURLToPath(new URL('./', import.meta.url)),
  plugins: [{ name: 'perf-wall-capture', enforce: 'pre', load(id) {
    if (id === fixture) return readFileSync(process.env.MV_E2E_JOURNEY_FIXTURE ||
      new URL('./perf-wall-fixture.mjs', import.meta.url), 'utf8');
  } }, ...config.plugins],
  resolve: { ...config.resolve, alias: [...config.resolve.alias,
    { find: /^vue$/, replacement: `${ui}node_modules/vue/dist/vue.runtime.esm-bundler.js` }] },
  build: { outDir: process.env.MV_E2E_BUILD, emptyOutDir: true },
});
