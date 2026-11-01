import {createApp, h, nextTick} from 'vue';
import App from '../src/App.vue';
import RoleSurface from '../src/surfaces/RoleSurface.vue';
import {installKitTheme} from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
import '../src/design/metaviewer.css';
import {createOverlayCoordinator, observeOverlays} from '../src/surfaces/overlayCoordinator.js';
import {createWallLayout, SCOPE} from '../src/wall/layout.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => {if (!value) throw Error(message);};
const calls=[], states=new Map();
let raw=null;
globalThis.metaviewerRoles={
  status:async id=>{return {ok:true,role:'agent',view:{state:states.get(id)||'closed'}};},
  mount:async(id,bounds)=>{calls.push(['mount',id,bounds]);states.set(id,'ready');return {ok:true};},
  close:async id=>{calls.push(['close',id]);states.delete(id);return {ok:true};},
  resize:async()=>({ok:true}),visibility:async()=>({ok:true}),
};
const rows=['p18e-a','p18e-b'].map(id=>({id,surfaceId:id,generation:1,visibility:'unfolded',control:'agent',attachmentState:'attaching',backendLifecycle:'active',title:id}));
const snapshot={status:'live',stale:false,envelope:{schema:'surface/v0.1',epoch:1,revision:1,query:'wall',projection:{rows}},error:null};
const projectionView={getProjection:()=>({rows}),getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
const props={scope:SCOPE,layout:createWallLayout(SCOPE,rows),
  storage:{readRaw:async()=>raw,writeAtomic:async value=>{raw=value;}},runtime:{projectionView}};
const overlays=createOverlayCoordinator(document),stopObserving=observeOverlays(overlays);
function makeApp() {const instance=createApp(App,props);instance.component('RoleSurface',RoleSurface);installKitTheme(instance);instance.provide('overlayCoordinator',overlays);return instance;}
let app=makeApp();
const boxes=()=>[...document.querySelectorAll('[data-desktop="agent-1"] .mv-tile')].map(n=>{
  const {x,y,width,height}=n.getBoundingClientRect();return {x,y,width,height};
});
window.p18eBrowser=async()=>{
  app.mount('#app');await nextTick();await wait(300);
  document.getElementById('view-agent').click();await nextTick();await wait(300);
  const outcomes=[];
  for(const preset of ['single','side-by-side','grid','focus-strip',null]) {
    document.getElementById('tile-preset-'+(preset??'floating')).click();const result={ok:true};await nextTick();await wait(250);
    const rects=boxes();outcomes.push({preset,result,rects});
    console.log('PRESET',JSON.stringify(outcomes.at(-1)));
    assert(result?.ok,'preset refused '+JSON.stringify(result));
    assert(rects.length===2,'expected both tiles');
    if(preset==='single') assert(Math.abs(rects[0].y-rects[1].y)>100,'single must stack tiles');
    if(preset==='side-by-side'||preset==='grid') assert(Math.abs(rects[0].x-rects[1].x)>100,'preset must split columns');
    if(preset==='focus-strip') assert(Math.max(...rects.map(r=>r.width))/Math.min(...rects.map(r=>r.width))>1.5,'focus tile must be wider');
    assert(JSON.parse(raw).views.agent.desktops[0].preset===preset,'preset must persist');
    assert(document.getElementById('tile-preset-'+(preset??'floating')).getAttribute('aria-pressed')==='true','active preset must be visible');
  }
  // Presets belong to each desktop across view switches and a renderer remount.
  document.getElementById('tile-preset-focus-strip').click();await nextTick();await wait(100);
  document.getElementById('desktop-add').click();await nextTick();await wait(250);
  document.getElementById('tile-preset-grid').click();await nextTick();await wait(100);
  document.getElementById('view-human').click();await nextTick();await wait(100);
  document.getElementById('tile-preset-single').click();await nextTick();await wait(100);
  const saved=JSON.parse(raw);
  assert(saved.views.agent.desktops[0].preset==='focus-strip','agent desktop 1 preset isolated');
  assert(saved.views.agent.desktops[1].preset==='grid','agent desktop 2 preset isolated');
  assert(saved.views.human.desktops[0].preset==='single','human desktop 1 preset isolated');
  document.getElementById('view-agent').click();await nextTick();
  document.getElementById('desktop-agent-1').click();await nextTick();await wait(100);
  app.unmount();await nextTick();app=makeApp();app.mount('#app');await nextTick();await wait(400);
  assert(document.getElementById('tile-preset-focus-strip').getAttribute('aria-pressed')==='true','restored desktop preset selected');
  assert(boxes().length===2,'restored both tiles');
  const menu=document.getElementById('tile-menu-p18e-a');assert(menu,'agent menu must exist');menu.click();await nextTick();await wait(30);
  assert(document.body.hasAttribute('data-mv-modal'),'open menu owns overlay');
  assert(document.getElementById('tile-watch-p18e-a'),'watch action must exist');document.getElementById('tile-watch-p18e-a').click();await nextTick();await wait(250);
  assert(!document.body.hasAttribute('data-mv-modal'),'closed menu released overlay');
  assert(calls.some(c=>c[0]==='mount'&&c[1]==='p18e-a'),'watch must mount after menu closes');
  const viewport=document.querySelector('[data-capsule-role="agent"] .mv-role-viewport').getBoundingClientRect();
  assert(viewport.height>100,'watch viewport retains height');
  menu.click();await nextTick();document.getElementById('tile-watch-p18e-a').click();await nextTick();await wait(150);
  assert(!states.has('p18e-a'),'close watch revoked native view');
  // A content-sized host reproduces the zero-height watch regression:
  // hiding its only canvas with display:none removes the mountable viewport.
  app.unmount();await nextTick();
  const host=document.createElement('div');host.style.cssText='position:fixed;top:0;left:0;width:700px;height:auto';document.body.append(host);
  app=createApp({render:()=>h(RoleSurface,{surfaceId:'p18e-natural',control:'agent'},
    {default:()=>h('canvas',{width:700,height:400,style:'display:block;width:700px;height:400px'})})});
  app.provide('overlayCoordinator',overlays);app.mount(host);await nextTick();await wait(100);
  document.getElementById('tile-menu-p18e-natural').click();await nextTick();await wait(30);
  document.getElementById('tile-watch-p18e-natural').click();await nextTick();await wait(250);
  const natural=host.querySelector('.mv-role-viewport').getBoundingClientRect();
  assert(natural.height>=400,'watch collapsed its content-sized viewport: '+natural.height);
  assert(calls.some(c=>c[0]==='mount'&&c[1]==='p18e-natural'),'content-sized watch must mount');
  app.unmount();host.remove();stopObserving();
  return {desktopPresetRestore:true,naturalWatchHeight:natural.height,presets:outcomes,watchMounted:true,watchClosed:true,calls};
};
