import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import {createOverlayCoordinator} from '../src/surfaces/overlayCoordinator.js';
import {createHiddenSessionPool} from '../src/surfaces/hiddenSessions.js';
const read = rel => readFileSync(new URL(rel,import.meta.url),'utf8');
let serial=0;
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

async function scopedOracle(source) {
  await withRoles(async ({add,calls,attrs,overlays,pool}) => {
    await add('target','human');await add('neighbor','human');calls.length=0;
    const owner={};overlays.setSurface(owner,'target',true);await tick();
    assert.ok(calls.some(c=>c[0]==='visibility'&&c[1]==='target'&&c[2]===false),'target hides');
    assert.ok(!calls.some(c=>c[0]==='visibility'&&c[1]==='neighbor'&&c[2]===false),'neighbor remains live');
    assert.equal(attrs.has('data-mv-modal'),false,'tile chrome is not a global modal');
    assert.ok(!calls.some(c=>c[0]==='close'),'occlusion never closes a view');
    calls.length=0;overlays.setSurface(owner,'target',false);await tick();
    assert.ok(calls.some(c=>c[0]==='visibility'&&c[1]==='target'&&c[2]===true),'target restores');
    calls.length=0;overlays.set({},true);await new Promise(resolve=>setTimeout(resolve,130));
    for(const id of ['target','neighbor']) assert.ok(calls.some(c=>c[0]==='visibility'&&c[1]===id&&c[2]===false),'global modal hides '+id);
  },source);
}
test('tile chrome occludes its native view only and global modals still hide all views',()=>scopedOracle(read('../src/surfaces/RoleSurface.vue')));
test('ignoring scoped occlusion is rejected by the same native-view oracle',async()=>{
  const source=read('../src/surfaces/RoleSurface.vue');
  const mutant=source.replace(' && !scopedOcclusion','');
  assert.notEqual(source,mutant);await assert.rejects(()=>scopedOracle(mutant),{code:'ERR_ASSERTION'});
});

test('scoped chrome shows a real native preview without mounting human canvas input',async()=>{
  await withRoles(async({add,overlays})=>{
    const image='data:image/png;base64,aGVsbG8=';
    globalThis.metaviewerRoles.preview=async()=>({ok:true,image});
    const f=await add('preview','human');
    const all=n=>[n,...n.children.flatMap(all)];
    const owner={};overlays.setSurface(owner,'preview',true);await tick();
    assert.equal(all(f.root).find(n=>n.tag==='img')?.props.src,image);
    assert.ok(!all(f.root).some(n=>n.tag==='canvas'),'human never gets the canvas input slot');
    overlays.setSurface(owner,'preview',false);await tick();
    assert.ok(!all(f.root).some(n=>n.tag==='img'),'preview is dropped when the native view returns');
  });
});
test('scoped owners compose, rebind and release without changing global ownership',()=>{
  const coordinator=createOverlayCoordinator(),a={},b={};
  coordinator.setSurface(a,'a',true);coordinator.setSurface(b,'a',true);coordinator.setSurface(a,'a',false);
  assert.equal(coordinator.isSurfaceOccluded('a'),true);
  coordinator.setSurface(b,'b',true);assert.equal(coordinator.isSurfaceOccluded('a'),false);
  assert.equal(coordinator.isSurfaceOccluded('b'),true);assert.equal(coordinator.count,0);
  coordinator.dispose();assert.equal(coordinator.isSurfaceOccluded('b'),false);
});
