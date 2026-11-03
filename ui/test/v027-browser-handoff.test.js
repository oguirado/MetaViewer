import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOperatorService} from '../electron/operatorBridge.js';
const record={schema:'metaviewer.handoff/v1',surface_id:'browser-fixture',step_index:0,reason:'login_wall',confidence:100,evidence_kinds:['ax_role_name']};
test('V027 F11: browser wall in documented private RAM namespace latches and acknowledges',async t=>{
  const state=mkdtempSync(join(tmpdir(),'mv-v027-state-'));
  const ram=mkdtempSync('/dev/shm/metaviewer-goal.');
  t.after(()=>{rmSync(state,{recursive:true,force:true});rmSync(ram,{recursive:true,force:true});});
  const env={MV_OPERATOR_STATE_HOME:state,XDG_STATE_HOME:state};
  const sent=[],service=createOperatorService({env,notify:v=>sent.push(v)});
  assert.deepEqual(service.refresh().rows,[]);
  const run=join(ram,'metaviewer/runs','b'.repeat(32));mkdirSync(run,{recursive:true,mode:0o700});
  const file=join(run,'browser-goal.handoff.json');
  writeFileSync(file,JSON.stringify(record),{mode:0o600});
  assert.deepEqual(service.refresh().rows,[record]);
  assert.equal(sent.length,1);
  assert.deepEqual(await service.request('handoff.ack',[{surface_id:record.surface_id,step_index:0,gesture:'operator-acknowledge'}]),{ok:true});
  assert.ok(existsSync(file+'.ack.json'));
  assert.deepEqual(createOperatorService({env}).refresh().rows,[]);
});
test('V027 F11: configured RAM root and browser files retain private-file validation',t=>{
  const ram=mkdtempSync('/dev/shm/mv-v027-config-');
  t.after(()=>rmSync(ram,{recursive:true,force:true}));
  const runs=join(ram,'metaviewer/runs');mkdirSync(runs,{recursive:true,mode:0o700});
  const files=[];
  for(let n=0;n<3;n++){
    const run=join(runs,String(n).repeat(32));mkdirSync(run,{mode:0o700});
    const file=join(run,'browser-goal.handoff.json');files.push(file);
    writeFileSync(file,JSON.stringify({...record,surface_id:'browser-'+n}),{mode:0o600});
  }
  chmodSync(files[1],0o644);rmSync(files[2]);symlinkSync(files[0],files[2]);
  const service=createOperatorService({env:{XDG_STATE_HOME:ram}});
  assert.deepEqual(service.refresh().rows,[{...record,surface_id:'browser-0'}]);
  assert.deepEqual(createOperatorService({env:{XDG_STATE_HOME:ram,MV_HANDOFF_PATHS:'[]'}}).refresh().rows,[]);
});
