import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {parse} from '@vue/compiler-sfc';
const dir=new URL('./.tmp-p18g-wall/',import.meta.url);mkdirSync(dir,{recursive:true});after(()=>rmSync(dir,{recursive:true,force:true}));
const source=readFileSync(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8');
let serial=0;
export async function loadWall(text=source){const path=new URL(`wall-${serial++}.mjs`,dir);writeFileSync(path,parse(text).descriptor.script.content);return import(path.href);}
function fixture(wall){
 const panels=[],closed=[];let snapshot={status:'unavailable',envelope:null};const projection={rows:[]};
 const api={width:0,height:0,groups:[],panels,getPanel:id=>panels.find(p=>p.id===id),addPanel(){throw Error('unused');}};
 const errors=[];const controller=wall.createWallWorkspaceController({projectionView:{getProjection:()=>projection,getSnapshot:()=>snapshot},onLayoutError:e=>errors.push(e)});
 assert.equal(controller.handleReady({api,windows:{state:()=>({}),show(){},hide(){},float(){},dock(){}},revision:1}).ok,true);
 const add=id=>panels.push({id,api:{close(){closed.push(id);panels.splice(panels.findIndex(p=>p.id===id),1);}},group:{}});
 return {controller,api,projection,closed,errors,add,setSnapshot:v=>snapshot=v};
}
test('wall orphan grace starts after delayed authoritative snapshot, resets while unavailable',async()=>{
 const wall=await loadWall();const f=fixture(wall);f.add('panel-late');
 f.controller.refreshPreset(0);f.controller.refreshPreset(30000);assert.deepEqual(f.closed,[]);
 f.setSnapshot({status:'live',stale:false,envelope:{projection:f.projection}});
 f.controller.refreshPreset(30001);f.controller.refreshPreset(35000);assert.deepEqual(f.closed,[]);
 f.projection.rows=[{id:'late',backendLifecycle:'active'}];f.controller.refreshPreset(35001);assert.deepEqual(f.closed,[]);
 f.add('panel-orphan');f.controller.refreshPreset(40000);f.controller.refreshPreset(45000);assert.deepEqual(f.closed,['panel-orphan']);
});
test('periodic layout failure clears preset and emits one typed error',async()=>{
 const wall=await loadWall();const f=fixture(wall);f.add('panel-live');f.projection.rows=[{id:'live',backendLifecycle:'active'}];
 f.setSnapshot({status:'live',envelope:{projection:f.projection}});
 assert.equal(f.controller.setPreset('grid').ok,true);f.api.width=1000;f.api.height=800;
 assert.doesNotThrow(()=>f.controller.refreshPreset());assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'LAYOUT_PRESET_FAILED');
 for(let i=0;i<5;i++)assert.doesNotThrow(()=>f.controller.refreshPreset());assert.equal(f.errors.length,1);
});

test('H34 preset validates every panel before moving any earlier panel',async()=>{
 const wall=await loadWall();const f=fixture(wall);const moved=[];
 for(const id of ['one','two','three']){f.add('panel-'+id);f.projection.rows.push({id,backendLifecycle:'active'});}
 f.api.panels[0].api.moveTo=()=>moved.push('one');f.api.panels[1].api.moveTo=()=>moved.push('two');
 f.api.width=1000;f.api.height=800;assert.equal(f.controller.setPreset('grid').ok,false);assert.deepEqual(moved,[]);
});
test('H35 long open/close sessions retain bounded identity placement history',async()=>{
 const instrumented=source.replace('return Object.freeze({ hasSurfacePanel, handleReady, dispose, revealWorkload, revealSurface,', 'return Object.freeze({ historySizes:()=>[panelIdentities.size,identitySlots.size,panelOrder.length], hasSurfacePanel, handleReady, dispose, revealWorkload, revealSurface,');assert.notEqual(instrumented,source);
 const wall=await loadWall(instrumented),panels=[],projection={rows:[]};
 const api={panels,groups:[],getPanel:id=>panels.find(p=>p.id===id),addPanel:options=>{const panel={...options,group:{id:'home',panels:[]},api:{setActive(){},close(){panels.splice(panels.indexOf(panel),1);}}};panel.group.panels.push(panel);panels.push(panel);return panel;}};
 const c=wall.createWallWorkspaceController({projectionView:{getProjection:()=>projection,getSnapshot:()=>({status:'live',stale:false,envelope:{projection}})}});
 assert(c.handleReady({api,windows:{state:()=>({}),show(){},hide(){},float(){},dock(){}},revision:1}).ok);
 for(let i=0;i<1024;i++){
  const id='surface-'+i;projection.rows=[{id,surfaceId:id,profile_id:'profile-'+i,backendLifecycle:'active'}];
  assert(c.revealSurface(id,'split').ok);assert(c.applyPresentationIntent({type:'close',capsuleId:id}).ok);c.refreshPreset(i);
 }
 assert(c.historySizes().every(n=>n<=256));
});
