import {test} from 'node:test';
import assert from 'node:assert/strict';
import fsPromises,{mkdtemp,mkdir,rm,stat,readFile,readdir,writeFile,chmod,symlink} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {installAuthorityWire,WIRE_CHANNELS,INTENT_OPS,createSettingsStore,deliverAuthorityFrame,createSideTerminalAdapter,nestedIdentity,validateIntentBody} from '../electron/authorityWire.js';
import {createPreloadFacade,installPreload} from '../electron/preload.js';

const surface={schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'human',profile_id:'test'};
const notice={surface,frame_ref:{schema:'frame_ref/v0.2',surface_id:'s1',generation:1,tick:1,ts_ns:1,width:1,height:1,format:'rgb24',sha256:'a'.repeat(64),capture_us:1}};
const verdict={schema:'action_verdict/v0.2',proposal_id:'p',decision:'admitted',core_seq:1};
const settings=JSON.stringify({scheme:'mv-light',density:'compact'});
const spec={command:'luna',args:['--safe'],cols:80,rows:24};
const validProposal=JSON.stringify({
  schema:'action_proposal/v0.2',
  proposal_id:'p',
  surface_id:'s1',
  based_on_frame:{generation:1,sha256:'a'.repeat(64)},
  action:{type:'click',x:10,y:20,button:'left'},
  expectation:{type:'state_sha256_change'},
  budget:{max_ms:1000,max_retries:0},
});
const calls={loadSettings:[],saveSettings:[settings],recordingDestination:[],nestedDepth:[],selfCapsuleId:[],
  propose:[validProposal],intent:[JSON.stringify({schema:'ui_intent/v0.2',request_id:'r1',op:'take_control',params:{surface_id:'s1'}})],subscribeFrames:[],unsubscribeFrames:[],
  terminalEnabled:[true],terminalOpen:[spec]};
