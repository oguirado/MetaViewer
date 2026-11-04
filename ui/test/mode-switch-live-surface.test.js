import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {installRoleHost} from '../electron/roleHost.js';

test('mode switch retains the running browser and identity in both directions',async t=>{
  const root=await mkdtemp(join(tmpdir(),'switch-live-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const handlers=new Map(),states=new Map(),calls=[];
  let surface={surface_id:'live',profile_id:'demo',kind:'browser',state:'active',control:'human'};
  states.set('live',surface);
  const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript:()=> 'p',unregisterPreloadScript(){}}};
  const core={getHumanSurface:()=>surface,request:async()=>{calls.push('create');throw Error('must not create');},
    stopSurface:async()=>{calls.push('destroy');throw Error('must not destroy');},
    switchRole:async(id,role)=>{calls.push(role);assert.equal(id,'live');surface={...surface,control:role};return {schema:'metaviewer.role_switch_result/v0.3',request_id:'test',surface_id:id,role,ok:true};}};
  const host=installRoleHost({electron:{ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler(){}}},window:parent,core,
    env:{MV_SRF_PROFILES:JSON.stringify({demo:{Kind:'browser',role:'human'}}),MV_SRF_STATE_DIR:root,MV_SRF_BIN_DIR:root},
    capsuleStates:states,admit:()=>true,listIdentities:async()=>({ok:true,rows:[{id:'demo'}]})});
  t.after(()=>host.dispose());
  const invoke=()=>handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op:'switch',surfaceId:'live'});
  for(const role of ['agent','human','agent','human','agent','human']){
    const result=await invoke();assert.equal(result.ok,true);assert.equal(result.surfaceId,'live');
    assert.equal(result.role,role);assert.equal(result.reused,true);assert.equal(states.get('live').state,'active');
  }
  assert.deepEqual(calls,['agent','human','agent','human','agent','human']);
});

test('a runtime without role transfer refuses visibly and never restarts the browser',async t=>{
  const root=await mkdtemp(join(tmpdir(),'switch-unsupported-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let handler;const surface={surface_id:'live',profile_id:'demo',kind:'browser',state:'active',control:'human'};
  const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript:()=> 'p',unregisterPreloadScript(){}}};
  const host=installRoleHost({electron:{ipcMain:{handle:(_k,v)=>{handler=v;},removeHandler(){}}},window:parent,
    core:{getHumanSurface:()=>surface,stopSurface:assert.fail,request:assert.fail},
    env:{MV_SRF_PROFILES:JSON.stringify({demo:{Kind:'browser',role:'human'}}),MV_SRF_STATE_DIR:root,MV_SRF_BIN_DIR:root},
    capsuleStates:new Map([['live',surface]]),admit:()=>true,listIdentities:async()=>({ok:true,rows:[{id:'demo'}]})});
  t.after(()=>host.dispose());
  const reply=await handler({}, {schema:'metaviewer.roles/v0.3',op:'switch',surfaceId:'live'});
  assert.equal(reply.ok,false);assert.equal(reply.code,'CAPSULE_MODE_UNAVAILABLE');
  assert.match(reply.reason,/cannot preserve the running capsule/);assert.equal(surface.state,'active');
});
