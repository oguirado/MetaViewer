// Remembered Grid6 cells and capsule display names, driven through the real
// DesktopWorkspace SFC (compiled, custom renderer) and the WallWorkspace controller.
// The wall child is a stub that records what DesktopWorkspace hands to each desktop.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as vue from 'vue';
import {compileSfc, flush, rendererElement} from './mvui2-terminal-mount.mjs';
import * as wallLayout from '../src/wall/layout.js';
import * as layoutProfile from '../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';
import * as desktopLayout from '../electron/desktopLayout.js';
import * as desktopShortcuts from '../electron/desktopShortcuts.js';

const source=readFileSync(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8');
const script=source.match(/<script>([\s\S]*?)<\/script>/)[1];
const wall=await import(`data:text/javascript;base64,${Buffer.from(script.replace(/import .* from 'vue';/,'const defineComponent = value=>value; const h=()=>{};')).toString('base64')}`);

/** One record per mounted desktop wall: its live props and its emit. */
const walls=[];
const WallStub=vue.defineComponent({
  inheritAttrs:false,
  props:['projectionView','storage','identityCells','snapGrid','hidden'],
  emits:['ready','snap-grid-change','custom-layout'],
  setup(props,ctx){
    const entry={props,emit:ctx.emit};walls.push(entry);
    vue.onBeforeUnmount(()=>walls.splice(walls.indexOf(entry),1));
    return ()=>vue.h('section');
  },
});
const Desktop=await compileSfc('wall/DesktopWorkspace.vue',{
  './WallWorkspace.vue':WallStub,
  './layout.js':wallLayout,
  '../../.kit/capsule-ui-kit/src/workspace/layoutProfile.js':layoutProfile,
  '../../electron/desktopLayout.js':desktopLayout,
  '../../electron/desktopShortcuts.js':desktopShortcuts,
});

/** @param {Array<any>} rows @param {string|null} saved */
async function mountDesktop(t,rows,saved=null){
  globalThis.window??={};
  for(const name of ['addEventListener','removeEventListener'])globalThis.window[name]??=()=>{};
  const writes=[], exposed=vue.ref(null), root={children:[]};
  const projection={rows};
  const props={
    storage:{readRaw:async()=>saved,writeAtomic:async(/** @type {string} */ json)=>{writes.push(JSON.parse(json));}},
    scope:wallLayout.SCOPE, defaultProfile:wallLayout.createWallLayout(),
    projectionView:{getProjection:()=>projection,getSnapshot:()=>({status:'live',stale:false,envelope:{projection}}),subscribe:()=>()=>{}},
    intentBuilders:{}, controlRegistry:{}, scheduler:{}, tileScheduler:{},
    rows, modes:Object.fromEntries(rows.map(row=>[row.id,'agent'])),
  };
  const renderer=vue.createRenderer({
    createElement:rendererElement, createText:text=>({text}), createComment:text=>({text}),
    insert(node,parent){node.parent=parent;parent.children.push(node);},
    remove(node){const list=node.parent?.children;if(list)list.splice(list.indexOf(node),1);},
    setText(node,text){node.text=text;}, setElementText(node,text){node.text=text;},
    patchProp(node,key,_old,value){node.props[key]=value;}, parentNode:node=>node.parent, nextSibling:()=>null, setScopeId(){},
  });
  const app=renderer.createApp({setup:()=>()=>vue.h(Desktop,{...props,ref:exposed})});
  app.mount(root);
  t.after(()=>app.unmount());
  await flush();
  const active=walls.find(entry=>entry.props.hidden===false);
  assert.ok(active,'the active desktop mounts one wall');
  return {active,exposed,writes};
}
const row=(id,profile,title)=>({id,surfaceId:id,profile_id:profile,title,backendLifecycle:'active'});
/** A saved Floating layout with one capsule panel at an absolute position on a 1200x600 wall. */
function floatingLayout(surfaceId,left,top){
  const layout=structuredClone(wallLayout.createWallLayout());
  layout.dockview.grid.width=1200;layout.dockview.grid.height=600;
  layout.dockview.panels={['panel-'+surfaceId]:{id:'panel-'+surfaceId,contentComponent:'capsule',title:surfaceId,params:{capsuleId:surfaceId}}};
  layout.dockview.floatingGroups=[{data:{id:'float-'+surfaceId,views:['panel-'+surfaceId],activeView:'panel-'+surfaceId},position:{left,top,width:400,height:300}}];
  return JSON.stringify(layout);
}

test('V026 rename reaches the tile title the wall renders, live and after a restart',async t=>{
  const {active,exposed,writes}=await mountDesktop(t,[row('surface-a','identity-a','Old')]);
  const projected=()=>active.props.projectionView.getProjection().rows.find(item=>item.id==='surface-a')?.title;
  const snapshot=()=>active.props.projectionView.getSnapshot().envelope.projection.rows.find(item=>item.id==='surface-a')?.title;
  assert.equal(projected(),'Old');
  // Negative control: an invalid label is refused and the tile keeps its title.
  assert.equal(await exposed.value.renameCapsule('surface-a','Bad\u0007name'),false);
  assert.equal(projected(),'Old');
  assert.equal(await exposed.value.renameCapsule('surface-a','Editor'),true);
  assert.equal(projected(),'Editor');
  assert.equal(snapshot(),'Editor');
  const saved=writes.at(-1);
  assert.equal(saved.labels['identity-a'],'Editor');
  // Restart: a fresh workspace reads the saved state and titles the same tile.
  for(const entry of [...walls])walls.splice(walls.indexOf(entry),1);
  const again=await mountDesktop(t,[row('surface-b','identity-a','Old')],JSON.stringify(saved));
  assert.equal(again.active.props.projectionView.getProjection().rows.find(item=>item.id==='surface-b')?.title,'Editor');
});

test('V026 a snap commit records the identity cell of the dropped capsule',async t=>{
  const {active,writes}=await mountDesktop(t,[row('surface-a','identity-0','Browser')]);
  active.emit('snap-grid-change',{cols:3,rows:2});
  await flush();
  assert.deepEqual(active.props.snapGrid,{cols:3,rows:2});
  await active.props.storage.writeAtomic(floatingLayout('surface-a',800,300));
  await flush();
  assert.deepEqual({...active.props.identityCells['identity-0']},{col:2,row:1});
  assert.deepEqual(writes.at(-1).views.agent.desktops[0].identityCells,{'identity-0':{col:2,row:1}});
  // Negative control: a drop on another cell replaces the remembered cell.
  await active.props.storage.writeAtomic(floatingLayout('surface-a',400,0));
  await flush();
  assert.deepEqual({...active.props.identityCells['identity-0']},{col:1,row:0});
  assert.deepEqual(writes.at(-1).views.agent.desktops[0].identityCells,{'identity-0':{col:1,row:0}});
});

test('V026 reopening an identity places it in its remembered cell, others take the first free cell',()=>{
  const rows=[], panels=[], groups=[], positions=new Map();
  const api={width:1200,height:600,panels,groups,getPanel:id=>panels.find(p=>p.id===id),toJSON:()=>({floatingGroups:panels.filter(p=>positions.has(p.id)).map(p=>({data:{views:[p.id]},position:positions.get(p.id)}))}),
    addPanel(options){const group={id:options.id,api:{location:{type:'grid'}}};groups.push(group);const panel={...options,group,api:{setActive(){},setTitle(){},close(){}}};panels.push(panel);return panel;},
    addFloatingGroup(item,opts){const panel=item.group?item:panels.find(p=>p.group===item);panel.group.api.location.type='floating';positions.set(panel.id,{...opts.position,width:opts.width,height:opts.height});},
    addGroup(){const group={api:{location:{type:'grid'}}};groups.push(group);return group;}};
  const windows={state:id=>({floating:positions.has(id),hidden:false}),show(){},hide(){},float(){},dock(){}};
  const controller=wall.createWallWorkspaceController({floatingGrid:()=>({cols:3,rows:2}),savedCells:()=>({'identity-0':{col:2,row:1}}),projectionView:{getProjection:()=>({rows})}});
  assert(controller.handleReady({api,windows}).ok);
  assert(controller.setPreset('floating').ok);
  rows.push(row('surface-0','identity-0','Browser'));
  assert(controller.revealSurface('surface-0','split').ok);
  controller.refreshPreset();
  const remembered=positions.get('panel-surface-0');
  assert.equal(remembered.left,800);assert.equal(remembered.top,300);
  // Negative control: an identity without a remembered cell takes the first free cell.
  rows.push(row('surface-1','identity-1','Notes'));
  assert(controller.revealSurface('surface-1','split').ok);
  controller.refreshPreset();
  const fresh=positions.get('panel-surface-1');
  assert.equal(fresh.left,0);assert.equal(fresh.top,0);
  controller.dispose();
});