async function fixture(t,env={},argv=['--nested-depth=1']) {
  const root=await mkdtemp(join(tmpdir(),'wire-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const handlers=new Map(),forwarded=[];
  const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
  const contents={id:9,mainFrame:frame,isDestroyed:()=>false,postMessage(...args){forwarded.push(args);}};
  const event={sender:contents,senderFrame:frame};
  let intentReply=true,coreReply=verdict,terminalReply={session:'s1'};
  const coreCalls=[],terminalCalls=[];
  const ipcMain={handle:(channel,fn)=>handlers.set(channel,fn),removeHandler:channel=>handlers.delete(channel)};
  const binding=installAuthorityWire({ipcMain,contents,env:{XDG_CONFIG_HOME:root,MV_SELF_CAPSULE_ID:'capsule-1',...env},argv,
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
  f.coreReply({decision:'admitted'});await assert.rejects(f.call('propose',validProposal),/OUTCOME/);
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
  for(const name of ['authority','input','sideTerminal','loadSettings','saveSettings','recordingDestination','nestedDepth','selfCapsuleId']) assert.ok(Object.keys(exposed).includes(name));
  assert.ok(Object.isFrozen(exposed.authority));assert.ok(Object.isFrozen(exposed.input));assert.ok(Object.isFrozen(exposed.sideTerminal));
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
  for(const op of ['pin','move','tab','float','layout_save','layout_load','execute_shell'])
    await assert.rejects(f.call('intent',JSON.stringify({schema:'ui_intent/v0.2',request_id:'r',op,params:{slot_id:'s'}})),/INTENT/);
  assert.deepEqual(f.coreCalls,[]);
});

test('control intents retain their existing forwarding behavior',async t=>{
  const f=await fixture(t);
  for(const op of ['take_control','release_control']) {
    const intent={schema:'ui_intent/v0.2',request_id:op,op,params:{surface_id:'s1'}};
    const json=JSON.stringify(intent);assert.equal(await f.call('intent',json),true);
    assert.deepEqual(f.coreCalls.at(-1),{op:'intent',json});
  }
});

for(const op of ['take_control','release_control']) {
  const intent={schema:'ui_intent/v0.2',request_id:'r1',op,params:{surface_id:'surface-1'}};
  test(`${op}: bare op and malformed closed intent are refused with zero core calls`,async t=>{
    const f=await fixture(t);
    const bad=[{op},{...intent,extra:true},{...intent,schema:'ui_intent/v0.1'},
      ...Object.keys(intent).map(key=>{const v={...intent};delete v[key];return v;}),
      ...[null,[],{},{surface_id:'s',extra:true},{slot_id:'s'},
        ...['','a'.repeat(129),'-surf','has space','é','a\n',1,null].map(surface_id=>({surface_id}))].map(params=>({...intent,params})),
      ...['','bad id',1,null].map(request_id=>({...intent,request_id}))];
    for(const value of bad) await assert.rejects(f.call('intent',JSON.stringify(value)),/INTENT/);
    assert.deepEqual(f.coreCalls,[]);
    const json=JSON.stringify(intent);
    assert.equal(await f.call('intent',json),true);
    assert.deepEqual(f.coreCalls,[{op:'intent',json}]);
  });
}

for (const [op,params] of [
  ['hide',{slot_id:'cuk-ai-slot-s1'}], ['show',{slot_id:'s1'}],
  ['move',{slot_id:'s1',group_id:'group-2',index:0}],
  ['tab',{slot_id:'s1',group_id:'group-2',index:255}],
  ['float',{slot_id:'s1',x_px:0,y_px:16383,width_px:16384,height_px:1}],
]) {
  test(`${op}: exact layout contract forwards and rejects field/bound mutants`,async t=>{
    const f=await fixture(t);
    const intent={schema:'ui_intent/v0.2',request_id:'layout',op,params};
    const json=JSON.stringify(intent);
    assert.equal(await f.call('intent',json),true);
    assert.deepEqual(f.coreCalls,[{op:'intent',json}]);
    const bad=[{...intent,extra:0},{...intent,schema:'wrong'},{...intent,request_id:'a\n'},
      {...intent,params:{...params,extra:0}}, {...intent,params:{...params,slot_id:'a\n'}}];
    for (const key of Object.keys(params)) {
      const missing={...params};delete missing[key];bad.push({...intent,params:missing});
      bad.push({...intent,params:{...params,[key]:null}});
    }
    for(const key of ['index','x_px','y_px','width_px','height_px'].filter(key=>key in params)) {
      for(const n of [-1,0.5,Number.MAX_SAFE_INTEGER,'1']) bad.push({...intent,params:{...params,[key]:n}});
    }
    if ('group_id' in params) bad.push({...intent,params:{...params,group_id:'bad group'}});
    for(const candidate of bad) await assert.rejects(f.call('intent',JSON.stringify(candidate)),/INTENT/);
    assert.equal(f.coreCalls.length,1);
    f.intentReply(false);await assert.rejects(f.call('intent',json),/OUTCOME/);
  });
}

test('EVUI-03 regression: stateOnly destroyed/lost closes all matching surfaceId streams regardless of generation or absent binding and revokes port in finally', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const frameRef = {
    schema: 'frame_ref/v0.2',
    surface_id: 's1',
    generation: 1,
    tick: 1,
    ts_ns: 1,
    width: 1,
    height: 1,
    format: 'rgb24',
    ramws_path: '/dev/shm/private.rgb',
    sha256: sha,
    capture_us: 1,
  };
  const makeEntry = (surfaceId, surfaceGen) => {
    const binding = { principal: 'ui', epoch: 1, surfaceId, surfaceGeneration: surfaceGen };
    const wirePort = new EventEmitter();
    wirePort.postMessage = () => {};
    wirePort.start = () => {};
    wirePort.close = () => {};
    const ref = { ...frameRef, surface_id: surfaceId };
    const st = { ...surface, surface_id: surfaceId };
    let revocations = 0;
    return {
      entry: {
        frameRef: ref,
        state: st,
        readerOptions: {
          binding,
          limits: { maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 1 },
          pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
          onReleaseLease() {},
          acquirePublishedLease: async () => ({
            identity: { ...binding, frameGeneration: 1, leaseId: `lease-${surfaceId}-${surfaceGen}` },
            published: true,
            byteLength: 3,
            readOwnedBytes: async () => bytes,
            release: async () => {},
          }),
        },
        portOptions: {
          port: wirePort,
          role: 'sender',
          binding,
          limits: { maxFrameBytes: 4096, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
          onReleaseLease() {},
          onRevoke() { revocations += 1; },
        },
      },
      getRevocations: () => revocations,
    };
  };

  // 1. Stream opened at surfaceGeneration 1, destroyed stateOnly arrives at surfaceGeneration 2; negative control stream for s2 survives.
  const streams = new Set();
  const s1Gen1 = makeEntry('s1', 1);
  const s2Gen1 = makeEntry('s2', 1);
  try {
    assert.equal(await deliverAuthorityFrame(s1Gen1.entry, { postMessage() {} }, streams), true);
    assert.equal(await deliverAuthorityFrame(s2Gen1.entry, { postMessage() {} }, streams), true);
    assert.equal(streams.size, 2);

    await deliverAuthorityFrame(
      {
        stateOnly: true,
        frameRef,
        state: { ...surface, surface_id: 's1', state: 'destroyed' },
        readerOptions: { binding: { principal: 'ui', epoch: 1, surfaceId: 's1', surfaceGeneration: 2 } },
      },
      { postMessage() {} },
      streams,
    );
    assert.equal(streams.size, 1, 's1 stream must be removed even when surfaceGeneration advanced');
    assert.equal(s1Gen1.getRevocations(), 1, 's1 port must be revoked on generation-advanced destroy');
    assert.equal(s2Gen1.getRevocations(), 0, 'negative control: s2 stream must survive');

    // 2. Stream opened for s1, lost stateOnly arrives without readerOptions/binding.
    const s1NoBinding = makeEntry('s1', 1);
    assert.equal(await deliverAuthorityFrame(s1NoBinding.entry, { postMessage() {} }, streams), true);
    assert.equal(streams.size, 2);

    await deliverAuthorityFrame(
      {
        stateOnly: true,
        frameRef,
        state: { ...surface, surface_id: 's1', state: 'lost' },
      },
      { postMessage() {} },
      streams,
    );
    assert.equal(streams.size, 1, 's1 stream must be removed even when stateOnly has no readerOptions.binding');
    assert.equal(s1NoBinding.getRevocations(), 1);
    assert.equal(s2Gen1.getRevocations(), 0, 'negative control: s2 stream must still survive');

    // 3. If reader.closeReader() throws during stateOnly cleanup, port.revokeFramePort('SHUTDOWN') still runs in finally and stateOnly delivery completes.
    const s1Throw = makeEntry('s1', 1);
    assert.equal(await deliverAuthorityFrame(s1Throw.entry, { postMessage() {} }, streams), true);
    const s1Stream = [...streams].find(item => JSON.parse(item.key)[2] === 's1');
    assert.ok(s1Stream);
    s1Stream.reader = { closeReader: async () => { throw new Error('CLOSE_READER_BOOM'); } };
    assert.equal(
      await deliverAuthorityFrame(
        {
          stateOnly: true,
          frameRef,
          state: { ...surface, surface_id: 's1', state: 'destroyed' },
        },
        { postMessage() {} },
        streams,
      ),
      true,
    );
    assert.equal(s1Throw.getRevocations(), 1, 'port must be revoked in finally even when closeReader throws');
    assert.equal(streams.size, 1);
  } finally {
    for (const stream of [...streams]) {
      await stream.reader.closeReader().catch(() => {});
      stream.port.revokeFramePort('SHUTDOWN');
    }
  }
});

test('EVUI-04 regression: validateIntentBody rejects Symbol-keyed body or params with the caller error instead of TypeError', () => {
  const customErr = () => new Error('CUSTOM_INTENT_ERR');
  const sym = Symbol('s');

  const bodyWithSymbol = {
    [sym]: 1,
    op: 'fold',
    params: { slot_id: 's1' },
    request_id: 'r1',
    schema: 'ui_intent/v0.2',
  };
  assert.throws(() => validateIntentBody(bodyWithSymbol, customErr), /^Error: CUSTOM_INTENT_ERR$/);

  const paramsWithSymbol = {
    op: 'fold',
    params: { [sym]: 1, slot_id: 's1' },
    request_id: 'r1',
    schema: 'ui_intent/v0.2',
  };
  assert.throws(() => validateIntentBody(paramsWithSymbol, customErr), /^Error: CUSTOM_INTENT_ERR$/);

  // Negative control: valid body passes and returns the body.
  const valid = {
    op: 'fold',
    params: { slot_id: 's1' },
    request_id: 'r1',
    schema: 'ui_intent/v0.2',
  };
  assert.equal(validateIntentBody(valid, customErr), valid);
});

test('RV10-01: destroyed published mid-read aborts the read and posts no active surface afterwards', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wire-rv10-01-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bytes = new Uint8Array([1, 2, 3]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const frameRef = {
    schema: 'frame_ref/v0.2',
    surface_id: 's1',
    generation: 1,
    tick: 1,
    ts_ns: 1,
    width: 1,
    height: 1,
    format: 'rgb24',
    ramws_path: '/dev/shm/private.rgb',
    sha256: sha,
    capture_us: 1,
  };
  const binding = { principal: 'ui', epoch: 1, surfaceId: 's1', surfaceGeneration: 1 };
  const handlers = new Map();
  const posted = [];
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = {
    id: 9,
    mainFrame: frame,
    isDestroyed: () => false,
    postMessage: (...args) => posted.push(args),
  };
  const event = { sender: contents, senderFrame: frame };
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
  };

  let emitEntry = null;
  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: { request: async () => true },
    env: { XDG_CONFIG_HOME: root },
    argv: [],
    frames: {
      subscribe: (cb) => {
        emitEntry = cb;
        return () => {};
      },
    },
  });
  t.after(() => wire.dispose());

  await handlers.get(WIRE_CHANNELS.subscribeFrames)(event);

  let surfaceAlive = true;
  let readAbortedBeforeManualSettle = false;
  let notifyReadEntered = null;
  const readEntered = new Promise((resolve) => {
    notifyReadEntered = resolve;
  });
  let settleRead = null;
  let revocations = 0;

  const wirePort = new EventEmitter();
  wirePort.postMessage = () => {};
  wirePort.start = () => {};
  wirePort.close = () => {};

  const slowFramePromise = emitEntry({
    frameRef,
    state: { ...surface, surface_id: 's1', state: 'active' },
    stateUpdated: true,
    resolveLatestState: () => (surfaceAlive ? { ...surface, surface_id: 's1', state: 'active' } : null),
    readerOptions: {
      binding,
      limits: { maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 1 },
      pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
      onReleaseLease() {},
      acquirePublishedLease: async () => ({
        identity: { ...binding, frameGeneration: 1, leaseId: 'lease-rv10-01' },
        published: true,
        byteLength: 3,
        readOwnedBytes: ({ signal }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                readAbortedBeforeManualSettle = true;
                reject(new Error('ABORTED_BY_CLOSE_READER'));
              },
              { once: true },
            );
            settleRead = () => resolve(bytes);
            notifyReadEntered();
          }),
        release: async () => {},
      }),
    },
    portOptions: {
      port: wirePort,
      role: 'sender',
      binding,
      limits: { maxFrameBytes: 4096, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
      onReleaseLease() {},
      onRevoke() {
        revocations += 1;
      },
    },
  });

  await readEntered;
  assert.equal(posted.length, 0);

  // Publish terminal destroyed mid-read; surface is now absent in host state.
  surfaceAlive = false;
  const destroyPromise = emitEntry({
    stateOnly: true,
    frameRef,
    state: { ...surface, surface_id: 's1', state: 'destroyed' },
    readerOptions: { binding },
  });

  // closeReader must abort the in-flight read without waiting for manual settleRead().
  await new Promise((resolve) => setImmediate(resolve));
  const abortedByDestroy = readAbortedBeforeManualSettle;
  if (!abortedByDestroy) {
    settleRead?.();
  }
  await Promise.all([slowFramePromise, destroyPromise]);

  assert.equal(abortedByDestroy, true, 'closeReader must abort in-flight readFrame before it settles');
  assert.equal(revocations, 1, 'stream port must be revoked on mid-read destroyed');
  const statesPosted = posted.map(([, msg]) => msg.surface.state);
  assert.deepEqual(statesPosted, ['destroyed'], 'no active surface post may occur after destroyed is published');

  // Direct deliverAuthorityFrame check: when resolveLatestState() returns null (absent surface),
  // even a stateUpdated: true entry whose read fails returns false without posting a stale active fallback.
  const directPosted = [];
  const directStreams = new Set();
  const directPort = new EventEmitter();
  directPort.postMessage = () => {};
  directPort.start = () => {};
  directPort.close = () => {};
  try {
    const ok = await deliverAuthorityFrame(
      {
        frameRef,
        state: { ...surface, surface_id: 's1', state: 'active' },
        stateUpdated: true,
        resolveLatestState: () => null,
        readerOptions: {
          binding,
          limits: { maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 1 },
          pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
          onReleaseLease() {},
          acquirePublishedLease: async () => {
            throw new Error('READ_FAIL');
          },
        },
        portOptions: {
          port: directPort,
          role: 'sender',
          binding,
          limits: { maxFrameBytes: 4096, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
          onReleaseLease() {},
          onRevoke() {},
        },
      },
      { postMessage: (...args) => directPosted.push(args) },
      directStreams,
    );
    assert.equal(ok, false);
    assert.equal(directPosted.length, 0, 'absent surface (resolveLatestState -> null) must not post stale fallback');
  } finally {
    for (const s of directStreams) {
      await s.reader.closeReader().catch(() => {});
      s.port.revokeFramePort('SHUTDOWN');
    }
  }

  // Negative control: oracle rejects a stale active post preceding or following destroyed.
  assert.throws(() => assert.deepEqual(['active', 'destroyed'], ['destroyed']));
});

