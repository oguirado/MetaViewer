import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMainBindings } from '../electron/hostBindings.js';

const req={schema:'capture_request/v1',request_id:'renderer request',surface_id:'surface'};
const hash='a'.repeat(64);
const replies={recordStart:{ok:true,recording_id:'record'},screenshot:{ok:true,shot:{id:'shot',surface_id:'surface',width:1,height:1,sha256:hash,created_ms:0}},recordStop:{ok:true,recording:{id:'record',surface_id:'surface',frames:1,duration_ms:2,sealed:true,sha256:hash}},list:{ok:true,rows:[]}};
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'mv-cap-'));
  const reg=component=>({endpoint:{component,instance:component},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.2.0',component_commit:'a'.repeat(40),dependencies:[]}});
  const config={session_id:'capture',core:reg('core'),peers:[reg('ui')]};
  await mkdir(join(root,'metaviewer'),{mode:0o700});
  await writeFile(join(root,'config.json'),JSON.stringify(config),{mode:0o600});
  let peer,seq=0,refusal=null,malformed=false;const requests=[],sockets=new Set();
  const send=body=>peer.write(JSON.stringify({schema:'envelope/v0.2',msg_id:`r-${++seq}`,ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq,nonce:`n-${seq}`,body})+'\n');
  const metadata=(code,value)=>send({schema:'surface_event/v0.2',event:'error',data:{surface_id:'capture',code,detail:JSON.stringify(value)}});
  const server=createServer(socket=>{peer=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',data=>{
    buffer+=data;let offset;while((offset=buffer.indexOf('\n'))>=0) {
      const env=JSON.parse(buffer.slice(0,offset));buffer=buffer.slice(offset+1);requests.push(env);
      if(env.body.schema==='hello/v0.2') {send(config.core.hello);continue;}
      const method=env.body.schema==='surface_request/v0.2'?'list':{ram_start:'recordStart',ram_stop:'recordStop',screenshot:'screenshot'}[env.body.op];
      let reply=refusal?{ok:false,code:refusal,request_id:env.body.request_id}:replies[method];
      if(malformed)reply={...reply,path:'/secret'};
      metadata('CAPTURE_REPLY',{request_id:env.msg_id,method,reply});
    }
  });});
  server.listen(join(root,'metaviewer/core.sock'));await once(server,'listening');await chmod(join(root,'metaviewer/core.sock'),0o600);
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const bindings=await createMainBindings({env:{MV_CORE_CONFIG:join(root,'config.json'),XDG_RUNTIME_DIR:root},createMessageChannel:()=>{throw Error('no frames');}});
  t.after(()=>bindings.core.dispose());
  return {core:bindings.core,requests,metadata,refuse:code=>{refusal=code;},malform:()=>{malformed=true;}};
}
test('production capture transport routes every operation and closed state subscription',async t=>{
  const f=await fixture(t);const seen=[];const revoke=f.core.subscribeCapture(value=>seen.push(value));
  for(const [method,request] of [['recordStart',{...req,mode:'ai'}],['screenshot',req],['recordStop',{schema:req.schema,request_id:req.request_id,recording_id:'record'}],['list',undefined]]) {
    const reply=await f.core.request({op:'capture',method,request});assert.deepEqual(reply,replies[method]);
    assert.ok(!JSON.stringify(reply).includes('path'));
  }
  assert.deepEqual(f.requests.slice(1).map(e=>e.body.op),['ram_start','screenshot','ram_stop','list']);
  const state={type:'capture.state',recording_id:'record',surface_id:'surface',phase:'recording',frames:1,elapsed_ms:2};
  f.metadata('CAPTURE_STATE',state);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(seen,[state]);
  revoke();f.metadata('CAPTURE_STATE',state);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(seen,[state]);
  await assert.rejects(f.core.request({op:'capture',method:'screenshot',request:{...req,path:'/secret'}}));
});
test('production capture refusals retain original renderer correlation',async t=>{
  const f=await fixture(t);
  for(const code of ['SURFACE_UNKNOWN','ALREADY_RECORDING','NOT_RECORDING','CAPTURE_UNAVAILABLE','LIMIT']) {
    f.refuse(code);assert.deepEqual(await f.core.request({op:'capture',method:'screenshot',request:req}),{ok:false,code,request_id:req.request_id});
  }
  f.refuse('NOT_RECORDING');
  assert.deepEqual(await f.core.request({op:'capture',method:'recordStop',request:{schema:req.schema,request_id:req.request_id,recording_id:'absent'}}),{ok:false,code:'NOT_RECORDING',request_id:req.request_id});
});
test('production capture rejects capability-bearing replies and malformed state',async t=>{
  const f=await fixture(t);f.malform();
  await assert.rejects(f.core.request({op:'capture',method:'screenshot',request:req}),/CORE_SEAMS_ABSENT/);
  const g=await fixture(t);let seen=false;g.core.subscribeCapture(()=>{seen=true;});
  g.metadata('CAPTURE_STATE',{type:'capture.state',path:'/secret'});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(g.core.getStatus().availability,'unavailable');assert.equal(seen,false);
});
