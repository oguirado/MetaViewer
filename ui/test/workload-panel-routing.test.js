import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as vue from 'vue';
import {renderToString} from '@vue/server-renderer';
import {parse} from '@vue/compiler-sfc';
import {classifyCapsulePanelParams,createCapsulePanelRouter} from '../src/wall/workloadPanelParams.js';
import {floatLayoutPanel,createWindowPresentation} from '../.kit/capsule-ui-kit/src/workspace/windowPresentation.js';
const source=readFileSync(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8');
const normal=parse(source).descriptor.script.content.replace(/from ['"]vue['"]/,`from ${JSON.stringify(import.meta.resolve('vue'))}`);
const {createWallWorkspaceController}=await import('data:text/javascript;base64,'+Buffer.from(normal).toString('base64'));
const kitURL=new URL('../.kit/capsule-ui-kit/src/workspace/DockWorkspace.vue',import.meta.url);
const script=parse(readFileSync(kitURL,'utf8')).descriptor.script.content.replace("'./layoutProfile.js'",JSON.stringify(new URL('./layoutProfile.js',kitURL).href));
const kit=await import('data:text/javascript;base64,'+Buffer.from(script).toString('base64'));
const row=Object.freeze({id:'workload-one',title:'Owned workload'});
const valid=x=>x===row;

test('actual closed kit admits workload routing and rejects old panel kind/unknown params',async()=>{
 const content=createCapsulePanelRouter({...vue,graphical:vue.defineComponent({render:()=>vue.h('span','Graphical')}),rows:()=>[row],validate:valid,slot:({workload})=>vue.h('p',workload.title)});
 const registry=kit.createPanelRegistry({CapsulePanel:content});
 assert.equal(registry.resolveComponentName('GuestWorkloadPanel'),'MissingPanel');
 const options={id:'workload-panel:workload-one',component:'CapsulePanel',params:{sessionId:row.id},renderer:'always'};
 assert.equal(kit.buildAddPanelOptions(options).ok,true);
 assert.equal(kit.buildAddPanelOptions({...options,params:{workloadId:row.id}}).ok,false);
 const rendered=await renderToString(vue.createSSRApp(registry.components.CapsulePanel,{params:{params:options.params}}));
 assert.match(rendered,/Owned workload/);
 const graphical=await renderToString(vue.createSSRApp(content,{params:{params:{capsuleId:'cap-one'}}}));assert.match(graphical,/Graphical/);
});

test('controller is inert by default and creates only validated workload presentation',()=>{
 const added=[],panels=new Map();const api={panels:[],groups:[],getPanel:id=>panels.get(id),addPanel:p=>{added.push(p);const panel={id:p.id,api:{setActive(){}}};panels.set(p.id,panel);return panel;}};
 const options={projectionView:{getProjection:()=>({rows:[]})},workloadTiles:()=>[row]};
 const absent=createWallWorkspaceController(options);assert.equal(absent.revealWorkload(row.id).ok,false);
 const controller=createWallWorkspaceController({...options,validateWorkloadTile:valid});assert.equal(controller.revealWorkload(row.id).ok,false);
 assert.equal(controller.handleReady({api,windows:{state:()=>({hidden:false}),show(){},hide(){},float(){},dock(){}},revision:1}).ok,true);
 assert.equal(controller.revealWorkload('foreign').ok,false);assert.equal(controller.revealWorkload(row.id).ok,true);assert.equal(controller.revealWorkload(row.id).ok,true);
 assert.equal(added.length,1);assert.equal(added[0].component,'CapsulePanel');assert.deepEqual(added[0].params,{sessionId:row.id});controller.dispose();absent.dispose();
});

test('actual kit float/hide/show preserves both identities; parser refuses mixed and accessor data',()=>{
 for(const initial of [{capsuleId:'cap-one'},{sessionId:row.id}]){
  const kind=Object.hasOwn(initial,'capsuleId')?'graphical':'workload';
  assert.equal(classifyCapsulePanelParams(initial).kind,kind);
  const id='panel-one',layout={grid:{root:{type:'leaf',data:{id:'group-one',views:[id],activeView:id}}},panels:{[id]:{params:initial}},floatingGroups:[]};
  const floated=floatLayoutPanel(layout,id,{left:0,top:0,width:100,height:100},{width:100,height:100});
  const panel={id,params:floated.panels[id].params};panel.api={location:{type:'floating'},isMaximized:()=>false,updateParameters:p=>Object.assign(panel.params,p),setActive(){}};
  const group={id:'group-one',panels:[panel],api:{setVisible(){},location:{type:'grid'}}};panel.group=group;
  const presentation=createWindowPresentation({panels:[panel],groups:[group],getPanel:()=>panel,getGroup:()=>group,toJSON:()=>floated},()=>{});
  assert.equal(classifyCapsulePanelParams({params:panel.params}).kind,kind);presentation.hide(id);assert.equal(classifyCapsulePanelParams({params:panel.params}).kind,kind);presentation.show(id);assert.equal(classifyCapsulePanelParams({params:panel.params}).kind,kind);
 }
 let reads=0;const accessor={};Object.defineProperty(accessor,'params',{get(){reads++;return {sessionId:row.id};}});
 for(const p of [accessor,Object.create({params:{sessionId:row.id}}),{params:{capsuleId:'cap',sessionId:row.id}},{params:{sessionId:row.id,extra:1}},{params:{sessionId:row.id,slotFolded:'yes'}}])assert.equal(classifyCapsulePanelParams(p),null);
 assert.equal(reads,0);
});