test('RV10-03: fast-path stateOnly supersedes older queued stateOnly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wire-rv10-03-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bytes = new Uint8Array([1, 2, 3]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const makeRef = (sid) => ({
    schema: 'frame_ref/v0.2',
    surface_id: sid,
    generation: 1,
    tick: 1,
    ts_ns: 1,
    width: 1,
    height: 1,
    format: 'rgb24',
    ramws_path: '/dev/shm/private.rgb',
    sha256: sha,
    capture_us: 1,
  });
  const handlers = new Map();
  const posted = [];
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = {
    id: 9,
    mainFrame: frame,
    isDestroyed: () => false,
    postMessage: (...args) => posted.push(args),
  };
  const event = { sender: contents, senderFrame: frame };
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
  };
  let stateOnlyDiagCount = 0;
  let emitEntry = null;
  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: { request: async () => true },
    env: { XDG_CONFIG_HOME: root },
    argv: [],
    frameDiag: {
      recordStateOnly: () => {
        stateOnlyDiagCount += 1;
      },
    },
    frames: {
      subscribe: (cb) => {
        emitEntry = cb;
        return () => {};
      },
    },
  });
  t.after(() => wire.dispose());

  let notifyAReadEntered = null;
  const aReadEntered = new Promise((resolve) => {
    notifyAReadEntered = resolve;
  });
  let releaseARead = null;
  const bindingA = { principal: 'ui', epoch: 1, surfaceId: 'sA', surfaceGeneration: 1 };
  const portA = new EventEmitter();
  portA.postMessage = () => {};
  portA.start = () => {};
  portA.close = () => {};

  const bindingC = { principal: 'ui', epoch: 1, surfaceId: 'sC', surfaceGeneration: 1 };
  const portC = new EventEmitter();
  portC.postMessage = () => {};
  portC.start = () => {};
  portC.close = () => {};

  // While unsubscribed:
  // 1) stage slow frame for sA,
  // 2) stage older folded stateOnly for sB,
  // 3) stage failing frame + folded stateOnly for sC (setting stateUpdated: true on sC).
  await emitEntry({
    frameRef: makeRef('sA'),
    state: { ...surface, surface_id: 'sA', visibility: 'unfolded' },
    readerOptions: {
      binding: bindingA,
      limits: { maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 1 },
      pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
      onReleaseLease() {},
      acquirePublishedLease: async () => ({
        identity: { ...bindingA, frameGeneration: 1, leaseId: 'lease-sA' },
        published: true,
        byteLength: 3,
        readOwnedBytes: () =>
          new Promise((resolve) => {
            releaseARead = () => resolve(bytes);
            notifyAReadEntered();
          }),
        release: async () => {},
      }),
    },
    portOptions: {
      port: portA,
      role: 'sender',
      binding: bindingA,
      limits: { maxFrameBytes: 4096, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
      onReleaseLease() {},
      onRevoke() {},
    },
  });
  await emitEntry({
    stateOnly: true,
    frameRef: makeRef('sB'),
    state: { ...surface, surface_id: 'sB', visibility: 'folded' },
  });
  await emitEntry({
    frameRef: makeRef('sC'),
    state: { ...surface, surface_id: 'sC', visibility: 'unfolded' },
    readerOptions: {
      binding: bindingC,
      limits: { maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 1 },
      pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
      onReleaseLease() {},
      acquirePublishedLease: async () => {
        throw new Error('FAIL_SC_READ');
      },
    },
    portOptions: {
      port: portC,
      role: 'sender',
      binding: bindingC,
      limits: { maxFrameBytes: 4096, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
      onReleaseLease() {},
      onRevoke() {},
    },
  });
  await emitEntry({
    stateOnly: true,
    frameRef: makeRef('sC'),
    state: { ...surface, surface_id: 'sC', visibility: 'folded' },
  });

  // Subscribe starts draining sA; emit newer unfolded stateOnly for sB and sC while sA is mid-read.
  const subPromise = handlers.get(WIRE_CHANNELS.subscribeFrames)(event);
  await aReadEntered;

  await emitEntry({
    stateOnly: true,
    frameRef: makeRef('sB'),
    state: { ...surface, surface_id: 'sB', visibility: 'unfolded' },
  });
  await emitEntry({
    stateOnly: true,
    frameRef: makeRef('sC'),
    state: { ...surface, surface_id: 'sC', visibility: 'unfolded' },
  });

  releaseARead();
  await subPromise;

  const bMessages = posted.filter(([, msg]) => msg.surface.surface_id === 'sB').map(([, msg]) => msg.surface.visibility);
  assert.equal(bMessages.at(-1), 'unfolded', 'newer fast-path unfolded state must not be overwritten by older queued folded state');
  assert.deepEqual(bMessages, ['unfolded']);

  const cMessages = posted.filter(([, msg]) => msg.surface.surface_id === 'sC').map(([, msg]) => msg.surface.visibility);
  assert.deepEqual(cMessages, ['unfolded'], 'fast-path merge into queued frame entry must clear stateUpdated to avoid duplicate post on reader failure');
  assert.equal(stateOnlyDiagCount, 2);

  // Negative control: oracle rejects stale trailing 'folded'.
  assert.throws(() => assert.equal(['unfolded', 'folded'].at(-1), 'unfolded'));
});

