import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from '@vue/compiler-sfc';
import * as desktops from '../electron/desktopLayout.js';
import {desktopShortcut,interceptDesktopShortcut} from '../electron/desktopShortcuts.js';
import {surfaceCreateRefusal} from '../electron/roleHost.js';
import {createRefusalReason,MAX_CAPSULES} from '../electron/profilePicker.js';
import {createWallLayout,SCOPE} from '../src/wall/layout.js';
import {decodeAndMigrateLayoutProfile} from '../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';
const read = path=>readFileSync(new URL(path,import.meta.url),'utf8');
const wallSource = parse(read('../src/wall/WallWorkspace.vue')).descriptor.script.content;
let serial = 0;
const load = source=>import('data:text/javascript;base64,'+Buffer.from(source.replace(/from 'vue'/,"from '"+import.meta.resolve('vue')+"'")).toString('base64')+'#'+serial++);
const wall = await load(wallSource);
const mut = (source,from,to)=>{assert(source.includes(from),'mutation anchor');return source.replace(from,to);};
function geometryOracle(api,preset) {
  for (let n=1;n<=5;n++) {
    const rows=Array.from({length:n},(_,i)=>({id:'t'+i})),tiles=rows.map(r=>({id:'panel-'+r.id}));
    const rects=api.presetRectangles(preset,tiles,1400,1000);
    assert.equal(rects.length,n);
    const expected = tiles.map(({id},i)=> {
      if(preset==='single')return {id,x:0,y:0,width:1400,height:1000};
      if(preset==='side-by-side')return n===1 ? {id,x:0,y:0,width:1400,height:1000} : {id,x:i ? 700:0,y:0,width:700,height:1000};
      if(preset==='grid')return {id,x:(Math.min(i,3)%2)*700,y:Math.floor(Math.min(i,3)/2)*500,width:700,height:500};
      if(preset==='focus-strip') { if(n===1||i===0)return {id,x:0,y:0,width:n===1?1400:979,height:1000};const y=Math.floor((i-1)*1000/(n-1));return {id,x:979,y,width:421,height:Math.floor(i*1000/(n-1))-y}; }
      return {id,x:24*i,y:0,width:1260,height:1000};
    });
    assert.deepEqual(rects,expected,preset+' '+n);
    const layout=api.arrangePreset(createWallLayout(SCOPE,rows).dockview,preset,tiles,1400,1000);
    assert(decodeAndMigrateLayoutProfile({...createWallLayout(SCOPE,rows),dockview:layout},{expectedScope:SCOPE}).ok);
    assert.deepEqual(api.arrangePreset(layout,preset,tiles,1400,1000),layout,'idempotent serialized cell geometry');
    const cells=[];const walk=node=>node.type==='leaf'?cells.push(node.data):node.data.forEach(walk);walk(layout.grid.root);
    const float=layout.floatingGroups||[];
    assert.deepEqual([...cells,...float.map(g=>g.data)].flatMap(c=>c.views).sort(),tiles.map(t=>t.id).sort());
    if(preset==='single')assert.equal(cells.filter(c=>c.views.length).length,1);
    if(preset==='side-by-side')assert.equal(cells.filter(c=>c.views.length).length,Math.min(n,2));
    if(preset==='grid') {assert.equal(cells.length,4);assert.equal(cells.filter(c=>!c.views.length).length,Math.max(0,4-n));}
    if(preset==='floating')assert.equal(float.length,n);
  }
}
const mutations={single:["if (preset === 'single') return", "if (false) return"], 'side-by-side':["Math.min(index,1)","index"],grid:["Math.min(index,3)","index"],'focus-strip':["width * .7","width * .6"],floating:["24 * index","48 * index"]};
const awaitedMutants={};
for(const [preset,[from,to]] of Object.entries(mutations))awaitedMutants[preset]=await load(mut(wallSource,from,to));
for(const preset of Object.keys(mutations)) {
  test('P18F '+preset+' exact cell/tab geometry for one through five tiles',()=>geometryOracle(wall,preset));
  test('P18F mutant '+preset+' is killed',()=>assert.throws(()=>geometryOracle(awaitedMutants[preset],preset),{code:'ERR_ASSERTION'}));
}

