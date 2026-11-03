// Real Dockview fixture: exercises the wall-owned pointer capture with live DOM.
import {createDockview} from 'dockview-core';
import {installFloatingDrag} from '../src/wall/WallWorkspace.vue';
const root = document.querySelector('#wall'), result=document.querySelector('#result');
const api=createDockview(root,{createComponent:()=>({element:document.createElement('div'),init(){this.element.textContent='Floating capsule';}})});
api.layout(800,600);
const panel=api.addPanel({id:'test',component:'test',title:'Drag this window'});
api.addFloatingGroup(panel,{position:{left:30,top:30},width:300,height:220});
api.addGroup({direction:'right'});
let custom=0, saved=0;
const release=installFloatingDrag(root,api,()=>({cols:2,rows:2}),()=>custom++,()=>{
  saved++;const group=api.toJSON().floatingGroups[0];
  result.textContent=JSON.stringify({custom,saved,...group.position});
});
window.addEventListener('beforeunload',()=>{release();api.dispose();});
window.tileProbe={api,get result(){return result.textContent;}};
function exercise(ctrlKey) {
  const overlay=root.querySelector('.dv-resize-container'), header=overlay.querySelector('.dv-floating-titlebar');
  const b=header.getBoundingClientRect(), area=overlay.parentElement.getBoundingClientRect();
  const start={...api.toJSON().floatingGroups[0].position};
  const pointer=(type,x,y)=>new PointerEvent(type,{bubbles:true,button:0,pointerId:9,clientX:x,clientY:y,ctrlKey});
  header.dispatchEvent(pointer('pointerdown',b.left+25,b.top+8));
  document.dispatchEvent(pointer('pointermove',area.left+650,area.top+450));
  const preview=root.querySelector('.wall-snap-preview');
  if (!preview || preview.hidden===ctrlKey) throw Error('Preview modifier gate failed');
  document.dispatchEvent(pointer('pointerup',area.left+650,area.top+450));
  const after=api.toJSON();
  if (!after.floatingGroups?.length || after.floatingGroups[0].data.views[0]!=='test') throw Error('Floating panel docked');
  const end=after.floatingGroups[0].position;
  if (ctrlKey ? end.left!==400 || end.top!==300 || end.width!==400 || end.height!==300 : end.width!==start.width || end.height!==start.height || end.left===start.left) throw Error('Unexpected drag geometry: '+JSON.stringify(end));
  result.setAttribute('aria-label',ctrlKey?'Control snap passed':'Free drag passed');
}
for(const [label,ctrl] of [['Run free drag',false],['Run Control snap',true]]) {
  const button=document.createElement('button');button.textContent=label;
  button.onclick=()=>{try{exercise(ctrl);}catch(error){result.textContent=String(error);result.setAttribute('aria-label','Drag failed');throw error;}};
  document.body.insertBefore(button,root);
}