test('MV10-NEW-01: destroy while unsubscribed still notifies and releases on resubscribe', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wire-mv10-new01-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bytes = new Uint8Array([1, 2, 3]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const frameRef = {
    schema: 'frame_ref/v0.2',
    surface_id: 's1',
    generation: 1,
    tick: 1,
    ts_ns: 1,
    width: 1,
    height: 1,
    format: 'rgb24',
    ramws_path: '/dev/shm/private.rgb',
    sha256: sha,
    capture_us: 1,
  };
  const binding = { principal: 'ui', epoch: 1, surfaceId: 's1', surfaceGeneration: 1 };
  const handlers = new Map();
  const posted = [];
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = {
    id: 9,
    mainFrame: frame,
    isDestroyed: () => false,
    postMessage: (...args) => posted.push(args),
  };
  const event = { sender: contents, senderFrame: frame };
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
  };

  let emitEntry = null;
  const wire = installAuthorityWire({
    ipcMain,
    contents,
    core: { request: async () => true },
    env: { XDG_CONFIG_HOME: root },
    argv: [],
    frames: {
      subscribe: (cb) => {
        emitEntry = cb;
        return () => {};
      },
    },
  });
  t.after(() => wire.dispose());

  let revocations = 0;
  const wirePort = new EventEmitter();
  wirePort.postMessage = () => {};
  wirePort.start = () => {};
  wirePort.close = () => {};

  await handlers.get(WIRE_CHANNELS.subscribeFrames)(event);
  await emitEntry({
    frameRef,
    state: { ...surface, surface_id: 's1', state: 'active' },
    readerOptions: {
      binding,
      limits: { maxFrameBytes: 4096, maxWidth: 64, maxHeight: 64, readTimeoutMs: 1000, maxConcurrentReads: 1 },
      pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
      onReleaseLease() {},
      acquirePublishedLease: async () => ({
        identity: { ...binding, frameGeneration: 1, leaseId: 'lease-new01' },
        published: true,
        byteLength: 3,
        readOwnedBytes: async () => bytes,
        release: async () => {},
      }),
    },
    portOptions: {
      port: wirePort,
      role: 'sender',
      binding,
      limits: { maxFrameBytes: 4096, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
      onReleaseLease() {},
      onRevoke() {
        revocations += 1;
      },
    },
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0][1].surface.state, 'active');
  assert.equal(revocations, 0);

  await handlers.get(WIRE_CHANNELS.unsubscribeFrames)(event);
  await emitEntry({
    stateOnly: true,
    frameRef,
    state: { ...surface, surface_id: 's1', state: 'destroyed' },
    readerOptions: { binding },
  });
  await handlers.get(WIRE_CHANNELS.subscribeFrames)(event);

  assert.equal(posted.length, 2, 'resubscribe must deliver the destroyed notice staged while unsubscribed');
  assert.equal(posted[1][1].surface.state, 'destroyed');
  assert.equal(revocations, 1, 'stream must be closed and revoked when destroyed while unsubscribed');

  // Negative control: oracle rejects missing destroyed notice or unrevoked stream.
  assert.throws(() => assert.equal(1, 2));
  assert.throws(() => assert.equal(0, 1));
});

