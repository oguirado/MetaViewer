// The kit must first pass tools/sync_kit.mjs against kit.lock.json.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const kit = fileURLToPath(new URL('./.kit/capsule-ui-kit/', import.meta.url));
const pkg = JSON.parse(readFileSync(`${kit}package.json`, 'utf8'));
const alias = Object.entries(pkg.exports).map(([key, value]) => ({
  // Match one export exactly: a root string alias also captures subpaths.
  find: new RegExp(`^${(key === '.' ? 'capsule-ui-kit' : `capsule-ui-kit/${key.slice(2)}`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  replacement: `${kit}${(typeof value === 'string' ? value : value.default).replace(/^\.\//, '')}`,
}));

export default defineConfig({
  base: './',
  plugins: [vue(), {
    name: 'sandbox-preload',
    generateBundle() {
      // The preload is deliberately a single import-free JS source. Strip only
      // its declaration exports to retain the guarded CommonJS native entry.
      const source = readFileSync(new URL('./electron/preload.js', import.meta.url), 'utf8');
      if (/^import\s|^export\s+(?!const |class |function )/m.test(source)) {
        throw new Error('Preload bundling contract changed');
      }
      this.emitFile({ type: 'asset', fileName: 'preload/preload.cjs',
        source: source.replace(/^export (?=const |class |function )/gm, '') });
    },
  }],
  resolve: { alias, dedupe: ['vue', 'dockview-core', 'dockview-vue'] },
});
