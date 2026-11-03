// Visual fixture uses the production role header and clipping rules.
import {createApp, h, ref, onMounted, nextTick} from 'vue';
import CapsulePanel from '../.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue';
import {installKitTheme} from 'capsule-ui-kit/theme';
import '../src/App.vue'; // Production chrome visibility rules.
import RoleSurface from '../src/surfaces/RoleSurface.vue';
import 'capsule-ui-kit/theme.css';
import '../src/wall/wall.css';
globalThis.metaviewerRoles = {
  status:async()=>({ok:true,role:'agent',hostWindow:{title:'Mines',program:'gnome-mines',state:'active'}}),
  close:async()=>({ok:true}),
};
const app=createApp({setup(){
 const verdict=ref('Checking menus');
 onMounted(async()=>{
   await new Promise(resolve=>setTimeout(resolve,500));await nextTick();
   const buttons=[...document.querySelectorAll('.mv-role-menu-button')];
   const valid=buttons.length===5 && buttons.every(button=>{
     const tile=button.closest('.mv-tile').getBoundingClientRect(),rect=button.getBoundingClientRect();
     return rect.left>=tile.left && rect.right<=tile.right && document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===button;
   });
   verdict.value=valid?'All menus reachable':'Menu clipped';
 });
 return ()=>h('main',{class:'mv-shell'},[
  h('p',{role:'status','aria-label':verdict.value},verdict.value),
  h('div',{style:'display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;width:100%'},Array.from({length:5},(_,i)=>h(CapsulePanel,{class:'mv-tile',capsuleId:'probe-'+i,style:'min-width:0;overflow:hidden;border:1px solid #777'},{surface:()=>h(RoleSurface,{surfaceId:'probe-'+i,label:'Mines '+i,control:'human',presentationActive:false},()=>h('p','Window content'))}))),
 ]);
}});
installKitTheme(app);
app.provide('capsuleChromeStyle','openvue');
app.provide('tileLayoutActions',{desktops:()=>[],transfers:new Map(),resize(){}});
app.mount('#app');