test('R3-T4-012 (T19): main propose validates full 7-key action_proposal/v0.2 contract pre-send', async t => {
  const f = await fixture(t);
  const base = JSON.parse(validProposal);
  for (const requiredKey of ['schema', 'proposal_id', 'surface_id', 'based_on_frame', 'action', 'expectation', 'budget']) {
    const copy = { ...base };
    delete copy[requiredKey];
    await assert.rejects(f.call('propose', JSON.stringify(copy)), /PROPOSAL/);
  }
  await assert.rejects(f.call('propose', '{"proposal_id":"p"}'), /PROPOSAL/);
  await assert.rejects(f.call('propose', '{"schema":"action_proposal/v0.2","proposal_id":"p"}'), /PROPOSAL/);
  await assert.rejects(f.call('propose', JSON.stringify({ ...base, extra: 1 })), /PROPOSAL/);
  await assert.rejects(f.call('propose', JSON.stringify({ ...base, action: { type: 'click', x: -1, y: 0, button: 'left' } })), /PROPOSAL/);
  await assert.rejects(f.call('propose', JSON.stringify({ ...base, expectation: { type: 'unknown' } })), /PROPOSAL/);
  await assert.rejects(f.call('propose', JSON.stringify({ ...base, budget: { max_ms: 0, max_retries: 0 } })), /PROPOSAL/);
  assert.equal(f.coreCalls.length, 0);
  const res = await f.call('propose', validProposal);
  assert.deepEqual(res, verdict);
  assert.equal(f.coreCalls.length, 1);
});

