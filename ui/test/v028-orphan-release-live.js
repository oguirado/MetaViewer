import {createApp, defineAsyncComponent, h, ref, nextTick} from 'vue';
import {installKitTheme} from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
import '../src/design/metaviewer.css';
let released=0;
globalThis.metaviewerRoles={
  choices:async()=>[{profileId:'account-a',available:true,currentMode:'closed',held:true,holder:'srf-id-orphan'}],
  releaseIdentity:async()=>{released++;return {ok:true};},
};
const Dialog=defineAsyncComponent(()=>import('../src/identities/IdentitiesDialog.vue'));
const open=ref(true);
const app=createApp({setup:()=>()=>h('main',[
  h('button',{id:'reopen',onClick:()=>{open.value=true;}},'Open Identities'),
  h(Dialog,{open:open.value,host:{identity:{list:async()=>({ok:true,rows:[{id:'account-a',label:'Account',domains:[]}]})}},onClose:()=>{open.value=false;}}),
])});
installKitTheme(app);app.mount('#app');
window.orphanLive={
  async reopen(){open.value=false;await nextTick();open.value=true;await nextTick();},
  state:()=>({released,confirmation:!!document.querySelector('#identity-release-dialog'),identities:!!document.querySelector('#identities-dialog')}),
};
