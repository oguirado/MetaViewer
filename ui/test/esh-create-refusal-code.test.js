import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installAuthorityWire,WIRE_CHANNELS,ADAPTER_DETAIL_CODES} from '../electron/authorityWire.js';
async function wire(t,coreRequest) {
  const root=await mkdtemp(join(tmpdir(),'esh-wire-'));
  const handlers=new Map(),frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
  const contents={id:9,mainFrame:frame,isDestroyed:()=>false,postMessage(){}};
  const binding=installAuthorityWire({ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},contents,env:{XDG_CONFIG_HOME:root},argv:[],core:{request:coreRequest},terminal:null});
  t.after(async()=>{await binding.dispose();await rm(root,{recursive:true,force:true});});
  return ()=>handlers.get(WIRE_CHANNELS.createSurface)({sender:contents,senderFrame:frame});
}
const event=data=>({schema:'surface_event/v0.2',event:'error',data:{surface_id:'x',...data}});
test('ESH-CREATE-1: the adapter "profile already bound" refusal reaches the renderer as PROFILE_ALREADY_BOUND',async t=>{
  const create=await wire(t,async()=>event({code:'adapter',detail:'binding: profile already bound'}));
  assert.deepEqual(await create(),{ok:false,code:'PROFILE_ALREADY_BOUND'});
});
test('ESH-CREATE-2: the same detail carried by a thrown error maps too',async t=>{
  const create=await wire(t,async()=>{throw Object.assign(new Error('binding: profile already bound'),{code:'adapter'});});
  assert.deepEqual(await create(),{ok:false,code:'PROFILE_ALREADY_BOUND'});
});
test('ESH-CREATE-3 negative controls: unknown details stay generic, uppercase codes pass through, details never leak',async t=>{
  let reply=event({code:'adapter',detail:'binding: something else /home/user/secret'});
  const create=await wire(t,async()=>reply);
  assert.deepEqual(await create(),{ok:false,code:'SURFACE_CREATE_FAILED'});
  reply=event({code:'adapter',detail:'xx binding: profile already bound'});
  assert.deepEqual(await create(),{ok:false,code:'SURFACE_CREATE_FAILED'});
  reply=event({code:'RAM_ADMISSION_REFUSED',detail:'ignored'});
  assert.deepEqual(await create(),{ok:false,code:'RAM_ADMISSION_REFUSED'});
  assert.deepEqual([...ADAPTER_DETAIL_CODES.values()],['PROFILE_ALREADY_BOUND']);
});
