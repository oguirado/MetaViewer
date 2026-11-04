import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as vue from 'vue';
import {parse} from '@vue/compiler-sfc';
import {compileSfc,mountComponent,text,nodes,flush} from './mvui2-terminal-mount.mjs';
import * as values from '../electron/guestCommandValues.js';
import * as rewindControls from '../src/wall/rewindStateControls.js';
import {guestWorkloadTile,validGuestWorkloadTile} from '../src/wall/guestWorkloadTile.js';
import {classifyCapsulePanelParams,createCapsulePanelRouter} from '../src/wall/capsulePanelRouter.js';

// Execute the actual pinned kit normal-script exports; no permissive fake registry.
const kitURL=new URL('../.kit/capsule-ui-kit/src/workspace/DockWorkspace.vue',import.meta.url);
const kitSource=readFileSync(kitURL,'utf8');
let kitScript=parse(kitSource).descriptor.script.content;
kitScript=kitScript.replace("'./layoutProfile.js'",JSON.stringify(new URL('./layoutProfile.js',kitURL).href));
const kit=await import('data:text/javascript;base64,'+Buffer.from(kitScript).toString('base64'));
const snapshot={available:true,busy:false,canCancel:false,uncertain:true,code:'TRANSPORT',revision:2,
 session:{schema:'guest_command_session/v0.2',workload_id:'workload-one',generation:1,owner_id:'actor-one',profile_id:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64',phase:'uncertain',ownership:'held',jobs_started:0,job:null,controls:{cancel:null,stop:null}},stdout:'',stderr:''};
const tile=guestWorkloadTile(snapshot);

test('actual kit admits closed CapsulePanel params; old component and new unknown keys refuse',()=>{
 const row={id:'guest-console-panel:'+tile.id,component:'CapsulePanel',params:{sessionId:tile.id},renderer:'always'};
 assert.equal(kit.buildAddPanelOptions(row).ok,true);
 assert.equal(kit.createPanelRegistry({}).resolveComponentName('GuestWorkloadPanel'),'MissingPanel');
 assert.equal(kit.buildAddPanelOptions({...row,params:{panelKind:'microvm',workloadId:tile.id}}).ok,false);
});

test('admitted real registry renders actual guest panel and Stop for uncertain held ownership',async()=>{
 const Panel=await compileSfc('components/GuestCommandPanel.vue',{'../../electron/guestCommandValues.js':values,'../wall/rewindStateControls.js':rewindControls});
 const Router=createCapsulePanelRouter({...vue,graphical:vue.defineComponent({render(){throw Error('wrong graphical route');}}),rows:()=>[tile],validate:validGuestWorkloadTile,slot:({workload})=>vue.h(Panel,{snapshot:workload.snapshot})});
 const registry=kit.createPanelRegistry({CapsulePanel:Router});
 assert.equal(registry.resolveComponentName('CapsulePanel'),'CapsulePanel');
 const mounted=mountComponent(registry.components.CapsulePanel,{params:{params:{sessionId:tile.id}}});
 try{await flush();assert.match(text(mounted.root),/Guest commands/);assert.match(text(mounted.root),/Stop capsule/);
  const stop=nodes(mounted.root).find(n=>n.tag==='button'&&text(n).includes('Stop capsule'));
  assert.ok(stop);assert.ok(!stop.props.disabled);
 }finally{mounted.app.unmount();}
});

test('legacy graphical params delegate unchanged; malformed routes never invoke either content',async()=>{
 const seen=[];const Graph=vue.defineComponent({props:['params'],setup:p=>()=>{seen.push(p.params);return vue.h('span','graphical');}});
 const Router=createCapsulePanelRouter({...vue,graphical:Graph,rows:()=>[tile],validate:validGuestWorkloadTile,slot:()=>{throw Error('wrong workload route');}});
 const original={params:{capsuleId:'cap-one'},api:{id:'cap-one'}};
 const mounted=mountComponent(Router,{params:original});try{await flush();assert.match(text(mounted.root),/graphical/);assert.equal(vue.toRaw(seen[0]),original);}finally{mounted.app.unmount();}
 let touched=0;const getter={};Object.defineProperty(getter,'params',{get(){touched++;return {capsuleId:'cap-one'};}});
 const inherited=Object.create({params:{capsuleId:'cap-one'}});
 const innerGetter={};Object.defineProperty(innerGetter,'viewMode',{enumerable:true,get(){touched++;return 'microvm';}});
 for(const wrapper of [getter,inherited,{params:innerGetter},{params:{capsuleId:'cap-one',sessionId:tile.id}},{params:{viewMode:'microvm',sessionId:tile.id,extra:true}},{params:{viewMode:123,sessionId:tile.id}},{params:{capsuleId:' cap-one'}}])assert.equal(classifyCapsulePanelParams(wrapper),null);
 assert.equal(touched,0);
});

test('stale or duplicate workload identity shows unavailable and never renders Stop',async()=>{
 for(const rows of [[],[tile,tile]]){
  const Router=createCapsulePanelRouter({...vue,graphical:null,rows:()=>rows,validate:validGuestWorkloadTile,slot:()=>{throw Error('stale slot reached');}});
  const mounted=mountComponent(Router,{params:{params:{sessionId:tile.id}}});
  try{await flush();assert.match(text(mounted.root),/no longer available/);assert.doesNotMatch(text(mounted.root),/Stop capsule/);}finally{mounted.app.unmount();}
 }
});


test('actual kit float/hide/show preserves graphical and MicroVM identities',async()=>{
 const {floatLayoutPanel,createWindowPresentation}=await import('../.kit/capsule-ui-kit/src/workspace/windowPresentation.js');
 for(const initial of [{capsuleId:'cap-one'},{sessionId:tile.id}]){
  const expected=Object.hasOwn(initial,'capsuleId')?'graphical':'microvm';
  assert.equal(classifyCapsulePanelParams(initial)?.kind,expected);
  assert.equal(classifyCapsulePanelParams({params:initial})?.kind,expected);
  const id='panel-one';
  const layout={grid:{root:{type:'leaf',data:{id:'group-one',views:[id],activeView:id}}},panels:{[id]:{params:initial}},floatingGroups:[]};
  const floated=floatLayoutPanel(layout,id,{left:0,top:0,width:100,height:100},{width:100,height:100});
  const panel={id,params:floated.panels[id].params};
  panel.api={location:{type:'floating'},isMaximized:()=>false,updateParameters:patch=>Object.assign(panel.params,patch),setActive:()=>{}};
  const group={id:'group-one',panels:[panel],api:{setVisible:()=>{},location:{type:'grid'}}};panel.group=group;
  const api={panels:[panel],groups:[group],getPanel:key=>key===id?panel:null,getGroup:key=>key===group.id?group:null,toJSON:()=>floated};
  const presentation=createWindowPresentation(api,()=>{});
  assert.equal(classifyCapsulePanelParams({params:panel.params})?.kind,expected);
  presentation.hide(id);
  assert.equal(presentation.state(id).hidden,true);
  assert.equal(classifyCapsulePanelParams({params:panel.params})?.kind,expected);
  presentation.show(id);
  assert.equal(presentation.state(id).hidden,false);
  assert.equal(classifyCapsulePanelParams({params:panel.params})?.kind,expected);
  if(expected==='microvm'){
   const Panel=await compileSfc('components/GuestCommandPanel.vue',{'../../electron/guestCommandValues.js':values,'../wall/rewindStateControls.js':rewindControls});
   const Router=createCapsulePanelRouter({...vue,graphical:null,rows:()=>[tile],validate:validGuestWorkloadTile,slot:({workload})=>vue.h(Panel,{snapshot:workload.snapshot})});
   const mounted=mountComponent(kit.createPanelRegistry({CapsulePanel:Router}).components.CapsulePanel,{params:{params:panel.params}});
   try{await flush();assert.match(text(mounted.root),/Stop capsule/);}finally{mounted.app.unmount();}
  }
 }
});


test('real kit persists both identity variants with presentation metadata',async()=>{
 const {serializeLayoutProfile,decodeAndMigrateLayoutProfile}=await import('../.kit/capsule-ui-kit/src/workspace/layoutProfile.js');
 const {createWallLayout,SCOPE}=await import('../src/wall/layout.js');
 for(const params of [{capsuleId:'cap-one',viewMode:null,slotFolded:false},{sessionId:tile.id,viewMode:null,slotFolded:true}]){
  const profile=structuredClone(createWallLayout(SCOPE,[{id:'cap-one'}]));
  const id=Object.keys(profile.dockview.panels)[0];
  profile.dockview.panels[id].params=params;
  const encoded=serializeLayoutProfile(profile,{expectedScope:SCOPE});
  assert.equal(encoded.ok,true,encoded.reason);
  const decoded=decodeAndMigrateLayoutProfile(encoded.json,{expectedScope:SCOPE});
  assert.equal(decoded.ok,true,decoded.reason);
  assert.deepEqual(decoded.profile.dockview.panels[id].params,params);
  assert.equal(classifyCapsulePanelParams({params:decoded.profile.dockview.panels[id].params})?.kind,Object.hasOwn(params,'capsuleId')?'graphical':'microvm');
 }
});
