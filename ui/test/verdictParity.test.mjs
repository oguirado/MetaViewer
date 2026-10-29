import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir, chmod, writeFile, rm, lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once, EventEmitter} from 'node:events';
import {verdictReply} from '../electron/authorityWire.js';
import {verdictRow} from '../src/core/hostAdapters.js';
import {createMainBindings} from '../electron/hostBindings.js';
import {createPreloadFacade} from '../electron/preload.js';

const fixture = JSON.parse(await readFile(fileURLToPath(new URL('../../tests/fixtures/verdict_parity.json', import.meta.url)), 'utf8'));
const proposal = {schema:'action_proposal/v0.2',proposal_id:'p',surface_id:'s',based_on_frame:{generation:1,sha256:'a'.repeat(64)},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'},budget:{max_ms:1000,max_retries:0}};

// Exercise the production matcher through a private local socket and pinned hello.
async function host(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'vp-'));
  const registration = component => ({endpoint:{component,instance:component+'-test'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});
  const config = {session_id:'parity',core:registration('core'),peers:[registration('ui')]};
  const sockets = new Set();
  let seq = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});socket.on('close',()=>sockets.delete(socket));
    let buffer = '';
    const send = body => socket.write(JSON.stringify({...fixture.envelope_template,msg_id:'reply-'+(++seq),from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq,nonce:'nonce-'+seq,body})+'\n');
    socket.on('data', data => {
      buffer += data;
      let offset;
      while ((offset=buffer.indexOf('\n')) >= 0) {
        const env = JSON.parse(buffer.slice(0,offset));buffer=buffer.slice(offset+1);
        if (env.body.schema === 'hello/v0.2') send(config.core.hello);
        else respond(env.body, send);
      }
    });
  });
  let bindings;
  t.after(async () => {
    bindings?.core.dispose();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true});
  });
  await mkdir(join(root,'metaviewer'),{mode:0o700});
  const socketPath=join(root,'metaviewer/core.sock');
  server.listen(socketPath);await once(server,'listening');await chmod(socketPath,0o600);
  const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const info=await lstat(socketPath);
  bindings=await createMainBindings({env:{MV_CORE_CONFIG:configPath,XDG_RUNTIME_DIR:root},
    createMessageChannel:()=>({port1:Object.assign(new EventEmitter(),{start(){},close(){},postMessage(){}}),port2:{close(){}}}),
    getPeerCredentials:()=>({pid:process.pid,uid:process.getuid(),gid:process.getgid(),ino:info.ino})});
  assert.equal((await bindings.core.start()).availability,'live','host fixture must establish live authority');
  return bindings;
}

function check(t, vector, decoder, actual) {
  const expected=vector.contract_verdict==='accept';
  const finding=vector.findings[decoder];
  if (finding) {
    assert.notEqual(actual,expected,`stale ${finding}: ${vector.id}`);
    t.skip(finding);
  } else assert.equal(actual,expected,`${decoder}/${vector.id}`);
}
const accepts = async fn => {try {await fn();return true;} catch {return false;}};
for (const v of fixture.vectors.filter(v=>v.family==='action_verdict')) {
  for (const [name,decode] of [['js_row',verdictRow],['js_reply',verdictReply]]) {
    test(`${name}/${v.id}`,async t=>check(t,v,name,await accepts(()=>decode(structuredClone(v.payload)))));
  }
  test(`js_matcher/${v.id}`,async t=>{
    const bindings=await host(t, (body,send)=>{if(body.schema==='action_proposal/v0.2') send(v.payload);});
    const actual=await accepts(()=>bindings.core.request({op:'propose',json:JSON.stringify(proposal)}));
    check(t,v,'js_matcher',actual);
  });
}
for (const v of fixture.vectors.filter(v=>v.family==='record_event')) {
  test(`js_record_event/${v.id}`,{skip:'FINDING JS-RECORD-EVENT-DECODER-ABSENT'},()=>{});
}
for (const v of fixture.vectors.filter(v=>v.family==='record_request' && v.payload.op==='ram_start' && v.id.includes('_fps_'))) {
  const request={schema:'capture_request/v1',request_id:'q',surface_id:v.payload.params.surface_id,mode:'ai'};
  if(Object.hasOwn(v.payload.params,'max_fps')) request.max_fps=v.payload.params.max_fps;
  test(`js_preload/${v.id}`,async t=>{
    const api=createPreloadFacade({transport:{invoke:async()=>({ok:true,recording_id:'r'}),subscribe:()=>()=>{}},bridge:{exposeInMainWorld(){}}});
    check(t,v,'js_preload',await accepts(()=>api.capture.recordStart(request)));
  });
  test(`js_capture/${v.id}`,async t=>{
    let wire;
    const bindings=await host(t,(body,send)=>{
      if(body.schema!=='record_request/v0.2') return;
      wire=body;
      send({schema:'surface_event/v0.2',event:'error',data:{surface_id:'capture',code:'CAPTURE_REPLY',detail:JSON.stringify({method:'recordStart',request_id:body.request_id,reply:{ok:true,recording_id:'r'}})}});
    });
    const actual=await accepts(()=>bindings.core.request({op:'capture',method:'recordStart',request}));
    if(actual && Object.hasOwn(request,'max_fps')) assert.equal(wire.params.max_fps,request.max_fps);
    if(actual && !Object.hasOwn(request,'max_fps')) assert.equal(wire.params.max_fps,3,'current default fill witness');
    check(t,v,'js_capture',actual);
  });
}
test('kills JS widened refusal enum mutant',()=>{
  const v=fixture.vectors.find(v=>v.id==='verdict_reason_code_0');
  assert.throws(()=>verdictReply(v.payload));
  // Behavioral mutant: unknown reasons are silently normalized into the closed enum.
  const mutant=value=>verdictReply({...value,reason_code:'POLICY'});
  assert.doesNotThrow(()=>mutant(v.payload));
  assert.equal(v.contract_verdict,'refuse');
});
