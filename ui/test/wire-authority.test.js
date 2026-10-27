import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,stat,readFile,readdir,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {installAuthorityWire,WIRE_CHANNELS,createSettingsStore,deliverAuthorityFrame,createSideTerminalAdapter,nestedIdentity} from '../electron/authorityWire.js';
import {createPreloadFacade,installPreload} from '../electron/preload.js';

const surface={schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'human',profile_id:'test'};
const notice={surface,frame_ref:{schema:'frame_ref/v0.2',surface_id:'s1',generation:1,tick:1,ts_ns:1,width:1,height:1,format:'rgb24',sha256:'a'.repeat(64),capture_us:1}};
const verdict={schema:'action_verdict/v0.2',proposal_id:'p',decision:'admitted',core_seq:1};
const settings=JSON.stringify({scheme:'mv-light',density:'compact'});
const spec={command:'luna',args:['--safe'],cols:80,rows:24};
const calls={loadSettings:[],saveSettings:[settings],recordingDestination:[],nestedDepth:[],selfCapsuleId:[],
  propose:['{"proposal_id":"p"}'],intent:['{"op":"take_control"}'],subscribeFrames:[],unsubscribeFrames:[],
  terminalEnabled:[true],terminalOpen:[spec]};
async function fixture(t,env={}) {
  const root=await mkdtemp(join(tmpdir(),'wire-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const handlers=new Map(),forwarded=[];
  const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
  const contents={id:9,mainFrame:frame,isDestroyed:()=>false,postMessage(...args){forwarded.push(args);}};
  const event={sender:contents,senderFrame:frame};
  let intentReply=true,coreReply=verdict,terminalReply={session:'s1'};
  const coreCalls=[],terminalCalls=[];
  const ipcMain={handle:(channel,fn)=>handlers.set(channel,fn),removeHandler:channel=>handlers.delete(channel)};
  const binding=installAuthorityWire({ipcMain,contents,env:{XDG_CONFIG_HOME:root,MV_SELF_CAPSULE_ID:'capsule-1',...env},argv:['--nested-depth=1'],
    core:{request:async value=>{coreCalls.push(value);return value.op==='intent'?intentReply:coreReply;}},
    profiles:new Map([['luna',{args:['--safe']}]]),terminal:{setEnabled:async()=>true,open:async value=>{terminalCalls.push(value);return terminalReply;}}});
  t.after(async()=>{await binding.dispose();await rm(root,{recursive:true,force:true});});
  const call=(name,...args)=>handlers.get(WIRE_CHANNELS[name])(event,...args);
  return {root,handlers,event,call,contents,forwarded,coreCalls,terminalCalls,
    intentReply:value=>{intentReply=value;},coreReply:value=>{coreReply=value;},terminalReply:value=>{terminalReply=value;}};
}
for(const [name,args] of Object.entries(calls)) {
  test(`${name}: admitted and refuses foreign sender, subframe, surplus and oversized input`,async t=>{
    const f=await fixture(t);
    await f.call('terminalEnabled',true);
    const handler=f.handlers.get(WIRE_CHANNELS[name]);
    await assert.rejects(handler({sender:{...f.contents},senderFrame:f.event.senderFrame},...args),/SENDER/);
    await assert.rejects(handler({...f.event,senderFrame:{...f.event.senderFrame}},...args),/SENDER/);
    await assert.rejects(handler(f.event,...args,'extra'),/ARGS/);
    await assert.rejects(handler(f.event,'é'.repeat(262145)),/ARGS|PAYLOAD/);
    const result=await f.call(name,...args);
    if(['saveSettings','intent','subscribeFrames','unsubscribeFrames','terminalEnabled'].includes(name)) assert.equal(result,true);
    if(name==='nestedDepth') assert.equal(result,1);
    if(name==='selfCapsuleId') assert.equal(result,'capsule-1');
    if(name==='propose') assert.deepEqual(result,verdict);
    if(name==='terminalOpen') assert.deepEqual(result,{session:'s1'});
  });
}
const facadeCalls={...calls};delete facadeCalls.subscribeFrames;delete facadeCalls.unsubscribeFrames;
function facade(reply,subscribe=()=>()=>{}) {
  return createPreloadFacade({transport:{invoke:async()=>reply,subscribe},bridge:{exposeInMainWorld(){}}});
}
function invoke(api,name,args) {
  if(name==='propose'||name==='intent') return api.authority[name](...args);
  if(name==='terminalOpen') return api.sideTerminal.open(...args);
  if(name==='terminalEnabled') return api.sideTerminal.setEnabled(...args);
  return api[name](...args);
}
const goodReplies={loadSettings:settings,saveSettings:true,recordingDestination:'/tmp/recordings',nestedDepth:1,selfCapsuleId:'capsule-1',propose:verdict,intent:true,terminalEnabled:true,terminalOpen:{session:'s1'}};
for(const [name,args] of Object.entries(facadeCalls)) {
  test(`${name}: preload accepts typed reply and refuses malformed reply/arity/oversize`,async()=>{
    assert.deepEqual(await invoke(facade(goodReplies[name]),name,args),goodReplies[name]);
    await assert.rejects(invoke(facade({unexpected:true}),name,args),/OUTCOME/);
    await assert.rejects(invoke(facade(true),name,[...args,'extra']),/ARGS/);
    await assert.rejects(invoke(facade(true),name,['é'.repeat(262145)]),/ARGS|PAYLOAD/);
  });
}
test('settings replacement is atomic, private, bounded, and leaves no temporary files',async t=>{
  const f=await fixture(t),path=join(f.root,'metaviewer','settings.json');
  assert.equal(await f.call('loadSettings'),null);
  await f.call('saveSettings',settings);
  const first=await stat(path);
  assert.equal(first.mode&0o777,0o600);
  await f.call('saveSettings','{"scheme":"mv-dark","density":"compact"}');
  assert.notEqual((await stat(path)).ino,first.ino);
  assert.equal(await readFile(path,'utf8'),'{"scheme":"mv-dark","density":"compact"}');
  assert.deepEqual(await readdir(join(f.root,'metaviewer')),['settings.json']);
  await assert.rejects(f.call('saveSettings','{broken'));
  await assert.rejects(f.call('saveSettings','{"scheme":"next","density":"compact"}'),/SETTINGS_SCHEME/);
  assert.equal(await f.call('loadSettings'),'{"scheme":"mv-dark","density":"compact"}');
  await chmod(path,0o644);await assert.rejects(f.call('loadSettings'),/SETTINGS_FILE/);
  await rm(path);await symlink('/etc/passwd',path);await assert.rejects(f.call('loadSettings'));
});
test('recording destination is validated at install and exposes only a frozen opaque token',async t=>{
  const f=await fixture(t);assert.equal(await f.call('recordingDestination'),null);
  await f.call('saveSettings',settings);
  assert.equal(await f.call('recordingDestination'),null);
  const destination=join(f.root,'secret-host-dir');await mkdir(destination);
  const absolute=await fixture(t,{MV_RECORDING_DESTINATION:destination});
  const token=await absolute.call('recordingDestination');
  assert.equal(token,'recording:configured');
  assert.ok(!token.includes('/'));assert.notEqual(token,destination);
  const empty=await fixture(t,{MV_RECORDING_DESTINATION:''});
  assert.equal(await empty.call('recordingDestination'),null);
  await assert.rejects(fixture(t,{MV_RECORDING_DESTINATION:'relative'}),/SETTINGS_DESTINATION/);
  const source=fileURLToPath(new URL('../',import.meta.url));
  await assert.rejects(fixture(t,{MV_RECORDING_DESTINATION:source}),/SETTINGS_IN_REPO/);
  const alias=join(f.root,'source-alias');await symlink(source,alias);
  await assert.rejects(fixture(t,{MV_RECORDING_DESTINATION:alias}),/SETTINGS_IN_REPO/);
});
test('dangling settings ancestors reject load and save with SETTINGS_DIRECTORY',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wire-dangling-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const alias=join(root,'config');
  await symlink(fileURLToPath(new URL('../missing-config-target',import.meta.url)),alias);
  const store=createSettingsStore({XDG_CONFIG_HOME:alias});
  await assert.rejects(store.load(),/^Error: SETTINGS_DIRECTORY$/);
  await assert.rejects(store.save(settings),/^Error: SETTINGS_DIRECTORY$/);
});
test('missing and live outside-source symlink settings ancestors still round-trip',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wire-ancestors-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const base=join(root,'missing','config');
  const missing=createSettingsStore({XDG_CONFIG_HOME:base});
  assert.equal(await missing.load(),null);
  assert.equal(await missing.save(settings),true);
  assert.equal(await missing.load(),settings);
  const alias=join(root,'live');await symlink(base,alias);
  const live=createSettingsStore({XDG_CONFIG_HOME:alias});
  assert.equal(await live.load(),settings);
  const dark=JSON.stringify({scheme:'mv-dark',density:'compact'});
  assert.equal(await live.save(dark),true);
  assert.equal(await live.load(),dark);assert.equal(await missing.load(),dark);
});
test('terminal refuses arbitrary commands, argv changes, disabled state, malformed broker replies',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.call('terminalOpen',spec),/DISABLED/);
  await f.call('terminalEnabled',true);
  for(const bad of [{...spec,command:'/bin/sh'},{...spec,args:['; rm -rf /']},{...spec,cols:0}]) await assert.rejects(f.call('terminalOpen',bad));
  assert.deepEqual(f.terminalCalls,[]);
  await f.call('terminalOpen',spec);
  assert.deepEqual(f.terminalCalls,[{command:'provider',provider:'luna',cols:80,rows:24}]);
  f.terminalReply({session:'s1',path:'/oops'});await assert.rejects(f.call('terminalOpen',spec),/OUTCOME/);
  f.coreReply({decision:'admitted'});await assert.rejects(f.call('propose','{}'),/OUTCOME/);
  await assert.rejects(f.call('intent','{"op":"execute_shell"}'),/INTENT/);
});
test('PTY adapter uses existing owner-envelope facade and checks broker refusal',async()=>{
  const requests=[];
  const adapter=createSideTerminalAdapter({subscribe:()=>()=>{},request:async(op,value)=>{
    requests.push([op,value]);return op==='capabilities'?{ok:true,owner:'renderer-9'}:{ok:true,session:'s1'};
  }});
  assert.equal(await adapter.setEnabled(true),true);
  assert.deepEqual(await adapter.open({command:'provider',provider:'luna'}),{session:'s1'});
  assert.deepEqual(requests[1],['open',{owner:'renderer-9',value:{command:'provider',provider:'luna'}}]);
  adapter.dispose();await assert.rejects(adapter.open({}),/UNAVAILABLE/);
});
test('frame subscription validates metadata, forwards no paths, revokes listener and rejects bad ack',async()=>{
  let listener,stops=0;const operations=[];
  const api=createPreloadFacade({transport:{invoke:async channel=>{operations.push(channel);return true;},subscribe:(_channel,cb)=>{listener=cb;return()=>stops++;}},bridge:{exposeInMainWorld(){}}});
  const delivered=[];const stop=api.authority.subscribeFrames(value=>delivered.push(value));
  listener({frame_ref:{ramws_path:'/dev/shm/secret'},surface:{}});assert.equal(delivered.length,0);
  listener(notice);assert.equal(delivered.length,1);
  stop();stop();listener(notice);assert.equal(delivered.length,1);assert.equal(stops,1);
  assert.throws(()=>api.authority.subscribeFrames(()=>{},'extra'),/ARGS/);
  let revoked=false;facade(false,()=>()=>{revoked=true;}).authority.subscribeFrames(()=>{});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(revoked,true);
});
test('native preload exposes new domain methods as enumerable own properties',()=>{
  let exposed;
  const api=installPreload({contextBridge:{exposeInMainWorld:(_name,value)=>{exposed=value;}},ipcRenderer:{invoke:async()=>true,on(){},removeListener(){}}});
  assert.equal(api,exposed);
  for(const name of ['authority','sideTerminal','loadSettings','saveSettings','recordingDestination','nestedDepth','selfCapsuleId']) assert.ok(Object.keys(exposed).includes(name));
  assert.ok(Object.isFrozen(exposed.authority));assert.ok(Object.isFrozen(exposed.sideTerminal));
});
test('verified frames use frameReader and framePort; digest tampering and replay never deliver',async()=>{
  const bytes=new Uint8Array([1,2,3]),messages=[],metadata=[],streams=new Set();
  const binding={principal:'ui',epoch:1,surfaceId:'s1',surfaceGeneration:1};
  const wirePort=new EventEmitter();wirePort.postMessage=value=>messages.push(value);wirePort.start=()=>{};wirePort.close=()=>{};
  const frameRef={schema:'frame_ref/v0.2',surface_id:'s1',generation:1,tick:1,ts_ns:1,width:1,height:1,format:'rgb24',ramws_path:'/dev/shm/private.rgb',sha256:createHash('sha256').update(bytes).digest('hex'),capture_us:1};
  const entry={frameRef,state:{...surface,secret_path:'/private'},readerOptions:{binding,limits:{maxFrameBytes:4096,maxWidth:64,maxHeight:64,readTimeoutMs:1000,maxConcurrentReads:1},pixelEnvironment:{environmentId:'test',zoom:1,dpr:1},onReleaseLease(){},acquirePublishedLease:async()=>({identity:{...binding,frameGeneration:entry.frameRef.generation,leaseId:`lease-${entry.frameRef.generation}`},published:true,byteLength:3,readOwnedBytes:async()=>bytes,release:async()=>{}})},portOptions:{port:wirePort,role:'sender',binding,limits:{maxFrameBytes:4096,ackTimeoutMs:1000,maxSurfacesPerPort:1},onReleaseLease(){},onRevoke(){}}};
  const contents={postMessage:(...args)=>metadata.push(args)};
  try {
    assert.equal(await deliverAuthorityFrame(entry,contents,streams),true);
    assert.equal(messages.length,1);assert.equal(metadata.length,1);
    assert.ok(!JSON.stringify(metadata).includes('/dev/shm'));assert.ok(!JSON.stringify(metadata).includes('/private'));
    assert.equal(await deliverAuthorityFrame(entry,contents,streams),false);
    entry.frameRef={...frameRef,generation:2,sha256:'a'.repeat(64)};
    assert.equal(await deliverAuthorityFrame(entry,contents,streams),false);assert.equal(messages.length,1);
  } finally {for(const stream of [...streams]) {await stream.reader.closeReader();stream.port.revokeFramePort('SHUTDOWN');}}
});

