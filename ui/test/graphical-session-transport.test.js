import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installAuthorityWire,GRAPHICAL_SESSION_CHANNELS} from '../electron/authorityWire.js';
import {createPreloadFacade} from '../electron/preload.js';

const snapshot=()=>({available:true,busy:false,code:null,revision:0,session:null,uncertain:false,point_ages_ms:{}});
async function fixture(t,nested=false){
 const root=await mkdtemp(join(tmpdir(),'graphical-wire-')),handlers=new Map(),calls=[],posts=[];
 const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
 const contents={id:321,mainFrame:frame,isDestroyed:()=>false,postMessage:(...a)=>posts.push(a)};
 let removed=false;
 const core={request:async()=>true,graphicalSession:{status:snapshot,request:async a=>{calls.push(a);return snapshot();},subscribe:cb=>{cb(snapshot());return()=>{removed=true;};}}};
 const binding=installAuthorityWire({ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},contents,core,argv:nested?['--nested-depth=1']:[],env:{XDG_CONFIG_HOME:root}});
 t.after(async()=>{await binding.dispose();await rm(root,{recursive:true,force:true});});
 return {handlers,calls,posts,event:{sender:contents,senderFrame:frame},contents,binding,removed:()=>removed};
}
test('graphical IPC forwards one validated action and rejects wrong arity and sender before dispatch',async t=>{
 const f=await fixture(t),action={op:'attach',surface_id:'surface-one'},handler=f.handlers.get(GRAPHICAL_SESSION_CHANNELS.graphicalSessionRequest);
 assert.deepEqual(await handler(f.event,action),snapshot());assert.deepEqual(f.calls,[action]);
 for(const args of [[],[action,action],[{...action,owner_id:'actor-forged'}]])await assert.rejects(handler(f.event,...args),/ARGS|BAD_REQUEST/);
 await assert.rejects(handler({...f.event,sender:{...f.contents}},action),/SENDER/);
 assert.equal(f.calls.length,1);
 assert.equal(f.posts[0][0],'metaviewer:graphical-session.state');
 await f.binding.dispose();assert.equal(f.removed(),true);
});
test('nested wall cannot request graphical rewind or subscribe to its state',async t=>{
 const f=await fixture(t,true),status=await f.handlers.get(GRAPHICAL_SESSION_CHANNELS.graphicalSessionStatus)(f.event);
 assert.equal(status.available,false);assert.equal(status.session,null);assert.deepEqual(f.posts,[]);
 await assert.rejects(f.handlers.get(GRAPHICAL_SESSION_CHANNELS.graphicalSessionRequest)(f.event,{op:'attach',surface_id:'surface-one'}),/BAD_REQUEST/);
 assert.deepEqual(f.calls,[]);
});
test('preload keeps the graphical action and snapshot boundary closed',async()=>{
 const calls=[];
 const api=createPreloadFacade({transport:{invoke:async(c,a)=>{calls.push([c,a]);return snapshot();},subscribe:()=>()=>{}},bridge:{exposeInMainWorld(){}}});
 const action={op:'attach',surface_id:'surface-one'};
 assert.deepEqual(await api.graphicalSession.request(action),snapshot());
 assert.equal(calls[0][0],'metaviewer:graphical-session.request');assert.deepEqual(calls[0][1],[action]);
 await assert.rejects(api.graphicalSession.request({...action,runtime_id:'runtime-forged'}),/PAYLOAD/);assert.equal(calls.length,1);
 const bad=createPreloadFacade({transport:{invoke:async()=>({...snapshot(),path:'/private'})},bridge:{exposeInMainWorld(){}}});
 await assert.rejects(bad.graphicalSession.status(),/OUTCOME/);
});
