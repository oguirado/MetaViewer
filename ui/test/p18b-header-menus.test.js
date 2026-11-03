import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as tileStates from '../src/wall/tileStates.js';
import { createOverlayCoordinator, observeOverlays } from '../src/surfaces/overlayCoordinator.js';
import { createHiddenSessionPool } from '../src/surfaces/hiddenSessions.js';
import { installSurfacePresentation } from '../src/surfaces/presentationServices.js';
import { xpraTileDocument } from '../electron/xpraClient.js';
import { attachXpraHumanTile } from '../electron/xpraHumanTile.js';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

let serial = 0;
const read = file => readFileSync(new URL(file, import.meta.url),'utf8');
const all = node => [node,...(node.children || []).flatMap(all)];
const text = node => [node.text || '',...(node.children || []).map(text)].join(' ').trim();
const tick = async () => { await new Promise(resolve => setTimeout(resolve,20)); await vue.nextTick(); };
async function compile(source, deps = {}) {
  const {descriptor} = parse(source);
  let code = compileScript(descriptor,{id:'p18b-'+(++serial),inlineTemplate:true}).content;
  code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm,'');
  globalThis.__p18bDeps = deps;
  code = code.replace(/^import\s+(.+?)\s+from\s+(['"])(.*?)\2;?/gm,(line,binding,_q,path) => path === 'vue'
    ? line.replace(/(['"])vue\1/,JSON.stringify(import.meta.resolve('vue')))
    : `const ${binding} = globalThis.__p18bDeps[${JSON.stringify(path)}];`);
  return (await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64')+'#'+serial)).default;
}
function mount(Component, props = {}, providers = {}, slots = {}) {
  const geometry = {shown:true};
  const node = tag => ({tag,children:[],props:{},parent:null,style:{},
    getBoundingClientRect:()=>({x:10,y:10,width:geometry.shown?700:0,height:500}),
    getClientRects:()=>geometry.shown?[1]:[]});
  const renderer = vue.createRenderer({
    createElement:node,createText:value=>({...node('#text'),text:value}),createComment:()=>node('#comment'),
    setText(n,value){n.text=value;},setElementText(n,value){n.text=value;n.children=[];},
    patchProp(n,key,_previous,value){n.props[key]=value;},
    insert(n,parent,anchor){if(n.parent)this.remove(n);n.parent=parent;const at=parent.children.indexOf(anchor);parent.children.splice(at<0?parent.children.length:at,0,n);},
    remove(n){if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);n.parent=null;},
    parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1] || null,
    setScopeId(){},querySelector:()=>null,
  });
  const root=node('root'),app=renderer.createApp({render:()=>vue.h(Component,props,slots)});
  for(const [key,value] of Object.entries(providers))app.provide(key,value);
  app.mount(root);
  return {root,app,geometry};
}
function documentFixture() {
  const attrs=new Map(),listeners=new Map();
  const doc={body:{setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),hasAttribute:k=>attrs.has(k),getAttribute:k=>attrs.get(k)??null},
    addEventListener(k,fn){if(!listeners.has(k))listeners.set(k,new Set());listeners.get(k).add(fn);},
    removeEventListener(k,fn){listeners.get(k)?.delete(fn);},
    querySelectorAll:()=>[],getElementById:()=>null};
  return {doc,attrs,fire:(k,event)=>{for(const fn of listeners.get(k)||[])fn(event);}};
}
async function withRoles(run, source = read('../src/surfaces/RoleSurface.vue')) {
  const prior={api:globalThis.metaviewerRoles,doc:globalThis.document,width:globalThis.innerWidth,height:globalThis.innerHeight};
  const {doc,attrs}=documentFixture();globalThis.document=doc;globalThis.innerWidth=1600;globalThis.innerHeight=1100;
  const calls=[],roles=new Map(),fixtures=[];
  globalThis.metaviewerRoles={status:async id=>({role:roles.get(id),view:{state:'ready'}}),
    mount:async id=>{calls.push(['mount',id]);return {ok:true};},resize:async()=>({ok:true}),
    visibility:async(id,shown)=>{calls.push(['visibility',id,shown]);return {ok:true};},
    close:async id=>{calls.push(['close',id]);return {ok:true};},confirmLogin:async()=>({ok:true})};
  const Component=await compile(source),overlays=createOverlayCoordinator(doc),pool=createHiddenSessionPool();
  const add=async (id,role)=>{
    roles.set(id,role);
    const f=mount(Component,{surfaceId:id,control:role},{overlayCoordinator:overlays,hiddenSessionPool:pool},{default:()=>vue.h('canvas')});
    fixtures.push(f);await tick();return f;
  };
  try {await run({add,calls,attrs,overlays,pool});}
  finally {for(const f of fixtures)f.app.unmount();globalThis.metaviewerRoles=prior.api;globalThis.document=prior.doc;globalThis.innerWidth=prior.width;globalThis.innerHeight=prior.height;}
}
const menuButton = f => all(f.root).find(n=>n.props?.['aria-haspopup']==='menu');
const openMenu = async f => {menuButton(f).props.onClick();await tick();};

async function modeOracle(source,role) {
  await withRoles(async({add})=>{
    const f=await add('mode',role);
    assert.equal(all(f.root).some(n=>n.props?.role==='menu'),false);
    await openMenu(f);
    const actions=all(f.root).filter(n=>n.props?.role==='menuitem').map(text);
    assert.deepEqual(actions,role==='human'
      ? ['Switch to agent mode','Mark as logged in','Stop capsule']
      : ['Switch to human mode','Watch read-only','Stop capsule','Take control (emergency)']);
    if(role==='agent')assert.equal(all(f.root).filter(n=>n.props?.role==='separator').length,1);
  },source);
}
for(const role of ['human','agent']) {
  test(`P18B ${role} menu exposes exactly its mode actions`,()=>modeOracle(read('../src/surfaces/RoleSurface.vue'),role));
  test(`P18B mutant: wrong ${role} action group is detected`,async()=>{
    const original=read('../src/surfaces/RoleSurface.vue');
    const mutant=role==='human'
      ? original.replace('v-if="role === \'human\'" role="menuitem"','v-if="role === \'agent\'" role="menuitem"')
      : original.replace('v-if="role === \'agent\' && control === \'agent\'" role="menuitem"','v-if="role === \'human\' && control === \'agent\'" role="menuitem"');
    assert.notEqual(mutant,original);await assert.rejects(()=>modeOracle(mutant,role),{code:'ERR_ASSERTION'});
  });
}

test('P18B overlapping tile menus retain the modal flag and native connection until the last closes',async()=>{
  await withRoles(async({add,calls,attrs})=>{
    const first=await add('first','human'),second=await add('second','human');
    await openMenu(first);await openMenu(second);
    await new Promise(r=>setTimeout(r,130));
    assert.equal(attrs.get('data-mv-modal'),'open');
    assert(calls.some(c=>c[0]==='visibility'&&c[1]==='first'&&c[2]===false));
    await openMenu(first);assert.equal(attrs.get('data-mv-modal'),'open');
    await openMenu(second);assert.equal(attrs.has('data-mv-modal'),false);
    await new Promise(r=>setTimeout(r,130));
    assert(calls.some(c=>c[0]==='visibility'&&c[1]==='first'&&c[2]===true));
    assert.equal(calls.filter(c=>c[0]==='mount').length,2);assert.equal(calls.filter(c=>c[0]==='close').length,0);
  });
});

async function countOracle(factory) {
  const {doc,attrs}=documentFixture(),coordinator=factory(doc),outer={},inner={};
  coordinator.set(outer,true);coordinator.set(inner,true);coordinator.set(outer,false);
  assert.equal(attrs.get('data-mv-modal'),'open');coordinator.set(inner,false);assert.equal(attrs.has('data-mv-modal'),false);
}
test('P18B mutant: a boolean overlay flag fails overlapping ownership',async()=>{
  await countOracle(createOverlayCoordinator);
  await assert.rejects(()=>countOracle(doc=>({set(_owner,open){if(open)doc.body.setAttribute('data-mv-modal','open');else doc.body.removeAttribute('data-mv-modal');}})),{code:'ERR_ASSERTION'});
});

test('P18B native selects retain dialog ownership and release all event listeners on disposal',()=>{
  const previous=globalThis.MutationObserver;globalThis.MutationObserver=class{observe(){}disconnect(){}};
  try {
    const {doc,attrs,fire}=documentFixture(),coordinator=createOverlayCoordinator(doc),dialog={};
    const dispose=observeOverlays(coordinator,doc);coordinator.set(dialog,true);
    fire('pointerdown',{target:{tagName:'SELECT'}});assert.equal(coordinator.count,2);
    fire('change',{});assert.equal(attrs.get('data-mv-modal'),'open');
    coordinator.set(dialog,false);assert.equal(attrs.has('data-mv-modal'),false);
    dispose();fire('pointerdown',{target:{tagName:'SELECT'}});assert.equal(coordinator.count,0);
  } finally {globalThis.MutationObserver=previous;}
});

test('P18B the permanent sidebar menu is not an overlay; visible popup menus are',()=>{
  const previousObserver=globalThis.MutationObserver,previousStyle=globalThis.getComputedStyle;
  let scan;globalThis.MutationObserver=class{constructor(fn){scan=fn;}observe(){}disconnect(){}};
  globalThis.getComputedStyle=()=>({visibility:'visible'});
  try {
    const {doc,attrs}=documentFixture(),coordinator=createOverlayCoordinator(doc);
    const sidebar={getAttribute:()=> 'menu',closest:()=>({}),getClientRects:()=>[1],hasAttribute:()=>false};
    const popup={...sidebar,closest:()=>null};let nodes=[sidebar];doc.querySelectorAll=()=>nodes;
    const dispose=observeOverlays(coordinator,doc);assert.equal(attrs.has('data-mv-modal'),false);
    nodes=[sidebar,popup];scan();assert.equal(attrs.get('data-mv-modal'),'open');
    nodes=[sidebar];scan();assert.equal(attrs.has('data-mv-modal'),false);dispose();
  } finally {globalThis.MutationObserver=previousObserver;globalThis.getComputedStyle=previousStyle;}
});

test('P18B native popover toggle events own the flag even without an attribute mutation',()=>{
  const previous=globalThis.MutationObserver;globalThis.MutationObserver=class{observe(){}disconnect(){}};
  try {
    const {doc,attrs,fire}=documentFixture(),coordinator=createOverlayCoordinator(doc);
    const dispose=observeOverlays(coordinator,doc),first={matches:()=>true,isConnected:true},second={matches:()=>true,isConnected:true};
    fire('beforetoggle',{target:first,newState:'open'});assert.equal(attrs.get('data-mv-modal'),'open');
    fire('beforetoggle',{target:second,newState:'open'});
    fire('toggle',{target:first,newState:'closed'});assert.equal(attrs.get('data-mv-modal'),'open');
    fire('toggle',{target:second,newState:'closed'});assert.equal(attrs.has('data-mv-modal'),false);
    fire('beforetoggle',{target:first,newState:'open'});dispose();assert.equal(attrs.has('data-mv-modal'),false);
    fire('beforetoggle',{target:first,newState:'open'});assert.equal(coordinator.count,0);
  } finally {globalThis.MutationObserver=previous;}
});

async function capOracle(factory) {
  const released=[],pool=factory(2);
  for(const id of ['shown','old','recent','new'])pool.update(id,true,()=>released.push(id));
  pool.update('old',false,()=>released.push('old'));
  pool.update('recent',false,()=>released.push('recent'));
  pool.update('old',true,()=>released.push('old'));
  pool.update('old',false,()=>released.push('old'));
  pool.update('new',false,()=>released.push('new'));
  assert.deepEqual(released,['recent']);assert(!released.includes('shown'));
  pool.setLimit(0);assert.deepEqual(new Set(released),new Set(['old','recent','new']));
}
test('P18B cap uses last shown order, protects shown tiles, and supports changing the limit',()=>capOracle(createHiddenSessionPool));
test('P18B an already restored tile cannot be evicted by a stale hidden sample',()=>{
  const released=[],pool=createHiddenSessionPool(1);let nowShown=false;
  pool.update('restored',false,()=>released.push('restored'),()=>nowShown);
  nowShown=true;
  pool.update('hidden',false,()=>released.push('hidden'));
  assert.deepEqual(released,[]);
  pool.setLimit(0);assert.deepEqual(released,['hidden']);
});
test('P18B mutant: reverse eviction order fails the cap oracle',async()=>{
  const source=read('../src/surfaces/hiddenSessions.js'),mutant=source.replace('a[1].lastShown - b[1].lastShown','b[1].lastShown - a[1].lastShown');
  assert.notEqual(source,mutant);
  const mod=await import('data:text/javascript;base64,'+Buffer.from(mutant).toString('base64'));
  await assert.rejects(()=>capOracle(mod.createHiddenSessionPool),{code:'ERR_ASSERTION'});
});
test('P18B mutant: admitting shown views as eviction victims fails the cap oracle',async()=>{
  const source=read('../src/surfaces/hiddenSessions.js'),mutant=source.replace('!entry.shown && !entry.isShown?.()','true');
  assert.notEqual(source,mutant);
  const mod=await import('data:text/javascript;base64,'+Buffer.from(mutant).toString('base64'));
  await assert.rejects(()=>capOracle(mod.createHiddenSessionPool),{code:'ERR_ASSERTION'});
});
test('P18B five hidden role views release the oldest; restored released tile requires explicit reconnect',async()=>{
  await withRoles(async({add,calls})=>{
    const fixtures=[];for(let i=0;i<5;i++)fixtures.push(await add('cap-'+i,'human'));
    for(const f of fixtures){f.geometry.shown=false;await new Promise(r=>setTimeout(r,130));}
    assert.deepEqual(calls.filter(c=>c[0]==='close'),[['close','cap-0']]);
    fixtures[0].geometry.shown=true;await new Promise(r=>setTimeout(r,130));await tick();
    assert.match(text(fixtures[0].root),/Disconnected to save resources, click to reconnect/);
    assert.equal(calls.filter(c=>c[0]==='mount'&&c[1]==='cap-0').length,1);
    const reconnect=all(fixtures[0].root).find(n=>n.tag==='button'&&text(n)==='Disconnected to save resources, click to reconnect');
    reconnect.props.onClick();await tick();assert.equal(calls.filter(c=>c[0]==='mount'&&c[1]==='cap-0').length,2);
    assert.equal(all(fixtures[0].root).find(n=>n.props?.class==='mv-role-status').text,'Human capsule');
  });
});

const passiveStub=vue.defineComponent({render:()=>null});
async function ghostOracle(source) {
  const shell=vue.defineComponent({setup:(_,ctx)=>()=>vue.h('section',{class:'shell'},[vue.h('header',{},'Agent shell'),ctx.slots.surface?.()])});
  const Component=await compile(source,{'capsule-ui-kit/CapsulePanel':shell,'./TileCaptureChrome.vue':passiveStub,'../netmode/NetworkPanel.vue':passiveStub,'./tileStates.js':tileStates});
  const revision=vue.ref(0),state={hidden:false},view={getSnapshot:()=>null,subscribe:()=>()=>{}};
  const f=mount(Component,{capsuleId:'agent',presentationInstance:'panel-agent',projectionView:view,intentBuilders:{visibility(){},control(){},presentation(){}},controlRegistry:{},scheduler:{},tileScheduler:null},
    {capsuleWindowPresentation:{revision,get:()=>({state:()=>state})}});
  try {
    const panel=()=>all(f.root).find(n=>n.props?.class==='mv-tile');
    assert.equal(panel().props.hidden,false);
    state.hidden=true;revision.value++;await tick();assert.equal(panel().props.hidden,true);
    // Adding a capsule makes Dockview restore/re-layout the retained renderer.
    revision.value++;await tick();assert.equal(panel().props.hidden,true);
    state.hidden=false;revision.value++;await tick();assert.equal(panel().props.hidden,false);
  } finally {f.app.unmount();}
}
test('P18B hidden agent shell stays hidden across a presentation revision',()=>ghostOracle(read('../src/wall/SurfacePanel.vue')));
test('P18B mutant: hiding only the body leaves the agent shell visible',async()=>{
  const source=read('../src/wall/SurfacePanel.vue'),mutant=source.replace(':hidden="presentationHidden"',':hidden="false"');
  assert.notEqual(source,mutant);await assert.rejects(()=>ghostOracle(mutant),{code:'ERR_ASSERTION'});
});

async function headerOracle(source) {
  const calls=[];globalThis.__p18bHeaderCalls=calls;
  const navigation=source.match(/<nav aria-label="Workspace tools"[\s\S]*?<\/nav>/)?.[0];
  const dock=source.match(/<UiButton label="Terminal" id="shell-terminal"[^\n]+/)?.[0];
  assert.ok(navigation && dock, 'navigation and dock actions remain reachable');
  const fragment=navigation+dock;
  const Component=await compile(`<script setup>import {ref} from 'vue';const railOpen=ref(true),launcherOpen=ref(false),identitiesOpen=ref(false),creativeOpen=ref(false),settingsOpen=ref(false),terminalOpen=ref(false),terminalDeckOpen=ref(false),selectedSurface=ref({});const toggleCreative=()=>globalThis.__p18bHeaderCalls.push('Storyboard'),toggleSettings=()=>globalThis.__p18bHeaderCalls.push('Settings'),toggleTerminal=()=>globalThis.__p18bHeaderCalls.push('Terminal');</script><template>${fragment}</template>`,{'capsule-ui-kit/ui':{}});
  const Button=vue.defineComponent({props:['label'],setup:(p,ctx)=>()=>vue.h('button',ctx.attrs,p.label)});
  const Host=vue.defineComponent({setup(){vue.getCurrentInstance().appContext.components.UiButton=Button;return()=>vue.h(Component);}});
  const live=mount(Host);
  try {
    const buttons=()=>all(live.root).filter(n=>n.tag==='button');
    assert.deepEqual(buttons().map(text),['Add capsule','Identities','Settings','Storyboard','Terminal']);
    for(const label of ['Storyboard','Settings','Terminal']) {
      buttons().find(n=>text(n)===label).props.onClick();await tick();
      assert.equal(calls.at(-1),label,`${label} calls its existing feature handler`);
    }
  } finally {live.app.unmount();delete globalThis.__p18bHeaderCalls;}
}
test('P18B navigation and dock retain existing feature actions',()=>headerOracle(read('../src/App.vue')));
test('P18B mutant: omitting a moved action fails the navigation oracle',async()=>{
  const source=read('../src/App.vue'),mutant=source.replace(/<UiButton label="Terminal" id="shell-terminal"[^\n]+/,'');
  assert.notEqual(source,mutant);await assert.rejects(()=>headerOracle(mutant),{code:'ERR_ASSERTION'});
});
test('P18B mutant: referencing a moved handler without calling it fails the navigation oracle',async()=>{
  const source=read('../src/App.vue'),mutant=source.replace('@click="toggleTerminal()"','@click="void toggleTerminal"');
  assert.notEqual(source,mutant);await assert.rejects(()=>headerOracle(mutant),{code:'ERR_ASSERTION'});
});

test('P18B watch initially says Connecting and reserves Reconnecting for recovery',()=>{
  assert.match(xpraTileDocument,/>Connecting…<\/div>/);assert.doesNotMatch(xpraTileDocument,/>Reconnecting…<\/div>/);
  const source=read('../electron/xpraHumanTile.js');
  assert.match(source,/state === 'reconnecting' \? 'Reconnecting…' : 'Connecting…'/);
  const mutant=xpraTileDocument.replace('>Connecting…</div>','>Reconnecting…</div>');
  assert.throws(()=>assert.match(mutant,/>Connecting…<\/div>/),{code:'ERR_ASSERTION'});
});

test('P18B native watch updates the actual overlay after a failed probe and recovery reload',async()=>{
  let ready=true,active=true;const labels=[],states=[],overlay={hidden:false,textContent:''};
  class Contents extends EventEmitter {
    setIgnoreMenuShortcuts(){}setWindowOpenHandler(){}setZoomFactor(){}close(){}
    async loadURL(){overlay.hidden=false;overlay.textContent=xpraTileDocument.match(/aria-live="polite">([^<]+)/)[1];labels.push(overlay.textContent);}
    async executeJavaScript(source){
      if(source.startsWith('Boolean'))return ready;
      vm.runInNewContext(source,{document:{getElementById:()=>overlay}});labels.push(overlay.textContent);return true;
    }
  }
  const contents=new Contents(),ipcMain=new EventEmitter();
  const isolated=new EventEmitter();Object.assign(isolated,{setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest(){},onBeforeSendHeaders(){}},async clearStorageData(){}});
  class View {webContents=contents;setBounds(){}setVisible(){}}
  const tile=await attachXpraHumanTile({electron:{WebContentsView:View,session:{fromPartition:()=>isolated},ipcMain},
    window:{contentView:{addChildView(){},removeChildView(){}}},bridge:{origin:'http://127.0.0.1:12345',requestHeaders:{}},
    bounds:{x:0,y:0,width:700,height:500},trace:{setActive(){}},isActive:()=>active,writable:false,
    capsuleSize:()=>({width:1280,height:900}),onState:s=>states.push(s),onFailure:assert.fail});
  try {
    assert.equal(labels[0],'Connecting…');assert(!states.includes('reconnecting'));
    ready=false;await new Promise(r=>setTimeout(r,300));assert.equal(overlay.textContent,'Reconnecting…');
    ready=true;await new Promise(r=>setTimeout(r,550));
    assert(states.includes('reconnecting'));assert.equal(states.at(-1),'ready');assert.equal(overlay.hidden,true);
    assert(labels.filter(label=>label==='Reconnecting…').length>=2,'loss and recovery reload both publish reconnect wording');
  } finally {active=false;await tile.close();}
});


async function lateMountOracle(source) {
  const previous = {api:globalThis.metaviewerRoles, doc:globalThis.document, interval:globalThis.setInterval};
  let finishMount, intervals = 0, enteredMount = false;
  const timers = [];
  const pending = new Promise(resolve => { finishMount = resolve; });
  const {doc} = documentFixture();
  globalThis.document = doc;
  globalThis.metaviewerRoles = {status:async()=>({role:'human',view:{state:'ready'}}),
    mount:async()=>{enteredMount = true; return pending;},close:async()=>({ok:true})};
  globalThis.setInterval = (...args) => { intervals++; const timer=previous.interval(...args); timers.push(timer); return timer; };
  let fixture;
  try {
    const Component = await compile(source);
    fixture = mount(Component,{surfaceId:'late-native',control:'human'});
    await tick(); assert.equal(enteredMount,true,'native mount is pending');
    fixture.app.unmount(); fixture = null;
    finishMount({ok:true}); await tick();
    assert.equal(intervals,0,'no timer can survive the component lifetime');
  } finally {
    fixture?.app.unmount(); finishMount({ok:true});
    for (const timer of timers) clearInterval(timer);
    globalThis.setInterval=previous.interval;globalThis.document=previous.doc;globalThis.metaviewerRoles=previous.api;
  }
 }
test('P18B a native mount finishing after unmount cannot start a polling timer', () =>
  lateMountOracle(read('../src/surfaces/RoleSurface.vue')));
test('P18B mutant: late mount polling without the lifetime guard is rejected', async () => {
  const source=read('../src/surfaces/RoleSurface.vue');
  const mutant=source.replace('    if (!alive) return; // An in-flight native mount may finish after unmount.','');
  assert.notEqual(source,mutant);
  await assert.rejects(()=>lateMountOracle(mutant),{code:'ERR_ASSERTION'});
});


test('P18B entry services install persistent settings and dispose counted overlay ownership', () => {
  const {doc,attrs}=documentFixture(),providers=new Map(),storage=new Map();
  let unmount;
  const app={provide:(name,value)=>providers.set(name,value),onUnmount:fn=>{unmount=fn;}};
  const prefs={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
  installSurfacePresentation(app,doc,prefs);
  const settings=providers.get('hiddenSessionSettings'),pool=providers.get('hiddenSessionPool');
  assert.equal(settings.get(),4);
  settings.set(1);assert.equal(pool.limit,1);assert.equal(storage.get('mv.hiddenLiveSessionLimit'),'1');
  assert.throws(()=>settings.set(-1),/HIDDEN_SESSION_LIMIT_INVALID/);
  assert.equal(pool.limit,1);assert.equal(storage.get('mv.hiddenLiveSessionLimit'),'1');
  providers.get('overlayCoordinator').set({},true);assert.equal(attrs.get('data-mv-modal'),'open');
  unmount();assert.equal(attrs.has('data-mv-modal'),false);
});

test('P18B malformed persisted caps refuse service installation before providers are published', () => {
  for(const stored of ['-1','1.5','broken','9007199254740992']) {
    const {doc}=documentFixture();let provided=0;
    assert.throws(()=>installSurfacePresentation({provide(){provided++;}},doc,{getItem:()=>stored}),/HIDDEN_SESSION_LIMIT_INVALID/);
    assert.equal(provided,0);
  }
});


async function deferredVisibilityOracle(source) {
  await withRoles(async({add,calls,overlays})=>{
    let finishMount;
    globalThis.metaviewerRoles.mount=()=>new Promise(resolve=>{finishMount=resolve;});
    const f=await add('pending-human','human'),dialog={};
    try {
      overlays.set(dialog,true);finishMount({ok:true,visible:false});await tick();
      assert.equal(calls.some(c=>c[0]==='visibility'&&c[2]===true),false,'menu stays above a mount that completes while modal');
      overlays.set(dialog,false);await new Promise(resolve=>setTimeout(resolve,130));
      assert.equal(calls.some(c=>c[0]==='visibility'&&c[2]===true),true,'completed mount appears only after modal dismissal');
      assert.equal(calls.some(c=>c[0]==='close'),false,'visibility never disconnects the view');
    } finally {finishMount({ok:true,visible:false});overlays.set(dialog,false);}
  },source);
}
test('P18B a connecting native view waits for current modal admission before showing',()=>
  deferredVisibilityOracle(read('../src/surfaces/RoleSurface.vue')));
test('P18B mutant: ignoring deferred visibility prevents the native view from returning',async()=>{
  const source=read('../src/surfaces/RoleSurface.vue'),mutant=source.replace('if (reply.visible === false)','if (false)');
  assert.notEqual(source,mutant);await assert.rejects(()=>deferredVisibilityOracle(mutant),{code:'ERR_ASSERTION'});
});
