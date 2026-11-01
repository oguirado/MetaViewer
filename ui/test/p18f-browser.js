import {createApp,h,ref,nextTick} from 'vue';
import DesktopWorkspace from '../src/wall/DesktopWorkspace.vue';
import RoleSurface from '../src/surfaces/RoleSurface.vue';
import {installKitTheme} from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
import '../src/design/metaviewer.css';
import {createOverlayCoordinator,observeOverlays} from '../src/surfaces/overlayCoordinator.js';
import {createWallLayout,SCOPE} from '../src/wall/layout.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const settle=async()=>{await nextTick();await sleep(230);await nextTick();};
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const rows=ref([]),workspace=ref(null),states=new Map(),calls=[],listeners=new Set();
let stored=null;
const feed={getProjection:()=>({rows:rows.value}),getSnapshot:()=>({status:'live',stale:false,envelope:{projection:{rows:rows.value}}}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
globalThis.metaviewerRoles={
 status:async id=>({ok:true,role:rows.value.find(row=>row.id===id)?.control || 'human',view:{state:states.get(id)?'ready':'closed'}}),
 mount:async(id,bounds)=>{if(!states.has(id)){states.set(id,{bridge:'bridge-'+id,visible:true});calls.push(['connect',id]);}calls.push(['mount',id,bounds]);return {ok:true};},
 close:async id=>{calls.push(['close',id]);states.delete(id);return {ok:true};},
 resize:async(id,bounds)=>{calls.push(['resize',id,bounds]);return {ok:true};},visibility:async(id,visible)=>{if(states.has(id))states.get(id).visible=visible;calls.push(['visibility',id,visible]);return {ok:true};},
};
const overlays=createOverlayCoordinator(document);observeOverlays(overlays);
const app=createApp({render:()=>h('main',{style:'height:100vh;display:flex;flex-direction:column'},[
 h('header',{style:'height:32px;flex:none;padding:4px'},'P18F — controlled geometry fixture (native transport simulated)'),
 h(DesktopWorkspace,{ref:workspace,scope:SCOPE,defaultProfile:createWallLayout(SCOPE),storage:{readRaw:async()=>stored,writeAtomic:async raw=>{stored=raw;}},projectionView:feed,rows:rows.value,modes:Object.fromEntries(rows.value.map(r=>[r.id,r.control])),intentBuilders:{visibility:body=>body,control:body=>body,presentation:({capsuleId,verb})=>({type:verb,capsuleId})},controlRegistry:{},scheduler:{},tileScheduler:null,onSubmitIntent:()=>{},style:'flex:1;min-height:0'}, {surface:({capsuleId,desktopActive})=>h(RoleSurface,{surfaceId:capsuleId,label:capsuleId,control:rows.value.find(row=>row.id===capsuleId)?.control || 'human',presentationActive:desktopActive})})
])});
installKitTheme(app);app.provide('overlayCoordinator',overlays);app.mount('#app');
const style=document.createElement('style');style.textContent='html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}.cuk-capsule-panel{height:100%}.mv-surface-host{width:100%;height:100%;min-height:0}.mv-tile-capture-host{display:flex;flex-direction:column;min-height:0}.mv-role-viewport{background:linear-gradient(135deg,#17232e,#263b4c)}.mv-role-status{padding:12px;color:#dce9ef}.mv-tile-size-controls button{font-size:11px}';document.head.append(style);
const leaves=node=>node.type==='leaf'?[node]:node.data.flatMap(leaves);
const same=(a,b)=>Math.abs(a-b)<=2;
const clone=v=>JSON.parse(JSON.stringify(v));
const layout=()=>JSON.parse(stored).views.human.desktops.find(d=>d.id===JSON.parse(stored).views.human.active).layout.dockview;
const geometry=()=>[...document.querySelectorAll('[data-desktop="human-1"] .dv-groupview')].filter(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0).map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.id,x:r.x,y:r.y,width:r.width,height:r.height,tiles:el.querySelectorAll('.mv-tile').length};});
window.p18fPrepare=async(count,preset)=>{
 const nextRows=Array.from({length:count},(_,i)=>({id:'fixture-'+i,surfaceId:'fixture-'+i,generation:1,visibility:'unfolded',control:'human',attachmentState:'attaching',backendLifecycle:'active',title:'Human '+(i+1)}));
 const removed=rows.value.filter(row=>!nextRows.some(next=>next.id===row.id)).map(row=>({...row,backendLifecycle:'destroyed'}));
 if(removed.length){rows.value=[...nextRows,...removed];for(const fn of listeners)fn(feed.getSnapshot());await settle();}
 rows.value=nextRows;
 for(const fn of listeners)fn(feed.getSnapshot());await settle();
 let result=workspace.value.setPreset(preset);assert(result?.ok,'preset refused '+preset);await settle();
 let before=layout();
 const activeLeaves=leaves(before.grid.root).filter(l=>l.visible!==false);
 const panels=Object.values(before.panels);assert(panels.length===count,'one panel per tile');
 if(preset==='single'){assert(activeLeaves.filter(l=>l.data.views.length).length===1,'single group');assert(activeLeaves.find(l=>l.data.views.length).data.views.length===count,'all excess tabs');}
 if(preset==='side-by-side'){assert(activeLeaves.filter(l=>l.data.views.length).length===Math.min(count,2),'two columns');if(count>1)assert(activeLeaves.at(-1).data.views.length===count-1,'extras right tabs');}
 if(preset==='grid'){assert(activeLeaves.length===4,'four cells incl empty '+JSON.stringify({activeLeaves,rects:geometry()}));assert(activeLeaves.filter(l=>l.data.views.length===0).length===Math.max(0,4-count),'empty fourth cell');}
 if(preset==='floating'){assert(before.floatingGroups?.length===count,'one float per tile '+JSON.stringify({before,geometry:geometry()}));assert(!document.body.hasAttribute('data-mv-modal'),'floating dialog is modeless');}
 const visibleNative=rows.value.filter(row=>states.get(row.id)?.visible).length;
 const expectedNative=preset==='single'?1:preset==='side-by-side'?Math.min(count,2):preset==='grid'?Math.min(count,4):count;
 assert(visibleNative===expectedNative,'only visible tabs paint native views '+JSON.stringify({preset,count,visibleNative,expectedNative}));
 const rects=geometry();
 const wall=document.querySelector('[data-desktop="human-1"] .dv-shell').getBoundingClientRect();
 if(preset==='single')assert(rects.some(r=>same(r.width,wall.width)&&same(r.height,wall.height)),'single fills wall '+JSON.stringify({rects,wall:{width:wall.width,height:wall.height}}));
 if(preset==='side-by-side'&&count>1)assert(rects.every(r=>Math.abs(r.width-wall.width/2)<=4&&same(r.height,wall.height)),'equal columns');
 if(preset==='grid')assert(rects.every(r=>Math.abs(r.width-wall.width/2)<=4&&Math.abs(r.height-wall.height/2)<=4),'equal grid cells '+JSON.stringify({rects,wall}));
 if(preset==='focus-strip'&&count>1)assert(rects.some(r=>same(r.width,Math.floor(wall.width*.7))),'70 percent focus');
 if(preset==='floating')assert(rects.every(r=>r.x>=wall.x-2&&r.y>=wall.y-2&&r.x+r.width<=wall.right+2&&r.y+r.height<=wall.bottom+2),'floats inside wall');
 result=workspace.value.setPreset(preset);assert(result?.ok,'repeat preset refused');await settle();
 const after=geometry();assert(after.length===rects.length,'repeat group count');
 assert(after.every((r,i)=>['x','y','width','height'].every(k=>same(r[k],rects[i][k]))),'repeat geometry idempotent');
 return {count,preset,rects,wall:{width:wall.width,height:wall.height},nativeConnections:calls.filter(c=>c[0]==='connect').length};
};
window.p18fControls=async()=>{
 await window.p18fPrepare(2,'side-by-side');
 const tile=()=>document.getElementById('tile-size-wider-fixture-0').closest('.mv-tile').getBoundingClientRect();
 const before=tile().width;
 for(let i=0;i<3;i++){document.getElementById('tile-size-wider-fixture-0').click();await settle();}
 const wider=tile().width;
 for(let i=0;i<3;i++){document.getElementById('tile-size-narrower-fixture-0').click();await settle();}
 const after=tile().width;assert(same(before,after),'size roundtrip '+[before,wider,after]);assert(wider>before+100,'wider responds');
 const connected=calls.filter(c=>c[0]==='connect'&&c[1]==='fixture-0').length,closed=calls.filter(c=>c[0]==='close'&&c[1]==='fixture-0').length;
 assert(workspace.value.addDesktop()===2,'new desktop 2');await settle();workspace.value.selectDesktop(1);await settle();
 const sourceActive=JSON.parse(stored).views.human.active;
 assert((await workspace.value.moveTile('fixture-0',2)).ok,'Move accepts');await settle();
 assert(JSON.parse(stored).views.human.active===sourceActive,'Move stays');
 assert(calls.filter(c=>c[0]==='connect'&&c[1]==='fixture-0').length===connected,'Move retains bridge');
 assert(calls.filter(c=>c[0]==='close'&&c[1]==='fixture-0').length===closed,'Move never revokes');
 workspace.value.selectDesktop(2);await settle();
 assert((await workspace.value.moveTile('fixture-0',1,true)).ok,'Move and go accepts');await settle();
 assert(JSON.parse(stored).views.human.active===1,'Move and go follows');
 assert(calls.filter(c=>c[0]==='connect'&&c[1]==='fixture-0').length===connected,'return retains bridge');
 // Menu owns native-view occlusion and exposes only this view's desktops.
 document.getElementById('tile-menu-fixture-0').click();await settle();assert(document.body.hasAttribute('data-mv-modal'),'menu overlays native');
 assert(document.getElementById('tile-move-fixture-0-2'),'destination listed');document.getElementById('tile-menu-fixture-0').click();await settle();
 return {before,wider,after,delta:after-before,moveBridgePreserved:true,menuOcclusion:true};
};

