import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installRoleHost} from '../electron/roleHost.js';

test('lost Program retains Stop authority until verified destroy, then reopens without restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'v028-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const states=new Map(),authority=new Map();let invoke,verified=false,stops=0,seq=0,profile;
 const window=new EventEmitter();window.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
 const host=installRoleHost({electron:{ipcMain:{handle(_k,fn){invoke=fn;},removeHandler(){}}},window,
  env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:'{}'},capsuleStates:states,admit:()=>true,
  listIdentities:async()=>({ok:true,rows:profile?[{id:profile,browser:'program'}]:[]}),
  provisionProgramIdentity:async()=>({ok:true}),stageMode:async()=>async()=>{},
  core:{getHumanSurface:id=>authority.get(id),request:async req=>{
   profile=req.params.profile_id;
   const surface={schema:'surface/v0.2',surface_id:`surface-${++seq}`,kind:'desktop_capsule',profile_id:profile,state:'active',control:'agent'};
   states.set(surface.surface_id,surface);authority.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
  },stopSurface:async id=>{stops++;return {schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...states.get(id),state:verified?'destroyed':'lost'}}};}},
 });t.after(()=>host.dispose());
 const call=(op,body={})=>invoke({}, {schema:'metaviewer.roles/v0.3',op,...body});
 const first=await call('create-program',{choice:{binary:process.execPath,role:'agent'}});assert.equal(first.ok,true);
 // The core can report loss before its presentation mirror receives the event.
 authority.set(first.surfaceId,{...states.get(first.surfaceId),state:'lost'});
 const rows=await call('programs');assert.equal(rows[0].currentMode,'lost');assert.equal(rows[0].surfaceId,first.surfaceId);
 const refused=await call('stop',{surfaceId:first.surfaceId});assert.equal(refused.code,'CAPSULE_STOP_UNPROVEN');assert.equal(stops,1);
 assert.equal((await call('open',{choice:{profileId:profile,role:'agent'}})).ok,false);
 verified=true;assert.equal((await call('stop',{surfaceId:first.surfaceId})).ok,true);assert.equal(stops,2);
 const reopened=await call('open',{choice:{profileId:profile,role:'agent'}});assert.equal(reopened.ok,true);assert.equal(reopened.profileId,first.profileId);assert.notEqual(reopened.surfaceId,first.surfaceId);
});