test('nested identity distinguishes absent fields and refuses malformed depth or capsule identity',()=>{
  assert.deepEqual(nestedIdentity([],{}),{depth:null,self:null});
  assert.deepEqual(nestedIdentity(['--nested-depth=0'],{}),{depth:0,self:null});
  for(const args of [['--nested-depth=2'],['--nested-depth=1','--nested-depth=1']]) assert.throws(()=>nestedIdentity(args,{}));
  assert.throws(()=>nestedIdentity([],{MV_SELF_CAPSULE_ID:'/host/path'}));
});
test('settings never write inside the source tree',()=>{
  assert.throws(()=>createSettingsStore({XDG_CONFIG_HOME:fileURLToPath(new URL('../',import.meta.url))}),/IN_REPO/);
});
test('multiple frame listeners share one host subscription until the last revocation',async()=>{
  let listener,stops=0;const calls=[],received=[];
  const api=createPreloadFacade({transport:{invoke:async channel=>{calls.push(channel);return true;},subscribe:(_channel,cb)=>{listener=cb;return()=>stops++;}},bridge:{exposeInMainWorld(){}}});
  const first=api.authority.subscribeFrames(()=>received.push('a'));
  const second=api.authority.subscribeFrames(()=>received.push('b'));
  first();listener(notice);assert.deepEqual(received,['b']);assert.equal(stops,0);
  second();await new Promise(resolve=>setImmediate(resolve));assert.equal(stops,1);
  assert.deepEqual(calls,['metaviewer:authority.subscribe','metaviewer:authority.unsubscribe']);
});

