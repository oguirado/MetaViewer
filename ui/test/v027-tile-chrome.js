// Container widths vary independently of the browser viewport.
import {createApp, h, ref, nextTick} from 'vue';
import {installKitTheme} from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
import '../src/App.vue';
import SurfacePanel from '../src/wall/SurfacePanel.vue';
import RoleSurface from '../src/surfaces/RoleSurface.vue';
import SurfaceCanvas from '../src/surfaces/SurfaceCanvas.vue';

globalThis.metaviewerRoles = {status:async()=>({ok:true,role:'agent',hostWindow:{title:'Research window',program:'editor',state:'active'}}),close:async()=>({ok:true})};
const width=ref(410), count=ref(3), sizes=[];
const rows=Array.from({length:4},(_,i)=>({id:'chrome-'+i,surfaceId:'chrome-'+i,title:'Research window '+i,profile_id:'test',backendLifecycle:'active',generation:1,visibility:'unfolded',control:'agent',attachmentState:'live'}));
const snapshot={status:'live',stale:false,error:null,envelope:{schema:'surface/v0.1',epoch:1,revision:1,projection:{rows}}};
const view={getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
const app=createApp({render:()=>h('main',{class:'mv-shell',style:'display:block;height:700px'},[
  h('div',{style:`display:grid;grid-template-columns:repeat(${count.value},${width.value}px);gap:8px;height:600px`},rows.slice(0,count.value).map(row=>h(SurfacePanel,{
    capsuleId:row.id,title:row.title,presentationInstance:row.id,projectionView:view,
    intentBuilders:{visibility:x=>x,control:x=>x,presentation:x=>x},controlRegistry:{},scheduler:{},tileScheduler:null,
    captureState:{bySurface:{},toggleRecord(){},screenshot(){}},clipboard:{writeText:async()=>{}},
  },{surface:()=>h(RoleSurface,{surfaceId:row.id,label:row.title,control:'agent',presentationActive:false},()=>h(SurfaceCanvas,{surfaceId:row.id,state:'live',frame:'frame-witness',generation:1,frameWidth:1280,frameHeight:900}))}))),
])});
installKitTheme(app);app.provide('capsuleChromeStyle','openvue');
app.provide('capsuleWindowPresentation',{revision:ref(0),get:()=>({state:()=>({hidden:false,floating:false,maximized:false})})});
app.provide('tileLayoutActions',{desktops:()=>[],transfers:new Map(),resize:(_id,action)=>sizes.push(action)});
app.provide('displayPortRouter',{bindSurface:binding=>binding.onState({surfaceId:binding.surfaceId,state:'active'}),unbindSurface(){}});
app.mount('#app');
const settle=async()=>{await nextTick();await new Promise(r=>setTimeout(r,100));};
const rect=n=>n.getBoundingClientRect();
const visible=n=>rect(n).width>0 && rect(n).height>0;
const assert=(ok,message)=>{if(!ok)throw Error(message);};
async function probe(){
  const measurements=[];
  for(const w of [410,300,900]){
    width.value=w;count.value=w===300?4:w===900?1:3;await settle();
    const tile=document.querySelector('.mv-tile'),header=tile.querySelector('.cuk-capsule-panel__header');
    assert(rect(header).height<= (w<500?40:110),`header too tall at ${w}: ${rect(header).height}`);
    assert(rect(tile.querySelector('.mv-tile-rail')).height<=44,`capture rail too tall at ${w}`);
    if(w<500){
      const strip=tile.querySelector('.mv-surface__strip');
      for(const selector of ['.mv-surface__display-chip','.mv-surface__guard']){
        const label=strip.querySelector(selector),range=document.createRange();range.selectNodeContents(label);
        assert(visible(label),`status label hidden at ${w}`);
        for(const line of range.getClientRects()){
          const box=rect(strip);
          assert(line.left>=box.left-1 && line.right<=box.right+1 && line.bottom<=box.bottom+1,`status clipped at ${w}: ${label.textContent}`);
          assert(line.bottom<=rect(tile).bottom+1,`status below tile at ${w}: ${label.textContent}`);
        }
      }
      assert(rect(tile.querySelector('.mv-role-viewport')).height>rect(tile).height/2,`frame gets less than half the tile at ${w}`);
      assert(visible(tile.querySelector('.mv-role-mode-badge')),`role hidden at ${w}`);
    }
    for(const button of tile.querySelectorAll('button')){
      if(!visible(button))continue;
      const b=rect(button),t=rect(tile);
      assert(b.left>=t.left-1 && b.right<=t.right+1,`button clipped at ${w}: ${button.ariaLabel||button.textContent}`);
      assert(button.ariaLabel || button.textContent.trim(),`unnamed button at ${w}`);
      if(w<500 && !button.disabled)assert(button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),`button obscured at ${w}: ${button.ariaLabel||button.textContent}`);
    }
    const resize=tile.querySelector('[id^="tile-size-wider-"]');
    if(w<500){
      assert(!visible(resize),'resize stays in menu at narrow width');
      tile.querySelector('.mv-role-menu-button').click();await settle();
      const item=tile.querySelector('[id^="tile-menu-size-wider-"]');
      assert(item && visible(item),'resize menu item reachable');
      const box=rect(item);assert(item.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)),'resize menu item obscured');
      item.click();await settle();
      assert(sizes.at(-1)==='wider','resize menu preserves action');
    }else assert(visible(resize),'wide resize controls unchanged');
    measurements.push({width:w,header:rect(header).height,rail:rect(tile.querySelector('.mv-tile-rail')).height});
  }
  width.value=410;count.value=3;await settle();
  return measurements;
}
// Optional inspection mode keeps the same dev fixture available for capture.
if(!new URL(location.href).searchParams.has('inspect')){
  setTimeout(()=>probe().then(result=>{document.body.dataset.result=JSON.stringify(result);document.body.dataset.verdict='pass';}).catch(error=>{document.body.dataset.verdict='fail';document.body.dataset.error=error.message;}),500);
}