function desktopOracle(api) {
  const state=api.createDesktopState();api.assignSurface(state,'h','human');
  api.addDesktop(state);api.addDesktop(state);state.views.human.desktops[2].preset='grid';api.assignSurface(state,'third','human');
  assert(api.removeDesktop(state,'human',2));assert.deepEqual(state.views.human.desktops.map(d=>d.id),[1,2]);
  assert.equal(state.views.human.active,2);assert.equal(state.assignments.third.desktop,2);assert.equal(state.views.human.desktops[1].preset,'grid');assert.equal(state.views.human.next,3);
  assert.equal(api.addDesktop(state),3);
  state.views.human.active=1;
  assert(api.moveSurface(state,'h',2));assert.equal(state.assignments.h.desktop,2);assert.equal(state.views.human.active,1);
  assert(api.moveSurface(state,'h',3,true));assert.equal(state.assignments.h.desktop,3);assert.equal(state.views.human.active,3);
  assert.equal(api.moveSurface(state,'h',99,true),false);assert.equal(state.assignments.h.view,'human');
  assert(api.validateDesktopState(JSON.parse(JSON.stringify(state))));
}
test('P18F removal remaps populated desktops; Move and Move and go preserve ownership',()=>desktopOracle(desktops));
for(const [name,from,to] of [['renumber','  renumberDesktops(state,view);',''],['move','home.desktop = desktop;','home.desktop = 1;'],['follow','if (follow) {state.activeView','if (false) {state.activeView']])test('P18F mutant '+name+' is killed',async()=>{
 const api=await load(mut(read('../electron/desktopLayout.js'),from,to));assert.throws(()=>desktopOracle(api),{code:'ERR_ASSERTION'});
});

test('P18F Ctrl+Alt+arrows consumed on keydown and keyup at native boundary with exact surface target',async()=>{
 for(const [key,action] of Object.entries({ArrowLeft:'narrower',ArrowRight:'wider',ArrowUp:'shorter',ArrowDown:'taller'})) {
  assert.deepEqual(desktopShortcut({key,ctrlKey:true,altKey:true}),{type:'resize',action});
  let prevented=0;const sent=[],captured=new Set();const event={preventDefault(){prevented++;}},win={webContents:{executeJavaScript:async code=>sent.push(code)}};
  assert(interceptDesktopShortcut(event,{key,type:'keyDown',control:true,alt:true},win,captured,'human-2'));
  assert(interceptDesktopShortcut(event,{key,type:'keyUp'},win,captured,'human-2'));assert.equal(prevented,2);assert.equal(captured.size,0);
  assert(sent[0].includes('"capsuleId":"human-2"'));assert(sent[0].includes(JSON.stringify(action)));
 }
 assert.equal(desktopShortcut({key:'ArrowRight',ctrlKey:true,altKey:false}),null);
});

test('P18F capacity maps only fixed display-exhaustion faults and preserves other adapter codes',()=>{
 const prior=console.info;console.info=()=>{};
 try {
  for(const detail of ['identity display pool exhausted; stop a capsule first','configured display is in use; stop its capsule first'])assert.equal(surfaceCreateRefusal({data:{code:'profile',detail}}),'CAPSULE_SLOT_UNAVAILABLE');
  assert.equal(surfaceCreateRefusal({data:{code:'profile',detail:'unadmitted profile, kind or geometry'}}),'ADAPTER_PROFILE');
  assert.equal(surfaceCreateRefusal({data:{code:'frame',detail:'native frame allocation mismatch'}}),'ADAPTER_FRAME');
  assert.equal(createRefusalReason('CAPSULE_SLOT_UNAVAILABLE'),`No free capsule slot. Stop another capsule first (up to ${MAX_CAPSULES} run at once).`);
 }finally{console.info=prior;}
});

