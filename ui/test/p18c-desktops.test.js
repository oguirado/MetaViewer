import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse, compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as model from '../electron/desktopLayout.js';
import * as keys from '../electron/desktopShortcuts.js';
import {createWallLayout,SCOPE} from '../src/wall/layout.js';
import {decodeAndMigrateLayoutProfile} from '../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';
import {createHiddenSessionPool} from '../src/surfaces/hiddenSessions.js';
import {createXpraHumanSession} from '../electron/xpraHumanSession.js';
import {CHANNELS} from '../electron/main.js';
import {stageElectronModules} from '../tools/package.js';
import {pathToFileURL} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const read = file => readFileSync(new URL(file,import.meta.url),'utf8');
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const tick = async () => {await vue.nextTick();await sleep(5);await vue.nextTick();};
const validLayout = value => decodeAndMigrateLayoutProfile(value,{expectedScope:SCOPE}).ok;
let serial=0;
async function altered(file,from,to) {
  const source=read(file),mutant=source.replace(from,to);assert.notEqual(source,mutant);
  return import('data:text/javascript;base64,'+Buffer.from(mutant).toString('base64')+'#'+(++serial));
}
const rows=[{id:'h',backendLifecycle:'active'},{id:'a',backendLifecycle:'active'}];
function filterOracle(api) {
  const state=api.createDesktopState();api.assignSurface(state,'h','human');api.assignSurface(state,'a','agent');
  assert.deepEqual(api.desktopRows(state,rows,'human',1).map(r=>r.id),['h']);
  assert.deepEqual(api.desktopRows(state,rows,'agent',1).map(r=>r.id),['a']);
}
test('P18C each view admits only matching-mode capsules',()=>filterOracle(model));
test('P18C mutant: dropping view filtering is rejected',async()=>{
  const api=await altered('../electron/desktopLayout.js','state.assignments[row.id]?.view === view && ','');
  assert.throws(()=>filterOracle(api),{code:'ERR_ASSERTION'});
});
function desktopOracle(api) {
  const state=api.createDesktopState();api.assignSurface(state,'h','human');
  assert.equal(api.addDesktop(state),2);api.assignSurface(state,'new','human');
  assert.deepEqual(state.assignments.new,{view:'human',desktop:2});
  assert.equal(api.removeDesktop(state,'human',2),false);
  assert.equal(api.addDesktop(state),3);assert.equal(api.removeDesktop(state,'human',3),true);
  assert.equal(api.addDesktop(state),4); // Removed numbers are never reused.
  assert.deepEqual(state.views.agent.desktops.map(d=>d.id),[1]);
}
test('P18C numbered desktops allocate monotonically and new capsules use their matching active desktop',()=>desktopOracle(model));
test('P18C mutant: new capsule forced to desktop 1 is rejected',async()=>{
  const api=await altered('../electron/desktopLayout.js','desktop:state.views[view].active','desktop:1');
  assert.throws(()=>desktopOracle(api),{code:'ERR_ASSERTION'});
});
function moveOracle(api) {
  const state=api.createDesktopState();api.assignSurface(state,'h','human');api.addDesktop(state,'agent');
  api.assignSurface(state,'h','agent');assert.deepEqual(state.assignments.h,{view:'agent',desktop:2});
  assert.deepEqual(api.desktopRows(state,rows,'human',1),[]);
  assert.deepEqual(api.desktopRows(state,rows,'agent',2).map(r=>r.id),['h']);
}
test('P18C a mode change moves a capsule to the destination active desktop',()=>moveOracle(model));
test('P18C mutant: preserving the old mode home is rejected',async()=>{
  const api=await altered('../electron/desktopLayout.js','if (!home || home.view !== view)','if (!home)');
  assert.throws(()=>moveOracle(api),{code:'ERR_ASSERTION'});
});
function persistenceOracle(api) {
  const state=api.createDesktopState();api.addDesktop(state);api.assignSurface(state,'h','human');
  state.activeView='agent';api.addDesktop(state);api.assignSurface(state,'a','agent');
  state.views.human.desktops[1].layout=createWallLayout(SCOPE,[rows[0]]);
  state.views.human.desktops[1].preset='grid';
  state.views.agent.desktops[1].layout=createWallLayout(SCOPE,[rows[1]]);
  const restored=JSON.parse(JSON.stringify(state));assert(api.validateDesktopState(restored,validLayout));
  assert.deepEqual(restored,state);assert.equal(restored.views.human.active,2);assert.equal(restored.activeView,'agent');
  restored.views.agent.desktops[1].layout=state.views.human.desktops[1].layout;
  assert.equal(api.validateDesktopState(restored,validLayout),false,'cross-desktop panel aliases are refused');
}
test('P18C views, active desktops, presets and layouts round-trip with strict ownership',()=>persistenceOracle(model));
test('P18C mutant: accepting cross-desktop panel aliases is rejected',async()=>{
  const api=await altered('../electron/desktopLayout.js',"if (typeof id !== 'string' || panels.has(id) || state.assignments[id]?.view !== view ||\n          state.assignments[id]?.desktop !== desktop.id) return false;",'if (false) return false;');
  assert.throws(()=>persistenceOracle(api),{code:'ERR_ASSERTION'});
});
test('P18C prune preserves surviving geometry and leaves a valid empty layout',()=>{
  const layout=createWallLayout(SCOPE,rows),before=JSON.stringify(layout);
  const pruned=model.pruneDesktopLayout(layout,id=>id==='h');assert(validLayout(pruned));
  assert.deepEqual(Object.keys(pruned.dockview.panels),['panel-h']);assert.equal(JSON.stringify(layout),before);
  assert(validLayout(model.pruneDesktopLayout(layout,()=>false)));
});
test('P18C a floating-only desktop keeps its geometry without aliasing the empty dock group',()=>{
  const layout=JSON.parse(JSON.stringify(createWallLayout(SCOPE,[rows[0]])));
  layout.dockview.grid.root={type:'leaf',data:{id:'root-empty',views:[]}};
  layout.dockview.floatingGroups=[{data:{id:'desktop-empty',views:['panel-h'],activeView:'panel-h'},position:{left:20,top:30,width:600,height:400}}];
  layout.dockview.activeGroup='desktop-empty';assert(validLayout(layout));
  const pruned=model.pruneDesktopLayout(layout,()=>true);assert(validLayout(pruned));
  assert.deepEqual(pruned.dockview.floatingGroups,layout.dockview.floatingGroups);
  assert.notEqual(pruned.dockview.grid.root.data.id,'desktop-empty');
});
test('P18C packaged bridge saves and reloads the desktop envelope and refuses corrupt embedded layout',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'p18c-layout-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const app=join(directory,'app');await stageElectronModules(app);
  const {createLayoutBridge}=await import(pathToFileURL(join(app,'electron/main.js')));
  const storage=await mkdtemp(join(tmpdir(),'p18c-storage-'));t.after(()=>rm(storage,{recursive:true,force:true}));
  const bridge=createLayoutBridge({directory:storage}),save=bridge.find(e=>e.channel===CHANNELS.save),load=bridge.find(e=>e.channel===CHANNELS.load);
  const state=model.createDesktopState();model.assignSurface(state,'h','human');state.views.human.desktops[0].layout=createWallLayout(SCOPE,[rows[0]]);
  assert.equal(model.validateDesktopState(state),false,'an absent layout validator cannot admit embedded profiles');
  const raw=JSON.stringify(state);await save.invoke(raw);assert.equal(await load.invoke(),raw);
  const corrupt=JSON.parse(raw);corrupt.views.human.desktops[0].layout.scope.product='foreign';await assert.rejects(save.invoke(JSON.stringify(corrupt)),/LAYOUT_CONTRACT_INVALID/);
});
function shortcutOracle(api) {
  const executed=[],captured=new Set(),window={webContents:{executeJavaScript:async source=>executed.push(source)}};
  for (const key of ['Tab','1','9']) {
    let prevented=0;
    assert.equal(api.interceptDesktopShortcut({preventDefault:()=>prevented++},{type:'keyDown',key,control:true,code:key},window,captured),true);
    assert.equal(prevented,1);assert.equal(captured.size,1);
    assert.equal(api.interceptDesktopShortcut({preventDefault:()=>prevented++},{type:'keyUp',key,control:false,code:key},window,captured),true);
    assert.equal(prevented,2);assert.equal(captured.size,0);
  }
  assert.equal(executed.length,3);assert(executed.every(s=>s.includes('metaviewer:desktop-shortcut')));
  assert.equal(api.desktopShortcut({key:'2',ctrlKey:true}).desktop,2);
  assert.equal(api.desktopShortcut({key:'Tab',ctrlKey:true}).type,'toggle');
  for (const input of [{key:'1'},{key:'0',control:true},{key:'1',control:true,alt:true},{key:'Tab',control:true,meta:true}]) assert.equal(api.desktopShortcut(input),null);
}
test('P18C native shortcuts consume down and up, dispatch to app, and spare normal remote keys',()=>shortcutOracle(keys));
test('P18C mutant: forwarding app shortcuts to xpra is rejected',async()=>{
  const api=await altered('../electron/desktopShortcuts.js','  event.preventDefault();','  // mutant: input forwarded');
  assert.throws(()=>shortcutOracle(api),{code:'ERR_ASSERTION'});
});

