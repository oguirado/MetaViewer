import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {installAuthorityWire} from '../electron/authorityWire.js';
import * as vue from 'vue';
import * as catalogModel from '../src/catalog/catalogModel.js';
import {compileSfc,mountComponent,nodes,text,flush,SidebarIcon} from './mvui2-terminal-mount.mjs';
import {parse} from '@vue/compiler-sfc';
import {arm64CapsuleStatusSync} from '../electron/guestCommandProfile.js';
import {capsuleCapabilitiesValid} from '../electron/guestCommandValues.js';
import {envelopeTagForBody} from '../electron/hostBindings.js';
import {availableCatalogKindIds,unavailableArmCapsules} from '../src/catalog/catalogModel.js';
import {guestWorkloadTile,validGuestWorkloadTile} from '../src/wall/guestWorkloadTile.js';
import {createPreloadFacade} from '../electron/preload.js';
const status={vm:{available:true,reason:''},microvm:{available:true,reason:''}};
const session={schema:'guest_command_session/v0.2',workload_id:'workload-one',generation:1,owner_id:'actor-one',profile_id:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64',phase:'ready',ownership:'held',jobs_started:0,job:null,controls:{cancel:null,stop:null}};
const snapshot={available:true,busy:false,canCancel:false,uncertain:false,code:null,revision:1,session,stdout:'',stderr:''};
test('capabilities are closed, sanitized and ARM-only; absent setup stays visible disabled',()=>{
 const missing=arm64CapsuleStatusSync({},'arm64');assert.ok(capsuleCapabilitiesValid(missing));assert.equal(missing.vm.available,false);assert.equal(unavailableArmCapsules(missing).length,2);
 const ready=arm64CapsuleStatusSync({MV_ARM64_CAPSULE_STATUS:JSON.stringify(status)},'arm64');assert.ok(capsuleCapabilitiesValid(ready));assert.ok(availableCatalogKindIds(false,false,ready).includes('microvm'));
 const x64=arm64CapsuleStatusSync({MV_ARM64_CAPSULE_STATUS:JSON.stringify(status)},'x64');assert.equal(x64.supported_host,false);assert.deepEqual(unavailableArmCapsules(x64),[]);assert.ok(!availableCatalogKindIds(true,true,x64).some(k=>['vm','microvm'].includes(k)));
 const other=availableCatalogKindIds(true,true).filter(k=>!['vm','microvm'].includes(k));assert.deepEqual(availableCatalogKindIds(false,false,missing),other);
 for(const bad of [{...status,extra:1},{...status,vm:{available:'true',reason:''}},{...status,vm:{available:false,reason:'/private/path'}},{...status,vm:{available:false,reason:'bad\nreason'}},{...status,vm:{available:false,reason:''}}]){const result=arm64CapsuleStatusSync({MV_ARM64_CAPSULE_STATUS:JSON.stringify(bad)},'arm64');assert.equal(result.vm.available,false);assert.equal(result.microvm.available,false);assert.match(result.vm.reason,/invalid/);}
 assert.equal(capsuleCapabilitiesValid({...ready,vm:{...ready.vm,path:'private'}}),false);
});
test('capabilities getter is zero-action, zero-arity and validates its reply',async()=>{
 let reply=arm64CapsuleStatusSync({},'arm64');const calls=[];const api=createPreloadFacade({transport:{invoke:async(...args)=>{calls.push(args);return reply;}},bridge:{exposeInMainWorld(){}}});
 assert.deepEqual(await api.guestCommand.capabilities(),reply);assert.equal(calls[0][0],'metaviewer:guest-command.capabilities');await assert.rejects(api.guestCommand.capabilities({}),/arity/);reply={...reply,private_path:'x'};await assert.rejects(api.guestCommand.capabilities());
});
test('exact capsule body families use additive tag, legacy hello/list keep legacy tag',()=>{
 for(const schema of ['headless_request/v0.2','headless_event/v0.2','guest_command_request/v0.2','guest_command_event/v0.2'])assert.equal(envelopeTagForBody({schema}),'capsule_envelope/v0.2');
 for(const schema of ['hello/v0.2','surface_request/v0.2','surface_event/v0.2','guest_command_session/v0.2'])assert.equal(envelopeTagForBody({schema}),'envelope/v0.2');
});
test('workload tile identity is separate from surface/frame authority and retains unknown/released state',()=>{
 const tile=guestWorkloadTile(snapshot);assert.ok(validGuestWorkloadTile(tile));assert.equal(tile.workload_id,session.workload_id);assert.equal(tile.surfaceId,undefined);assert.equal(tile.frame,undefined);assert.equal(validGuestWorkloadTile({...tile,surfaceId:'forged'}),false);assert.equal(guestWorkloadTile({...snapshot,session:{...session,extra:1}}),null);
 for(const s of [{...session,phase:'uncertain'},{...session,phase:'stopped',ownership:'released'}])assert.ok(guestWorkloadTile({...snapshot,session:s}));
});
const source=readFileSync(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8');
const code=parse(source).descriptor.script.content.replace("from 'vue'",`from ${JSON.stringify(import.meta.resolve('vue'))}`);
const {createWallWorkspaceController}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('wall creates one local console panel from validated workload, never sends backend intent',()=>{
 const tile=guestWorkloadTile(snapshot),panels=new Map(),added=[];const api={panels:[],groups:[],getPanel:id=>panels.get(id),addPanel:p=>{added.push(p);const panel={id:p.id,api:{setActive(){}}};panels.set(p.id,panel);return panel;}};
 const controller=createWallWorkspaceController({projectionView:{getProjection:()=>({rows:[]})},workloadTiles:()=>[tile],validateWorkloadTile:validGuestWorkloadTile});
 assert.equal(controller.revealWorkload(tile.id).ok,false);assert.equal(controller.handleReady({api,windows:{state:()=>({hidden:false}),show(){},hide(){},float(){},dock(){}},revision:1}).ok,true);
 assert.equal(controller.revealWorkload('forged').ok,false);assert.equal(controller.revealWorkload(tile.id).ok,true);assert.equal(controller.revealWorkload(tile.id).ok,true);assert.equal(added.length,1);assert.equal(added[0].component,'CapsulePanel');assert.deepEqual(added[0].params,{sessionId:tile.id});assert.equal(added[0].params.capsuleId,undefined);controller.dispose();
 const unverified=createWallWorkspaceController({workloadTiles:()=>[tile]});assert.equal(unverified.revealWorkload(tile.id).ok,false);
});

test('host capability getter intersects custody and real profiles without actions',async t=>{
 const root=await mkdtemp('/dev/shm/capsule-cap-');const handlers=new Map(),states=new Map();let actions=0;
 const env={XDG_CONFIG_HOME:root,MV_ARM64_CAPSULES:'1',MV_ARM64_CAPSULE_STATUS:JSON.stringify(status),MV_SRF_PROFILES:JSON.stringify({vm:{Kind:'vm',NativeKind:'vm',Program:'notepad-vm',Width:1280,Height:900,Display:':100',RAMRoot:'/dev/shm/synthetic-vm',default_mode:'agent'}})};
 const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'},contents={id:901,mainFrame:frame,isDestroyed:()=>false,send(){},postMessage(){}};let guest={...snapshot,session:null};
 const wire=installAuthorityWire({ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},contents,env,argv:[],hostArch:'arm64',capsuleStates:states,core:{guestCommand:{status:()=>guest,subscribe:()=>()=>{}},request:async()=>{actions++;throw Error('unexpected action');}}});
 t.after(async()=>{await wire.dispose();await rm(root,{recursive:true});});
 const api=createPreloadFacade({transport:{invoke:(key,args)=>handlers.get(key)({sender:contents,senderFrame:frame},...args)},bridge:{exposeInMainWorld(){}}});
 let cap=await api.guestCommand.capabilities();assert.equal(cap.vm.available,true);assert.equal(cap.microvm.available,true);
 states.set('s',{state:'lost'});cap=await api.guestCommand.capabilities();assert.equal(cap.microvm.available,false);states.set('s',{state:'destroyed'});assert.equal((await api.guestCommand.capabilities()).microvm.available,true);
 guest={...snapshot};assert.equal((await api.guestCommand.capabilities()).vm.available,false);assert.equal((await api.authority.createSurface({kind:'vm'})).ok,false);
 guest={...snapshot,session:{...session,phase:'stopped',ownership:'released'}};cap=await api.guestCommand.capabilities();assert.equal(cap.vm.available,true);assert.equal(cap.microvm.available,false);
 env.MV_SRF_PROFILES='{}';assert.equal((await api.guestCommand.capabilities()).vm.available,false);assert.equal(actions,0);
});
test('mounted picker renders disabled ARM reasons and omits ARM entries on x64',async()=>{
 const Dialog=vue.defineComponent({props:['types'],setup:(p,c)=>()=>vue.h('div',{},[...p.types.map(k=>vue.h('button',{'data-kind':k.id},k.label)),c.slots.empty?.()])});
 const Catalog=await compileSfc('catalog/CatalogLauncher.vue',{'./GroupedCapsuleDialog.vue':Dialog,'./catalogModel.js':catalogModel,'../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue':SidebarIcon});
 for(const arch of ['arm64','x64']){const cap=arm64CapsuleStatusSync({},arch),mounted=mountComponent(Catalog,{visible:true,arm64Capabilities:cap});await flush();const buttons=nodes(mounted.root).filter(n=>n.tag==='button');assert.equal(buttons.filter(n=>Object.hasOwn(n.props??{},'disabled')&&n.props.disabled!==false).length,arch==='arm64'?2:0);assert.ok(!buttons.some(n=>['vm','microvm'].includes(n.props?.['data-kind'])));if(arch==='arm64')assert.match(text(mounted.root),/Complete ARM64 capsule setup/);mounted.app.unmount();}
});
