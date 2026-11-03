// [TARGET, unit decision] Close the roleHost -> private opening file -> real
// hostBindings socket gap. Only the remote peer and Electron registration are
// doubles; existing mounted-App and native adapter suites own either end.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {createServer} from 'node:net';
import {chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {installRoleHost} from '../electron/roleHost.js';
import {createMainBindings} from '../electron/hostBindings.js';

const registration = component => ({endpoint:{component,instance:component+'-seams'},
  hello:{schema:'hello/v0.2',contract_version:'v0.2',component,
    component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});

async function until(predicate) {
  const deadline = Date.now() + 5000; // [TARGET] bounded event wait, never sleep-then-assert.
  for (;;) {
    if (predicate()) return;
    assert.ok(Date.now() < deadline, 'SEAM_EVENT_TIMEOUT');
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mv-seam-'));
  const sockets = new Set(), requests = [];
  const config = {session_id:'seams-session',core:registration('core'),peers:[registration('ui')]};
  await mkdir(join(root,'metaviewer'),{mode:0o700});
  const configPath = join(root,'config.json');
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  let peer, sequence = 0, bindings, roles;
  const send = body => peer.write(JSON.stringify({schema:'envelope/v0.2',msg_id:'reply-'+(++sequence),
    ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,
    seq:sequence,nonce:'nonce-'+sequence,body})+'\n');
  const server = createServer(socket => {
    peer=socket; sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
    let buffer='';
    socket.on('data',data=>{
      buffer+=data;
      for(let newline;(newline=buffer.indexOf('\n'))>=0;) {
        const envelope=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);
        requests.push(envelope);
        if(envelope.body.schema==='hello/v0.2') send(config.core.hello);
      }
    });
  });
  t.after(async()=>{
    await bindings?.core.dispose();
    try { await roles?.dispose(); } catch { /* a killed mutant can retain custody */ }
    for(const socket of sockets) socket.destroy();
    await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true});
  });
  server.listen(join(root,'metaviewer/core.sock'));await once(server,'listening');
  await chmod(join(root,'metaviewer/core.sock'),0o600);
  const env={MV_CORE_CONFIG:configPath,XDG_RUNTIME_DIR:root,MV_SRF_STATE_DIR:root,
    MV_SRF_PROFILES:JSON.stringify({'seams-browser':{Kind:'browser',NativeKind:'browser',
      Width:1280,Height:900,Display:':100',RAMRoot:'/dev/shm/seams-fixture'}})};
  bindings=await createMainBindings({env,createMessageChannel:()=>({
    port1:Object.assign(new EventEmitter(),{postMessage(){},start(){},close(){}}),port2:{close(){}}})});
  let handler;
  const window=new EventEmitter();window.webContents={session:{registerPreloadScript(){},unregisterPreloadScript(){}}};
  const states=new Map();
  roles=installRoleHost({electron:{ipcMain:{handle(_channel,h){handler=h;},removeHandler(){}},
    app:{getPath:()=>root}},window,core:bindings.core,env,capsuleStates:states,admit:()=>true,
    readFreeMemoryBytes:async()=>64*1024**3,
    listIdentities:async()=>({ok:true,rows:[{id:'seams-browser'}]}),
    provisionProgramIdentity:async()=>({ok:true})});
  const binary=join(root,'seams-editor');await writeFile(binary,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const call=(op,body={})=>handler({}, {schema:'metaviewer.roles/v0.3',op,...body});
  return {root,binary,bindings,states,requests,send,call};
}

test('ordered role transport: opening sidecar survives interleaved create and stop acknowledgements',async t=>{
  const f=await fixture(t);
  // [TARGET] fixtures represent the four catalog flows; no capsule is started.
  for(const [label,role,program,hostXpra] of [
    ['Agent browser','agent',false,false],['Human browser','human',false,false],
    ['Host program','human',true,true],['Program','agent',true,false],
  ]) await t.test(label,async()=>{
    const start=f.requests.length;
    let settled=false;
    const opening=f.call(program?'create-program':'open',{choice:program?
      {binary:f.binary,role,...(hostXpra?{hostXpra:true}:{})}:{profileId:'seams-browser',role}})
      .then(reply=>{settled=true;return reply;});
    void opening.catch(()=>{});
    await until(()=>f.requests.slice(start).some(e=>e.body.op==='create') || settled);
    assert.equal(settled,false,'SEAM_CREATE_MUST_WAIT_FOR_WIRE');
    const request=f.requests.slice(start).find(e=>e.body.op==='create').body;
    const profile=request.params.profile_id;
    assert.equal(request.params.kind,program?'desktop_capsule':'browser','SEAM_KIND');
    const path=join(f.root,'opening-modes',profile+'.json');
    const expected={schema:'metaviewer.opening_mode/v0.3',profile_id:profile,mode:role,
      ...(program?{host_binary:f.binary}:{}),...(hostXpra?{host_xpra:true}:{})};
    assert.deepEqual(JSON.parse(await readFile(path,'utf8')),expected,'SEAM_OPENING_PAYLOAD');
    assert.equal((await stat(path)).mode&0o777,0o600,'SEAM_PRIVATE_SIDECAR');
    const surface={schema:'surface/v0.2',surface_id:'surface-'+label.replaceAll(' ','-'),
      profile_id:profile,kind:request.params.kind,display:':100',geometry:{w:1280,h:900},
      state:'active',visibility:'unfolded',control:role};
    const unrelated={...surface,surface_id:'foreign-'+surface.surface_id,profile_id:'other-profile'};
    f.send({schema:'surface_event/v0.2',event:'created',data:{surface:unrelated}});
    await until(()=>f.bindings.core.getHumanSurface(unrelated.surface_id));
    assert.equal(settled,false,'SEAM_FOREIGN_CREATE_MUST_NOT_SETTLE');
    assert.deepEqual(JSON.parse(await readFile(path,'utf8')),expected,'SEAM_KEEP_STAGE_UNTIL_ACK');
    f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
    const opened=await opening;
    assert.equal(opened.ok,true,'SEAM_OPEN_RESULT');assert.equal(opened.surfaceId,surface.surface_id);
    assert.equal(opened.role,role);assert.equal(f.states.get(surface.surface_id).control,role);
    await assert.rejects(readFile(path),{code:'ENOENT'},'SEAM_CLEAR_STAGE_AFTER_ACK');
    // Stop must traverse hostBindings, retain custody through unrelated/active
    // events, then release the profile only after this surface is destroyed.
    settled=false;
    const stopping=f.call('stop',{surfaceId:surface.surface_id}).then(reply=>{settled=true;return reply;});
    void stopping.catch(()=>{});
    await until(()=>f.requests.slice(start).some(e=>e.body.op==='destroy'));
    assert.deepEqual(f.requests.slice(start).find(e=>e.body.op==='destroy').body.params,
      {surface_id:surface.surface_id},'SEAM_STOP_TARGET');
    f.send({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...unrelated,state:'destroyed'}}});
    f.send({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...surface,visibility:'folded'}}});
    await until(()=>f.bindings.core.getHumanSurface(surface.surface_id)?.visibility==='folded');
    assert.equal(settled,false,'SEAM_STOP_MUST_WAIT_FOR_DESTROY');
    assert.equal(f.states.get(surface.surface_id).state,'active','SEAM_RETAIN_CUSTODY');
    f.send({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...surface,state:'destroyed'}}});
    assert.equal((await stopping).ok,true,'SEAM_STOP_RESULT');
    assert.equal(f.states.get(surface.surface_id).state,'destroyed');
    assert.equal([...f.states.keys()].some(key=>key.startsWith('pending:')),false);
  });
});

