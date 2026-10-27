import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreloadFacade, ContractError } from '../electron/preload.js';
import { scrubChildEnv } from '../electron/coreLauncher.js';
import { installCaptureBridge, assertCaptureCall, assertCaptureReply } from '../electron/captureBridge.js';

// [TARGET, unit decision] Export accepts a capture ID and opaque destination
// token only. The same request covers sealed screenshots and recordings.
const request = {schema:'capture_request/v1',request_id:'export request',capture_id:'capture-1',destination:'recording:configured'};
const reply = {ok:true,export:{id:'capture-1',bytes:2048,sha256:'a'.repeat(64)}};
function fixture(core,env={}) {
  const handlers=new Map();
  const frame={url:'app://metaviewer/index.html',origin:'app://metaviewer'};
  const contents={id:1,mainFrame:frame,getURL:()=>frame.url};
  const event={sender:contents,senderFrame:frame};
  const bridge=installCaptureBridge({ipcMain:{handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)},contents,core,env});
  const api=createPreloadFacade({transport:{invoke:(channel,args)=>handlers.get(channel)(event,...args)},bridge:{exposeInMainWorld(){}}}).capture;
  return {api,event,handlers,bridge};
}
test('export crosses the closed preload/main seam with metadata only',async()=>{
  const root=mkdtempSync(join(tmpdir(),'mv-export-ui-'));
  const seen=[];
  const f=fixture({request:async value=>{seen.push(value);return reply;}},{MV_RECORDING_DESTINATION:root});
  try {
    assert.deepEqual(await f.api.export(request),reply);
    assert.deepEqual(seen,[{op:'capture',method:'export',request}]);
    const result=await f.api.export(request);
    assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.export));
    assert.ok(!JSON.stringify(result).includes(root));
    await assert.rejects(f.handlers.get('metaviewer:capture.export')({...f.event,sender:{}},request),ContractError);
  } finally {await f.bridge.dispose();rmSync(root,{recursive:true});}
});
test('unset destination refuses before transport and creates nothing',async()=>{
  let invoked=false;
  const f=fixture({request:async()=>{invoked=true;assert.fail('no destination');}});
  try {
    for(const destination of [null,'recording:configured']) {
      assert.deepEqual(await f.api.export({...request,destination}),{ok:false,code:'DESTINATION_UNSET',request_id:request.request_id});
    }
    assert.equal(invoked,false);
  } finally {await f.bridge.dispose();}
});
test('both boundary gates reject paths, traversal, extra keys and non-opaque tokens',()=>{
  const f=fixture({request:()=>assert.fail('invalid request reached core')});
  try {
    for(const value of [{...request,path:'/tmp/evil'},{...request,capture_id:'../evil'}, {...request,destination:'/tmp'}, {...request,destination:undefined}, {...request,bytes:10}]) {
      assert.throws(()=>assertCaptureCall('export',[value]),ContractError);
      assert.throws(()=>f.api.export(value),ContractError);
    }
    assert.throws(()=>f.api.export(),ContractError);
  } finally {void f.bridge.dispose();}
});
test('export receipts and typed refusals are closed and correlated',()=>{
  assert.deepEqual(assertCaptureReply('export',reply),reply);
  for(const code of ['DESTINATION_UNSET','CAPTURE_UNKNOWN','NOT_SEALED','DESTINATION_UNAVAILABLE','DESTINATION_EXISTS','LIMIT']) {
    const refusal={ok:false,code,request_id:request.request_id};
    assert.deepEqual(assertCaptureReply('export',refusal,request.request_id),refusal);
    assert.throws(()=>assertCaptureReply('export',refusal,'other'),ContractError);
  }
  for(const bad of [{...reply,path:'/secret'}, {...reply,export:{...reply.export,path:'/secret'}}, {...reply,export:{...reply.export,bytes:0}}, {...reply,export:{...reply.export,bytes:16777217}}, {...reply,export:{...reply.export,sha256:'oops'}}]) assert.throws(()=>assertCaptureReply('export',bad),ContractError);
});
test('nested export refuses locally without IPC',async()=>{
  const api=createPreloadFacade({transport:{nested:true,invoke:()=>assert.fail('nested export IPC')},bridge:{exposeInMainWorld(){}}}).capture;
  assert.deepEqual(await api.export(request),{ok:false,code:'NESTED_DISPLAY_ONLY',request_id:request.request_id});
});

test('launcher forwards only the validated host destination grant',()=>{
  const root=mkdtempSync(join(tmpdir(),'mv-export-env-'));
  const toolPath=process.env.PATH.split(delimiter).filter(value=>value.startsWith('/')).join(delimiter);
  try {
    const child=scrubChildEnv({PATH:toolPath,MV_RECORDING_DESTINATION:root,MV_UNRELATED:'secret'},root);
    assert.equal(child.MV_RECORDING_DESTINATION,root);
    assert.equal(child.MV_UNRELATED,undefined);
    assert.equal(scrubChildEnv({PATH:toolPath},root).MV_RECORDING_DESTINATION,undefined);
    for(const destination of ['relative',root+'\n',root+'\0',join(root,'missing')]) {
      assert.throws(()=>scrubChildEnv({PATH:toolPath,MV_RECORDING_DESTINATION:destination},root));
    }
  } finally {rmSync(root,{recursive:true});}
});
