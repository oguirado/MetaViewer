import {createApp,h,ref} from 'vue';
import CatalogLauncher from '../src/catalog/CatalogLauncher.vue';
import {installKitTheme} from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
import '../src/App.vue';
const appId='0123456789abcdef01234567';
globalThis.metaviewerRoles={listApps:async()=>({apps:[{id:appId,name:'Probe window',binary:'xmessage',icon:''}],recent:[]})};
const app=createApp({setup(){
 const visible=ref(false),status=ref('No launch requested');
 return()=>h('main',{class:'mv-shell'},[
  h('button',{id:'probe-add',onClick:()=>{visible.value=true;}},'Add capsule'),
  h('button',{id:'probe-launcher',onClick:()=>{visible.value=true;}},'Launcher'),
  h('p',{role:'status'},status.value),
  h(CatalogLauncher,{visible:visible.value,'onUpdate:visible':value=>{visible.value=value;},
   onCreate:(intent,settle)=>{
    status.value='Launch requested: '+intent.binary;
    settle(globalThis.opfixNative?.launch(intent) ?? Promise.resolve({ok:true}));
   }}),
 ]);
}});
installKitTheme(app);app.mount('#app');