async function compile(source,deps={}) {
  const {descriptor}=parse(source);let code=compileScript(descriptor,{id:'p18c-'+(++serial),inlineTemplate:true}).content;
  globalThis.__p18cDeps=deps;
  code=code.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm,(line,binding,q,path)=>path==='vue'
    ? line.replace(/(['"])vue\1/,JSON.stringify(import.meta.resolve('vue')))
    : `const ${binding.replace(/\bas\b/g,':')} = globalThis.__p18cDeps[${JSON.stringify(path)}];`);
  return (await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64')+'#'+serial)).default;
}
function mount(Component,props,providers={}) {
  const node=tag=>({tag,children:[],props:{},style:{},parent:null,
    getBoundingClientRect:()=>({x:10,y:10,width:700,height:500}),getClientRects:()=>[1]});
  const renderer=vue.createRenderer({createElement:node,createComment:()=>node('#comment'),createText:text=>({...node('#text'),text}),
    setText(n,text){n.text=text;},setElementText(n,text){n.text=text;n.children=[];},
    patchProp(n,key,old,value){n.props[key]=value;},insert(n,parent,anchor){if(n.parent)this.remove(n);n.parent=parent;const at=parent.children.indexOf(anchor);parent.children.splice(at<0?parent.children.length:at,0,n);},
    remove(n){if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);n.parent=null;},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1],setScopeId(){},querySelector:()=>null});
  const root=node('root'),app=renderer.createApp(Component,props);for(const [key,value] of Object.entries(providers))app.provide(key,value);
  return {root,app,vm:app.mount(root)};
}
function environment() {
  const before={window:globalThis.window,document:globalThis.document,api:globalThis.metaviewerRoles};
  const target=new EventTarget();globalThis.window=target;
  globalThis.document={body:{hasAttribute:()=>false},getElementById:()=>null,addEventListener(){},removeEventListener(){}};
  return ()=>{globalThis.window=before.window;globalThis.document=before.document;globalThis.metaviewerRoles=before.api;};
}
async function hideOracle(source) {
  const restore=environment(),calls=[];let live;
  const session=createXpraHumanSession({role:'human',setReadonly:async()=>true,
    openBridge:async()=>({close:async()=>calls.push('bridge-close')}),
    showView:async()=>({resize(){},setVisible:value=>calls.push(['visible',value]),close:async()=>calls.push('view-close')}),closeTrace(){}});
  await session.open();
  globalThis.metaviewerRoles={status:async()=>({role:'human',view:{state:'ready'}}),mount:async()=>({ok:true}),resize:async()=>({ok:true}),
    visibility:async(_id,value)=>{session.setVisible(value);return {ok:true};},close:async()=>{calls.push('close');await session.close();return {ok:true};}};
  try {
    const Role=await compile(source),props=vue.reactive({surfaceId:'h',presentationActive:true});
    const Host=vue.defineComponent({setup:()=>()=>vue.h(Role,props)});
    live=mount(Host,{}, {hiddenSessionPool:createHiddenSessionPool()});await tick();
    for(let i=0;i<5;i++){props.presentationActive=false;await tick();props.presentationActive=true;await tick();}
    assert.equal(calls.filter(c=>typeof c==='string').length,0);assert.equal(calls.filter(c=>c[0]==='visible'&&!c[1]).length,5);
    assert(session.active);
  } finally {live?.app.unmount();await session.close();restore();}
}
test('P18C five view switches hide human sessions without closing the session or bridge',()=>hideOracle(read('../src/surfaces/RoleSurface.vue')));
test('P18C mutant: revoking instead of hiding a human view is rejected',async()=>{
  const source=read('../src/surfaces/RoleSurface.vue'),mutant=source.replace('const reply = await api.visibility(props.surfaceId,false);','await revoke(); const reply = {ok:true};');
  assert.notEqual(source,mutant);await assert.rejects(()=>hideOracle(mutant),{code:'ERR_ASSERTION'});
});

async function workspaceFixture(run,source=read('../src/wall/DesktopWorkspace.vue'),initial=null) {
  const restore=environment();let live;const saved=[],mounted=[],retired=[];
  let stored=initial;
  const Wall=vue.defineComponent({props:['projectionView','storage'],emits:['ready','wall-settled'],setup(p,ctx){
    const identity=++serial;mounted.push(identity);const revision=vue.ref(0),stop=p.projectionView.subscribe(()=>revision.value++);
    ctx.expose({revealSurface:id=>({ok:p.projectionView.getProjection().rows.some(r=>r.id===id)}),setPreset:()=>({ok:true}),applyPresentationIntent:()=>({ok:true})});
    vue.onMounted(()=>{ctx.emit('ready');ctx.emit('wall-settled');});vue.onBeforeUnmount(()=>{stop();retired.push(identity);});
    return()=>{void revision.value;return vue.h('section',{},p.projectionView.getProjection().rows.map(r=>vue.h('article',{id:r.id},r.id)));};
  }});
  try {
    const Workspace=await compile(source,{'./WallWorkspace.vue':Wall,'./layout.js':{createWallLayout},'../../.kit/capsule-ui-kit/src/workspace/layoutProfile.js':{decodeAndMigrateLayoutProfile},'../../electron/desktopLayout.js':model,'../../electron/desktopShortcuts.js':keys});
    const props=vue.reactive({storage:{readRaw:async()=>stored,writeAtomic:async raw=>{stored=raw;saved.push(JSON.parse(raw));}},scope:SCOPE,defaultProfile:createWallLayout(SCOPE),projectionView:{getSnapshot:()=>({envelope:{projection:{rows}}})},rows:[...rows],modes:{h:'human',a:'agent'},intentBuilders:{},controlRegistry:{},scheduler:{},tileScheduler:{}});
    live=mount(Workspace,props);await tick();await tick();
    await run({vm:live.vm,props,saved,mounted,retired,getStored:()=>stored});
  } finally {live?.app.unmount();restore();}
}
test('P18C actual desktop host keeps inactive walls mounted, routes openings, and persists navigation',()=>workspaceFixture(async({vm,props,saved,mounted,retired})=>{
  assert.equal(mounted.length,2);assert.equal(vm.addDesktop(),2);await tick();
  props.rows.push({id:'h2',backendLifecycle:'active'});props.modes.h2='human';await tick();
  assert.deepEqual(saved.at(-1).assignments.h2,{view:'human',desktop:2});
  for(let i=0;i<5;i++){vm.selectView('agent');await tick();vm.selectView('human');await tick();}
  assert.equal(retired.length,0);assert.equal(mounted.length,3);
  await vm.followSurface('h','agent');await tick();
  assert.equal(saved.at(-1).activeView,'agent');assert.deepEqual(saved.at(-1).assignments.h,{view:'agent',desktop:1});
  assert.equal(vm.removeDesktop(1),false);
}));
test('P18C actual host restores independent desktops and active view after remount',async()=>{
  let raw;
  await workspaceFixture(async({vm,getStored})=>{vm.addDesktop();vm.selectView('agent');vm.addDesktop();await tick();raw=getStored();});
  await workspaceFixture(async({mounted,saved})=>{assert.equal(mounted.length,4);assert.equal(saved.at(-1).activeView,'agent');assert.equal(saved.at(-1).views.human.active,2);},undefined,raw);
});
test('P18C actual host consumes Ctrl+Tab and Ctrl+number in capture phase',()=>workspaceFixture(async({vm,saved})=>{
  vm.addDesktop();await tick();
  const send=key=>{const event=new Event('keydown',{cancelable:true});Object.defineProperties(event,{key:{value:key},ctrlKey:{value:true}});window.dispatchEvent(event);assert(event.defaultPrevented);};
  send('1');await tick();assert.equal(saved.at(-1).views.human.active,1);
  const release=new Event('keyup',{cancelable:true});Object.defineProperties(release,{key:{value:'1'},ctrlKey:{value:false}});
  window.dispatchEvent(release);assert(release.defaultPrevented,'the key-up stays captured after Ctrl is released');
  send('Tab');await tick();assert.equal(saved.at(-1).activeView,'agent');
}));
test('P18C a view selected during asynchronous layout loading takes precedence after restore',async()=>{
  let resolve;const pending=new Promise(done=>resolve=done);
  await workspaceFixture(async({vm,saved})=>{
    vm.selectView('agent');resolve(null);await tick();await tick();assert.equal(saved.at(-1).activeView,'agent');
  },undefined,pending);
});
test('P18C mutant: remounting walls on view switches is rejected',async()=>{
  const source=read('../src/wall/DesktopWorkspace.vue'),mutant=source.replace(':key="key"',':key="key + state.activeView"');
  assert.notEqual(source,mutant);
  await assert.rejects(()=>workspaceFixture(async({vm,retired})=>{
    vm.selectView('agent');await tick();vm.selectView('human');await tick();assert.equal(retired.length,0);
  },mutant),{code:'ERR_ASSERTION'});
});
