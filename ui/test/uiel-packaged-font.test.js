import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPackage } from '@electron/asar';
import { sealRendererAssets, verifyPackagedSecurity } from '../tools/package.js';

// Mutation: skip the renderer entry when relativeName.endsWith('.woff2').
// The sealed-asset refusal already names the planted font; no new font policy is needed.
test('U09 a font-free sealed package verifies; a post-seal font is refused by filename', async t => {
  const root = await mkdtemp(join(tmpdir(), 'uiel-font-Música-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'source'), built = join(root, 'built');
  for (const name of ['dist/renderer', 'dist/preload', 'electron']) await mkdir(join(app, name), { recursive: true });
  await mkdir(join(built, 'resources'), { recursive: true });
  await copyFile(new URL('../electron/main.js', import.meta.url), join(app, 'electron/main.js'));
  await writeFile(join(app, 'dist/renderer/index.html'), '<html>system fonts</html>');
  await writeFile(join(app, 'dist/preload/preload.cjs'), 'preload');
  await writeFile(join(app, 'electron/nesting.js'), 'entry');
  await writeFile(join(app, 'package.json'), JSON.stringify({ main: 'electron/nesting.js' }));
  await sealRendererAssets(app);
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  await writeFile(join(built, 'metaviewer'), Buffer.concat([
    Buffer.from('ELF-fixture'), sentinel, Buffer.from([1, 9]), Buffer.from('010011000'),
  ]));
  const archive = join(built, 'resources/app.asar');
  await createPackage(app, archive);
  await verifyPackagedSecurity(built);
  await writeFile(join(app, 'dist/renderer/font.woff2'), 'planted font bytes');
  await rm(archive);
  await createPackage(app, archive);
  await assert.rejects(verifyPackagedSecurity(built), /font\.woff2/);
  await rm(join(app, 'dist/renderer/font.woff2'));
  await rm(archive);
  await createPackage(app, archive);
  await verifyPackagedSecurity(built);
});