for(const op of ['fold','unfold']) {
  const intent={schema:'ui_intent/v0.2',request_id:'r1',op,params:{slot_id:'slot-1'}};
  test(`${op}: closed intent forwards unchanged and requires literal true acknowledgement`,async t=>{
    const f=await fixture(t),json=JSON.stringify(intent);
    assert.equal(await f.call('intent',json),true);
    assert.deepEqual(f.coreCalls,[{op:'intent',json}]);
    for(const reply of [false,null,1,'true',{},undefined]) {
      f.intentReply(reply);await assert.rejects(f.call('intent',json),/OUTCOME/);
    }
    for(const slot_id of ['a','A0._:-','a'.repeat(128)]) {
      f.intentReply(true);
      assert.equal(await f.call('intent',JSON.stringify({...intent,params:{slot_id}})),true);
    }
  });
  test(`${op}: malformed closed intent never reaches core`,async t=>{
    const f=await fixture(t);
    const bad=[{...intent,extra:true},{...intent,schema:'ui_intent/v0.1'},
      ...Object.keys(intent).map(key=>{const v={...intent};delete v[key];return v;}),
      ...[null,[],{}, {slot_id:'s',extra:true}, {surface_id:'s'},
        ...['', 'a'.repeat(129),'-slot','has space','é','a\n',1,null].map(slot_id=>({slot_id}))].map(params=>({...intent,params})),
      ...['','bad id',1,null].map(request_id=>({...intent,request_id}))];
    for(const value of bad) await assert.rejects(f.call('intent',JSON.stringify(value)),/INTENT/);
    await assert.rejects(f.call('intent',JSON.stringify(intent),'extra'),/ARGS/);
    assert.deepEqual(f.coreCalls,[]);
  });
}
test('intent allow-list still refuses other schema operations',async t=>{
  const f=await fixture(t);
  for(const op of ['hide','show','pin','move','tab','float','layout_save','layout_load','execute_shell'])
    await assert.rejects(f.call('intent',JSON.stringify({schema:'ui_intent/v0.2',request_id:'r',op,params:{slot_id:'s'}})),/INTENT/);
  assert.deepEqual(f.coreCalls,[]);
});

test('control intents retain their existing forwarding behavior',async t=>{
  const f=await fixture(t);
  for(const op of ['take_control','release_control']) {
    const json=JSON.stringify({op});assert.equal(await f.call('intent',json),true);
    assert.deepEqual(f.coreCalls.at(-1),{op:'intent',json});
  }
});
