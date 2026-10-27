import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPreload} from '../electron/preload.js';

function notice() {
  return {
    frame_ref:{schema:'frame_ref/v0.2',surface_id:'s1',generation:1,tick:0,ts_ns:0,
      capture_us:0,width:1,height:1,format:'rgb24',sha256:'a'.repeat(64)},
    surface:{schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',
      geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'human',profile_id:'test'},
  };
}
function fixture(t) {
  const delivered=[],posts=[];
  let listener;
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{
    location:{origin:'app://metaviewer'},postMessage:(...args)=>posts.push(args),
  }});
  t.after(()=>{if(previous) Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;});
  const api=installPreload({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{
    invoke:async()=>true,on:(_channel,fn)=>{listener=fn;},removeListener(){},
  }});
  t.after(api.authority.subscribeFrames(value=>delivered.push(value)));
  return {delivered,posts,emit:value=>listener({ports:[{}]},value)};
}
test('closed v0.2 notice delivers callbacks and byte-plane ports',t=>{
  const f=fixture(t),value=notice();f.emit(value);
  assert.deepEqual(f.delivered,[value]);
  assert.equal(f.posts.length,1);
});
const refusals=[
  ['v0.1',v=>{v.frame_ref.schema='frame_ref/v0.1';}],
  ['host path',v=>{v.frame_ref.ramws_path='/dev/shm/private';}],
  ...['A'.repeat(64),'a'.repeat(64)+'\n',['a'.repeat(64)],null].map(sha256=>
    [`invalid hash ${JSON.stringify(sha256)}`,v=>{v.frame_ref.sha256=sha256;}]),
];
for(const part of [null,'frame_ref','surface']) {
  const sample=part?notice()[part]:notice();
  refusals.push([`${part??'notice'} extra key`,v=>{(part?v[part]:v).extra=true;}]);
  for(const key of Object.keys(sample)) refusals.push([`${part??'notice'} missing ${key}`,v=>{delete (part?v[part]:v)[key];}]);
}
for(const key of ['generation','width','height','tick','ts_ns','capture_us']) {
  for(const bad of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'1',null,...(['generation','width','height'].includes(key)?[0]:[])]) {
    refusals.push([`${key} refuses ${JSON.stringify(bad)}`,v=>{v.frame_ref[key]=bad;}]);
  }
}
for(const [label,mutate] of refusals) test(`v0.2 notice refuses ${label} before callbacks or ports`,t=>{
  const f=fixture(t),value=notice();mutate(value);f.emit(value);
  assert.deepEqual(f.delivered,[]);assert.deepEqual(f.posts,[]);
});
