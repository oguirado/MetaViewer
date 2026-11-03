import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {OPERATOR_RESOURCES} from '../tools/package.js';

test('installed operator runtime imports program automation without a checkout; corrupted seal refuses', async () => {
  const root=await mkdtemp(join(tmpdir(),'mv-kit-runtime-'));
  const repo=fileURLToPath(new URL('../../',import.meta.url));
  try {
    const runtime=join(root,'resources/operator');
    const files={};
    for(const relative of OPERATOR_RESOURCES) {
      const dest=join(runtime,relative);
      await mkdir(dirname(dest),{recursive:true});
      await copyFile(join(repo,relative),dest);
      files[relative]=createHash('sha256').update(await readFile(dest)).digest('hex');
    }
    for(const required of ['agents/metaviewer_agents/mw_run.py','tools/mw_run_backend.py',
      'tools/mw_run_program.py','tools/mw_program_muse.py','agents/metaviewer_agents/perception/compiled.lock.json']) {
      assert.ok(Object.hasOwn(files,required),required);
    }
    await writeFile(join(runtime,'runtime.manifest.json'),JSON.stringify({schema:'metaviewer.operator-runtime/v1',files}));
    const env={...process.env,PYTHONPATH:join(runtime,'agents')};
    execFileSync('python3',['-c',`import sys;sys.path.insert(0,${JSON.stringify(join(runtime,'tools'))});import mw_run_program`],{cwd:root,env});
    const args=[join(runtime,'tools/mw_home_check.py'),'--repo',runtime,'--home',join(root,'user-memoryweb')];
    const result=JSON.parse(execFileSync('python3',args,{cwd:root,env,encoding:'utf8'}));
    assert.equal(result.ok,true);
    await writeFile(join(runtime,'tools/mw_run_backend.py'),'# mutated runtime\n');
    assert.throws(()=>execFileSync('python3',args,{cwd:root,env,stdio:'pipe'}),error=>{
      assert.match(String(error.stdout),/MW_RUNTIME_HASH/); return true;
    });
  } finally {await rm(root,{recursive:true,force:true});}
});