test('role transport source mutants are killed by the ordered journey',()=>{
  const cases=[
    ['openingMode.js','profile_id:profileId,mode};',"profile_id:profileId,mode:'agent'};"],
    ['openingMode.js','payload.host_xpra = true;','payload.host_xpra = false;'],
    ['hostBindings.js',"body.data?.surface?.surface_id === target && body.data.surface.state === 'destroyed'",
      'body.data?.surface?.surface_id === target'],
  ];
  for(const [file,before,after] of cases) {
    const mutation={path:fileURLToPath(new URL('../electron/'+file,import.meta.url)),before,after};
    const env={...process.env,P18G_MUTATION:JSON.stringify(mutation)};
    delete env.NODE_TEST_CONTEXT;
    const result=spawnSync(process.execPath,['--import',fileURLToPath(new URL('./p18g-mutant-loader.mjs',import.meta.url)),
      '--test','--test-name-pattern=^ordered role transport',fileURLToPath(import.meta.url)],
      {env,encoding:'utf8',timeout:30000,maxBuffer:1024**2});
    assert.ifError(result.error);assert.notEqual(result.status,0,'SEAM_MUTANT_SURVIVED '+file+'\n'+result.stdout+result.stderr);
    assert.match(result.stdout+result.stderr,/SEAM_(OPENING_PAYLOAD|STOP_MUST_WAIT_FOR_DESTROY)/,
      'mutant must die on the behavioral oracle, not setup/import');
  }
});
