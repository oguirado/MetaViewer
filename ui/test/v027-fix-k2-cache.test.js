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


for (const fault of ['docker', 'binding']) test(`V027 K2 transient ${fault} failure does not permanently reject a surviving wall`, t => {
  const f=fixture(t);f.write();f.bind();
  const service=f.service();
  if(fault==='docker') {
    f.probe.mock.mockImplementationOnce(()=>({status:1,stdout:'',stderr:''}));
  } else fs.writeFileSync(join(f.bindings,wall.surface_id+'.json'),'{');
  assert.deepEqual(service.refresh().rows,[]);
  f.bind();
  assert.deepEqual(service.refresh().rows,[wall]);
});
