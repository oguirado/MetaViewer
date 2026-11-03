import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,chmod,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installRoleHost,surfaceCreateRefusal} from '../electron/roleHost.js';
import {buildCreateIntent} from '../src/catalog/catalogModel.js';

test('Host program preserves roles, avoids the identity store, and stops on app disposal',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hx-Música-'));
 await chmod(root,0o700);
 const binary=join(root,'clock');await writeFile(binary,'');await chmod(binary,0o755);
 const states=new Map(),staged=[],stopped=[];let handler,seq=0,free=8*1024**3;
 const window=new EventEmitter();window.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
 const core={getHumanSurface:id=>states.get(id),async stopSurface(id){stopped.push(id);const surface={...states.get(id),state:'destroyed'};states.set(id,surface);return {schema:'surface_event/v0.2',event:'state_changed',data:{surface}}},async request(q){
  const opening=JSON.parse(await readFile(join(root,'opening-modes',q.params.profile_id+'.json'),'utf8'));staged.push(opening);
  const surface={schema:'surface/v0.2',surface_id:'surface-hx-'+(++seq),profile_id:q.params.profile_id,state:'active',control:opening.mode,geometry:{w:1280,h:900}};
  states.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
 }};
 const host=installRoleHost({electron:{ipcMain:{handle(_key,fn){handler=fn},removeHandler(){}}},window,core,env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:'{}'},capsuleStates:states,admit:()=>true,readFreeMemoryBytes:async()=>free,
 listIdentities:async()=>{throw Error('identity store must not be read')},provisionProgramIdentity:async()=>{throw Error('identity store must not be written')}});
 const call=(op,args={})=>handler({}, {schema:'metaviewer.roles/v0.3',op,...args});
 try {
  const result=buildCreateIntent({kind:'host-program',binary,role:'human'});assert.equal(result.ok,true);assert.equal(result.intent.kind,'host-program');
  assert.equal(buildCreateIntent({kind:'host-program',binary,role:'root'}).ok,false);
  const first=await call('create-program',{choice:{binary,role:'human',hostXpra:true}});assert.equal(first.ok,true);
  assert.equal(staged[0].host_xpra,true);assert.equal(staged[0].mode,'human');
  assert.equal((await call('status',{surfaceId:first.surfaceId})).hostXpra,true);
  const agent=await call('switch',{surfaceId:first.surfaceId});assert.equal(agent.ok,true);assert.equal(agent.role,'agent');
  const human=await call('switch',{surfaceId:agent.surfaceId});assert.equal(human.ok,true);assert.equal(human.role,'human');
  assert.deepEqual(staged.map(x=>[x.mode,x.host_xpra]),[['human',true],['agent',true],['human',true]]);
  const bad=await call('create-program',{choice:{binary,role:'human',hostXpra:false}});assert.equal(bad.ok,false);
  free=null;const noMemory=await call('create-program',{choice:{binary,role:'agent',hostXpra:true}});assert.equal(noMemory.code,'RAM_ADMISSION_REFUSED');
  free=8*1024**3;
  for(let i=0;i<15;i++) states.set('occupied-'+i,{surface_id:'occupied-'+i,profile_id:'occupied-'+i,state:'active'});
  const full=await call('create-program',{choice:{binary,role:'agent',hostXpra:true}});assert.equal(full.code,'CAPSULE_LIMIT_REACHED');
  assert.equal(staged.length,3);
  await host.dispose();assert.ok(stopped.includes(human.surfaceId));
 }finally{await host.dispose();await rm(root,{recursive:true,force:true})}
});

test('missing host dependencies retain the typed program refusal',()=>{
 assert.equal(surfaceCreateRefusal({data:{code:'host_program_unavailable',detail:'xpra missing'}}),'HOST_PROGRAM_UNAVAILABLE');
});
