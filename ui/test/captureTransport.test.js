import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMainBindings } from '../electron/hostBindings.js';
import { installCaptureBridge } from '../electron/captureBridge.js';
import { createPreloadFacade } from '../electron/preload.js';
import { createCapturePort, createCaptureState } from '../src/capture/capturePort.js';
import { captureRowsFor, captureShotsFor } from '../src/recording/recordingModel.js';

const req={schema:'capture_request/v1',request_id:'renderer request',surface_id:'surface'};
const hash='a'.repeat(64);
const replies={export:{ok:true,export:{id:'record',bytes:2048,sha256:hash}},recordStart:{ok:true,recording_id:'record'},screenshot:{ok:true,shot:{id:'shot',surface_id:'surface',width:1,height:1,sha256:hash,created_ms:0}},recordStop:{ok:true,recording:{id:'record',surface_id:'surface',frames:1,duration_ms:2,sealed:true,sha256:hash}},list:{ok:true,rows:[]}};
async function fixture(t, configured=true) {
  const root=await mkdtemp(join(tmpdir(),'mv-cap-'));
  const reg=component=>({endpoint:{component,instance:component},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.2.0',component_commit:'a'.repeat(40),dependencies:[]}});
  const config={session_id:'capture',core:reg('core'),peers:[reg('ui')]};
  await mkdir(join(root,'metaviewer'),{mode:0o700});
  await writeFile(join(root,'config.json'),JSON.stringify(config),{mode:0o600});
  let peer,seq=0,refusal=null,malformed=false;const requests=[],journal=[],sockets=new Set();
  const send=body=>peer.write(JSON.stringify({schema:'envelope/v0.2',msg_id:`r-${++seq}`,ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq,nonce:`n-${seq}`,body})+'\n');
  const metadata=(code,value)=>send({schema:'surface_event/v0.2',event:'error',data:{surface_id:'capture',code,detail:JSON.stringify(value)}});
  const server=createServer(socket=>{peer=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',data=>{
    buffer+=data;let offset;while((offset=buffer.indexOf('\n'))>=0) {
      const env=JSON.parse(buffer.slice(0,offset));buffer=buffer.slice(offset+1);requests.push(env);
      if(env.body.schema==='hello/v0.2') {send(config.core.hello);continue;}
      const method=env.body.schema==='surface_request/v0.2'?'list':{ram_start:'recordStart',ram_stop:'recordStop',screenshot:'screenshot',disk_start:'export'}[env.body.op];
      if(env.body.schema==='record_request/v0.2') {
        journal.push({
          schema:'session_record/v0.2',
          kind:refusal?'capture_refused':'capture_event',
          op:env.body.op,
          request_id:env.body.request_id,
          surface_id:env.body.params.surface_id,
          capture_id:env.body.params.recording_id??env.body.params.capture_id,
          code:refusal??'OK',
        });
      }
      let reply=refusal?{ok:false,code:refusal,request_id:env.body.request_id}:replies[method];
      if(malformed)reply={...reply,path:'/secret'};
      metadata('CAPTURE_REPLY',{request_id:env.msg_id,method,reply});
    }
  });});
  server.listen(join(root,'metaviewer/core.sock'));await once(server,'listening');await chmod(join(root,'metaviewer/core.sock'),0o600);
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const bindings=await createMainBindings({env:{MV_CORE_CONFIG:join(root,'config.json'),XDG_RUNTIME_DIR:root,MV_RECORDING_DESTINATION:configured?root:undefined},createMessageChannel:()=>{throw Error('no frames');}});
  t.after(()=>bindings.core.dispose());
  return {root,core:bindings.core,requests,journal,metadata,refuse:code=>{refusal=code;},malform:()=>{malformed=true;}};
}
test('production capture transport routes every operation and closed state subscription',async t=>{
  const f=await fixture(t);const seen=[];const revoke=f.core.subscribeCapture(value=>seen.push(value));
  for(const [method,request] of [['recordStart',{...req,mode:'ai'}],['screenshot',req],['recordStop',{schema:req.schema,request_id:req.request_id,recording_id:'record'}],['export',{schema:req.schema,request_id:req.request_id,capture_id:'record',destination:'recording:configured'}],['list',undefined]]) {
    const reply=await f.core.request({op:'capture',method,request});assert.deepEqual(reply,replies[method]);
    assert.ok(!JSON.stringify(reply).includes('path'));
  }
  assert.deepEqual(f.requests.slice(1).map(e=>e.body.op),['ram_start','screenshot','ram_stop','disk_start','list']);
  assert.match(f.requests[1].body.params.recording_id,/^[0-9a-f-]{36}$/i);
  assert.deepEqual(f.requests[1].body.params,{surface_id:'surface',recording_id:f.requests[1].body.params.recording_id,ring_bytes:8388608,max_fps:30});
  assert.match(f.requests[2].body.params.capture_id,/^[0-9a-f-]{36}$/i);
  assert.deepEqual(f.requests[2].body.params,{surface_id:'surface',capture_id:f.requests[2].body.params.capture_id});
  assert.deepEqual(f.requests[3].body.params,{surface_id:'surface',recording_id:'record'});
  assert.deepEqual(f.requests.at(-2).body.params,{surface_id:'surface',recording_id:'record',destination_capability_id:'recording:configured',destination_path:f.root,max_fps:30});
  assert.deepEqual(f.journal.map(r=>({op:r.op,surface_id:r.surface_id,code:r.code})),[
    {op:'ram_start',surface_id:'surface',code:'OK'},
    {op:'screenshot',surface_id:'surface',code:'OK'},
    {op:'ram_stop',surface_id:'surface',code:'OK'},
    {op:'disk_start',surface_id:'surface',code:'OK'},
  ]);
  const count=f.requests.length;
  assert.deepEqual(await f.core.request({op:'capture',method:'export',request:{schema:req.schema,request_id:req.request_id,capture_id:'record',destination:null}}),{ok:false,code:'DESTINATION_UNSET',request_id:req.request_id});
  assert.equal(f.requests.length,count);
  const state={type:'capture.state',recording_id:'record',surface_id:'surface',phase:'recording',frames:1,elapsed_ms:2};
  f.metadata('CAPTURE_STATE',state);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(seen,[state]);
  revoke();f.metadata('CAPTURE_STATE',state);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(seen,[state]);
  await assert.rejects(f.core.request({op:'capture',method:'screenshot',request:{...req,path:'/secret'}}));
});
test('production capture refusals retain original renderer correlation and pin fallback surface capture for unknown IDs',async t=>{
  const f=await fixture(t);
  for(const code of ['SURFACE_UNKNOWN','ALREADY_RECORDING','NOT_RECORDING','CAPTURE_UNAVAILABLE','LIMIT']) {
    f.refuse(code);assert.deepEqual(await f.core.request({op:'capture',method:'screenshot',request:req}),{ok:false,code,request_id:req.request_id});
  }
  f.refuse('NOT_RECORDING');
  assert.deepEqual(await f.core.request({op:'capture',method:'recordStop',request:{schema:req.schema,request_id:req.request_id,recording_id:'absent'}}),{ok:false,code:'NOT_RECORDING',request_id:req.request_id});
  assert.deepEqual(f.requests.at(-1).body.params,{surface_id:'capture',recording_id:'absent'});
  assert.equal(f.journal.at(-1).surface_id,'capture');
  assert.notEqual(f.journal.at(-1).surface_id,'');
  assert.equal(f.journal.at(-1).kind,'capture_refused');
  assert.equal(f.journal.at(-1).op,'ram_stop');

  f.refuse('CAPTURE_UNKNOWN');
  assert.deepEqual(await f.core.request({op:'capture',method:'export',request:{schema:req.schema,request_id:req.request_id,capture_id:'absent-export',destination:'recording:configured'}}),{ok:false,code:'CAPTURE_UNKNOWN',request_id:req.request_id});
  assert.deepEqual(f.requests.at(-1).body.params,{surface_id:'capture',recording_id:'absent-export',destination_capability_id:'recording:configured',destination_path:f.root,max_fps:30});
  assert.equal(f.journal.at(-1).surface_id,'capture');
  assert.notEqual(f.journal.at(-1).surface_id,'');
  assert.equal(f.journal.at(-1).kind,'capture_refused');
  assert.equal(f.journal.at(-1).op,'disk_start');

  // Known-ID control and full start parameter assertions: once recordStart and screenshot succeed on 'surface',
  // subsequent recordStop/export refusals and events resolve surface_id to 'surface' instead of fallback 'capture'.
  f.refuse(null);
  assert.deepEqual(await f.core.request({op:'capture',method:'recordStart',request:{...req,mode:'ai'}}),replies.recordStart);
  const startParams=f.requests.at(-1).body.params;
  assert.match(startParams.recording_id,/^[0-9a-f-]{36}$/i);
  assert.deepEqual(startParams,{surface_id:'surface',recording_id:startParams.recording_id,ring_bytes:8388608,max_fps:30});
  assert.equal(f.journal.at(-1).surface_id,'surface');

  assert.deepEqual(await f.core.request({op:'capture',method:'screenshot',request:req}),replies.screenshot);
  const shotParams=f.requests.at(-1).body.params;
  assert.match(shotParams.capture_id,/^[0-9a-f-]{36}$/i);
  assert.deepEqual(shotParams,{surface_id:'surface',capture_id:shotParams.capture_id});
  assert.equal(f.journal.at(-1).surface_id,'surface');

  f.refuse('NOT_RECORDING');
  assert.deepEqual(await f.core.request({op:'capture',method:'recordStop',request:{schema:req.schema,request_id:req.request_id,recording_id:'record'}}),{ok:false,code:'NOT_RECORDING',request_id:req.request_id});
  assert.deepEqual(f.requests.at(-1).body.params,{surface_id:'surface',recording_id:'record'});
  assert.equal(f.journal.at(-1).surface_id,'surface');

  f.refuse('NOT_SEALED');
  assert.deepEqual(await f.core.request({op:'capture',method:'export',request:{schema:req.schema,request_id:req.request_id,capture_id:'record',destination:'recording:configured'}}),{ok:false,code:'NOT_SEALED',request_id:req.request_id});
  assert.deepEqual(f.requests.at(-1).body.params,{surface_id:'surface',recording_id:'record',destination_capability_id:'recording:configured',destination_path:f.root,max_fps:30});
  assert.equal(f.journal.at(-1).surface_id,'surface');

  assert.deepEqual(await f.core.request({op:'capture',method:'export',request:{schema:req.schema,request_id:req.request_id,capture_id:'shot',destination:'recording:configured'}}),{ok:false,code:'NOT_SEALED',request_id:req.request_id});
  assert.deepEqual(f.requests.at(-1).body.params,{surface_id:'surface',recording_id:'shot',destination_capability_id:'recording:configured',destination_path:f.root,max_fps:30});
  assert.equal(f.journal.at(-1).surface_id,'surface');
});
test('production capture rejects capability-bearing replies and malformed state',async t=>{
  const f=await fixture(t);f.malform();
  await assert.rejects(f.core.request({op:'capture',method:'screenshot',request:req}),/CORE_SEAMS_ABSENT/);
  const g=await fixture(t);let seen=false;g.core.subscribeCapture(()=>{seen=true;});
  g.metadata('CAPTURE_STATE',{type:'capture.state',path:'/secret'});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(g.core.getStatus().availability,'unavailable');assert.equal(seen,false);
});