test('R3-T4-011 (T20): installAuthorityWire unwinds all 11 ipcMain handlers when frames.subscribe throws', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wire-r3-011-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = { id: 9, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const ipcMain = {
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error(`DUPLICATE:${channel}`);
      handlers.set(channel, fn);
    },
    removeHandler: (channel) => handlers.delete(channel),
  };
  let shouldThrow = true;
  const frames = {
    subscribe: () => {
      if (shouldThrow) throw new Error('FRAME_SOURCE');
      return () => {};
    },
  };
  const stubTerminal = { setEnabled: async () => true, open: async () => ({ session: 's1' }) };
  assert.throws(() => installAuthorityWire({
    ipcMain,
    contents,
    env: { XDG_CONFIG_HOME: root, MV_SELF_CAPSULE_ID: 'capsule-1' },
    argv: ['--nested-depth=0'],
    core: { request: async () => verdict },
    profiles: new Map(),
    terminal: stubTerminal,
    frames,
  }), /FRAME_SOURCE/);
  assert.equal(handlers.size, 0, 'all registered handlers must be removed when frames.subscribe throws');

  shouldThrow = false;
  const binding = installAuthorityWire({
    ipcMain,
    contents,
    env: { XDG_CONFIG_HOME: root, MV_SELF_CAPSULE_ID: 'capsule-1' },
    argv: ['--nested-depth=0'],
    core: { request: async () => verdict },
    profiles: new Map(),
    terminal: stubTerminal,
    frames,
  });
  assert.equal(handlers.size, Object.keys(WIRE_CHANNELS).length);
  await binding.dispose();
  assert.equal(handlers.size, 0);
});

