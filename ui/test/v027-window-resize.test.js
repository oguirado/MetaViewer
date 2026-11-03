import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRoleHost } from '../electron/roleHost.js';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/surfaces/RoleSurface.vue', import.meta.url), 'utf8');
const helpers = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const { findLiveHostWindow, reopenHostWindow } = await import('data:text/javascript;base64,' + Buffer.from(helpers).toString('base64'));

const picked = {xid:77594627,witness:'0x04a00003:1730541000',title:'Resize fixture',program:'chromium',width:778,height:663};
test('lost window Stop requires destroy receipt; explicit Reopen uses current dimensions and fresh surface', async t => {
 const root=await mkdtemp(join(tmpdir(),'mv-resize-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const handlers=new Map(), states=new Map(), calls=[];
 let next=0, stopRefused=true;
 const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript:()=> 'p',unregisterPreloadScript(){}}};
 const host=installRoleHost({electron:{ipcMain:{handle:(k,fn)=>handlers.set(k,fn),removeHandler:k=>handlers.delete(k)}},window:parent,
  env:{MV_SRF_PROFILES:JSON.stringify({'mv-live-1':{Kind:'browser',NativeKind:'browser',Width:1280,Height:900,RAMRoot:'/dev/shm',Display:':111'}}),MV_SRF_STATE_DIR:root},capsuleStates:states,
  stageMode:async()=>async()=>{},admit:()=>true,listIdentities:async()=>({ok:true,rows:[]}),
  core:{getHumanSurface:id=>states.get(id),request:async req=>{
   calls.push(req);const surface={schema:'surface/v0.2',surface_id:`surface-resize-${++next}`,profile_id:req.params.profile_id,kind:'desktop_capsule',geometry:req.params.geometry,state:'active',control:'agent',visibility:'unfolded',display:':0'};
   states.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
  },stopSurface:async id=>{
   if(stopRefused)return {schema:'surface_event/v0.2',event:'error',data:{code:'STOP_REFUSED'}};
   const surface={...states.get(id),state:'destroyed'};states.set(id,surface);
   return {schema:'surface_event/v0.2',event:'state_changed',data:{surface}};
  }}});
 t.after(()=>host.dispose());
 const invoke=(op,extra={})=>handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op,...extra});
 const first=await invoke('create-window',{choice:picked});assert.equal(first.ok,true);
 states.set(first.surfaceId,{...states.get(first.surfaceId),state:'lost'});
 const refused=await invoke('stop',{surfaceId:first.surfaceId});
 assert.equal(refused.ok,false);assert.equal(refused.code,'CAPSULE_STOP_UNPROVEN');
 assert.equal(states.get(first.surfaceId).state,'lost','failed Stop must retain binding');
 stopRefused=false;
 const current={...picked,width:931,height:726};
 const api={listWindows:async()=>[current],detachWindow:surfaceId=>invoke('detach-window',{surfaceId}),createWindow:choice=>invoke('create-window',{choice})};
 const reopened=await reopenHostWindow(api,first.surfaceId,picked);
 assert.equal(reopened.ok,true);assert.notEqual(reopened.surfaceId,first.surfaceId);
 assert.deepEqual(calls.at(-1).params.geometry,{w:931,h:726});
 assert.equal(states.get(first.surfaceId).state,'destroyed');
 const stopped=await invoke('stop',{surfaceId:reopened.surfaceId});assert.equal(stopped.ok,true);
});

test('Reopen refuses a closed window or changed witness before detaching', async()=>{
 for(const rows of [[],[{...picked,witness:'replacement'}]]){
  let detached=false;
  const api={listWindows:async()=>rows,detachWindow:async()=>{detached=true;return {ok:true};}};
  assert.equal(await findLiveHostWindow(api,picked),null);
  await assert.rejects(reopenHostWindow(api,'lost',picked),/HOST_WINDOW_UNAVAILABLE/);
  assert.equal(detached,false);
 }
});
