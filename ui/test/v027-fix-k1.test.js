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
async function windowFixture(t) {
 const root=await mkdtemp(join(tmpdir(),'mv-resize-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const handlers=new Map(), states=new Map(), calls=[];
 let next=0, stopRefused=true, createRefused=false, listed=[{...picked,title:'Updated title'}];
 const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript:()=> 'p',unregisterPreloadScript(){}}};
 const host=installRoleHost({electron:{ipcMain:{handle:(k,fn)=>handlers.set(k,fn),removeHandler:k=>handlers.delete(k)}},window:parent,
  env:{MV_SRF_PROFILES:JSON.stringify({'mv-live-1':{Kind:'browser',NativeKind:'browser',Width:1280,Height:900,RAMRoot:'/dev/shm',Display:':111'}}),MV_SRF_STATE_DIR:root},capsuleStates:states,
  listWindows:async()=>listed,stageMode:async()=>async()=>{},admit:()=>true,listIdentities:async()=>({ok:true,rows:[]}),
  core:{getHumanSurface:id=>states.get(id),request:async req=>{
   calls.push(req);if(createRefused)throw Error('CREATE_FAILED');const surface={schema:'surface/v0.2',surface_id:`surface-resize-${++next}`,profile_id:req.params.profile_id,kind:'desktop_capsule',geometry:req.params.geometry,state:'active',control:'agent',visibility:'unfolded',display:':0'};
   states.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
  },stopSurface:async id=>{
   if(stopRefused)return {schema:'surface_event/v0.2',event:'error',data:{code:'STOP_REFUSED'}};
   const surface={...states.get(id),state:'destroyed'};states.set(id,surface);
   return {schema:'surface_event/v0.2',event:'state_changed',data:{surface}};
  }}});
 t.after(()=>host.dispose());
 const invoke=(op,extra={})=>handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op,...extra});
 return {states,calls,invoke,setListed:value=>{listed=value;},setStopRefused:value=>{stopRefused=value;},setCreateRefused:value=>{createRefused=value;}};
}

test('v027-fix-k1: failed create after detach remains explicitly reopenable', async t => {
 const {states,calls,invoke,setStopRefused,setCreateRefused}=await windowFixture(t);
 const first=await invoke('create-window',{choice:picked});assert.equal(first.ok,true);
 states.set(first.surfaceId,{...states.get(first.surfaceId),state:'lost'});
 const refused=await invoke('stop',{surfaceId:first.surfaceId});
 assert.equal(refused.ok,false);assert.equal(refused.code,'CAPSULE_STOP_UNPROVEN');
 assert.equal(states.get(first.surfaceId).state,'lost','failed Stop must retain binding');
 setStopRefused(false);
 const current={...picked,width:931,height:726};
 const api={listWindows:async()=>[current],detachWindow:surfaceId=>invoke('detach-window',{surfaceId}),createWindow:choice=>invoke('create-window',{choice})};
 setCreateRefused(true);
 await assert.rejects(reopenHostWindow(api,first.surfaceId,picked),/CREATE_FAILED|XPRA_REFUSED/);
 setCreateRefused(false);
 const reopened=await reopenHostWindow(api,first.surfaceId,picked);
 assert.equal(reopened.ok,true);assert.notEqual(reopened.surfaceId,first.surfaceId);
 assert.deepEqual(calls.at(-1).params.geometry,{w:931,h:726});
 assert.equal(states.get(first.surfaceId).state,'destroyed');
 assert.equal((await invoke('stop',{surfaceId:reopened.surfaceId})).ok,true);
});

test('v027-fix-k1: duplicate refusal provides only the matching live surface for reveal',async t=>{
 const {invoke}=await windowFixture(t);
 const first=await invoke('create-window',{choice:picked});assert.equal(first.ok,true);
 const duplicate=await invoke('create-window',{choice:picked});
 assert.equal(duplicate.ok,false);assert.equal(duplicate.code,'PROFILE_ALREADY_BOUND');
 assert.equal(duplicate.surfaceId,first.surfaceId);
 const changedWitness=await invoke('create-window',{choice:{...picked,witness:'replacement'}});
 assert.equal(changedWitness.ok,false);assert.equal(changedWitness.surfaceId,undefined);
 const different=await invoke('create-window',{choice:{...picked,xid:picked.xid+1,witness:'other'}});
 assert.equal(different.ok,true);assert.notEqual(different.surfaceId,first.surfaceId);
});

