import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
test('floating allocation updates the real Dockview group minimum; panel-only mutant overflows', {timeout:30000},()=>{
 const dist=process.env.ELECTRON_OVERRIDE_DIST_PATH;assert.ok(dist);
 for(const negative of [false,true]) {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  if(negative)env.MV_CONSTRAINT_NEGATIVE='1';else delete env.MV_CONSTRAINT_NEGATIVE;
  const run=spawnSync('xvfb-run',['-a',join(dist,'electron'),fileURLToPath(new URL('./floating-constraints-render.cjs',import.meta.url))],{env,encoding:'utf8',timeout:12000});
  const output=run.stdout+run.stderr;assert.equal(run.error,undefined,output);
  if(negative){assert.notEqual(run.status,0,output);assert.match(output,/group constraint must fit/);}
  else {assert.equal(run.status,0,output);assert.match(output,/FLOATING_CONSTRAINTS_OK/);}
 }
});
