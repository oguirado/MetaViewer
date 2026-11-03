import {test,mock} from 'node:test';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,symlinkSync,existsSync,utimesSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {createOperatorService,discoverHandoffPaths,HANDOFF_DISCOVERY} from '../electron/operatorBridge.js';
// Restrict only the shared namespace enumeration; use real private directories/files.
function namespace(t, roots) {
  const original=fs.opendirSync;
  const handle=mock.method(fs,'opendirSync',function(path,...args){
    if(path!=='/dev/shm')return original.call(fs,path,...args);
    let index=0;return {readSync:()=>index<roots.length?{name:basename(roots[index++]),isDirectory:()=>true}:null,closeSync(){}};
  });
  syncBuiltinESMExports();
  t.after(()=>{handle.mock.restore();syncBuiltinESMExports();});
}
const record={schema:'metaviewer.handoff/v1',surface_id:'browser-fixture',step_index:0,reason:'login_wall',confidence:100,evidence_kinds:['ax_role_name']};
test('V027 F11: browser wall in documented private RAM namespace latches and acknowledges',async t=>{
  const state=mkdtempSync(join(tmpdir(),'mv-v027-state-'));
  const ram=mkdtempSync('/dev/shm/metaviewer-goal.');
  t.after(()=>{rmSync(state,{recursive:true,force:true});rmSync(ram,{recursive:true,force:true});});
  namespace(t,[ram]);
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
test('V027 F11: discovered RAM files retain descriptor private-file validation',t=>{
  const ram=mkdtempSync('/dev/shm/metaviewer-goal.');
  t.after(()=>rmSync(ram,{recursive:true,force:true}));
  namespace(t,[ram]);
  const runs=join(ram,'metaviewer/runs');mkdirSync(runs,{recursive:true,mode:0o700});
  const files=[];
  for(let n=0;n<3;n++){
    const run=join(runs,String(n).repeat(32));mkdirSync(run,{mode:0o700});
    const file=join(run,'browser-goal.handoff.json');files.push(file);
    writeFileSync(file,JSON.stringify({...record,surface_id:'browser-'+n}),{mode:0o600});
  }
  chmodSync(files[1],0o644);rmSync(files[2]);symlinkSync(files[0],files[2]);
  // Simulate a symlink replacement after discovery's lstat: only O_NOFOLLOW can reject it.
  const original=fs.lstatSync;
  const handle=mock.method(fs,'lstatSync',function(path,...args){return path===files[2]?statSync(path):original.call(fs,path,...args);});
  syncBuiltinESMExports();t.after(()=>{handle.mock.restore();syncBuiltinESMExports();});
  const service=createOperatorService({env:{HOME:'/nonexistent'}});
  assert.deepEqual(service.refresh().rows,[{...record,surface_id:'browser-0'}]);
  assert.deepEqual(createOperatorService({env:{XDG_STATE_HOME:ram,MV_HANDOFF_PATHS:'[]'}}).refresh().rows,[]);
});


test('V027 RAM handoffs survive invalid configured state and absent HOME',t=>{
  const ram=mkdtempSync('/dev/shm/metaviewer-goal.');
  t.after(()=>rmSync(ram,{recursive:true,force:true}));namespace(t,[ram]);
  const run=join(ram,'metaviewer/runs','c'.repeat(32));mkdirSync(run,{recursive:true,mode:0o700});
  const file=join(run,'browser-goal.handoff.json');writeFileSync(file,JSON.stringify(record),{mode:0o600});
  for (const env of [{},{MV_OPERATOR_STATE_HOME:'relative'},{MV_OPERATOR_STATE_HOME:'relative',XDG_STATE_HOME:ram}]) {
    assert.deepEqual(createOperatorService({env}).refresh().rows,[record]);
  }
});

test('V027 newest RAM run wins after global ordering beyond the root cap',t=>{
  const roots=[];namespace(t,roots);
  t.after(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true});});
  let newest;
  for(let n=0;n<HANDOFF_DISCOVERY.maxRuns+1;n++){
    const root=mkdtempSync('/dev/shm/metaviewer-goal.');roots.push(root);
    const run=join(root,'metaviewer/runs','d'.repeat(32));mkdirSync(run,{recursive:true,mode:0o700});
    const file=join(run,'browser-goal.handoff.json');writeFileSync(file,JSON.stringify(record),{mode:0o600});
    utimesSync(run,new Date(Date.now()-100000+n*1000),new Date(Date.now()-100000+n*1000));newest=file;
  }
  const paths=discoverHandoffPaths({HOME:'/nonexistent'},Date.now());
  assert.equal(paths[0],newest);assert.equal(paths.length,HANDOFF_DISCOVERY.maxRuns);
});