test('v027-fix-k1: relist refreshes the active title and preserves the lost title',async t=>{
 const {invoke,states,setListed}=await windowFixture(t);
 const first=await invoke('create-window',{choice:picked});assert.equal(first.ok,true);
 await invoke('list-windows');
 assert.equal((await invoke('status',{surfaceId:first.surfaceId})).hostWindow.title,'Updated title');
 setListed([{...picked,witness:'replacement',title:'Wrong witness title'}]);
 await invoke('list-windows');
 assert.equal((await invoke('status',{surfaceId:first.surfaceId})).hostWindow.title,'Updated title');
 states.set(first.surfaceId,{...states.get(first.surfaceId),state:'lost'});
 setListed([{...picked,title:'Later title'}]);
 await invoke('list-windows');
 assert.equal((await invoke('status',{surfaceId:first.surfaceId})).hostWindow.title,'Updated title');
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

test('v027-fix-k1: unrelated unknown surfaces cannot skip detach', async()=>{
 const api={listWindows:async()=>[picked],detachWindow:async()=>({ok:false,code:'SURFACE_UNKNOWN'}),createWindow:async()=>assert.fail('unproven detach')};
 await assert.rejects(reopenHostWindow(api,'unrelated',picked),/SURFACE_UNKNOWN/);
});

// Execute the production identity handler with its actual program branch.
test('v027-fix-k1: opposite-role live program gives an accurate notice; current role reveals', async()=>{
 const src=readFileSync(new URL('../src/identities/IdentitiesDialog.vue',import.meta.url),'utf8');
 const handler=src.slice(src.indexOf('async function openIdentity('),src.indexOf('/** @param {string} profileId */\nasync function stopIdentity'));
 const events=[], error={value:''};
 const open=new Function('isForeignIdentity','identityErrorText','busy','rows','modeFor','error','emit',`${handler};return openIdentity;`)(()=>false,()=>'',{value:false},{value:[{id:'calc',browser:'program'}]},()=>({surfaceId:'live',currentMode:'agent'}),error,(...event)=>events.push(event));
 await open('calc','human');
 assert.match(error.value,/agent.*mode/i);
 assert.deepEqual(events,[],'opposite role must not silently reveal as requested');
 await open('calc','agent');
 assert.deepEqual(events,[['open-identity',{profileId:'calc',surfaceId:'live',role:'agent'}],['close']]);
});

test('v027-fix-k1: desktop window has no impossible role switch; browser keeps it',async()=>{
 const {compileTemplate}=await import('@vue/compiler-sfc');
 const template=source.match(/<button[^>]*:id="`tile-switch-\$\{surfaceId\}`"[\s\S]*?<\/button>/)[0];
 const compiled=compileTemplate({source:template,filename:'RoleSurface.vue',id:'k1'}).code.replaceAll('from "vue"',`from ${JSON.stringify(import.meta.resolve('vue'))}`);
 const {render}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
 const context={surfaceId:'tile',hostWindow:{xid:42},progress:'',role:'agent',runMenu(){},lifecycle(){}};
 assert.notEqual(render(context,[]).type,'button');
 assert.equal(render({...context,hostWindow:null},[]).type,'button');
});

// Use the real App action: a refused duplicate reveals its panel, preserving authority.
test('v027-fix-k1: Add reveals a duplicate without taking control',async t=>{
 const previous=globalThis.metaviewerRoles;t.after(()=>{globalThis.metaviewerRoles=previous;});
 let reply={ok:false,code:'PROFILE_ALREADY_BOUND',surfaceId:'retained'};
 globalThis.metaviewerRoles={createWindow:async()=>reply};
 const source=readFileSync(new URL('../src/App.vue',import.meta.url),'utf8');
 const action=source.slice(source.indexOf('async function createWindowCapsule('),source.indexOf('/** @param {unknown} intent',source.indexOf('async function createWindowCapsule(')));
 const reveals=[],controls=[];
 const create=new Function('nextTick','selectGlobalView','revealOpenedIdentity','props','wallInputPending','applyWallControl',`${action};return createWindowCapsule;`)(async()=>{},()=>{},async(...args)=>reveals.push(args),{runtime:{intentBuilders:{}}},{value:{}},(...args)=>controls.push(args));
 assert.equal((await create({window:picked})).ok,true);
 assert.deepEqual(reveals,[['retained','agent']]);assert.deepEqual(controls,[]);
 reply={ok:false,code:'PROFILE_ALREADY_BOUND'};
 assert.equal((await create({window:picked})).ok,false);assert.equal(reveals.length,1);
});
