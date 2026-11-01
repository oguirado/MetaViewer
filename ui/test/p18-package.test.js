import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stageElectronModules, verifyStagedImports, sealRendererAssets } from '../tools/package.js';
import { createWallLayout } from '../src/wall/layout.js';

test('P18 staged main layout bridge saves with its bundled kit; absent decoder fails staging gate',async t=>{
  const root = await mkdtemp(join(tmpdir(),'p18-package-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const app = join(root,'app');
  await stageElectronModules(app);
  const {createLayoutBridge} = await import(pathToFileURL(join(app,'electron/main.js')));
  const storage = await mkdtemp(join(tmpdir(),'p18-layout-'));t.after(()=>rm(storage,{recursive:true,force:true}));
  const bridge = createLayoutBridge({directory:storage});
  const save = bridge.find(entry=>entry.channel==='metaviewer:layout.save');
  const load = bridge.find(entry=>entry.channel==='metaviewer:layout.load');
  const raw = JSON.stringify(createWallLayout());
  assert.equal(await save.invoke(raw),true); assert.equal(await load.invoke(),raw);
  await rm(join(app,'.kit/capsule-ui-kit/src/workspace/layoutProfile.js'));
  await assert.rejects(verifyStagedImports(app),/PKG_STAGED_IMPORT_MISSING/);
});
