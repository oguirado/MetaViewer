import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once,EventEmitter} from 'node:events';
import {createGraphicalSessionHost} from '../electron/graphicalSessionHost.js';
import {graphicalNoticeValid,graphicalNoticeEnvelopeValid} from '../electron/graphicalSessionNoticeValues.js';
import {createMainBindings,envelopeTagForBody} from '../electron/hostBindings.js';

const owner='actor-notice',surface='surface-notice',runtime='runtime-'+'a'.repeat(64);
const ready=()=>({schema:'graphical_session/v0.2',surface_id:surface,runtime_id:runtime,owner_id:owner,generation:1,authority_epoch:1,authority:'core',phase:'ready',ownership:'held',pending_request_id:null,points:[],backend:'qemu',isa:'aarch64'});
const notice=(session={...ready(),phase:'outcome_unknown'},notice_id='notice-epoch-one')=>({schema:'graphical_session_notice/v0.2',notice_id,reason_code:'EXECUTOR_EPOCH_CHANGED',session});
function fixture(){const sent=[],host=createGraphicalSessionHost({send:b=>sent.push(b),available:()=>true,ownerId:owner});let seq=0;const event=(p,event,session,extra={})=>host.receive({schema:'graphical_session_event/v0.2',event_id:'event-notice-'+(++seq),request_id:p.request_id,owner_id:owner,surface_id:surface,generation:1,authority_epoch:1,op:p.op,event,reason_code:null,point_id:null,session,elapsed_ms:event==='completed'?1:null,frame_sha256:null,frame_generation:null,...extra});return {host,sent,event};}
async function attach(f,s=ready()){const promise=f.host.request({op:'attach',surface_id:surface}),p=f.sent.at(-1);f.event(p,'accepted',null);f.event(p,'completed',s);await promise;}

