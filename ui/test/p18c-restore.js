import {createApp, h, nextTick, reactive} from 'vue';
import DesktopWorkspace from '../src/wall/DesktopWorkspace.vue';
import DockWorkspace from 'capsule-ui-kit/DockWorkspace';
import {createWallLayout, SCOPE} from '../src/wall/layout.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => {if (!value) throw Error(message);};
let raw = null, app, vm, settled;
const props = reactive({
  scope:SCOPE, defaultProfile:createWallLayout(SCOPE), rows:[], modes:{},
  storage:{readRaw:async()=>raw,writeAtomic:async value=>{raw=value;}},
  projectionView:{getProjection:()=>({rows:props.rows}),getSnapshot:()=>({status:'live',envelope:{projection:{rows:props.rows}}})},
  intentBuilders:{visibility:value=>value,control:value=>value,presentation:value=>value},
  controlRegistry:{},scheduler:{},tileScheduler:{},
});
async function mount() {
  settled = 0;
  app=createApp({render:()=>h(DesktopWorkspace,{...props,ref:value=>{vm=value;},onWallSettled:()=>settled++},
    {surface:({capsuleId})=>h('div',{'data-test-mounted':capsuleId},'Mounted '+capsuleId)})});
  app.mount('#app');await nextTick();await wait(150);
}
async function wallReady(key) {
  for (let i=0;i<80;i++) {
    const host=document.querySelector(`[data-desktop="${key}"] .mv-dock-workspace`);
    if(host?.dataset.wallRevealed==='true')return host;
    await wait(25);
  }
  throw Error('WALL_NOT_SETTLED '+key);
}
async function replay(legacy=false) {
  props.rows=[];props.modes={};raw=null;
  await mount();await wallReady('human-1');
  assert(vm.addDesktop()===2,'desktop allocation');await nextTick();await wallReady('human-2');
  // Exercise the real wall storage adapters and the host's serialized writer,
  // even for walls which have never contained a surface.
  for (const key of ['human-1','human-2','agent-1']) {
    const wall=document.querySelector(`[data-desktop="${key}"] .mv-dock-workspace`);
    wall.click();await wait(30);
  }
  await vm.followSurface('absent');await wait(30);
  assert(raw!==null,'persisted envelope');
  const value=JSON.parse(raw);
  assert(value.views.human.desktops[1].layout,'persisted desktop 2 layout');
  if(legacy) {
    for(const group of Object.values(value.views))for(const desktop of group.desktops)if(desktop.layout) {
      desktop.layout.dockview.grid.root={type:'leaf',data:{id:'desktop-empty',views:[]}};
    }
    raw=JSON.stringify(value);
  }
  app.unmount();await nextTick();await mount();
  await wallReady('human-2');
  vm.selectDesktop(1);await nextTick();await wallReady('human-1');
  vm.selectView('agent');await nextTick();await wallReady('agent-1');
  vm.selectView('human');vm.selectDesktop(2);await nextTick();await wallReady('human-2');
  props.modes['restore-human']='human';props.rows.push({id:'restore-human',surfaceId:'restore-human',backendLifecycle:'active',title:'Restored human'});
  await nextTick();await wait(150);
  const host=await wallReady('human-2');
  assert(settled>=3,'all restored walls emitted settlement');
  assert(!document.querySelector('.mv-dock-workspace__quarantine-banner'),'unexpected quarantine');
  assert(host.querySelector('[data-test-mounted="restore-human"]'),'human tile did not mount on desktop 2');
  await vm.selectDesktop(1);await nextTick();await vm.selectDesktop(2);await nextTick();
  assert(host.dataset.wallRevealed==='true','switching unsettled the wall');
  assert(host.querySelector('[data-test-mounted="restore-human"]'),'switching lost the tile');
  app.unmount();await nextTick();
  return {settled,tileMounted:true,quarantine:false};
}
async function bannerReplay() {
  let release,code;
  const viewport=reactive({width:1280});
  const read=new Promise(resolve=>{release=resolve;});
  app=createApp({render:()=>h(DockWorkspace,{
    scope:SCOPE,ownerWindowId:'quarantine-guard',defaultProfile:createWallLayout(SCOPE),
    initialViewportWidth:viewport.width,initialViewportHeight:900,
    storage:{readRaw:()=>read,writeAtomic:async()=>{throw Error('QUARANTINE_WRITE');}},
    onQuarantineDetected:event=>{code=event.code;},
  })});
  app.mount('#app');await wait(80);
  // A viewport update snapshots the host while its cold read is still pending.
  viewport.width++;await nextTick();
  const pendingBanner=document.querySelector('.mv-dock-workspace__quarantine-text')?.textContent;
  assert(pendingBanner?.includes('LAYOUT_RESTORE_PENDING'),'initial read-only banner needs a code: '+pendingBanner);
  release('{invalid');
  for(let i=0;i<80;i++) {
    if(document.querySelector('.mv-dock-workspace')?.dataset.wallRevealed==='true')break;
    await wait(25);
  }
  const banner=document.querySelector('.mv-dock-workspace__quarantine-text')?.textContent;
  assert(typeof code==='string'&&code.length>0,'quarantine event code absent');
  assert(banner?.includes(code),'quarantine banner must show its actual reason code');
  assert(document.querySelector('.mv-dock-workspace')?.dataset.wallRevealed==='true','safe quarantine wall did not settle');
  app.unmount();await nextTick();return {code,settled:true};
}
window.p18cRestore = async()=>({fresh:await replay(),legacy:await replay(true),quarantine:await bannerReplay()});
