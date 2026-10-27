import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreloadFacade, installPreload, ContractError } from '../electron/preload.js';
import { installCaptureBridge, assertCaptureReply, assertCaptureCall, CAPTURE_CHANNELS } from '../electron/captureBridge.js';
const req={schema:'capture_request/v1',request_id:'request',surface_id:'surface-demo'};
const digest='a'.repeat(64);
const replies={screenshot:{ok:true,shot:{id:'shot',surface_id:'surface-demo',width:1,height:1,sha256:digest,created_ms:0}},
  recordStart:{ok:true,recording_id:'record'},recordStop:{ok:true,recording:{id:'record',surface_id:'surface-demo',frames:1,duration_ms:10,sealed:true,sha256:digest}},
  export:{ok:true,export:{id:'record',bytes:2048,sha256:digest}},list:{ok:true,rows:[]},subscribe:{ok:true},unsubscribe:{ok:true}};
function facade(invoke,subscribe=()=>()=>{},nested=false) {
  return createPreloadFacade({transport:{invoke,subscribe,nested},bridge:{exposeInMainWorld(){}}}).capture;
}
test('capture facade has exact frozen keys and each method routes to its closed channel',async()=>{
  const calls=[];
  const api=facade(async(channel,args)=>{calls.push([channel,args]);return replies[Object.keys(CAPTURE_CHANNELS).find(k=>`metaviewer:${CAPTURE_CHANNELS[k]}`===channel)];});
  assert.deepEqual(Object.keys(api).sort(),['export','list','recordStart','recordStop','screenshot','subscribe']);assert.ok(Object.isFrozen(api));
  assert.deepEqual(await api.screenshot(req),replies.screenshot);
  await api.recordStart({...req,mode:'ai'});await api.recordStop({schema:req.schema,request_id:req.request_id,recording_id:'record'});await api.export({schema:req.schema,request_id:req.request_id,capture_id:'record',destination:'recording:configured'});await api.list();
  const stop=api.subscribe(()=>{});stop();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(c=>c[0]),Object.values(CAPTURE_CHANNELS).map(s=>`metaviewer:${s}`));
});
test('every refusal resolves with correlation and malformed shapes fail before transport',async()=>{
  for(const code of ['SURFACE_UNKNOWN','ALREADY_RECORDING','NOT_RECORDING','CAPTURE_UNAVAILABLE','NESTED_DISPLAY_ONLY','LIMIT']) {
    const api=facade(async()=>({ok:false,code,request_id:'request'}));
    assert.deepEqual(await api.screenshot(req),{ok:false,code,request_id:'request'});
  }
  let invoked=false;const api=facade(async()=>{invoked=true;});
  for(const value of [null,{}, {...req,bytes:[]},{...req,request_id:'é'},{...req,surface_id:'../escape'}]) assert.throws(()=>api.screenshot(value),ContractError);
  assert.throws(()=>api.recordStart(req),ContractError);assert.throws(()=>api.list(1),ContractError);
  assert.throws(()=>api.subscribe(3),ContractError);assert.equal(invoked,false);
});
test('positive replies reject all extra fields, paths, bytes and invalid refusal codes',()=>{
  for(const method of ['screenshot','recordStart','recordStop','list']) {
    assert.deepEqual(assertCaptureReply(method,replies[method]),replies[method]);
    for(const key of ['path','bytes','handle','channel']) assert.throws(()=>assertCaptureReply(method,{...replies[method],[key]:'secret'}),ContractError);
  }
  assert.throws(()=>assertCaptureReply('screenshot',{ok:false,code:'OTHER',request_id:'request'},'request'),ContractError);
  assert.throws(()=>assertCaptureReply('screenshot',{ok:true,shot:{...replies.screenshot.shot,path:'/secret'}}),ContractError);
  assert.throws(()=>assertCaptureReply('list',{ok:true,rows:[{path:'/secret'}]}),ContractError);
});
test('subscription drops malformed and capability bearing events and unsubscribes idempotently',async()=>{
  let receive;let revoked=0;const seen=[];const calls=[];
  const api=facade(async(channel)=>{calls.push(channel);return {ok:true};},(_channel,cb)=>{receive=cb;return()=>revoked++;});
  const stop=api.subscribe(v=>seen.push(v));
  const state={type:'capture.state',recording_id:'record',surface_id:'surface-demo',phase:'recording',frames:1,elapsed_ms:2};
  receive({...state,path:'/secret'});receive({...state,phase:'exported'});receive(state);
  assert.deepEqual(seen,[state]);stop();stop();await new Promise(resolve=>setImmediate(resolve));assert.equal(revoked,1);
  assert.deepEqual(calls,['metaviewer:capture.subscribe','metaviewer:capture.unsubscribe']);
});
// Sender fixture matches the authenticated top frame observation used by main.
function host(nested=false,core={request:async({method})=>replies[method]}) {
  const handlers=new Map();const frame={url:'app://metaviewer/index.html',origin:'app://metaviewer'};
  const contents={id:1,mainFrame:frame,getURL:()=>frame.url};
  const event={sender:contents,senderFrame:frame};
  const bridge=installCaptureBridge({ipcMain:{handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)},contents,core,nested});
  return {handlers,event,bridge};
}
test('main revalidates arguments and returns all positive shapes',async()=>{
  const h=host();
  for(const method of ['screenshot','recordStart','recordStop','list']) {
    const args=method==='list'?[]:[method==='recordStart'?{...req,mode:'ai'}:method==='recordStop'?{schema:req.schema,request_id:'request',recording_id:'record'}:req];
    assert.deepEqual(await h.handlers.get(`metaviewer:${CAPTURE_CHANNELS[method]}`)(h.event,...args),replies[method]);
  }
  await assert.rejects(h.handlers.get('metaviewer:capture.screenshot')(h.event,{...req,path:'/secret'}),ContractError);
  await assert.rejects(h.handlers.get('metaviewer:capture.list')({...h.event,sender:{}}),ContractError);
  await h.bridge.dispose();assert.equal(h.handlers.size,0);
});
test('nested refuses every method and transport absence resolves unavailable',async()=>{
  let invoked=false;const h=host(true,{request:async()=>{invoked=true;}});
  assert.equal(h.handlers.size,0);
  const api=facade(async()=>{assert.fail('nested IPC');},()=>{assert.fail('nested subscription');},true);
  const stopReq={schema:req.schema,request_id:'request',recording_id:'record'};
  for(const [method,args] of [['screenshot',[req]],['recordStart',[{...req,mode:'ai'}]],['recordStop',[stopReq]],['list',[]],['subscribe',[()=>{}]]]) {
    assert.deepEqual(await api[method](...args),{ok:false,code:'NESTED_DISPLAY_ONLY',request_id:args[0]?.request_id??''});
  }
  assert.throws(()=>api.screenshot({...req,path:'/secret'}),ContractError);
  assert.equal(invoked,false);await h.bridge.dispose();
  const unavailable=host(false,{request:async()=>{throw Error('offline');}});
  assert.deepEqual(await unavailable.handlers.get('metaviewer:capture.screenshot')(unavailable.event,req),{ok:false,code:'CAPTURE_UNAVAILABLE',request_id:'request'});
  await unavailable.bridge.dispose();
});
test('main and preload argument gates agree on allowed and forbidden requests',()=>{
  assertCaptureCall('screenshot',[req]);assert.throws(()=>assertCaptureCall('screenshot',[{...req,handle:4}]),ContractError);
});
test('main forwards only capture.state metadata and revokes its event source',async()=>{
  let emit,revoked=false;const sent=[];
  const h=host(false,{request:async({method})=>replies[method],subscribeCapture(cb){emit=cb;return()=>{revoked=true;};}});
  h.event.sender.send=(...args)=>sent.push(args);
  const state={type:'capture.state',recording_id:'record',surface_id:'surface-demo',phase:'recording',frames:2,elapsed_ms:3};
  emit(state);assert.equal(sent.length,0);
  await h.handlers.get('metaviewer:capture.subscribe')(h.event);
  emit({...state,bytes:[1]});emit(state);
  assert.deepEqual(sent,[['metaviewer:capture.state',state]]);
  await h.bridge.dispose();emit(state);assert.equal(sent.length,1);assert.equal(revoked,true);
});

test('native preload consumes the admitted nested signal and refuses without native IPC',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'MetaViewer --nested-depth=1'}});
  try {
    const api=installPreload({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke(){assert.fail('nested native IPC');},on(){assert.fail('nested native listener');}}}).capture;
    assert.deepEqual(await api.screenshot(req),{ok:false,code:'NESTED_DISPLAY_ONLY',request_id:req.request_id});
    assert.deepEqual(await api.recordStart({...req,mode:'ai'}),{ok:false,code:'NESTED_DISPLAY_ONLY',request_id:req.request_id});
    assert.deepEqual(await api.recordStop({schema:req.schema,request_id:req.request_id,recording_id:'record'}),{ok:false,code:'NESTED_DISPLAY_ONLY',request_id:req.request_id});
    assert.deepEqual(await api.list(),{ok:false,code:'NESTED_DISPLAY_ONLY',request_id:''});
    const unsubscribe=api.subscribe(()=>{});unsubscribe();
    assert.deepEqual(await unsubscribe,{ok:false,code:'NESTED_DISPLAY_ONLY',request_id:''});
  } finally {if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;}
});
