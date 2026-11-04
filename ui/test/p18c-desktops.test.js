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
  assert.equal(api.addDesktop(state),3); // Desktop numbers are positional.
  assert.deepEqual(state.views.agent.desktops.map(d=>d.id),[1]);
}
test('P18C numbered desktops reuse the removed final position and new capsules use their matching active desktop',()=>desktopOracle(model));
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
function emptyRestoreOracle(api) {
  const state=api.createDesktopState();api.addDesktop(state);
  for(const view of api.VIEWS)for(const desktop of state.views[view].desktops) {
    desktop.layout=api.pruneDesktopLayout(createWallLayout(SCOPE),()=>false);
    assert.equal(desktop.layout.dockview.grid.root.type,'branch','Dockview runtime requires a branch root');
  }
  const restored=JSON.parse(JSON.stringify(state));
  assert(api.validateDesktopState(restored,validLayout));
  api.assignSurface(restored,'h2','human');
  assert.deepEqual(api.desktopRows(restored,[{id:'h2'}],'human',2),[{id:'h2'}]);
  const layout=restored.views.human.desktops[1].layout;
  layout.dockview.grid.root={type:'leaf',data:{id:'desktop-empty',views:[]}};
  const original=JSON.stringify(layout),normalized=api.normalizeDesktopLayout(layout);
  assert.equal(normalized.dockview.grid.root.type,'branch');
  assert.deepEqual(normalized.dockview.grid.root.data,[layout.dockview.grid.root]);
  assert.equal(JSON.stringify(layout),original,'normalization must not mutate its input');
  assert(validLayout(normalized));
}
test('P18C restored empty desktop layouts are executable by Dockview and admit desktop 2 assignments',()=>emptyRestoreOracle(model));
test('P18C mutant: persisting the original leaf-root empty grid is rejected',async()=>{
  const api=await altered('../electron/desktopLayout.js',"{type:'branch',size,data:[{type:'leaf',size,data:{id,views:[]}}]}","{type:'leaf',data:{id,views:[]}}");
  assert.throws(()=>emptyRestoreOracle(api),{code:'ERR_ASSERTION'});
});
test('P18C normalization preserves a populated legacy leaf and its floating geometry',()=>{
  const layout=JSON.parse(JSON.stringify(createWallLayout(SCOPE,[rows[0]])));
  layout.dockview.grid.root=layout.dockview.grid.root.data[0];
  const expected=JSON.parse(JSON.stringify(layout));
  const normalized=model.normalizeDesktopLayout(layout);
  assert.deepEqual(normalized.dockview.grid.root.data,[expected.dockview.grid.root]);
  assert.deepEqual(normalized.dockview.panels,expected.dockview.panels);
  assert.equal(normalized.dockview.activeGroup,expected.dockview.activeGroup);
  assert.deepEqual(normalized.savedWallPlacements,expected.savedWallPlacements);
  assert.deepEqual(model.normalizeDesktopLayout(normalized),normalized,'normalization is idempotent');
});
test('P18C a floating-only desktop keeps its geometry without aliasing the empty dock group',()=>{
  const layout=JSON.parse(JSON.stringify(createWallLayout(SCOPE,[rows[0]])));
  layout.dockview.grid.root={type:'leaf',data:{id:'root-empty',views:[]}};
  layout.dockview.floatingGroups=[{data:{id:'desktop-empty',views:['panel-h'],activeView:'panel-h'},position:{left:20,top:30,width:600,height:400}}];
  layout.dockview.activeGroup='desktop-empty';assert(validLayout(layout));
  const pruned=model.pruneDesktopLayout(layout,()=>true);assert(validLayout(pruned));
  assert.deepEqual(pruned.dockview.floatingGroups,layout.dockview.floatingGroups);
  assert.equal(pruned.dockview.grid.root.type,'branch');
  assert.notEqual(pruned.dockview.grid.root.data[0].data.id,'desktop-empty');
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

async function workspaceFixture(run,source=read('../src/wall/DesktopWorkspace.vue'),initial=null, overrides={}, beforeLoad=()=>{}) {
  const restore=environment();let live;const saved=[],mounted=[],retired=[],presetCalls=[],presetReplies=new Map(),reveals=[],panels=new Map(),closePanels=new Map();
  let stored=initial;
  const Wall=vue.defineComponent({props:['projectionView','storage'],emits:['ready','wall-settled','panel-closed'],setup(p,ctx){
    const key=ctx.attrs['data-desktop'];panels.set(key,new Set());closePanels.set(key,id=>{panels.get(key).delete(id);ctx.emit('panel-closed',{capsuleId:id});});
    const identity=++serial;mounted.push(identity);const revision=vue.ref(0),stop=p.projectionView.subscribe(()=>revision.value++);
    ctx.expose({hasSurfacePanel:id=>panels.get(key).has(id),revealSurface:id=>{reveals.push({key,id});const ok=p.projectionView.getProjection().rows.some(r=>r.id===id);if(ok)panels.get(key).add(id);return {ok};},setPreset:preset=>{const key=ctx.attrs['data-desktop'];presetCalls.push({key,preset});return presetReplies.get(key)??{ok:true};},applyPresentationIntent:()=>({ok:true})});
    vue.onMounted(()=>{ctx.emit('ready');ctx.emit('wall-settled');});vue.onBeforeUnmount(()=>{stop();retired.push(identity);});
    return()=>{void revision.value;return vue.h('section',{},p.projectionView.getProjection().rows.map(r=>vue.h('article',{id:r.id},r.id)));};
  }});
  try {
    const Workspace=await compile(source,{'./WallWorkspace.vue':Wall,'./layout.js':{createWallLayout},'../../.kit/capsule-ui-kit/src/workspace/layoutProfile.js':{decodeAndMigrateLayoutProfile},'../../electron/desktopLayout.js':model,'../../electron/desktopShortcuts.js':keys});
    const props=vue.reactive({storage:{readRaw:async()=>stored,writeAtomic:async raw=>{stored=raw;saved.push(JSON.parse(raw));}},scope:SCOPE,defaultProfile:createWallLayout(SCOPE),projectionView:{getSnapshot:()=>({envelope:{projection:{rows}}})},rows:[...rows],modes:{h:'human',a:'agent'},intentBuilders:{},controlRegistry:{},scheduler:{},tileScheduler:{}});
    Object.assign(props,overrides);
    live=mount(Workspace,props);beforeLoad(live.vm);await tick();await tick();
    await run({vm:live.vm,props,saved,mounted,retired,presetCalls,presetReplies,reveals,panels,closePanels,getStored:()=>stored});
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

async function activePresetOracle(source) {
  await workspaceFixture(async({vm,presetCalls,presetReplies,saved})=>{
    presetCalls.length=0;
    assert(vm.setPreset('single').ok);await tick();
    assert.deepEqual(presetCalls.at(-1),{key:'human-1',preset:'single'});
    vm.addDesktop();await tick();
    assert(vm.setPreset('grid').ok);await tick();
    assert.deepEqual(presetCalls.at(-1),{key:'human-2',preset:'grid'});
    vm.selectView('agent');await tick();
    assert(vm.setPreset('focus-strip').ok);await tick();
    assert.deepEqual(presetCalls.at(-1),{key:'agent-1',preset:'focus-strip'});
    const state=saved.at(-1);
    assert.equal(state.views.human.desktops[0].preset,'single');
    assert.equal(state.views.human.desktops[1].preset,'grid');
    assert.equal(state.views.agent.desktops[0].preset,'focus-strip');
    presetReplies.set('agent-1',{ok:false,code:'LAYOUT_PRESET_INVALID'});
    assert.equal(vm.setPreset('bad').ok,false);await tick();
    assert.equal(saved.at(-1).views.agent.desktops[0].preset,'focus-strip','refused presets must not enter storage');
  },source);
}
test('P18E each preset routes to the active desktop and persists only on acceptance',()=>activePresetOracle());
test('P18E mutant routing presets to the former single wall is detected',async()=>{
  const source=read('../src/wall/DesktopWorkspace.vue');
  const mutant=source.replace('const result = walls.get(activeKey())?.setPreset(preset);',"const result = walls.get('human-1')?.setPreset(preset);");
  assert.notEqual(mutant,source);
  await assert.rejects(()=>activePresetOracle(mutant),{code:'ERR_ASSERTION'});
});

test('P18G desktop prune waits for loaded projection and uses authoritative rows rather than stale props',async()=>{
 const originalTimer=globalThis.setTimeout,originalNow=Date.now;let callback=null,now=0;
 globalThis.setTimeout=(fn,ms,...args)=>[250,5000].includes(ms)?(callback=fn,{unref(){}}):originalTimer(fn,ms,...args);
 Date.now=()=>now;
 try {await workspaceFixture(async({props,saved,vm})=>{
   props.projectionView.getProjection=()=>({rows:[]});
   props.projectionView.getSnapshot=()=>({status:'unavailable',envelope:null});
   props.rows.splice(0);await tick();assert(callback);now=30000;callback();await tick();
   assert(vm.testState.assignments.h,'unloaded projection must retain persisted assignment');
   props.projectionView.getProjection=()=>({rows});
   props.projectionView.getSnapshot=()=>({status:'live',stale:false,envelope:{projection:{rows}}});
   now=30001;callback();await tick();now=35002;callback();await tick();
   assert(vm.testState.assignments.h,'authoritative h survives even with stale empty props.rows');
 },read('../src/wall/DesktopWorkspace.vue').replace('defineExpose({','defineExpose({testState:state,'));}finally{globalThis.setTimeout=originalTimer;Date.now=originalNow;}
});
test('H41 returning to a former desktop reveals the surface again',()=>workspaceFixture(async({props,reveals})=>{
 const count=()=>reveals.filter(r=>r.id==='h'&&r.key==='human-1').length;assert.equal(count(),1);
 props.modes.h='agent';await tick();props.modes.h='human';await tick();assert.equal(count(),2);
}));
test('H42 desktop admission and restored-state validation enforce a finite per-view cap',()=>{
 const state=model.createDesktopState();for(let i=1;i<16;i++)model.addDesktop(state,'human');
 const before=JSON.stringify(state);assert.throws(()=>model.addDesktop(state,'human'),/DESKTOP_LIMIT/);assert.equal(JSON.stringify(state),before);
 state.views.human.desktops.push({id:17,preset:null,layout:null});state.views.human.next=18;assert.equal(model.validateDesktopState(state,()=>true),false);
});

// V027: exercise the production host with asynchronous role discovery.
const onlyAgent = {rows:[{id:'a',backendLifecycle:'active'}],modes:{a:'agent'}};
test('V027 first agent capsule selects Agents after its role arrives',()=>workspaceFixture(async({props,saved})=>{
  props.rows.splice(0,props.rows.length,{id:'a',backendLifecycle:'active'}); await tick();
  assert.equal(saved.at(-1).activeView,'human','unknown roles must not select a view');
  props.modes.a='agent'; await tick();
  assert.equal(saved.at(-1).activeView,'agent');
  props.rows.push({id:'h'});props.modes.h='human';await tick();
  assert.equal(saved.at(-1).activeView,'agent','later arrivals must not jump views');
},undefined,null,{rows:[],modes:{}}));
test('V027 an explicit choice before role discovery prevents automatic navigation',()=>workspaceFixture(async({vm,props,saved})=>{
  vm.selectView('human'); props.rows.splice(0,props.rows.length,{id:'a'});props.modes.a='agent';await tick();
  assert.equal(saved.at(-1).activeView,'human');
},undefined,null,{rows:[],modes:{}}));
test('V027 an explicit choice after automatic navigation remains selected',()=>workspaceFixture(async({vm,props,saved})=>{
  assert.equal(saved.at(-1).activeView,'agent');vm.selectView('human');await tick();
  props.rows.push({id:'a2'});props.modes.a2='agent';await tick();
  assert.equal(saved.at(-1).activeView,'human');
},undefined,null,onlyAgent));
test('V027 saved Humans profile wins over agent-only startup',()=>workspaceFixture(async({saved})=>{
  assert.equal(saved.at(-1).activeView,'human');
},undefined,JSON.stringify(model.createDesktopState()),onlyAgent));
test('V027 a human capsule prevents automatic Agents selection',()=>workspaceFixture(async({saved})=>{
  assert.equal(saved.at(-1).activeView,'human');
}));
test('V027 negative control detects removal of automatic first-view selection',async()=>{
  const source=read('../src/wall/DesktopWorkspace.vue');
  const mutant=source.replace("state.value.activeView = 'agent';", "state.value.activeView = 'human';");
  assert.notEqual(source,mutant);
  await assert.rejects(()=>workspaceFixture(async({saved})=>{
    assert.equal(saved.at(-1).activeView,'agent');
  },mutant,null,onlyAgent),{code:'ERR_ASSERTION'});
});
test('V027 empty view names the other view and its button navigates both ways',async()=>{
  const source=read('../src/wall/EmptyWallView.vue').replace("import './wall.css';",'');
  const Button=vue.defineComponent({props:['label'],emits:['click'],setup:(p,{emit})=>()=>vue.h('button',{onClick:()=>emit('click')},p.label)});
  const Empty=await compile(source,{'capsule-ui-kit/ui':{UiButton:Button}});
  for(const [view,label] of [['agent','Agents'],['human','Humans']]) {
    const events=[];
    const Host=vue.defineComponent({setup:()=>()=>vue.h(Empty,{hint:`Your running capsules are in the ${label} view.`},
      {action:()=>vue.h(Button,{id:'empty-wall-other-view',label:`Go to ${label}`,onClick:()=>events.push(view)})})});
    const live=mount(Host,{});
    try {
      const flatten=n=>[n,...n.children.flatMap(flatten)],nodes=flatten(live.root);
      assert(nodes.some(n=>n.text===`Your running capsules are in the ${label} view.`));
      const button=nodes.find(n=>n.props.id==='empty-wall-other-view');
      assert.equal(button.text,`Go to ${label}`);button.props.onClick();
      assert.deepEqual(events,[view]);
    } finally {live.app.unmount();}
  }
  const live=mount(Empty,{});
  try {assert.equal(live.root.children[0].children.some(n=>n.props.id==='empty-wall-other-view'),false);}
  finally {live.app.unmount();}
  const app=read('../src/App.vue');
  assert.match(app,/<template v-if="otherCapsuleView" #action>/);
  assert.match(app,/@click="selectGlobalView\(otherCapsuleView\)"/);
  assert.match(app,/<EmptyWallView :hint="otherCapsuleView/);
  assert.match(app,/assignments\[row.id\]\?\.view === other/);
});

test('V027 a choice while layout loading is pending wins over agent-only startup',()=>workspaceFixture(async({saved})=>{
  assert.equal(saved.at(-1).activeView,'human');
},undefined,null,onlyAgent,vm=>vm.selectView('human')));


test('desktop owner persists display names without remounting or changing capsule identity',()=>workspaceFixture(async({vm,saved,mounted,retired})=>{
  const before=mounted.length;
  assert.equal(await vm.renameDesktop('human',1,'Research'),true);
  assert.equal(await vm.renameCapsule('h','Notes'),true);await tick();
  assert.equal(saved.at(-1).views.human.desktops[0].label,'Research');
  assert.equal(saved.at(-1).labels.h,'Notes');assert.equal(saved.at(-1).assignments.h.view,'human');
  assert.equal(mounted.length,before);assert.equal(retired.length,0);
}));
test('desktop owner refuses corrupt layout names on restore',async()=>{
 const state=model.createDesktopState();state.labels={h:'x'.repeat(81)};
 await workspaceFixture(async({vm})=>{assert.equal(await vm.renameCapsule('h','Allowed'),false);},undefined,JSON.stringify(state));
});
test('failed name persistence restores the previous display label',async()=>{
 let fail=false,raw=null;
 await workspaceFixture(async({vm})=>{
  assert.equal(await vm.renameCapsule('h','Before'),true);fail=true;
  assert.equal(await vm.renameCapsule('h','After'),false);fail=false;
  assert.equal(await vm.renameDesktop('human',1,'Research'),true);await tick();
  assert.equal(JSON.parse(raw).labels.h,'Before');
 },undefined,null,{storage:{readRaw:async()=>null,writeAtomic:async value=>{if(fail)throw Error('write refused');raw=value;}}});
});

test('an in-flight capsule name write cannot be superseded before it settles',async()=>{
 let hold=false,release,raw=null;
 await workspaceFixture(async({vm})=>{
  assert.equal(await vm.renameCapsule('h','Before'),true);hold=true;
  const first=vm.renameCapsule('h','After');
  assert.equal(await vm.renameCapsule('h','Too soon'),false);
  await tick();hold=false;release();assert.equal(await first,true);await tick();
  assert.equal(JSON.parse(raw).labels.h,'After');
 },undefined,null,{storage:{readRaw:async()=>null,writeAtomic:async value=>{if(hold)await new Promise(resolve=>{release=resolve;});raw=value;}}});
});

test('identity deletion retires saved aliases and cells while stopping preserves identity aliases',async()=>{
 const state=model.createDesktopState();state.labels={'identity-a':'Old account',h:'Transient',other:'Keep'};
 state.views.human.desktops[0].identityCells={'identity-a':{col:0,row:0},other:{col:1,row:0}};
 await workspaceFixture(async({vm,saved})=>{
  vm.forgetSurface('h');await tick();assert.equal(saved.at(-1).labels.h,undefined);assert.equal(saved.at(-1).labels['identity-a'],'Old account');
  await vm.forgetIdentity('identity-a');await tick();const latest=saved.at(-1);
  assert.equal(latest.labels['identity-a'],undefined);assert.equal(latest.labels.other,'Keep');
  assert.equal(latest.views.human.desktops[0].identityCells['identity-a'],undefined);
  assert.deepEqual(latest.views.human.desktops[0].identityCells.other,{col:1,row:0});
 },undefined,JSON.stringify(state));
});


test('OPFIX a vanished panel is recovered when returning to its desktop',()=>workspaceFixture(async({vm,panels,saved})=>{
 assert.ok(panels.get('human-1').has('h'));
 vm.addDesktop();await tick();vm.selectView('agent');await tick();
 panels.get('human-1').delete('h');
 vm.selectView('human');vm.selectDesktop(1);await tick();
 assert.equal(saved.at(-1).assignments.h.desktop,1);
 assert.ok(panels.get('human-1').has('h'),'a listed live capsule must be revealed again after panel loss');
}));
test('OPFIX explicit panel closure survives navigation until Refresh is requested',()=>workspaceFixture(async({vm,panels,closePanels,saved})=>{
 closePanels.get('human-1')('h');await tick();
 vm.selectView('agent');await tick();vm.selectView('human');await tick();
 assert.equal(panels.get('human-1').has('h'),false,'navigation respects explicit Close');
 const assignments=JSON.stringify(saved.at(-1).assignments);
 const result=await vm.refreshCurrentDesktop();await tick();
 assert.equal(result.ok,true);
 assert.ok(panels.get('human-1').has('h'),'Refresh restores the current desktop from live rows');
 assert.equal(JSON.stringify(saved.at(-1).assignments),assignments,'Refresh never moves capsules');
}));