function sizingOracle(api) {
 const size={width:700,height:500},writes=[];
 const panel={id:'panel-h',api:{setActive(){}},group:{api:{get boundingBox(){return {...size};},setSize(next){Object.assign(size,next);writes.push(next);}}}};
 const windows={state:()=>({hidden:false,floating:true}),show(){},hide(){},float(){},dock(){}};
 const controller=api.createWallWorkspaceController({projectionView:{getProjection:()=>({rows:[{id:'h',surfaceId:'h',backendLifecycle:'active'}]})}});
 assert(controller.handleReady({api:{getPanel:()=>panel,addPanel(){},width:1400,height:1000},windows}).ok);
 for(let i=0;i<3;i++)assert(controller.resizeTile('h','wider').ok);assert.equal(size.width,1120);
 for(let i=0;i<3;i++)assert(controller.resizeTile('h','narrower').ok);assert.equal(size.width,700);
 assert(controller.resizeTile('h','taller').ok);assert.equal(size.height,600);assert(controller.resizeTile('h','shorter').ok);assert.equal(size.height,500);
 for(let i=0;i<20;i++)controller.resizeTile('h','narrower');assert.equal(size.width,240);
 for(let i=0;i<20;i++)controller.resizeTile('h','taller');assert.equal(size.height,1000);
 controller.resizeTile('h','fit');assert.deepEqual(size,{width:640,height:480});assert.equal(controller.resizeTile('h','unknown').ok,false);assert(writes.length>0);
}
test('P18F sizing steps reverse, clamp and fit floating panels',()=>sizingOracle(wall));
test('P18F mutant size step is killed',async()=>assert.throws(()=>sizingOracle(awaitedSizeMutant),{code:'ERR_ASSERTION'}));
const awaitedSizeMutant=await load(mut(wallSource,'wallHeight) * .1','wallHeight) * .2'));

const roleSource=parse(read('../src/surfaces/RoleSurface.vue')).descriptor.script.content;
const role=await load(roleSource);
function clippingOracle(api) {
 const doc=globalThis.document, style=globalThis.getComputedStyle;
 try {
  const tiny={x:0,y:0,width:1,height:1},visible={x:400,y:300,width:400,height:300};
  const wall={id:'shell-wall',className:'',getBoundingClientRect:()=>tiny};
  const floating={className:'dv-resize-container',getBoundingClientRect:()=>visible,parentElement:wall};
  const content={className:'content',getBoundingClientRect:()=>visible,parentElement:floating};
  const el={closest:()=>floating,parentElement:content};
  globalThis.document={getElementById:()=>wall};globalThis.getComputedStyle=()=>({overflow:'visible'});
  const clips=api.collectClipRects(el);assert.equal(clips.wallViewport,null);
  assert(api.clipRoleBounds(visible,clips.scrollAncestors,clips.wallViewport,{width:1600,height:1000}).visible);
  content.className='clipped';globalThis.getComputedStyle=()=>({overflow:'hidden'});content.getBoundingClientRect=()=>tiny;
  assert.equal(api.clipRoleBounds(visible,...Object.values(api.collectClipRects(el)),{width:1600,height:1000}).visible,false);
 }finally{globalThis.document=doc;globalThis.getComputedStyle=style;}
}
test('P18F floating clips stop at the floating window; internal clips still apply',()=>clippingOracle(role));
test('P18F mutant wall fallback on floats is killed',async()=>assert.throws(()=>clippingOracle(awaitedClipMutant),{code:'ERR_ASSERTION'}));
const awaitedClipMutant=await load(mut(roleSource,'!floating && !wallViewport','!wallViewport'));

function modelessOracle(api) {
 const previous={MutationObserver:globalThis.MutationObserver,getComputedStyle:globalThis.getComputedStyle};
 let scan;
 try {
  globalThis.MutationObserver=class{constructor(callback){scan=callback;}observe(){}disconnect(){}};
  globalThis.getComputedStyle=()=>({visibility:'visible'});
  let modal='false',role='dialog';
  const node={getAttribute:key=>key==='role'?role:key==='aria-modal'?modal:null,classList:{contains:name=>name==='dv-resize-container'},hasAttribute:()=>false,getClientRects:()=>[{}],closest:()=>null};
  const body={setAttribute(){},removeAttribute(){}};
  const doc={body,querySelectorAll:()=>[node],addEventListener(){},removeEventListener(){}};
  const coordinator=api.createOverlayCoordinator(doc),dispose=api.observeOverlays(coordinator,doc);
  assert.equal(coordinator.count,0,'floating modeless dialog must paint native content');
  modal='true';scan();assert.equal(coordinator.count,1,'real modal must hide native content');
  modal='false';role='menu';scan();assert.equal(coordinator.count,1,'tile menu must hide native content');
  dispose();
 }finally{Object.assign(globalThis,previous);}
}
const overlaySource=read('../src/surfaces/overlayCoordinator.js'),overlay=await load(overlaySource);
const overlayMutant=await load(mut(overlaySource,"el.classList?.contains('dv-resize-container')","false"));
test('P18F floating dialog is modeless; menus and modal dialogs still occlude native views',()=>modelessOracle(overlay));
test('P18F mutant classifying a float as modal is killed',()=>assert.throws(()=>modelessOracle(overlayMutant),{code:'ERR_ASSERTION'}));