test('native export without a host grant refuses before sending a disk request',async t=>{
  const f=await fixture(t,false);
  const count=f.requests.length;
  const request={schema:req.schema,request_id:req.request_id,capture_id:'record',destination:'recording:configured'};
  assert.deepEqual(await f.core.request({op:'capture',method:'export',request}),{ok:false,code:'DESTINATION_UNSET',request_id:req.request_id});
  assert.equal(f.requests.length,count);
});

test('sealed recordings list roundtrips through hostBindings and preload with surface filtering and negative controls',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mv-cap-reclist-'));
  const reg=component=>({endpoint:{component,instance:component},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.2.0',component_commit:'a'.repeat(40),dependencies:[]}});
  const config={session_id:'capture-reclist',core:reg('core'),peers:[reg('ui')]};
  await mkdir(join(root,'metaviewer'),{mode:0o700});
  await writeFile(join(root,'config.json'),JSON.stringify(config),{mode:0o600});
  /** @type {Map<string,any>} */ const rows=new Map();
  let peer,seq=0,nowMs=0,filterRecordingsOnly=false;const sockets=new Set();
  const send=body=>peer.write(JSON.stringify({schema:'envelope/v0.2',msg_id:`r-${++seq}`,ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq,nonce:`n-${seq}`,body})+'\n');
  const metadata=(code,value)=>send({schema:'surface_event/v0.2',event:'error',data:{surface_id:'capture',code,detail:JSON.stringify(value)}});
  const server=createServer(socket=>{peer=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',data=>{
    buffer+=data;let offset;while((offset=buffer.indexOf('\n'))>=0) {
      const env=JSON.parse(buffer.slice(0,offset));buffer=buffer.slice(offset+1);
      if(env.body.schema==='hello/v0.2') {send(config.core.hello);continue;}
      if(env.body.schema==='surface_request/v0.2' && env.body.op==='list' && env.msg_id.startsWith('capture-list:')) {
        const listedRows=filterRecordingsOnly?[...rows.values()].filter(r=>r.kind==='recording'):[...rows.values()];
        metadata('CAPTURE_REPLY',{request_id:env.msg_id,method:'list',reply:{ok:true,rows:listedRows}});
        continue;
      }
      if(env.body.schema==='record_request/v0.2' && env.body.op==='ram_start') {
        const id=env.body.params.recording_id,surface_id=env.body.params.surface_id;
        rows.set(id,{id,kind:'recording',surface_id,phase:'recording',frames:1,duration_ms:0,sealed:false,created_ms:(nowMs+=10)});
        metadata('CAPTURE_REPLY',{request_id:env.msg_id,method:'recordStart',reply:{ok:true,recording_id:id}});
        metadata('CAPTURE_STATE',{type:'capture.state',recording_id:id,surface_id,phase:'recording',frames:1,elapsed_ms:0});
      } else if(env.body.schema==='record_request/v0.2' && env.body.op==='ram_stop') {
        const id=env.body.params.recording_id,row=rows.get(id);
        row.phase='sealed';row.sealed=true;row.frames=2;row.duration_ms=4000;
        metadata('CAPTURE_REPLY',{request_id:env.msg_id,method:'recordStop',reply:{ok:true,recording:{id,surface_id:row.surface_id,frames:2,duration_ms:4000,sealed:true,sha256:hash}}});
        metadata('CAPTURE_STATE',{type:'capture.state',recording_id:id,surface_id:row.surface_id,phase:'sealed',frames:2,elapsed_ms:4000});
      } else if(env.body.schema==='record_request/v0.2' && env.body.op==='screenshot') {
        const id=env.body.params.capture_id,surface_id=env.body.params.surface_id,created_ms=(nowMs+=10);
        rows.set(id,{id,kind:'shot',surface_id,phase:'sealed',frames:1,duration_ms:0,sealed:true,created_ms});
        metadata('CAPTURE_REPLY',{request_id:env.msg_id,method:'screenshot',reply:{ok:true,shot:{id,surface_id,width:1,height:1,sha256:hash,created_ms}}});
      }
    }
  });});
  server.listen(join(root,'metaviewer/core.sock'));await once(server,'listening');await chmod(join(root,'metaviewer/core.sock'),0o600);
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const bindings=await createMainBindings({env:{MV_CORE_CONFIG:join(root,'config.json'),XDG_RUNTIME_DIR:root},createMessageChannel:()=>{throw Error('no frames');}});
  t.after(()=>bindings.core.dispose());
  const handlers=new Map(),listeners=new Set(),frame={url:'app://metaviewer/index.html',origin:'app://metaviewer'};
  const contents={id:1,mainFrame:frame,getURL:()=>frame.url,send:(channel,value)=>{if(channel==='metaviewer:capture.state')for(const cb of listeners)cb(value);}};
  const event={sender:contents,senderFrame:frame};
  const bridge=installCaptureBridge({ipcMain:{handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)},contents,core:bindings.core});
  t.after(()=>bridge.dispose());
  const facade=createPreloadFacade({
    transport:{
      invoke:(channel,args)=>handlers.get(channel)(event,...args),
      subscribe:(_channel,cb)=>{listeners.add(cb);return()=>listeners.delete(cb);},
    },
    bridge:{exposeInMainWorld(){}},
  }).capture;
  const state=createCaptureState(createCapturePort(facade));
  t.after(()=>state.dispose());

  // Negative control 1: no recordings -> empty list.
  assert.deepEqual(await state.refresh(),{ok:true,rows:[]});
  assert.deepEqual(captureRowsFor(state,'surface-demo'),[]);

  // Seal two recordings on surface-demo and one on surface-other.
  for(const surfaceId of ['surface-demo','surface-demo','surface-other']) {
    const started=await state.toggleRecord(surfaceId);
    assert.equal(started.ok,true);
    const stopped=await state.toggleRecord(surfaceId);
    assert.equal(stopped.ok,true);
    assert.equal(stopped.recording.sealed,true);
  }

  // L2-2 auto-refresh: sealed events and stop success already relisted, so the renderer rows equal the host rows for surface-demo with no explicit refresh() (other surface excluded).
  const autoRows=captureRowsFor(state,'surface-demo');
  assert.equal(autoRows.length,2);
  assert.ok(autoRows.every(r=>r.capsuleId==='surface-demo' && r.phase==='sealed' && r.frames===2 && r.elapsedSeconds===4));
  const listed=await state.refresh();
  assert.equal(listed.ok,true);
  assert.equal(listed.rows.length,3);
  const demoRows=captureRowsFor(state,'surface-demo');
  assert.equal(demoRows.length,2);
  assert.ok(demoRows.every(r=>r.capsuleId==='surface-demo' && r.phase==='sealed' && r.frames===2 && r.elapsedSeconds===4));
  // Negative control 2: surface-other recording is not listed for surface-demo, and recordings-only run yields zero shots (no bleed).
  assert.equal(captureRowsFor(state,'surface-other').length,1);
  assert.deepEqual(captureShotsFor(state,'surface-demo'),[]);
  assert.deepEqual(captureShotsFor(state,'surface-other'),[]);

  // R4: Seal 2 screenshots on surface-demo via the mocked core and verify list returns all 4 on surface-demo with kinds intact.
  for(let i=0;i<2;i+=1) {
    const shotRes=await state.screenshot('surface-demo');
    assert.equal(shotRes.ok,true);
    assert.equal(shotRes.shot.surface_id,'surface-demo');
  }
  const withShots=await state.refresh();
  assert.equal(withShots.ok,true);
  const demoAll=withShots.rows.filter(r=>r.surface_id==='surface-demo');
  assert.equal(demoAll.length,4);
  assert.equal(demoAll.filter(r=>r.kind==='recording').length,2);
  assert.equal(demoAll.filter(r=>r.kind==='shot').length,2);

  // captureRowsFor shows only recordings (2) and captureShotsFor shows only shots (2).
  const recOnly=captureRowsFor(state,'surface-demo');
  const shotOnly=captureShotsFor(state,'surface-demo');
  assert.equal(recOnly.length,2);
  assert.ok(recOnly.every(r=>r.capsuleId==='surface-demo' && r.phase==='sealed' && !('kind' in r)));
  assert.equal(shotOnly.length,2);
  assert.ok(shotOnly.every(r=>r.capsuleId==='surface-demo' && r.kind==='shot' && r.phase==='sealed'));
  assert.deepEqual(captureShotsFor(state,'surface-other'),[]);

  // Negative control 3: a mutant in core list that filters non-recording rows drops the shots and fails the 4-row / 2-shot checks.
  filterRecordingsOnly=true;
  const filteredList=await state.refresh();
  assert.equal(filteredList.ok,true);
  assert.equal(filteredList.rows.filter(r=>r.surface_id==='surface-demo').length,2);
  assert.equal(captureShotsFor(state,'surface-demo').length,0);
  filterRecordingsOnly=false;
});