test('closed notice schema accepts only unknown held no-pending state and Core-to-UI envelope',()=>{
 const body=notice();assert.equal(graphicalNoticeValid(body),true);
 for(const patch of [{extra:true},{reason_code:'OUTCOME_UNKNOWN'},{session:{...body.session,phase:'ready'}},{session:{...body.session,ownership:'released'}},{session:{...body.session,pending_request_id:'request-old'}}])assert.equal(graphicalNoticeValid({...body,...patch}),false);
 const env={schema:'graphical_session_notice_envelope/v0.2',msg_id:'notice-envelope',ts_ns:0,from:{component:'core',instance:'core-one'},to:{component:'ui',instance:'ui-one'},session_id:'session-one',seq:1,nonce:'notice-nonce',body};assert.equal(graphicalNoticeEnvelopeValid(env),true);
 for(const patch of [{schema:'graphical_session_envelope/v0.2'},{from:{component:'daemon',instance:'daemon-one'}},{to:{component:'agent',instance:'agent-one'}}])assert.equal(graphicalNoticeEnvelopeValid({...env,...patch}),false);
 assert.equal(envelopeTagForBody(body),'graphical_session_notice_envelope/v0.2');assert.equal(envelopeTagForBody({schema:'graphical_session_event/v0.2'}),'graphical_session_envelope/v0.2');
});
test('notice only quarantines an exact existing owner and duplicate notification is idempotent',async()=>{
 const f=fixture();await attach(f);const before=f.host.status(),n=notice();assert.equal(f.host.notice(n),true);const after=f.host.status();assert.equal(after.uncertain,true);assert.equal(after.session.phase,'outcome_unknown');assert.equal(after.session.ownership,'held');assert.equal(after.session.runtime_id,before.session.runtime_id);assert.deepEqual(after.session.points,before.session.points);assert.equal(f.host.commandAllowed(),false);assert.equal(f.sent.length,1);
 assert.equal(f.host.notice(n),false);assert.equal(f.host.status().revision,after.revision);
});
test('no-held foreign stale and replaced-runtime notices never establish or mutate ownership',async()=>{
 const empty=fixture();assert.equal(empty.host.notice(notice()),false);assert.equal(empty.host.status().session,null);assert.equal(empty.host.status().uncertain,false);
 const f=fixture();await attach(f);const before=f.host.status();
 for(const patch of [{surface_id:'foreign'},{runtime_id:'runtime-'+'b'.repeat(64)},{owner_id:'actor-foreign'},{generation:2},{authority_epoch:2},{points:[{point_id:'point-foreign',label:'Foreign',generation:1,manifest_sha256:'b'.repeat(64),created_mono_ns:1}]}]){assert.equal(f.host.notice(notice({...notice().session,...patch})),false);assert.deepEqual(f.host.status().session,before.session);assert.equal(f.host.status().uncertain,false);}
 assert.equal(f.host.surfaceClosed(surface),true);assert.equal(f.host.notice(notice()),false);await attach(f,{...ready(),runtime_id:'runtime-'+'c'.repeat(64)});assert.equal(f.host.notice(notice()),false);assert.equal(f.host.status().session.runtime_id,'runtime-'+'c'.repeat(64));assert.equal(f.host.status().uncertain,false);
});
test('notice accessors never execute and malformed state never becomes Ready',async()=>{
 const f=fixture();await attach(f);let reads=0;const bad={...notice()};Object.defineProperty(bad,'session',{enumerable:true,get(){reads++;return notice().session;}});assert.throws(()=>f.host.notice(bad),/GRAPHICAL_NOTICE_PROTOCOL/);assert.equal(reads,0);assert.equal(f.host.status().uncertain,false);
 assert.throws(()=>f.host.notice(notice({...ready(),phase:'ready'})),/GRAPHICAL_NOTICE_PROTOCOL/);assert.equal(f.host.status().session.phase,'ready');
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function waitFor(check){const end=Date.now()+1500;while(!check()){assert.ok(Date.now()<end,'bounded notice delivery');await new Promise(resolve=>setTimeout(resolve,5));}}
async function wireFixture(t){
 const arch=Object.getOwnPropertyDescriptor(process,'arch');Object.defineProperty(process,'arch',{...arch,value:'arm64'});t.after(()=>Object.defineProperty(process,'arch',arch));
 const root=await mkdtemp(join(tmpdir(),'graphical-notice-wire-')),sockets=new Set();let peer,seq=0;
 const reg=component=>({endpoint:{component,instance:component+'-notice'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});
 const config={session_id:'notice-wire',core:reg('core'),peers:[reg('ui'),reg('agent')]};const owner_id='actor-'+createHash('sha256').update('agent:'+config.peers[1].endpoint.instance).digest('hex');const current={...ready(),owner_id};
 const send=(body,patch={})=>peer.write(JSON.stringify({schema:envelopeTagForBody(body),msg_id:'wire-'+(++seq),ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq,nonce:'nonce-'+seq,body,...patch})+'\n');
 const surfaceRow={schema:'surface/v0.2',surface_id:surface,kind:'vm',display:':100',geometry:{w:400,h:300},state:'active',visibility:'unfolded',control:'agent',profile_id:'notice-vm'};
 const server=createServer(socket=>{peer=socket;sockets.add(socket);socket.on('error',()=>{});let text='';socket.on('data',bytes=>{text+=bytes;let end;while((end=text.indexOf('\n'))!==-1){const env=JSON.parse(text.slice(0,end));text=text.slice(end+1);const b=env.body;if(b.schema==='hello/v0.2')send(config.core.hello);else if(b.schema==='graphical_session_request/v0.2'){const event={schema:'graphical_session_event/v0.2',event_id:'event-wire-accepted',request_id:b.request_id,owner_id,surface_id:surface,generation:1,authority_epoch:1,op:'attach',event:'accepted',reason_code:null,point_id:null,session:null,elapsed_ms:null,frame_sha256:null,frame_generation:null};send(event);send({...event,event_id:'event-wire-completed',event:'completed',session:current,elapsed_ms:1});}else if(b.schema==='surface_request/v0.2'&&b.op==='destroy')send({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...surfaceRow,state:'destroyed'}}});}});});
 t.after(async()=>{for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});await mkdir(join(root,'metaviewer'),{mode:0o700});const path=join(root,'config.json');await writeFile(path,JSON.stringify(config),{mode:0o600});const socket=join(root,'metaviewer/core.sock');server.listen(socket);await once(server,'listening');await chmod(socket,0o600);
 const bindings=await createMainBindings({env:{MV_CORE_CONFIG:path,XDG_RUNTIME_DIR:root,MV_GRAPHICAL_SESSION_ENABLED:'1'},createMessageChannel:()=>({port1:Object.assign(new EventEmitter(),{postMessage(){},start(){},close(){}}),port2:{close(){}}})});t.after(()=>bindings.core.dispose());send({schema:'surface_event/v0.2',event:'created',data:{surface:surfaceRow}});await settle();await settle();await bindings.core.graphicalSession.request({op:'attach',surface_id:surface});return {bindings,send,current,config};
}
test('authenticated main receive route quarantines a matching notice and ordinary Stop remains available',async t=>{
 const f=await wireFixture(t);f.send(notice({...f.current,phase:'outcome_unknown'}));await waitFor(()=>f.bindings.core.graphicalSession.status().uncertain);assert.equal(f.bindings.core.getStatus().availability,'live');assert.equal(f.bindings.core.graphicalSession.status().session.ownership,'held');await f.bindings.core.stopSurface(surface);assert.equal(f.bindings.core.graphicalSession.status().session,null);
});
test('wrong notice family or foreign sender never reaches the optional feature',async t=>{
 for(const kind of ['family','sender'])await t.test(kind,async t=>{const f=await wireFixture(t),body=notice({...f.current,phase:'outcome_unknown'});f.send(body,kind==='family'?{schema:'graphical_session_envelope/v0.2'}:{from:f.config.peers[1].endpoint});await waitFor(()=>f.bindings.core.getStatus().availability!=='live');assert.equal(f.bindings.core.graphicalSession.status().available,false);});
});

test('notice cannot consume an in-flight operation as success or reopen it on a late completion',async()=>{
 const f=fixture();await attach(f);const promise=f.host.request({op:'mark',surface_id:surface,generation:1,authority_epoch:1,label:'Before'}),p=f.sent.at(-1);f.event(p,'accepted',{...ready(),phase:'pending',pending_request_id:p.request_id});
 assert.equal(f.host.notice(notice()),true);const state=await promise;assert.equal(state.uncertain,true);assert.equal(state.session.ownership,'held');assert.equal(state.session.phase,'outcome_unknown');assert.deepEqual(state.session.points,[]);assert.equal(f.host.commandAllowed(),false);
 assert.equal(f.event(p,'completed',{...ready(),points:[{point_id:'point-late',label:'Before',generation:1,manifest_sha256:'b'.repeat(64),created_mono_ns:1}]},{point_id:'point-late'}),false);assert.equal(f.host.status().session.phase,'outcome_unknown');assert.equal(f.sent.length,2);
});
test('notice schemas are lazy and memoized; inherited fields and symbols are refused',async()=>{
 const original=JSON.parse;let parses=0;JSON.parse=function(value,...args){if(typeof value==='string'&&value.includes('"graphical_session_notice.schema.json"'))parses++;return original.call(this,value,...args);};
 try{const values=await import(new URL('../electron/graphicalSessionNoticeValues.js?notice-lazy-test',import.meta.url));assert.equal(parses,0);assert.equal(values.graphicalNoticeValid(notice()),true);assert.equal(parses,1);assert.equal(values.graphicalNoticeValid(notice()),true);assert.equal(parses,1);}finally{JSON.parse=original;}
 assert.equal(graphicalNoticeValid(Object.create(notice())),false);assert.equal(graphicalNoticeValid({...notice(),session:Object.create(notice().session)}),false);assert.equal(graphicalNoticeValid({...notice(),[Symbol('foreign')]:true}),false);
});