test('R3-T4-002: refused unknown sids leave 0 rate-window keys and dispose clears all surface maps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wire-r3-002-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = { id: 9, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: (ch) => handlers.delete(ch) };
  let admitKnown = false;
  const binding = installAuthorityWire({
    ipcMain,
    contents,
    env: { XDG_CONFIG_HOME: root, MV_SELF_CAPSULE_ID: 'capsule-1' },
    argv: ['--nested-depth=0'],
    core: {
      request: async (req) => {
        if (req.op === 'input' && admitKnown && req.batch.surface_id === 's-known') {
          return { ok: true, accepted: req.batch.events.length };
        }
        return { ok: false, code: 'SURFACE_UNKNOWN' };
      },
    },
    profiles: new Map(),
    terminal: null,
  });
  const invokeInput = (sid, seq = 1) => handlers.get(WIRE_CHANNELS.intent)(event, {
    schema: 'surface_input/v1',
    surface_id: sid,
    stream_id: 1,
    seq,
    events: [{ kind: 'key', keys: ['a'] }],
  });
  for (let i = 0; i < 65; i += 1) {
    const out = await invokeInput(`unknown-65-${i}`);
    assert.deepEqual(out, { ok: false, code: 'SURFACE_UNKNOWN' });
  }
  assert.equal(binding.inputRateWindow.size, 0);
  assert.equal(binding.inputLastSeq.size, 0);

  for (let i = 0; i < 10000; i += 1) {
    const out = await invokeInput(`unknown-10k-${i}`);
    assert.equal(out.ok, false);
  }
  assert.equal(binding.inputRateWindow.size, 0);
  assert.equal(binding.inputLastSeq.size, 0);

  admitKnown = true;
  const okOut = await invokeInput('s-known', 1);
  assert.deepEqual(okOut, { ok: true, accepted: 1 });
  assert.equal(binding.inputRateWindow.has('s-known'), true);
  assert.equal(binding.inputLastSeq.get('s-known'), 1);

  await binding.dispose();
  assert.equal(binding.inputRateWindow.size, 0);
  assert.equal(binding.inputLastSeq.size, 0);
  assert.equal(binding.inputInFlightSeq.size, 0);
});

