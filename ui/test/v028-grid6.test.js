import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDesktopState,validateDesktopState} from '../electron/desktopLayout.js';
import {programBinaries} from '../electron/programBinaries.js';
import {stateRequest,stateEvent} from '../electron/preload.js';
const source=readFileSync(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8');
const script=source.match(/<script>([\s\S]*?)<\/script>/)[1];
const wall=await import(`data:text/javascript;base64,${Buffer.from(script.replace(/import .* from 'vue';/,'const defineComponent = value=>value; const h=()=>{};')).toString('base64')}`);

test('GRID6 next free cell uses exact snap bounds, row-major, then bounded default float',()=>{
 const occupied=[], grid={cols:3,rows:2};
 for(let index=0;index<6;index++){
  const rect=wall.nextFloatingCell(1241,601,grid,occupied);
  const expected=wall.floatDragBounds({}, {},{x:(index%3+.5)*1241/3,y:(Math.floor(index/3)+.5)*601/2,ctrlKey:true},1241,601,grid);
  assert.deepEqual(rect,expected);occupied.push(rect);
 }
 const overflow=wall.nextFloatingCell(1241,601,grid,occupied);
 assert.equal(overflow.width,Math.floor(1241*.9));assert.equal(overflow.height,601);
 assert(overflow.x>0 && overflow.x+overflow.width<=1241);
});
test('GRID6 identity hint wins only while its cell is free, changed grids reject out-of-grid hints',()=>{
 const grid={cols:3,rows:2}, hint={col:2,row:1};
 const remembered=wall.nextFloatingCell(1200,600,grid,[],hint);
 assert.deepEqual(remembered,{x:800,y:300,width:400,height:300});
 assert.deepEqual(wall.nextFloatingCell(1200,600,grid,[remembered],hint),{x:0,y:0,width:400,height:300});
 assert.equal(wall.nextFloatingCell(1200,600,{cols:1,rows:1},[],hint).x,0);
});
test('GRID6 strict bounded identity-cell persistence retains Floating without live surface IDs',()=>{
 const state=createDesktopState(), desktop=state.views.human.desktops[0];
 desktop.preset='floating';desktop.snapGrid={cols:3,rows:2};desktop.identityCells={'work-browser':{col:2,row:1}};
 assert.equal(validateDesktopState(JSON.parse(JSON.stringify(state))),true);
 for(const cells of [null,[],{'work-browser':{col:5,row:0}},{'work-browser':{col:1.1,row:0}},{'work-browser':{col:0,row:0,extra:true}},JSON.parse('{"__proto__":{"col":0,"row":0}}'),Object.fromEntries(Array.from({length:257},(_,i)=>['id-'+i,{col:0,row:0}]))]){
  desktop.identityCells=cells;assert.equal(validateDesktopState(state),false);
 }
});
test('GRID6 Program copy carries binary and host launch after matching success only; forget removes marker',async t=>{
 const root=await mkdtemp(join(tmpdir(),'grid6-markers-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const markers=programBinaries(join(root,'markers'));
 await markers.remember('source','/usr/bin/editor',true);
 const request=stateRequest({schema:'capsule_state_request/v0.2',op:'copy',profile_id:'source',destination_profile_id:'copy',operation_id:'operation',slot_id:'slot-one',credential_copy_confirmed:true});
 const completed=stateEvent({schema:'capsule_state_event/v0.2',op:'copy',profile_id:request.profile_id,operation_id:request.operation_id,slot_id:request.slot_id,event:'completed'});
 for(const result of [{...completed,event:'refused'},{...completed,operation_id:'wrong'},{...completed,slot_id:'other-slot'}]){
  await markers.copyWith(request,async()=>result);assert.equal(await markers.read('copy'),null);
 }
 await assert.rejects(markers.copyWith(request,async()=>{throw Error('CORE_REFUSED');}),/CORE_REFUSED/);
 await markers.copyWith(request,async()=>{assert.equal(await markers.read('copy'),null);return completed;});
 assert.deepEqual(await markers.readLaunch('copy'),{binary:'/usr/bin/editor',hostXpra:true,identityBound:true});
 await markers.forget('copy');assert.equal(await markers.read('copy'),null);
});

test('GRID6 Floating allocation preserves occupied rectangles and only floats newly revealed panels',()=>{
 const rows=[], panels=[],groups=[], positions=new Map();
 const api={width:1200,height:600,panels,groups,getPanel:id=>panels.find(p=>p.id===id),toJSON:()=>({floatingGroups:panels.filter(p=>positions.has(p.id)).map(p=>({data:{views:[p.id]},position:positions.get(p.id)}))}),
 addPanel(options){const group={id:options.id,api:{location:{type:'grid'}}};groups.push(group);const panel={...options,group,api:{setActive(){},setTitle(){},close(){}}};panels.push(panel);return panel;},
 addFloatingGroup(item,opts){const panel=item.group?item:panels.find(p=>p.group===item);panel.group.api.location.type='floating';const left=opts.position.left+(item.group && opts.position.left+opts.width===api.width ? -15 : 0);positions.set(panel.id,{...opts.position,left,width:opts.width,height:opts.height});},addGroup(){const group={api:{location:{type:'grid'}}};groups.push(group);return group;}};
 const windows={state:id=>({floating:positions.has(id),hidden:false}),show(){},hide(){},float(){},dock(){}};
 const grid={cols:3,rows:2};
 const controller=wall.createWallWorkspaceController({floatingGrid:()=>grid,savedCells:()=>({}),projectionView:{getProjection:()=>({rows})}});
 assert(controller.handleReady({api,windows}).ok);
 assert(controller.setPreset('floating').ok);
 for(let i=0;i<6;i++){
  rows.push({id:'surface-'+i,surfaceId:'surface-'+i,profile_id:'identity-'+i,backendLifecycle:'active'});
  assert(controller.revealSurface('surface-'+i,'split').ok);
  const before=JSON.stringify([...positions]);controller.refreshPreset();
  assert.equal(positions.get('panel-surface-'+i).left,(i%3)*400);
  assert.equal(positions.get('panel-surface-'+i).top,Math.floor(i/3)*300);
  assert.equal(JSON.stringify([...positions].slice(0,i)),before);
 }
 const before=JSON.stringify([...positions]);grid.cols=2;controller.refreshPreset();
 assert.equal(JSON.stringify([...positions]),before,'grid controls do not move existing windows');
 assert.equal(controller.beginFloatingDrag(),'floating');controller.refreshPreset();
 assert.equal(JSON.stringify([...positions]),before,'a drag preserves Floating without relaying peers');
 controller.dispose();
});

test('GRID6 copied program opens the selected identity and deleted identity markers are reconciled',async t=>{
 const {installRoleHost}=await import('../electron/roleHost.js');
 const {EventEmitter}=await import('node:events');
 const root=await mkdtemp(join(tmpdir(),'grid6-role-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const markers=programBinaries(join(root,'program-binaries'));
 await markers.remember('source-program',process.execPath,false);
 const states=new Map(),handlers=new Map(),creates=[];
 let rows=[{id:'source-program',browser:'program'}];
 const core={getHumanSurface:id=>states.get(id),async request(message){
  if(message.op==='capsule-state') {rows.push({id:message.request.destination_profile_id,browser:'program'});return stateEvent({schema:'capsule_state_event/v0.2',operation_id:message.request.operation_id,profile_id:message.request.profile_id,slot_id:message.request.slot_id,op:'copy',event:'completed'});}
  creates.push(message);const surface={surface_id:'copied-surface',profile_id:message.params.profile_id,state:'active',control:'agent'};
  states.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
 }};
 const original=core.request;
 const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
 const host=installRoleHost({electron:{ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)}},window:parent,core,
  env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:'{}'},capsuleStates:states,admit:()=>true,readFreeMemoryBytes:async()=>16*1024**3,
  listIdentities:async()=>({ok:true,rows}),provisionProgramIdentity:async()=>({ok:true}),stageMode:async()=>async()=>{}});
 t.after(()=>host.dispose());
 const call=(op,extra={})=>handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op,...extra});
 await call('programs');
 await core.request({op:'capsule-state',request:stateRequest({schema:'capsule_state_request/v0.2',op:'copy',profile_id:'source-program',destination_profile_id:'copied-program',operation_id:'copy-proof',slot_id:'slot-one',credential_copy_confirmed:true})});
 assert.equal(await markers.read('copied-program'),process.execPath);
 const opened=await call('open',{choice:{profileId:'copied-program',role:'agent'}});
 assert.equal(opened.ok,true);assert.equal(creates[0].params.profile_id,'copied-program');
 await call('programs');rows=rows.filter(row=>row.id!=='source-program');await call('programs');
 assert.equal(await markers.read('source-program'),null);
 await host.dispose();assert.equal(core.request,original);
});

test('GRID6 copy acknowledgement remains in the parent panel after it selects the copied identity',async()=>{
 const source=readFileSync(new URL('../src/identities/IdentitiesDialog.vue',import.meta.url),'utf8');
 const fn=source.match(/async function copiedIdentity\(profileId\) \{[\s\S]*?\n\}/)[0];
 const copyStatus={value:''},selectedSlots={value:'source'},calls=[];
 const copied=new Function('copyStatus','selectedSlots','invoke',fn+'; return copiedIdentity;')(copyStatus,selectedSlots,async op=>calls.push(op));
 await copied('copied-program');
 assert.equal(selectedSlots.value,'copied-program');assert.match(copyStatus.value,/Copied.*copied-program/);assert.deepEqual(calls,['list']);
});