window.p18fMembership=async()=>{
 const outcomes=[];
 for(const preset of ['single','side-by-side','grid','focus-strip','floating']) {
  await window.p18fPrepare(2,preset);
  const addedId='membership-'+preset;
  const third={id:addedId,surfaceId:addedId,generation:1,visibility:'unfolded',control:'human',attachmentState:'attaching',backendLifecycle:'active',title:'Human 3'};
  rows.value.push(third);for(const fn of listeners)fn(feed.getSnapshot());await settle();await settle();
  let saved=layout();assert(Object.keys(saved.panels).length===3,'membership add persisted '+preset);
  let cells=leaves(saved.grid.root).filter(l=>l.data.views.length);
  if(preset==='single')assert(cells.length===1&&cells[0].data.views.length===3,'single membership tabs');
  if(preset==='side-by-side')assert(cells.length===2&&cells.some(l=>l.data.views.length===2),'side membership tabs');
  if(preset==='grid')assert(leaves(saved.grid.root).length===4&&cells.length===3,'grid membership empty cell');
  if(preset==='focus-strip')assert(cells.length===3,'strip membership stacked');
  if(preset==='floating')assert(saved.floatingGroups?.length===3,'floating membership independent');
  rows.value.find(r=>r.id===addedId).backendLifecycle='destroyed';for(const fn of listeners)fn(feed.getSnapshot());await settle();await settle();
  rows.value=rows.value.filter(r=>r.id!==addedId);for(const fn of listeners)fn(feed.getSnapshot());await settle();
  saved=layout();assert(Object.keys(saved.panels).length===2,'membership remove persisted '+preset);
  outcomes.push({preset,added:3,remaining:2});
 }
 return outcomes;
};
window.p18fRenumber=async()=>{
 const state=()=>JSON.parse(stored);
 const connected=calls.filter(c=>c[0]==='connect'&&c[1]==='fixture-0').length;
 const closed=calls.filter(c=>c[0]==='close'&&c[1]==='fixture-0').length;
 assert(workspace.value.addDesktop()===3,'append third');await settle();
 assert((await workspace.value.moveTile('fixture-0',3)).ok,'move to third');await settle();
 assert(workspace.value.removeDesktop(2),'remove empty middle');await settle();
 assert(JSON.stringify(state().views.human.desktops.map(d=>d.id))==='[1,2]','numbers compact');
 assert(state().assignments['fixture-0'].desktop===2,'assignment follows renumber');
 assert(calls.filter(c=>c[0]==='connect'&&c[1]==='fixture-0').length===connected,'renumber retains connection');
 assert(calls.filter(c=>c[0]==='close'&&c[1]==='fixture-0').length===closed,'renumber keeps renderer');
 assert(workspace.value.addDesktop()===3,'new position reused');await settle();
 assert(workspace.value.removeDesktop(3),'remove new empty desktop');await settle();
 assert((await workspace.value.moveTile('fixture-0',1,true)).ok,'return to first');await settle();
 return {ids:state().views.human.desktops.map(d=>d.id),nativeBridgePreserved:true,next:state().views.human.next};
};

window.p18fAgentMove=async()=>{
 const agent={id:'agent-move',surfaceId:'agent-move',generation:1,visibility:'unfolded',control:'agent',attachmentState:'attaching',backendLifecycle:'active',title:'Agent watch handoff'};
 rows.value.push(agent);for(const fn of listeners)fn(feed.getSnapshot());await settle();workspace.value.selectView('agent');await settle();
 document.getElementById('tile-menu-agent-move').click();await settle();document.getElementById('tile-watch-agent-move').click();await settle();
 assert(states.has('agent-move'),'agent watch connected');
 const connects=calls.filter(c=>c[0]==='connect'&&c[1]==='agent-move').length;
 const closes=calls.filter(c=>c[0]==='close'&&c[1]==='agent-move').length;
 assert((await workspace.value.moveTile('agent-move','new',true)).ok,'agent move and go');await settle();
 assert(states.has('agent-move'),'watch survives move');
 assert(calls.filter(c=>c[0]==='connect'&&c[1]==='agent-move').length===connects,'watch retains bridge');
 assert(calls.filter(c=>c[0]==='close'&&c[1]==='agent-move').length===closes,'watch never revoked');
 return {watchRetained:true,sameBridge:true};
};