test('R3-ELECTRON-5: settings save invokes file.sync() before rename and aborts on sync rejection without corrupting committed file', async t => {
  const f = await fixture(t);
  const dir = join(f.root, 'metaviewer');
  const committedPath = join(dir, 'settings.json');
  const darkSettings = JSON.stringify({ scheme: 'mv-dark', density: 'compact' });

  // Positive control: clean save commits and rotates inode.
  await f.call('saveSettings', settings);
  const firstStat = await stat(committedPath);
  assert.equal(firstStat.mode & 0o777, 0o600);
  assert.equal(await readFile(committedPath, 'utf8'), settings);

  const originalOpen = fsPromises.open;
  const originalRename = fsPromises.rename;
  const events = [];
  let rejectFileSync = false;

  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  t.mock.method(fsPromises, 'open', async (targetPath, flags, mode) => {
    const handle = await originalOpen(targetPath, flags, mode);
    const name = String(targetPath);
    if (name.includes('.settings-') && name.endsWith('.tmp')) {
      const origSync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push('file.sync');
        if (rejectFileSync) {
          const err = /** @type {NodeJS.ErrnoException} */ (new Error('EIO: simulated fsync failure'));
          err.code = 'EIO';
          throw err;
        }
        return origSync();
      };
    }
    return handle;
  });
  t.mock.method(fsPromises, 'rename', async (oldPath, newPath) => {
    if (String(newPath) === committedPath) {
      events.push('rename');
    }
    return originalRename(oldPath, newPath);
  });
  syncBuiltinESMExports();

  // Verify file.sync() is invoked before rename/acknowledge and inode rotates.
  const ack = await f.call('saveSettings', darkSettings);
  assert.equal(ack, true);
  assert.deepEqual(events, ['file.sync', 'rename']);
  const secondStat = await stat(committedPath);
  assert.notEqual(secondStat.ino, firstStat.ino);
  assert.equal(await readFile(committedPath, 'utf8'), darkSettings);

  // Fault injection: file.sync() rejection aborts save before rename without corrupting committed file.
  events.length = 0;
  rejectFileSync = true;
  await assert.rejects(f.call('saveSettings', settings), /EIO/);
  assert.deepEqual(events, ['file.sync']);
  const afterFailStat = await stat(committedPath);
  assert.equal(afterFailStat.ino, secondStat.ino);
  assert.equal(await readFile(committedPath, 'utf8'), darkSettings);
  assert.deepEqual(await readdir(dir), ['settings.json']);
});


test('POLISH-2 browser create has zero renderer arguments, host-owned profile and typed errors', async t => {
  const f = await fixture(t, {}, []);
  const api = createPreloadFacade({transport:{invoke:async (channel,args) => f.handlers.get(channel)(f.event,...args)},bridge:{exposeInMainWorld(){}}});
  f.coreReply({schema:'surface_event/v0.2',event:'created',data:{surface}});
  assert.deepEqual(await api.authority.createSurface(),{ok:true});
  assert.deepEqual(f.coreCalls.at(-1),{schema:'surface_request/v0.2',op:'create',params:{kind:'browser',geometry:{w:1280,h:900},profile_id:'mv-live-1'}});
  const count = f.coreCalls.length;
  await assert.rejects(api.authority.createSurface({profile_id:'injected'}), /ARGS/);
  const handler = f.handlers.get(WIRE_CHANNELS.createSurface);
  await assert.rejects(handler({sender:{...f.contents},senderFrame:f.event.senderFrame}), /SENDER/);
  assert.equal(f.coreCalls.length,count);
  f.coreReply({schema:'surface_event/v0.2',event:'error',data:{surface_id:'none',code:'NATIVE_FAILED',detail:'private'}});
  assert.deepEqual(await api.authority.createSurface(),{ok:false,code:'NATIVE_FAILED'});
  const nested = await fixture(t);
  assert.deepEqual(await nested.call('createSurface'),{ok:false,code:'DISPLAY_ONLY'});
  assert.equal(nested.coreCalls.length,0);
});

test('POLISH-2 terminal missing support crosses preload as a typed reply',async t => {
  const f=await fixture(t);
  await f.call('terminalEnabled',true);
  f.terminalReply({ok:false,code:'TERMINAL_UNAVAILABLE'});
  const reply=await f.call('terminalOpen',spec);
  assert.deepEqual(reply,{ok:false,code:'TERMINAL_UNAVAILABLE'});
  assert.deepEqual(await facade(reply).sideTerminal.open(spec),reply);
});
