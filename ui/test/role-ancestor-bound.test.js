// A malformed or cyclic parent chain must not spin the RoleSurface clip walk
// (1 Nov 2026: unbounded test graphs exhausted host memory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';

const require = createRequire(import.meta.url);
const VUE_URL = pathToFileURL(require.resolve('vue')).href;

async function loadRoleSurfaceModule() {
  const source = readFileSync(new URL('../src/surfaces/RoleSurface.vue', import.meta.url), 'utf8');
  const compiled = compileScript(parse(source).descriptor, { id: 'role-ancestor-bound', inlineTemplate: true }).content;
  const code = compiled.replace(/from ["']vue["']/g, `from ${JSON.stringify(VUE_URL)}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const rect = () => ({ x: 0, y: 0, width: 100, height: 100 });

test('collectClipRects stops on a cyclic parent chain', async () => {
  const { collectClipRects } = await loadRoleSurfaceModule();
  const a = { getBoundingClientRect: rect }, b = { getBoundingClientRect: rect };
  a.parentElement = b; b.parentElement = a;
  const { scrollAncestors } = collectClipRects({ parentElement: a });
  assert.equal(scrollAncestors.length, 2);
});

test('collectClipRects visits at most MAX_ANCESTORS nodes of a deep chain', async () => {
  const { collectClipRects, MAX_ANCESTORS } = await loadRoleSurfaceModule();
  let node = { getBoundingClientRect: rect };
  for (let i = 0; i < 10_000; i++) node = { getBoundingClientRect: rect, parentElement: node };
  const { scrollAncestors } = collectClipRects({ parentElement: node });
  assert.equal(scrollAncestors.length, MAX_ANCESTORS);
});
