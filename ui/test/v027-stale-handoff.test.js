import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOperatorService,HANDOFF_DISCOVERY} from '../electron/operatorBridge.js';

const wall={schema:'metaviewer.handoff/v1',surface_id:'surface-old',step_index:0,reason:'login_wall',confidence:100,evidence_kinds:['ax_role_name']};
function fixture(t) {
  const original=fs.opendirSync;
  const namespace=mock.method(fs,'opendirSync',(path,...args)=>path==='/dev/shm'?{readSync:()=>null,closeSync(){}}:original(path,...args));
  t.after(()=>{namespace.mock.restore();syncBuiltinESMExports();});
  const root=fs.mkdtempSync(join(tmpdir(),'mv-v027-stale-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const run=join(root,'metaviewer/runs','a'.repeat(32));
  fs.mkdirSync(run,{recursive:true,mode:0o700});
  const bindings=join(root,'native/human-bindings');fs.mkdirSync(bindings,{recursive:true,mode:0o700});
  const path=join(run,HANDOFF_DISCOVERY.fileName);
  const start=Date.now(),old=new Date(start-60000);
  const write=(value=wall)=>{fs.writeFileSync(path,JSON.stringify(value),{mode:0o600});fs.utimesSync(path,old,old);};
  const bind=(surface=wall.surface_id,extra={})=>{
    fs.writeFileSync(join(bindings,surface+'.json'),JSON.stringify({schema:'metaviewer.human_binding/v0.3',surface_id:surface,
      container:'srf-id-account-a',profile_id:'account-a',run_id:'run-a',control_ready:true,role:'agent',...extra}),{mode:0o600});
  };
  let active=['srf-id-account-a'],calls=0,started=new Date(start-120000).toISOString();
  const probe=mock.method(childProcess,'spawnSync',(command,args,options)=>{
    calls++;assert.equal(command,'docker');
    if(args[0]==='ps')assert.deepEqual(args,['ps','--format','{{.Names}}']);
    else assert.deepEqual(args,['inspect','--format','{{.Name}} {{.State.Running}} {{.State.StartedAt}}',...active]);
    assert.equal(options.timeout,1000);assert.equal(options.shell,undefined);
    return {status:0,stdout:args[0]==='ps'?active.join('\n'):active.map(name=>`/${name} true ${started}`).join('\n'),stderr:''};
  });
  syncBuiltinESMExports();t.after(()=>{probe.mock.restore();syncBuiltinESMExports();});
  const env={XDG_STATE_HOME:root,MV_SRF_STATE_DIR:join(root,'native')};
  const service=(options={})=>createOperatorService({env,sessionStartedAt:start,...options});
  return {path,root,run,bindings,start,write,bind,service,stop:()=>{active=[];},replace:()=>{started=new Date(start).toISOString();},calls:()=>calls,probe};
}

test('V027 stale run survives stop/run on disk but cannot resurrect a wall on a new capsule',t=>{
  const f=fixture(t);f.write();f.bind();
  const first=f.service({sessionStartedAt:f.start-120000});
  assert.deepEqual(first.refresh().rows,[wall]);
  // Judge stop removes the capsule; its private RAM run and binding remain.
  f.stop();f.bind('surface-new');
  const events=[],restarted=f.service({notify:v=>events.push(v)});
  assert.deepEqual(restarted.refresh().rows,[]);
  assert.deepEqual(restarted.refresh().rows,[]);
  assert.deepEqual(events,[]);
  // A real wall raised after restart must still latch, then remain absorbing.
  f.write({...wall,surface_id:'surface-new'});
  const fresh=new Date(f.start+1000);fs.utimesSync(f.path,fresh,fresh);
  assert.deepEqual(restarted.refresh().rows,[{...wall,surface_id:'surface-new'}]);
  fs.rmSync(f.run,{recursive:true});
  assert.equal(restarted.refresh().rows.length,1);
});

test('V027 live capsule survives app restart and durable acknowledgement still wins',async t=>{
  const f=fixture(t);f.write();f.bind();
  const service=f.service();assert.deepEqual(service.refresh().rows,[wall]);
  assert.deepEqual(await service.request('handoff.ack',[{surface_id:wall.surface_id,step_index:0,gesture:'operator-acknowledge'}]),{ok:true});
  assert.deepEqual(f.service({sessionStartedAt:f.start+1000}).refresh().rows,[]);
});

test('V027 a new container reusing the old identity name cannot revive an old surface',t=>{
  const f=fixture(t);f.write();f.bind();
  assert.deepEqual(f.service().refresh().rows,[wall]);
  f.replace();f.bind('surface-new');
  assert.deepEqual(f.service().refresh().rows,[]);
});

test('V027 old records need an exact private surface and identity container witness',t=>{
  const f=fixture(t);f.write();
  assert.deepEqual(f.service().refresh().rows,[]); // absent surface
  f.bind('different-surface');assert.deepEqual(f.service().refresh().rows,[]);
  for(const extra of [{surface_id:'different-surface'},{container:'srf-id-other'},{control_ready:false},{profile_id:'other'},{schema:'foreign'}]) {
    f.bind(wall.surface_id,extra);assert.deepEqual(f.service().refresh().rows,[]);
  }
  f.bind();const binding=join(f.bindings,wall.surface_id+'.json');
  fs.chmodSync(binding,0o644);assert.deepEqual(f.service().refresh().rows,[]);
  fs.chmodSync(binding,0o600);fs.renameSync(binding,binding+'.real');fs.symlinkSync(binding+'.real',binding);
  assert.deepEqual(f.service().refresh().rows,[]);
  fs.unlinkSync(binding);fs.renameSync(binding+'.real',binding);
  assert.deepEqual(f.service().refresh().rows,[wall]); // positive control
});

test('V027 old explicit paths and touched run directories cannot bypass session admission',t=>{
  const f=fixture(t);f.write();
  fs.utimesSync(f.run,new Date(f.start+1000),new Date(f.start+1000));
  assert.deepEqual(f.service({env:{MV_HANDOFF_PATHS:JSON.stringify([f.path])}}).refresh().rows,[]);
  assert.equal(f.calls(),0);
  f.bind();f.probe.mock.mockImplementation(()=>({status:1,stdout:'srf-id-account-a'}));
  assert.deepEqual(f.service().refresh().rows,[]);
});

test('V027 a rejected old record asks docker once, not on every refresh',t=>{
  const f=fixture(t);f.write();f.bind();f.replace();
  const service=f.service();
  assert.deepEqual(service.refresh().rows,[]);
  const first=f.calls();assert.ok(first>0);
  for(let i=0;i<5;i++)assert.deepEqual(service.refresh().rows,[]);
  assert.equal(f.calls(),first);
});