function allocationOracle(api) {
 const layout={grid:{width:1400,height:900,orientation:'HORIZONTAL',root:{type:'branch',data:[{type:'leaf',size:698,data:{views:['a']}},{type:'branch',size:698,data:[{type:'leaf',size:448,data:{views:['b']}},{type:'leaf',size:448,data:{views:['c']}}]}]}}};
 assert.equal(api.panelAllocation(layout,'a','width'),700);
 assert.equal(api.panelAllocation(layout,'c','width'),700);
 assert.equal(api.panelAllocation(layout,'c','height'),450);
 assert.equal(api.panelAllocation(layout,'absent','height'),undefined);
}
const allocationMutant=await load(mut(wallSource,'child.size + gapShare','child.size'));
test('P18F inverse sizing compensates measured split gaps on both axes',()=>allocationOracle(wall));
test('P18F mutant omitting gap compensation is killed',()=>assert.throws(()=>allocationOracle(allocationMutant),{code:'ERR_ASSERTION'}));

const capacitySource=read('../electron/roleHost.js');
const capacitySlice=capacitySource.slice(capacitySource.indexOf('const createDetails'),capacitySource.indexOf('/** @param {any} v @param {string} keys */'));
const capacityMutant=await load(mut(capacitySlice,"return 'CAPSULE_SLOT_UNAVAILABLE'","return 'ADAPTER_PROFILE'"));
test('P18F mutant obscuring display exhaustion is killed',()=>{
 const prior=console.info;console.info=()=>{};
 try{assert.throws(()=>assert.equal(capacityMutant.surfaceCreateRefusal({data:{code:'profile',detail:'identity display pool exhausted; stop a capsule first'}}),'CAPSULE_SLOT_UNAVAILABLE'),{code:'ERR_ASSERTION'});}finally{console.info=prior;}
});

const shortcuts=await load(read('../electron/desktopShortcuts.js'));
const shortcutMutant=await load(mut(read('../electron/desktopShortcuts.js'),"if (action) return {type:'resize',action};","if (false) return {type:'resize',action};"));
const keyOracle=api=>assert.deepEqual(api.desktopShortcut({key:'ArrowRight',control:true,alt:true}),{type:'resize',action:'wider'});
test('P18F resize keyboard grammar is present',()=>keyOracle(shortcuts));
test('P18F mutant forwarding resize keyboard chords is killed',()=>assert.throws(()=>keyOracle(shortcutMutant),{code:'ERR_ASSERTION'}));

function tabVisibilityOracle(api) {
 const previous=globalThis.getComputedStyle;
 const element={getClientRects:()=>[{}]};
 try {
  globalThis.getComputedStyle=()=>({visibility:'hidden',display:'block'});
  assert.equal(api.isRoleElementPainted(element),false,'inactive retained tab hides native pixels');
  globalThis.getComputedStyle=()=>({visibility:'visible',display:'block'});
  assert.equal(api.isRoleElementPainted(element),true);
 }finally{globalThis.getComputedStyle=previous;}
}
const tabMutant=await load(mut(roleSource,"style?.visibility !== 'hidden' && ",''));
test('P18F inactive Dockview tabs with nonempty rectangles remain hidden',()=>tabVisibilityOracle(role));
test('P18F mutant painting inactive tabs is killed',()=>assert.throws(()=>tabVisibilityOracle(tabMutant),{code:'ERR_ASSERTION'}));

test('P18F preserving empty grid cells never retains an empty floating window after a move',()=>{
 const base=createWallLayout(SCOPE,[{id:'h'}]);
 const grid=wall.arrangePreset(base.dockview,'grid',[{id:'panel-h'}],1000,800);
 const visit=node=>{if(node.type==='branch')node.data.forEach(visit);else{node.data.views=[];delete node.data.activeView;}};visit(grid.grid.root);
 grid.floatingGroups=[{data:{id:'float',views:['panel-h'],activeView:'panel-h'},position:{left:10,top:10,width:600,height:400}}];
 const moved=desktops.pruneDesktopLayout({...base,dockview:grid},()=>false,true);
 assert.equal(moved.dockview.floatingGroups.length,0);
 assert.equal(Object.keys(moved.dockview.panels).length,0);
 assert(decodeAndMigrateLayoutProfile(moved,{expectedScope:SCOPE}).ok);
});
