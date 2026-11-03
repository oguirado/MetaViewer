import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateDesktopState, createDesktopState} from '../electron/desktopLayout.js';
const source = readFileSync(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const wall = await import(`data:text/javascript;base64,${Buffer.from(script.replace(/import .* from 'vue';/, 'const defineComponent = value => value; const h = () => {};')).toString('base64')}`);
test('Control gates snapping; plain movement keeps exact free position and size', () => {
  const start = {x:10,y:20,width:310,height:230};
  assert.deepEqual(wall.floatDragBounds(start,{x:30,y:40},{x:779,y:577,ctrlKey:false},800,600,{cols:2,rows:2}),{x:490,y:370,width:310,height:230});
  assert.deepEqual(wall.floatDragBounds(start,{x:30,y:40},{x:779,y:577,ctrlKey:true},801,601,{cols:2,rows:2}),{x:400,y:300,width:401,height:301});
});
test('grid validates limits and clamps edges without losing rounding pixels', () => {
  assert.deepEqual(wall.floatDragBounds({x:0,y:0,width:50,height:50},{x:0,y:0},{x:-3,y:-2,ctrlKey:true},801,601,{cols:3,rows:2}),{x:0,y:0,width:267,height:300});
  for (const cols of [0,-1,1.5,6,NaN]) assert.throws(()=>wall.floatDragBounds({}, {}, {},800,600,{cols,rows:2}));
});
test('desktop grid survives JSON round trip, stays isolated, legacy profiles pass', () => {
  const state = createDesktopState();
  assert.equal(validateDesktopState(state),true);
  state.views.human.desktops[0].snapGrid = {cols:3,rows:1};
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(validateDesktopState(restored),true);
  assert.equal(restored.views.agent.desktops[0].snapGrid,undefined);
  for (const grid of [{cols:0,rows:2},{cols:2,rows:6},{cols:2,rows:2,extra:1},null]) {
    restored.views.human.desktops[0].snapGrid = grid;
    assert.equal(validateDesktopState(restored),false);
  }
});

function gestureFixture(sibling = false) {
  const listeners = new Map(), commits = [];
  const listen = (name,fn) => {if (!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name).add(fn);};
  const unlisten = (name,fn) => listeners.get(name)?.delete(fn);
  const head={appendChild(sheet){this.sheet=sheet;}};
  const doc = {head,querySelector:()=>({getAttribute:()=> 'fixture-nonce'}),addEventListener:listen,removeEventListener:unlisten,defaultView:{addEventListener:listen,removeEventListener:unlisten},createElement:()=>({style:{},setAttribute(){},remove(){this.removed=true;}})};
  const element = {}, parent = {getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}),appendChild(p){this.preview=p;}};
  const overlay = {parentElement:parent,contains:e=>e===element,style:{},setAttribute(){this.dragging=true;},removeAttribute(){this.dragging=false;},getBoundingClientRect:()=>({left:10,top:20,width:300,height:200})};
  const header = {closest:()=>overlay}, target = {closest:selector=>selector.startsWith('button') ? null : header};
  const root = {ownerDocument:doc,contains:()=>true,addEventListener:listen,removeEventListener:unlisten};
  let customized=0, saved=0;
  const group = {element,api:{location:{type:'floating'},setActive(){}}};
  const content={setAttribute(){this.dragging=true;},removeAttribute(){this.dragging=false;}};
  if(sibling) {header.closest=()=>null; element.closest=()=>overlay;}
  const panel={group,view:{content:{element:{contains:e=>e===header,closest:()=>content}}}};
  group.activePanel=panel;
  const api = {panels:[panel],groups:[group],addFloatingGroup:(g,b)=>commits.push({g,b})};
  const dispose = wall.installFloatingDrag(root,api,()=>({cols:2,rows:2}),()=>customized++,()=>saved++);
  const send = (name,patch={}) => {const event={type:name,button:0,pointerId:7,clientX:30,clientY:40,ctrlKey:false,target,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...patch}; for(const fn of [...(listeners.get(name)||[])]) fn(event); return event;};
  return {send,dispose,commits,parent,overlay,content,listeners,head,doc,customized:()=>customized,saved:()=>saved};
}
test('floating pointer capture blocks native docking and commits free bounds once',()=>{
  const f=gestureFixture(); const down=f.send('pointerdown');
  assert.equal(down.prevented,true);assert.equal(down.stopped,true);
  f.send('pointermove',{clientX:250,clientY:150});
  f.send('pointermove',{clientX:260,clientY:160});
  assert.equal(f.customized(),1);
  assert.equal(f.parent.preview.hidden,true);
  f.send('pointerup',{clientX:260,clientY:160});
  assert.deepEqual(f.commits[0].b.position,{left:240,top:140});
  assert.equal(f.commits[0].b.width,300);
  assert.equal(f.saved(),1); f.dispose();
  assert.equal([...f.listeners.values()].reduce((n,s)=>n+s.size,0),0);
});
test('Control preview follows pointer; releasing Control before drop keeps free size',()=>{
  const f=gestureFixture(); f.send('pointerdown');
  f.send('pointermove',{clientX:700,clientY:500,ctrlKey:true});
  assert.equal(f.parent.preview.hidden,false);
  assert.match(f.head.sheet.textContent,/left:400px/);
  f.send('keyup',{key:'Control'}); assert.equal(f.parent.preview.hidden,true);
  f.send('pointerup',{clientX:700,clientY:500});
  assert.equal(f.commits[0].b.width,300); f.dispose();
});
test('Control drop snaps; unrelated pointers and cancelled gestures never commit',()=>{
  const f=gestureFixture(); f.send('pointerdown');
  f.send('pointermove',{pointerId:8,clientX:700,clientY:500,ctrlKey:true});
  assert.equal(f.customized(),0);
  f.send('pointermove',{clientX:700,clientY:500,ctrlKey:true});
  f.send('pointerup',{clientX:700,clientY:500,ctrlKey:true});
  assert.deepEqual(f.commits[0].b,{position:{left:400,top:300},width:400,height:300,disableSmartGuides:true});f.dispose();
  for(const event of ['pointercancel','blur','visibilitychange']) {
    const c=gestureFixture();c.send('pointerdown');c.send('pointermove',{clientX:700});c.send(event);c.send('pointerup');
    assert.equal(c.commits.length,0);assert.equal(c.overlay.dragging,false);c.dispose();
  }
});
test('custom drag closes preset refresh so later dimensions cannot re-dock the float',()=>{
  const row={id:'test',surfaceId:'test',backendLifecycle:'active',title:'Test',generation:1,visibility:'unfolded',control:'human'};
  const panel={id:'panel-test',api:{setTitle(){},close(){}}};
  let layouts=0;
  const api={width:0,height:0,groups:[],panels:[panel],getPanel:()=>panel,addPanel(){},addFloatingGroup(){layouts++;}};
  const windows={state:()=>({hidden:false,floating:true}),show(){},hide(){},float(){},dock(){throw Error('must never re-dock');}};
  const controller=wall.createWallWorkspaceController({projectionView:{getProjection:()=>({rows:[row]})}});
  assert.equal(controller.handleReady({api,windows}).ok,true);
  assert.equal(controller.setPreset('grid').ok,true);
  assert.equal(controller.setPreset(null).ok,true);
  api.width=800;api.height=600;
  assert.equal(controller.refreshPreset(),undefined);
  assert.equal(layouts,0);
  controller.dispose();
});

test('malformed desktop entries refuse without throwing before optional-grid validation',()=>{
  for (const desktop of [null,undefined,42,[],false]) {
    const state=createDesktopState();state.views.human.desktops[0]=desktop;
    assert.equal(validateDesktopState(state),false);
  }
});

test('missing style nonce refuses the gesture before native docking can start',()=>{
  const f=gestureFixture();f.doc.querySelector=()=>null;
  const down=f.send('pointerdown');assert.equal(down.stopped,true);
  f.send('pointermove',{clientX:700});f.send('pointerup');
  assert.equal(f.commits.length,0);assert.equal(f.customized(),0);f.dispose();
});

test('sibling-rendered capsule header resolves its floating group and follows Control changes without pointer motion',()=>{
  const f=gestureFixture(true);
  assert.equal(f.send('pointerdown').stopped,true);
  assert.equal(f.parent.preview.hidden,true);
  f.send('pointermove',{clientX:700,clientY:500});
  assert.equal(f.content.dragging,true);
  assert.equal(f.parent.preview.hidden,true);
  f.send('keydown',{key:'Control',ctrlKey:true});
  assert.equal(f.parent.preview.hidden,false);
  assert.match(f.head.sheet.textContent,/left:400px;top:300px;width:400px;height:300px/);
  f.send('keyup',{key:'Control'});
  assert.equal(f.parent.preview.hidden,true);
  f.send('keydown',{key:'Control',ctrlKey:true});
  f.send('pointerup',{clientX:700,clientY:500,ctrlKey:true});
  assert.deepEqual(f.commits[0].b,{position:{left:400,top:300},width:400,height:300,disableSmartGuides:true});
  assert.equal(f.content.dragging,false);f.dispose();
});
test('default floating frames use full wall height within bounds, including short and large walls',()=>{
  for(const [width,height] of [[1240,359],[1600,1000],[320,240],[3840,2160]]) {
    const rects=wall.presetRectangles('floating',Array.from({length:5},(_,id)=>({id:String(id)})),width,height);
    for(const rect of rects) {
      assert.equal(rect.height,height);
      assert.equal(rect.width,Math.floor(width*.9));
      assert(rect.width*rect.height>=width*height*.5);
      assert(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=width && rect.y+rect.height<=height);
    }
  }
});
