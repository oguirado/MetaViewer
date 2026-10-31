import test from 'node:test';
import assert from 'node:assert/strict';
import net, { createServer } from 'node:net';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, mkdir, chmod, writeFile, rm, readFile, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMainBindings, readPeerCredentials, INTENT_OPS as HOST_INTENT_OPS } from '../electron/hostBindings.js';
import { loadMainBindings, bootProductionMain, ELECTRON_PIN, CHANNELS } from '../electron/main.js';
import { deliverAuthorityFrame, WIRE_CHANNELS, INTENT_OPS as WIRE_INTENT_OPS, validateIntentBody } from '../electron/authorityWire.js';
import { installPreload } from '../electron/preload.js';

const surface = {schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'agent',profile_id:'test'};
const registration = component => ({endpoint:{component,instance:component+'-test'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});
async function waitForCondition(predicate, description = 'condition', timeoutMs = 5000) {
  const start = Date.now();
  while (true) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) {
      assert.fail(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, {badHello=false,refuseIntent=false,layoutRefusalCode=null}={}) {
  const root=await mkdtemp(join(tmpdir(),'mv-host-'));
  const ram=await mkdtemp('/dev/shm/mv-host-');
  const config={session_id:'host-test',core:registration('core'),peers:[registration('ui')]};
  await mkdir(join(root,'metaviewer'),{mode:0o700});
  const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const bytes=Buffer.from([1,2,3]);const path=join(ram,'frame.rgb');await writeFile(path,bytes,{mode:0o600});
  const frame={schema:'frame_ref/v0.2',surface_id:'s1',generation:1,tick:1,ts_ns:1,width:1,height:1,format:'rgb24',ramws_path:path,sha256:createHash('sha256').update(bytes).digest('hex'),capture_us:1};
  const requests=[],sockets=new Set();let peer,seq=0;
  const send=body=>peer.write(JSON.stringify({schema:'envelope/v0.2',msg_id:'reply-'+(++seq),ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq,nonce:'nonce-'+seq,body})+'\n');
  const server=createServer(socket=>{peer=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',data=>{
    buffer+=data;let offset;while((offset=buffer.indexOf('\n'))>=0){const env=JSON.parse(buffer.slice(0,offset));buffer=buffer.slice(offset+1);requests.push(env);
      if(env.body.schema==='hello/v0.2')send({...config.core.hello,...(badHello?{component_commit:'b'.repeat(40)}:{})});
      else if(env.body.schema==='surface_request/v0.2') { /* subscription has no reply */ }
      else if(env.body.schema==='ui_intent/v0.2') {
        const extended=['move','tab','float','hide','show'].includes(env.body.op);
        if(refuseIntent) {
          send({schema:'action_verdict/v0.2',proposal_id:env.body.request_id,decision:'refused',reason_code:'POLICY',core_seq:1});
          if(extended && layoutRefusalCode) send({schema:'surface_event/v0.2',event:'error',data:{surface_id:env.body.params.slot_id,code:layoutRefusalCode,detail:env.body.request_id}});
        } else if(extended) send(env.body);
        else send({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...surface,control:env.body.op==='take_control'?'human':'agent',visibility:env.body.op==='fold'?'folded':'unfolded'}}});
      }
      else send({schema:'action_verdict/v0.2',proposal_id:env.body.proposal_id,decision:'refused',reason_code:'POLICY',core_seq:1});
    }
  });});
  server.listen(join(root,'metaviewer/core.sock'));await once(server,'listening');await chmod(join(root,'metaviewer/core.sock'),0o600);
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});await rm(ram,{recursive:true,force:true});});
  const messages=[];const channels=[];
  const createMessageChannel=()=>{const port1=new EventEmitter();Object.assign(port1,{postMessage:value=>messages.push(value),start(){},close(){}});const port2={close(){}};channels.push({port1,port2});return {port1,port2};};
  const env={MV_CORE_CONFIG:configPath,XDG_RUNTIME_DIR:root};
  return {env,root,frame,send,requests,messages,channels,createMessageChannel,disconnect:()=>peer.destroy()};
}
test('default bootstrap connects, pins hello, delivers real bytes and routes intents/proposals',async t=>{
  const f=await fixture(t);
  const bindings=await loadMainBindings(f.env,{createMessageChannel:f.createMessageChannel});t.after(()=>bindings.core.dispose());
  assert.equal((await bindings.core.start()).availability,'live');
  const entryPromise=new Promise(resolve=>bindings.wire.frames.subscribe(resolve));
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  const entry=await entryPromise,streams=new Set(),metadata=[];
  try {
    assert.equal(await deliverAuthorityFrame(entry,{postMessage:(...args)=>metadata.push(args)},streams),true);
    assert.equal(f.messages.length,1);assert.deepEqual(metadata[0][2],[f.channels[0].port2]);
    assert.ok(!JSON.stringify(metadata).includes('/dev/shm'));
    for(const op of ['take_control','release_control','fold','unfold']) {
      const params=op==='fold'||op==='unfold'?{slot_id:'s1'}:{surface_id:'s1'};
      assert.equal(await bindings.core.request({op:'intent',json:JSON.stringify({schema:'ui_intent/v0.2',request_id:op,op,params})}),true);
      assert.equal(f.requests.at(-1).body.op,op);
    }
    const validProposal = {
      schema: 'action_proposal/v0.2',
      proposal_id: 'p',
      surface_id: 's1',
      based_on_frame: { generation: 1, sha256: 'a'.repeat(64) },
      action: { type: 'click', x: 1, y: 1, button: 'left' },
      expectation: { type: 'state_sha256_change' },
      budget: { max_ms: 1000, max_retries: 0 },
    };
    const reqCountBeforeBad = f.requests.length;
    await assert.rejects(
      bindings.core.request({ op: 'propose', json: JSON.stringify({ schema: 'action_proposal/v0.2', proposal_id: 'p' }) }),
      /CORE_SEAMS_ABSENT/,
    );
    assert.equal(f.requests.length, reqCountBeforeBad);
    const verdict=await bindings.core.request({op:'propose',json:JSON.stringify(validProposal)});
    assert.equal(verdict.reason_code,'POLICY');assert.equal(f.requests.at(-1).body.proposal_id,'p');
  } finally {for(const stream of streams){await stream.reader.closeReader();stream.port.revokeFramePort('SHUTDOWN');}}
});
test('missing configuration, unsafe socket and incorrect hello fail closed',async t=>{
  await assert.rejects(createMainBindings({env:{}}),/CORE_SEAMS_ABSENT/);
  const f=await fixture(t);await chmod(join(f.root,'metaviewer/core.sock'),0o666);
  await assert.rejects(createMainBindings({...f}),/CORE_SEAMS_ABSENT/);
  const bad=await fixture(t,{badHello:true});await assert.rejects(createMainBindings({...bad}),/CORE_SEAMS_ABSENT/);
});
test('bootstrap overrides are absolute and validated before returning bindings',async t=>{
  await assert.rejects(loadMainBindings({MV_CORE_BOOTSTRAP:'relative.js'}),/CORE_SEAMS_ABSENT/);
  const f=await fixture(t);const path=join(f.root,'bad.mjs');await writeFile(path,'export const createMainBindings = () => ({core:{}});');
  await assert.rejects(loadMainBindings({MV_CORE_BOOTSTRAP:path}),/CORE_SEAMS_ABSENT/);
  const main=await readFile(new URL('../electron/main.js',import.meta.url),'utf8');
  assert.ok(main.indexOf('const bindings = await loadMainBindings')<main.indexOf('await bootProductionMain({ core:bindings.core'));
});
test('producer refuses cross-bound references and path substitution',async t=>{
  const f=await fixture(t);const bindings=await createMainBindings({...f});t.after(()=>bindings.core.dispose());
  const entryPromise=new Promise(resolve=>bindings.wire.frames.subscribe(resolve));
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  const entry=await entryPromise;
  const streams=new Set();
  try {
    assert.equal(await deliverAuthorityFrame({...entry,frameRef:{...f.frame,surface_id:'other'},state:{...surface,surface_id:'other'}},{postMessage(){assert.fail('cross-bound frame reached renderer');}},streams),false);
    assert.equal(f.messages.length,0);
  } finally {for(const stream of streams){await stream.reader.closeReader();stream.port.revokeFramePort('SHUTDOWN');}}
});
test('producer refuses changed capability identity without opening a foreign path',async t=>{
  const f=await fixture(t);const bindings=await createMainBindings({...f});t.after(()=>bindings.core.dispose());
  const entryPromise=new Promise(resolve=>bindings.wire.frames.subscribe(resolve));
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  const entry=await entryPromise;
  for(const patch of [{surface_id:'other'},{ramws_path:'/etc/passwd'}]) {
    await assert.rejects(entry.readerOptions.acquirePublishedLease({binding:entry.readerOptions.binding,frameRef:{...f.frame,...patch},signal:new AbortController().signal}),/FRAME_BINDING/);
  }
  await assert.rejects(entry.readerOptions.acquirePublishedLease({binding:{...entry.readerOptions.binding,surfaceId:'other'},frameRef:f.frame,signal:new AbortController().signal}),/FRAME_BINDING/);
});

test('core refusals never become successful renderer intents',async t=>{
  const f=await fixture(t,{refuseIntent:true});const bindings=await createMainBindings({...f});t.after(()=>bindings.core.dispose());
  await assert.rejects(bindings.core.request({op:'intent',json:JSON.stringify({schema:'ui_intent/v0.2',request_id:'refused',op:'take_control',params:{surface_id:'s1'}})}),/INTENT_REFUSED/);
});

test('production boot installs the default socket wire and delivers a subscribed renderer frame',async t=>{
  const f=await fixture(t),handlers=new Map();
  const bindings=await loadMainBindings(f.env,{createMessageChannel:f.createMessageChannel});
  t.after(()=>bindings.core.dispose());
  const shell=join(f.root,'shell');
  await mkdir(join(shell,'dist/renderer'),{recursive:true});await mkdir(join(shell,'dist/preload'),{recursive:true});
  await writeFile(join(shell,'dist/renderer/index.html'),'<!doctype html><title>host test</title>');
  await writeFile(join(shell,'dist/preload/preload.cjs'),'');
  const session={setPermissionRequestHandler(){},setPermissionCheckHandler(){}};
  const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
  let resolveNotice;const notice=new Promise(resolve=>{resolveNotice=resolve;});
  const contents={id:17,mainFrame:frame,session,isDestroyed:()=>false,setWindowOpenHandler(){},on(){},loadURL:async()=>{},postMessage:(...args)=>resolveNotice(args)};
  let windows=0;
  class Window {
    constructor(){windows++;this.webContents=contents;}
    once(){} on(){} show(){} destroy(){} isDestroyed(){return false;}
  }
  const booted=await bootProductionMain({...bindings,app:{requestSingleInstanceLock:()=>true,whenReady:async()=>{},on(){},quit(){},getAppPath:()=>shell,getPath:()=>join(f.root,'user')},
    BrowserWindow:Window,ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},
    protocol:{registerSchemesAsPrivileged(){},handle(){},unhandle(){}},session:{defaultSession:session},
    electronVersion:ELECTRON_PIN,shellRoot:shell,argv:['metaviewer'],env:f.env,
    runtime:{xdgRuntimeDir:f.root,uid:process.getuid()},geometry:{width:1280,height:720},bridge:[CHANNELS.load,CHANNELS.save].map(channel=>({channel,decode:value=>value,invoke:async()=>null}))});
  t.after(()=>booted.dispose());assert.equal(windows,1);
  await handlers.get(WIRE_CHANNELS.subscribeFrames)({sender:contents,senderFrame:frame});
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  const delivered=await notice;assert.equal(delivered[0],'metaviewer:authority.frames');assert.equal(f.messages.length,1);
  assert.deepEqual(delivered[2],[f.channels[0].port2]);
  assert.equal(await handlers.get(WIRE_CHANNELS.intent)({sender:contents,senderFrame:frame},JSON.stringify({schema:'ui_intent/v0.2',request_id:'boot-take',op:'take_control',params:{surface_id:'s1'}})),true);
});

// Exercise the post-hello filesystem await deterministically, without timing sleeps.
for (const closeDuringStat of [true, false]) {
  test(`keepalive post-hello lstat race: close=${closeDuringStat}`, async t => {
    const f = await fixture(t);
    const originalConnect = net.createConnection, originalStat = fsPromises.lstat;
    const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
    const active = new Set();
    let client, socketStats = 0, bindings;
    t.after(async () => {
      await bindings?.core.dispose();
      for (const timer of active) originalClear(timer);
      t.mock.restoreAll(); syncBuiltinESMExports();
    });
    t.mock.method(net, 'createConnection', (...args) => {
      client = originalConnect(...args); return client;
    });
    t.mock.method(fsPromises, 'lstat', async (...args) => {
      const info = await originalStat(...args);
      if (args[0] === join(f.root, 'metaviewer/core.sock') && ++socketStats === 2 && closeDuringStat) {
        const closed = once(client, 'close');
        f.disconnect(); await closed;
      }
      return info;
    });
    t.mock.method(globalThis, 'setInterval', (...args) => {
      const timer = originalInterval(...args); active.add(timer); return timer;
    });
    t.mock.method(globalThis, 'clearInterval', timer => {
      active.delete(timer); return originalClear(timer);
    });
    syncBuiltinESMExports();
    const creating = createMainBindings({...f}).then(value => { bindings = value; return value; });
    if (closeDuringStat) {
      await assert.rejects(creating, /CORE_SEAMS_ABSENT/);
      assert.equal(active.size, 0);
    } else {
      await creating;
      assert.equal(bindings.core.getStatus().availability, 'live');
      assert.equal(active.size, 1);
      assert.equal([...active][0].hasRef(), false);
      await bindings.core.dispose();
      assert.equal(active.size, 0);
    }
    assert.equal(socketStats, 2);
  });
}

test('authorityWire and hostBindings share the exact frozen intent operation table', () => {
  assert.equal(HOST_INTENT_OPS, WIRE_INTENT_OPS);
  assert.ok(Object.isFrozen(WIRE_INTENT_OPS));
  assert.deepEqual(Object.keys(WIRE_INTENT_OPS).sort(), ['float', 'fold', 'hide', 'move', 'release_control', 'show', 'tab', 'take_control', 'unfold']);
});

test('hostBindings forwards every layout op with exact body and rejects bare/malformed ops before reaching core', async t => {
  const f = await fixture(t);
  const bindings = await createMainBindings({ ...f });
  t.after(() => bindings.core.dispose());
  const before = f.requests.length;
  for (const op of Object.keys(WIRE_INTENT_OPS)) {
    for (const bad of [{ op }, { schema: 'ui_intent/v0.2', request_id: 'r', op }, { schema: 'ui_intent/v0.2', request_id: 'r', op, params: {} }]) {
      await assert.rejects(bindings.core.request({ op: 'intent', json: JSON.stringify(bad) }), /CORE_SEAMS_ABSENT/);
    }
  }
  assert.equal(f.requests.length, before);
  const layoutCases = [
    ['hide', { slot_id: 'cuk-ai-slot-s1' }],
    ['show', { slot_id: 's1' }],
    ['move', { slot_id: 's1', group_id: 'group-2', index: 0 }],
    ['tab', { slot_id: 's1', group_id: 'group-2', index: 255 }],
    ['float', { slot_id: 's1', x_px: 0, y_px: 16383, width_px: 16384, height_px: 1 }],
  ];
  for (const [op, params] of layoutCases) {
    const body = { schema: 'ui_intent/v0.2', request_id: `req-${op}`, op, params };
    validateIntentBody(body);
    assert.equal(await bindings.core.request({ op: 'intent', json: JSON.stringify(body) }), true);
    assert.deepEqual(f.requests.at(-1).body, body);
  }
});

test('core layout refusals propagate as typed errors across hostBindings', async t => {
  for (const code of ['LAYOUT_UNKNOWN_SLOT', 'LAYOUT_ILLEGAL_TRANSITION', 'LAYOUT_INPUT_MODE_READ']) {
    const f = await fixture(t, { refuseIntent: true, layoutRefusalCode: code });
    const bindings = await createMainBindings({ ...f });
    t.after(() => bindings.core.dispose());
    for (const [op, params] of [
      ['hide', { slot_id: 'cuk-ai-slot-s1' }],
      ['show', { slot_id: 's1' }],
      ['move', { slot_id: 's1', group_id: 'g1', index: 0 }],
      ['tab', { slot_id: 's1', group_id: 'g1', index: 1 }],
      ['float', { slot_id: 's1', x_px: 10, y_px: 20, width_px: 300, height_px: 200 }],
    ]) {
      const body = { schema: 'ui_intent/v0.2', request_id: `refuse-${code}-${op}`, op, params };
      await assert.rejects(bindings.core.request({ op: 'intent', json: JSON.stringify(body) }), new RegExp(`^Error: ${code}$`));
      assert.deepEqual(f.requests.at(-1).body, body);
    }
  }
});

test('W2-REALAPP regression: sustained multi-frame delivery, pre-subscribe replay, state_changed propagation, port-revoke resilience', async t => {
  const f = await fixture(t), handlers = new Map();
  const bindings = await loadMainBindings(f.env, { createMessageChannel: f.createMessageChannel });
  t.after(() => bindings.core.dispose());
  const origSubscribe = bindings.wire.frames.subscribe;
  let stagedEntries = 0;
  bindings.wire.frames.subscribe = listener =>
    origSubscribe(async entry => {
      await listener(entry);
      stagedEntries += 1;
    });
  const shell = join(f.root, 'shell');
  await mkdir(join(shell, 'dist/renderer'), { recursive: true });
  await mkdir(join(shell, 'dist/preload'), { recursive: true });
  await writeFile(join(shell, 'dist/renderer/index.html'), '<!doctype html><title>host test</title>');
  await writeFile(join(shell, 'dist/preload/preload.cjs'), '');
  const session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const notices = [];
  let onNotice = () => {};
  const contents = {
    id: 23,
    mainFrame: frame,
    session,
    isDestroyed: () => false,
    setWindowOpenHandler() {},
    on() {},
    loadURL: async () => {},
    postMessage: (...args) => { notices.push(args); onNotice(args); },
  };
  class Window {
    constructor() { this.webContents = contents; }
    once() {} on() {} show() {} destroy() {} isDestroyed() { return false; }
  }
  const booted = await bootProductionMain({
    ...bindings,
    app: { requestSingleInstanceLock: () => true, whenReady: async () => {}, on() {}, quit() {}, getAppPath: () => shell, getPath: () => join(f.root, 'user') },
    BrowserWindow: Window,
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    protocol: { registerSchemesAsPrivileged() {}, handle() {}, unhandle() {} },
    session: { defaultSession: session },
    electronVersion: ELECTRON_PIN,
    shellRoot: shell,
    argv: ['metaviewer'],
    env: f.env,
    runtime: { xdgRuntimeDir: f.root, uid: process.getuid() },
    geometry: { width: 1280, height: 720 },
    bridge: [CHANNELS.load, CHANNELS.save].map(channel => ({ channel, decode: value => value, invoke: async () => null })),
  });
  t.after(() => booted.dispose());

  // 1. L1 pre-subscribe race: frame_ready (generation 1) arrives BEFORE renderer calls subscribeFrames.
  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface } });
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f.frame } });
  await waitForCondition(() => stagedEntries >= 1, 'pre-subscribe generation-1 frame staged in authorityWire');
  assert.equal(notices.length, 0);

  // Subscribing replays the pending generation-1 frame and announces port2.
  await handlers.get(WIRE_CHANNELS.subscribeFrames)({ sender: contents, senderFrame: frame });
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1].frame_ref.generation, 1);
  assert.deepEqual(notices[0][2], [f.channels[0].port2]);
  assert.equal(f.messages.length, 1);

  // ACK generation 1 on port1, then deliver generation 2 (previously failed with FRAME_BINDING).
  const firstDelivery = f.messages[0];
  f.channels[0].port1.emit('message', {
    schema: 'frame_ack/v0.2',
    kind: 'ack',
    correlation: firstDelivery.correlation,
    principal: firstDelivery.principal,
    epoch: firstDelivery.epoch,
    surfaceId: firstDelivery.surfaceId,
    surfaceGeneration: firstDelivery.surfaceGeneration,
    frameGeneration: firstDelivery.frameGeneration,
    leaseId: firstDelivery.leaseId,
    outcome: 'PRESENTED',
  });

  const nextNotice = new Promise(resolve => { onNotice = resolve; });
  const frame2 = { ...f.frame, generation: 2, tick: 2, ts_ns: 2 };
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: frame2 } });
  await nextNotice;
  assert.equal(notices.length, 2);
  assert.equal(notices[1][1].frame_ref.generation, 2);
  assert.deepEqual(notices[1][2], []);
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages[1].frameGeneration, 2);

  // 2. L4 control handoff: take_control / release_control state_changed updates renderer notice immediately.
  const controlNotice = new Promise(resolve => { onNotice = resolve; });
  assert.equal(
    await handlers.get(WIRE_CHANNELS.intent)(
      { sender: contents, senderFrame: frame },
      JSON.stringify({ schema: 'ui_intent/v0.2', request_id: 'take-1', op: 'take_control', params: { surface_id: 's1' } }),
    ),
    true,
  );
  await controlNotice;
  assert.equal(notices.at(-1)[1].surface.control, 'human');

  assert.equal(bindings.core.getStatus().availability, 'live');
});

test('W2-FRAMEPORT-HANDOFF: preload wall port forwarder posts frame_port/v1 once without DOM writes or ACKs; negative control fails planted paint or ACK', async t => {
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let domWrites = 0;
  let putImage = null;
  let wallPresent = true;
  const attrs = new Map([['data-state', 'connecting']]);
  const canvas = {
    width: 0,
    height: 0,
    hidden: true,
    removeAttribute(name) {
      domWrites += 1;
      if (name === 'hidden') this.hidden = false;
    },
    getContext() {
      domWrites += 1;
      return {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: img => {
          domWrites += 1;
          putImage = img;
        },
      };
    },
  };
  const waiting = { hidden: false, style: { display: '' } };
  const section = {
    setAttribute: (k, v) => {
      domWrites += 1;
      attrs.set(k, v);
    },
    getAttribute: k => attrs.get(k),
    querySelector: sel => {
      domWrites += 1;
      return sel === 'canvas.mv-surface__canvas' ? canvas : sel === '.mv-surface__waiting' ? waiting : null;
    },
  };
  const posts = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'app://metaviewer' },
      postMessage: (...args) => posts.push(args),
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: id => {
        if (id === 'metaviewer-app') return wallPresent ? {} : null;
        if (id === 'mv-surface-canvas-s1') {
          domWrites += 1;
          return section;
        }
        return null;
      },
    },
  });
  t.after(() => {
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
  });

  let ipcListener = null;
  const api = installPreload({
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: { invoke: async () => true, on: (_ch, fn) => { ipcListener = fn; }, removeListener() {} },
  });
  const seen = [];
  const unsubscribe = api.authority.subscribeFrames(v => seen.push(v));
  t.after(unsubscribe);

  const acks = [];
  let port2Closed = 0;
  let extraClosed = 0;
  let port2Started = 0;
  const port2 = new EventEmitter();
  port2.postMessage = msg => acks.push(msg);
  port2.start = () => { port2Started += 1; };
  port2.close = () => { port2Closed += 1; };
  const extraPort = { close: () => { extraClosed += 1; } };

  const sha = createHash('sha256').update(Buffer.from([10, 20, 30])).digest('hex');
  ipcListener(
    { ports: [port2, extraPort] },
    {
      frame_ref: {
        schema: 'frame_ref/v0.2',
        surface_id: 's1',
        generation: 1,
        tick: 1,
        ts_ns: 1,
        width: 1,
        height: 1,
        format: 'rgb24',
        sha256: sha,
        capture_us: 1,
      },
      surface,
    },
  );
  assert.equal(seen.length, 1);

  port2.emit('message', {
    data: {
      schema: 'frame_delivery/v0.2',
      kind: 'frame',
      correlation: 's1#1#lease-1',
      principal: 'ui',
      epoch: 1,
      surfaceId: 's1',
      surfaceGeneration: 1,
      frameGeneration: 1,
      leaseId: 'lease-1',
      width: 1,
      height: 1,
      format: 'rgb24',
      byteLength: 3,
      sha256: sha,
      pixelSpec: {},
      bytes: new Uint8Array([10, 20, 30]),
    },
  });

  const assertCleanHandoff = state => {
    assert.equal(state.posts.length, 1);
    const [message, targetOrigin, transfer] = state.posts[0];
    assert.deepEqual(Object.keys(message).sort(), ['schema', 'surface_generation', 'surface_id', 'type']);
    assert.deepEqual(message, {
      type: 'metaviewer:frame-port',
      schema: 'frame_port/v1',
      surface_id: 's1',
      surface_generation: 1,
    });
    assert.equal(targetOrigin, globalThis.window.location.origin);
    assert.equal(Array.isArray(transfer), true);
    assert.equal(transfer.length, 1);
    assert.strictEqual(transfer[0], port2);
    assert.equal(state.extraClosed, 1);
    assert.equal(state.port2Closed, 0);
    assert.equal(state.port2Started, 0);
    assert.equal(state.port2Listeners, 0);
    assert.equal(state.acks.length, 0);
    assert.equal(state.domWrites, 0);
    assert.equal(state.putImage, null);
    assert.equal(state.canvasHidden, true);
    assert.equal(state.waitingHidden, false);
    assert.equal(state.dataState, 'connecting');
  };

  const handoffState = {
    posts,
    extraClosed,
    port2Closed,
    port2Started,
    port2Listeners: port2.listenerCount('message'),
    acks,
    domWrites,
    putImage,
    canvasHidden: canvas.hidden,
    waitingHidden: waiting.hidden,
    dataState: attrs.get('data-state'),
  };
  assertCleanHandoff(handoffState);

  // Subsequent frame notice on the same stream carries no new port and triggers no second postMessage.
  ipcListener(
    { ports: [] },
    {
      frame_ref: {
        schema: 'frame_ref/v0.2',
        surface_id: 's1',
        generation: 2,
        tick: 2,
        ts_ns: 2,
        width: 1,
        height: 1,
        format: 'rgb24',
        sha256: sha,
        capture_us: 1,
      },
      surface,
    },
  );
  assert.equal(seen.length, 2);
  assert.equal(posts.length, 1);

  // Unsubscribing does not close port2 because preload never retained it.
  unsubscribe();
  assert.equal(port2Closed, 0);

  // When #metaviewer-app is absent, frame_port/v1 is not forwarded.
  wallPresent = false;
  const legacyPosts = [];
  globalThis.window.postMessage = (...args) => legacyPosts.push(args);
  const stopLegacy = api.authority.subscribeFrames(() => {});
  t.after(stopLegacy);
  const relayPort = {};
  ipcListener(
    { ports: [relayPort] },
    {
      frame_ref: {
        schema: 'frame_ref/v0.2',
        surface_id: 's1',
        generation: 1,
        tick: 1,
        ts_ns: 1,
        width: 1,
        height: 1,
        format: 'rgb24',
        sha256: sha,
        capture_us: 1,
      },
      surface,
    },
  );
  assert.equal(legacyPosts.filter(([msg]) => msg?.schema === 'frame_port/v1').length, 0);

  // Negative controls: a planted DOM paint or a planted preload ACK must fail the audit.
  assert.throws(() => assertCleanHandoff({ ...handoffState, domWrites: 1 }));
  assert.throws(() => assertCleanHandoff({ ...handoffState, canvasHidden: false }));
  assert.throws(() => assertCleanHandoff({ ...handoffState, dataState: 'live' }));
  assert.throws(() => assertCleanHandoff({
    ...handoffState,
    acks: [{ schema: 'frame_ack/v0.2', outcome: 'PRESENTED' }],
  }));
});

test('R2-T4-003 and R2-T4-004 regression: non-enumerable extra keys on intent body/params and unknown ops are rejected before reaching core', async t => {
  const f = await fixture(t);
  const bindings = await createMainBindings({ ...f });
  t.after(() => bindings.core.dispose());
  const before = f.requests.length;

  const withHiddenTop = { schema: 'ui_intent/v0.2', request_id: 'r1', op: 'take_control', params: { surface_id: 's1' } };
  Object.defineProperty(withHiddenTop, 'hidden', { value: 1, enumerable: false });
  assert.throws(() => validateIntentBody(withHiddenTop), /INTENT/);

  const withHiddenParam = { schema: 'ui_intent/v0.2', request_id: 'r1', op: 'release_control', params: { surface_id: 's1' } };
  Object.defineProperty(withHiddenParam.params, 'hidden', { value: 1, enumerable: false });
  assert.throws(() => validateIntentBody(withHiddenParam), /INTENT/);

  for (const unknownOp of ['pin', 'layout_save', 'layout_load', 'unknown_op']) {
    await assert.rejects(
      bindings.core.request({ op: 'intent', json: JSON.stringify({ schema: 'ui_intent/v0.2', request_id: 'r1', op: unknownOp, params: { slot_id: 's1' } }) }),
      /CORE_SEAMS_ABSENT/,
    );
  }
  assert.equal(f.requests.length, before);
});

test('R2-T4-005 regression: swapped peer and foreign SO_PEERCRED uid are rejected before hello; unswapped peer reaches live', async t => {
  // 1. Swapped-peer fixture: swap core.sock after pre-connect lstat to an attacker listener, and restore before post-hello lstat.
  const root = await mkdtemp(join(tmpdir(), 'mv-r2t4-005-'));
  const config = { session_id: 'host-test', core: registration('core'), peers: [registration('ui')] };
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const sockPath = join(root, 'metaviewer/core.sock');
  const origSockPath = join(root, 'metaviewer/core.sock.orig');
  const attackerSockPath = join(root, 'metaviewer/attacker.sock');

  const legitSockets = new Set();
  const legitServer = createServer(socket => { legitSockets.add(socket); });
  legitServer.listen(sockPath);
  await once(legitServer, 'listening');
  await chmod(sockPath, 0o600);

  let attackerBytes = 0;
  const attackerSockets = new Set();
  const attackerServer = createServer(socket => {
    attackerSockets.add(socket);
    socket.on('data', async data => {
      attackerBytes += data.length;
      if (!data.toString().includes('\n')) return;
      await rename(origSockPath, sockPath);
      socket.write(JSON.stringify({
        schema: 'envelope/v0.2', msg_id: 'reply-1', ts_ns: 0,
        from: config.core.endpoint, to: config.peers[0].endpoint,
        session_id: config.session_id, seq: 1, nonce: 'nonce-1',
        body: config.core.hello,
      }) + '\n');
    });
  });
  attackerServer.listen(attackerSockPath);
  await once(attackerServer, 'listening');
  await chmod(attackerSockPath, 0o600);

  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const s of [...legitSockets, ...attackerSockets]) s.destroy();
    await new Promise(resolve => legitServer.close(resolve));
    await new Promise(resolve => attackerServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const origOpen = fsPromises.open;
  let swapped = false;
  t.mock.method(fsPromises, 'open', async (...args) => {
    const handle = await origOpen(...args);
    if (!swapped && String(args[0]).endsWith('/config.json')) {
      swapped = true;
      await rename(sockPath, origSockPath);
      await rename(attackerSockPath, sockPath);
    }
    return handle;
  });
  syncBuiltinESMExports();

  await assert.rejects(
    createMainBindings({
      env: { MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: root },
      createMessageChannel: () => ({ port1: { close() {} }, port2: { close() {} } }),
    }),
    /CORE_SEAMS_ABSENT/,
  );
  assert.equal(attackerBytes, 0, 'swapped peer must be refused before hello is written');

  t.mock.restoreAll();
  syncBuiltinESMExports();

  // 2. Foreign SO_PEERCRED uid is rejected before writing hello.
  const f = await fixture(t);
  await assert.rejects(
    createMainBindings({
      ...f,
      getPeerCredentials: () => ({ pid: process.pid, uid: process.getuid() + 1, gid: process.getgid() }),
    }),
    /CORE_SEAMS_ABSENT/,
  );
  assert.equal(f.requests.length, 0);

  // 3. Negative control: unswapped peer with real SO_PEERCRED reaches live and matches uid/pid/ino.
  const sockInfo = await lstat(join(f.root, 'metaviewer/core.sock'));
  let observedCred = null;
  const liveBindings = await createMainBindings({
    ...f,
    getPeerCredentials: sock => {
      observedCred = readPeerCredentials(sock);
      return observedCred;
    },
  });
  t.after(() => liveBindings.core.dispose());
  assert.equal(liveBindings.core.getStatus().availability, 'live');
  assert.equal(observedCred.uid, process.getuid());
  assert.equal(observedCred.pid, process.pid);
  assert.equal(observedCred.ino, sockInfo.ino >>> 0);
});

test('R2-T4-006 regression: destroyed and lost surfaces release map slots, channels, subscriptions and streams; 65 concurrent active surfaces fail closed', async t => {
  const f = await fixture(t);
  const closedPorts = new Set();
  const createTrackedChannel = () => {
    const ch = f.createMessageChannel();
    const origClose1 = ch.port1.close.bind(ch.port1);
    const origClose2 = ch.port2.close.bind(ch.port2);
    ch.port1.close = () => { closedPorts.add(ch.port1); origClose1(); };
    ch.port2.close = () => { closedPorts.add(ch.port2); origClose2(); };
    return ch;
  };
  const bindings = await createMainBindings({ env: f.env, createMessageChannel: createTrackedChannel });
  t.after(() => bindings.core.dispose());

  const streams = new Set();
  const notices = [];
  let resolveEntry = null;
  bindings.wire.frames.subscribe(async entry => {
    await deliverAuthorityFrame(entry, { postMessage: (...args) => notices.push(args) }, streams);
    resolveEntry?.(entry);
  });

  t.after(async () => {
    for (const stream of [...streams]) {
      await stream.reader.closeReader();
      stream.port.revokeFramePort('SHUTDOWN');
    }
  });

  // 64 create + frame + destroy/lost cycles, followed by a 65th surface create + frame.
  for (let i = 1; i <= 64; i += 1) {
    const sid = `s-cycle-${i}`;
    const terminalState = i % 2 === 0 ? 'destroyed' : 'lost';
    const createdSurface = { ...surface, surface_id: sid, state: 'active' };
    const frameDone = new Promise(resolve => { resolveEntry = resolve; });
    f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: createdSurface } });
    f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: { ...f.frame, surface_id: sid } } });
    await frameDone;

    const stateDone = new Promise(resolve => { resolveEntry = resolve; });
    f.send({ schema: 'surface_event/v0.2', event: 'state_changed', data: { surface: { ...createdSurface, state: terminalState } } });
    await stateDone;
  }

  assert.equal(closedPorts.size, 128, 'both ports of each of the 64 destroyed/lost channels must be closed');
  assert.equal(streams.size, 0, 'authorityWire streams must be cleaned up on destroyed/lost');

  // 65th surface after 64 lifecycles succeeds and stays live; re-creating s-cycle-1 also re-subscribes.
  const subCountBefore = f.requests.filter(r => r.body.schema === 'surface_request/v0.2' && r.body.op === 'frame_subscribe').length;
  assert.equal(subCountBefore, 64);

  const finalDone = new Promise(resolve => { resolveEntry = resolve; });
  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: { ...surface, surface_id: 's-cycle-65', state: 'active' } } });
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: { ...f.frame, surface_id: 's-cycle-65' } } });
  await finalDone;

  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: { ...surface, surface_id: 's-cycle-1', state: 'active' } } });
  await waitForCondition(
    () => f.requests.filter(r => r.body.schema === 'surface_request/v0.2' && r.body.op === 'frame_subscribe').length === 66,
    'recreated s-cycle-1 frame_subscribe request',
  );
  const subCountAfter = f.requests.filter(r => r.body.schema === 'surface_request/v0.2' && r.body.op === 'frame_subscribe').length;
  assert.equal(subCountAfter, 66, 'recreated surface must be subscribed again after prior destroy/lost');
  assert.equal(bindings.core.getStatus().availability, 'live');

  // Negative control: 65 concurrent active surfaces exceed MAX_ITEMS (64) and shut down the connection.
  const fCap = await fixture(t);
  const capBindings = await createMainBindings({ ...fCap });
  t.after(() => capBindings.core.dispose());
  for (let i = 1; i <= 65; i += 1) {
    fCap.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: { ...surface, surface_id: `s-active-${i}`, state: 'active' } } });
  }
  await waitForCondition(() => capBindings.core.getStatus().availability === 'unavailable', '65th active surface shutdown');
  assert.equal(capBindings.core.getStatus().availability, 'unavailable');
});

test('R2-T4-023 regression: receive validates exact envelope keys and ts_ns bounds; exact envelopes are admitted', async t => {
  const makeServerWithHelloEnvelope = async mutateEnvelope => {
    const root = await mkdtemp(join(tmpdir(), 'mv-r2t4-023-'));
    const config = { session_id: 'host-test', core: registration('core'), peers: [registration('ui')] };
    await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const sockPath = join(root, 'metaviewer/core.sock');
    const sockets = new Set();
    let activeSocket = null;
    const server = createServer(socket => {
      activeSocket = socket;
      sockets.add(socket);
      socket.on('data', data => {
        if (!data.toString().includes('\n')) return;
        const base = {
          schema: 'envelope/v0.2', msg_id: 'reply-1', ts_ns: 0,
          from: config.core.endpoint, to: config.peers[0].endpoint,
          session_id: config.session_id, seq: 1, nonce: 'nonce-1',
          body: config.core.hello,
        };
        socket.write(JSON.stringify(mutateEnvelope(base)) + '\n');
      });
    });
    server.listen(sockPath);
    await once(server, 'listening');
    await chmod(sockPath, 0o600);
    t.after(async () => {
      for (const s of sockets) s.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    return {
      env: { MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: root },
      config,
      writeRaw: obj => activeSocket?.write(JSON.stringify(obj) + '\n'),
    };
  };

  for (const mutate of [
    env => ({ ...env, extra: true }),
    env => ({ ...env, ts_ns: 'invalid' }),
    env => ({ ...env, ts_ns: -1 }),
    env => ({ ...env, ts_ns: 1.5 }),
    env => ({ ...env, ts_ns: null }),
    env => ({ ...env, ts_ns: Number.MAX_SAFE_INTEGER + 1 }),
  ]) {
    const fBad = await makeServerWithHelloEnvelope(mutate);
    await assert.rejects(
      createMainBindings({ ...fBad, createMessageChannel: () => ({ port1: { close() {} }, port2: { close() {} } }) }),
      /CORE_SEAMS_ABSENT/,
    );
  }

  // Negative control: exact envelope with boundary ts_ns = Number.MAX_SAFE_INTEGER is admitted,
  // while a post-hello envelope missing ts_ns shuts down the live connection.
  const fGood = await makeServerWithHelloEnvelope(env => ({ ...env, ts_ns: Number.MAX_SAFE_INTEGER }));
  const bindings = await createMainBindings({
    ...fGood,
    createMessageChannel: () => ({ port1: { close() {} }, port2: { close() {} } }),
  });
  t.after(() => bindings.core.dispose());
  assert.equal(bindings.core.getStatus().availability, 'live');
  fGood.writeRaw({
    schema: 'envelope/v0.2', msg_id: 'reply-2',
    from: fGood.config.core.endpoint, to: fGood.config.peers[0].endpoint,
    session_id: fGood.config.session_id, seq: 2, nonce: 'nonce-2',
    body: { schema: 'surface_event/v0.2', event: 'created', data: { surface } },
  });
  await waitForCondition(() => bindings.core.getStatus().availability === 'unavailable', 'post-hello missing ts_ns shutdown');
  assert.equal(bindings.core.getStatus().availability, 'unavailable');
});

test('EVUI-01 regression: peer auth masks 64-bit cino to 32 bits, requires integer cred.ino equality, and spawns /usr/bin/python3 with scrubbed PATH', async t => {
  const hostBindingsSource = await readFile(new URL('../electron/hostBindings.js', import.meta.url), 'utf8');
  assert.match(
    hostBindingsSource,
    /cino\s*=\s*os\.fstat\(3\)\.st_ino\s*&\s*0xffffffff/i,
    'EVUI-01: PEERCRED_PY must mask cino to 32 bits (& 0xffffffff)',
  );
  assert.match(
    hostBindingsSource,
    /spawnSync\(['"]\/usr\/bin\/python3['"][\s\S]*?env:\s*\{\s*PATH:\s*['"]\/usr\/bin:\/bin['"]\s*\}/,
    'EVUI-01: readPeerCredentials must spawn /usr/bin/python3 with scrubbed env {PATH: "/usr/bin:/bin"}',
  );

  // Undefined or non-integer cred.ino must fail closed (refuse before hello).
  for (const badCred of [
    { pid: process.pid, uid: process.getuid(), gid: process.getgid() },
    { pid: process.pid, uid: process.getuid(), gid: process.getgid(), ino: undefined },
    { pid: process.pid, uid: process.getuid(), gid: process.getgid(), ino: null },
    { pid: process.pid, uid: process.getuid(), gid: process.getgid(), ino: '123' },
    { pid: process.pid, uid: process.getuid(), gid: process.getgid(), ino: 1.5 },
  ]) {
    const fBad = await fixture(t);
    await assert.rejects(
      createMainBindings({
        ...fBad,
        getPeerCredentials: () => badCred,
      }),
      /CORE_SEAMS_ABSENT/,
    );
    assert.equal(fBad.requests.length, 0, 'undefined/non-integer cred.ino must be refused before hello');
  }

  // Unit-test 32-bit mask with high inode (2**32 + low32): matching low 32 bits admitted, mismatched low 32 bits refused.
  const fMask = await fixture(t);
  const sockStat = await lstat(join(fMask.root, 'metaviewer/core.sock'));
  const highInoMatching = 2 ** 32 + (sockStat.ino >>> 0);
  const bindingsHigh = await createMainBindings({
    ...fMask,
    getPeerCredentials: () => ({
      pid: process.pid,
      uid: process.getuid(),
      gid: process.getgid(),
      ino: highInoMatching,
    }),
  });
  t.after(() => bindingsHigh.core.dispose());
  assert.equal(bindingsHigh.core.getStatus().availability, 'live');

  const fMismatch = await fixture(t);
  const mismatchStat = await lstat(join(fMismatch.root, 'metaviewer/core.sock'));
  await assert.rejects(
    createMainBindings({
      ...fMismatch,
      getPeerCredentials: () => ({
        pid: process.pid,
        uid: process.getuid(),
        gid: process.getgid(),
        ino: 2 ** 32 + (((mismatchStat.ino >>> 0) + 1) >>> 0),
      }),
    }),
    /CORE_SEAMS_ABSENT/,
  );

  // Poisoned ambient PATH must not hijack readPeerCredentials.
  const fPath = await fixture(t);
  const poisonedBin = await mkdtemp(join(tmpdir(), 'mv-poison-py-'));
  t.after(() => rm(poisonedBin, { recursive: true, force: true }));
  const fakePy = join(poisonedBin, 'python3');
  await writeFile(fakePy, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${poisonedBin}:${prevPath ?? ''}`;
  try {
    const liveWithPoisonedPath = await createMainBindings({
      ...fPath,
      env: { ...fPath.env, PATH: `${poisonedBin}:${prevPath ?? ''}` },
    });
    t.after(() => liveWithPoisonedPath.core.dispose());
    assert.equal(liveWithPoisonedPath.core.getStatus().availability, 'live');
  } finally {
    process.env.PATH = prevPath;
  }
});


test('W2-HOST-L2 L2-1 and L2-8 regression: valid hide/show/control/fold intents resolve literal true while local multislot view/mode toggles are refused; frame_ref dimensions remain constant across deliveries', async t => {
  const f = await fixture(t);
  const handlers = new Map();
  const bindings = await loadMainBindings(f.env, { createMessageChannel: f.createMessageChannel });
  t.after(() => bindings.core.dispose());
  const shell = join(f.root, 'shell');
  await mkdir(join(shell, 'dist/renderer'), { recursive: true });
  await mkdir(join(shell, 'dist/preload'), { recursive: true });
  await writeFile(join(shell, 'dist/renderer/index.html'), '<!doctype html><title>host l2 test</title>');
  await writeFile(join(shell, 'dist/preload/preload.cjs'), '');
  const session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const notices = [];
  let onNotice = () => {};
  const contents = {
    id: 31,
    mainFrame: frame,
    session,
    isDestroyed: () => false,
    setWindowOpenHandler() {},
    on() {},
    loadURL: async () => {},
    postMessage: (...args) => { notices.push(args); onNotice(args); },
  };
  class Window {
    constructor() { this.webContents = contents; }
    once() {} on() {} show() {} destroy() {} isDestroyed() { return false; }
  }
  const booted = await bootProductionMain({
    ...bindings,
    app: { requestSingleInstanceLock: () => true, whenReady: async () => {}, on() {}, quit() {}, getAppPath: () => shell, getPath: () => join(f.root, 'user') },
    BrowserWindow: Window,
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    protocol: { registerSchemesAsPrivileged() {}, handle() {}, unhandle() {} },
    session: { defaultSession: session },
    electronVersion: ELECTRON_PIN,
    shellRoot: shell,
    argv: ['metaviewer'],
    env: f.env,
    runtime: { xdgRuntimeDir: f.root, uid: process.getuid() },
    geometry: { width: 1280, height: 720 },
    bridge: [CHANNELS.load, CHANNELS.save].map(channel => ({ channel, decode: value => value, invoke: async () => null })),
  });
  t.after(() => booted.dispose());

  const api = installPreload({
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: {
      invoke: (channel, ...args) => handlers.get(channel)({ sender: contents, senderFrame: frame }, ...args),
      on() {},
      removeListener() {},
    },
  });

  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface } });

  // 1. L2-1: valid ui_intent/v0.2 bodies for hide, show, fold/unfold (with cuk-ai-slot-<id>) and control handoff
  // (take_control / release_control) resolve with literal true across hostBindings, authorityWire and preload.
  const admittedIntents = [
    { schema: 'ui_intent/v0.2', request_id: 'l2-1-take', op: 'take_control', params: { surface_id: 's1' } },
    { schema: 'ui_intent/v0.2', request_id: 'l2-1-hide', op: 'hide', params: { slot_id: 'cuk-ai-slot-s1' } },
    { schema: 'ui_intent/v0.2', request_id: 'l2-1-show', op: 'show', params: { slot_id: 'cuk-ai-slot-s1' } },
    { schema: 'ui_intent/v0.2', request_id: 'l2-1-fold', op: 'fold', params: { slot_id: 'cuk-ai-slot-s1' } },
    { schema: 'ui_intent/v0.2', request_id: 'l2-1-unfold', op: 'unfold', params: { slot_id: 'cuk-ai-slot-s1' } },
    { schema: 'ui_intent/v0.2', request_id: 'l2-1-release', op: 'release_control', params: { surface_id: 's1' } },
  ];
  for (const body of admittedIntents) {
    const reply = await api.authority.intent(JSON.stringify(body));
    assert.strictEqual(reply, true, `expected literal true for ${body.op}`);
    assert.deepEqual(f.requests.filter(r => r.body.schema === 'ui_intent/v0.2').at(-1)?.body, body);
  }

  // 2. L2-1 reproduction: the three local multislot control-bar toggle payloads ('hide-surface', 'show-surface',
  // 'input-mode-write' for READ->WRITE) are not ui_intent/v0.2 or action_proposal/v0.2 operations; when the
  // renderer forwards them to authority.propose or authority.intent, the host refuses them before core socket send.
  const reqCountBeforeLocal = f.requests.length;
  const localMultislotRequests = [
    { type: 'hide-surface', capsuleId: 's1' },
    { type: 'show-surface', capsuleId: 's1' },
    { type: 'input-mode-write', capsuleId: 's1', mode: 'write' },
  ];
  for (const localPayload of localMultislotRequests) {
    await assert.rejects(
      api.authority.propose(JSON.stringify(localPayload)),
      /PROPOSAL/,
    );
    await assert.rejects(
      api.authority.intent(JSON.stringify(localPayload)),
      /INTENT/,
    );
    const wrappedAsUiIntent = {
      schema: 'ui_intent/v0.2',
      request_id: `l2-1-${localPayload.type}`,
      op: localPayload.type,
      params: { slot_id: 'cuk-ai-slot-s1' },
    };
    await assert.rejects(
      api.authority.intent(JSON.stringify(wrappedAsUiIntent)),
      /INTENT/,
    );
    await assert.rejects(
      bindings.core.request({ op: 'intent', json: JSON.stringify(wrappedAsUiIntent) }),
      /CORE_SEAMS_ABSENT/,
    );
  }
  assert.equal(f.requests.length, reqCountBeforeLocal, 'unadmitted local multislot toggles must never reach core');

  // 3. L2-8: consecutive frame deliveries for the same surface preserve constant frame_ref width/height,
  // surface geometry, and MessagePort frame_delivery/v0.2 width/height.
  await handlers.get(WIRE_CHANNELS.subscribeFrames)({ sender: contents, senderFrame: frame });
  for (let gen = 1; gen <= 3; gen += 1) {
    const delivered = new Promise(resolve => { onNotice = resolve; });
    f.send({
      schema: 'surface_event/v0.2',
      event: 'frame_ready',
      data: { frame_ref: { ...f.frame, generation: gen, tick: gen, ts_ns: gen } },
    });
    const [, notice] = await delivered;
    assert.equal(notice.frame_ref.width, f.frame.width);
    assert.equal(notice.frame_ref.height, f.frame.height);
    assert.deepEqual(notice.surface.geometry, surface.geometry);
    const portMsg = f.messages.at(-1);
    assert.equal(portMsg.width, f.frame.width);
    assert.equal(portMsg.height, f.frame.height);
    assert.equal(portMsg.bytes.byteLength, f.frame.width * f.frame.height * 3);
    f.channels[0].port1.emit('message', {
      schema: 'frame_ack/v0.2',
      kind: 'ack',
      correlation: portMsg.correlation,
      principal: portMsg.principal,
      epoch: portMsg.epoch,
      surfaceId: portMsg.surfaceId,
      surfaceGeneration: portMsg.surfaceGeneration,
      frameGeneration: portMsg.frameGeneration,
      leaseId: portMsg.leaseId,
      outcome: 'PRESENTED',
    });
  }
});

test('R7 regression: tampered frame file yields DIGEST_MISMATCH with one release, mid-flight truncation yields SIZE_MISMATCH or IO_ERROR without moving the accepted floor, and valid bytes still verify', async t => {
  const f = await fixture(t);
  const bindings = await createMainBindings({ ...f });
  t.after(() => bindings.core.dispose());

  let nextEntryResolve = null;
  bindings.wire.frames.subscribe(entry => {
    nextEntryResolve?.(entry);
  });
  const nextEntry = () => new Promise(resolve => {
    nextEntryResolve = resolve;
  });

  const streams = new Set();
  const notices = [];
  const contents = { postMessage: (...args) => notices.push(args) };
  const readerRefusals = [];
  const deliveries = [];
  const frameDiag = {
    recordReaderRefusal: info => readerRefusals.push(info),
    recordDelivery: info => deliveries.push(info),
  };
  t.after(async () => {
    for (const stream of [...streams]) {
      await stream.reader.closeReader();
      stream.port.revokeFramePort('SHUTDOWN');
    }
  });

  const releaseCalls = [];
  const dropNotifications = [];
  let beforeReadHook = null;
  const instrumentEntry = entry => {
    const origAcquire = entry.readerOptions.acquirePublishedLease;
    const origOnRelease = entry.readerOptions.onReleaseLease;
    return {
      ...entry,
      readerOptions: {
        ...entry.readerOptions,
        onReleaseLease: notice => {
          dropNotifications.push(notice);
          origOnRelease(notice);
        },
        acquirePublishedLease: async req => {
          const lease = await origAcquire(req);
          const origRelease = lease.release;
          const origRead = lease.readOwnedBytes;
          let count = 0;
          const record = { frameGeneration: lease.identity.frameGeneration, count: 0, reasons: [] };
          releaseCalls.push(record);
          return {
            ...lease,
            readOwnedBytes: async opts => {
              if (beforeReadHook) {
                const hook = beforeReadHook;
                beforeReadHook = null;
                await hook();
              }
              return origRead(opts);
            },
            release: async arg => {
              count += 1;
              record.count = count;
              record.reasons.push(arg?.reason);
              return origRelease(arg);
            },
          };
        },
      },
    };
  };

  // Negative control (Goal 3): unmodified valid-bytes delivery (generation 1) verifies first in the same run.
  const entry1Promise = nextEntry();
  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface } });
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f.frame } });
  const entry1 = instrumentEntry(await entry1Promise);
  assert.equal(await deliverAuthorityFrame(entry1, contents, streams, frameDiag), true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].frameGeneration, 1);
  assert.equal(readerRefusals.length, 0);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].count, 1);
  assert.deepEqual(releaseCalls[0].reasons, ['SNAPSHOT_VERIFIED']);
  assert.equal(dropNotifications.length, 0);

  // ACK generation 1 so the sender port is ready for the next verified frame.
  const firstMsg = f.messages[0];
  f.channels[0].port1.emit('message', {
    schema: 'frame_ack/v0.2',
    kind: 'ack',
    correlation: firstMsg.correlation,
    principal: firstMsg.principal,
    epoch: firstMsg.epoch,
    surfaceId: firstMsg.surfaceId,
    surfaceGeneration: firstMsg.surfaceGeneration,
    frameGeneration: firstMsg.frameGeneration,
    leaseId: firstMsg.leaseId,
    outcome: 'PRESENTED',
  });

  // Goal 1: publish generation 2 whose RAM file bytes differ from the declared sha256 digest.
  const tamperedBytes = Buffer.from([9, 8, 7]);
  const declaredBytes = Buffer.from([4, 5, 6]);
  const declaredSha = createHash('sha256').update(declaredBytes).digest('hex');
  await writeFile(f.frame.ramws_path, tamperedBytes, { mode: 0o600 });
  const entry2BadDigestPromise = nextEntry();
  f.send({
    schema: 'surface_event/v0.2',
    event: 'frame_ready',
    data: { frame_ref: { ...f.frame, generation: 2, tick: 2, ts_ns: 2, sha256: declaredSha } },
  });
  const entry2BadDigest = instrumentEntry(await entry2BadDigestPromise);
  assert.equal(await deliverAuthorityFrame(entry2BadDigest, contents, streams, frameDiag), false);
  assert.equal(readerRefusals.length, 1);
  assert.equal(readerRefusals[0].reason, 'DIGEST_MISMATCH');
  assert.equal(readerRefusals[0].frameGeneration, 2);
  assert.equal(releaseCalls.length, 2);
  assert.equal(releaseCalls[1].count, 1, 'tampered frame lease must be released exactly once');
  assert.deepEqual(releaseCalls[1].reasons, ['DIGEST_MISMATCH']);
  assert.equal(dropNotifications.length, 1);
  assert.equal(dropNotifications[0].reason, 'DIGEST_MISMATCH');
  assert.equal(dropNotifications[0].frameGeneration, 2);

  // Goal 2a: truncate the RAM file before stat (1 byte instead of 3) -> SIZE_MISMATCH and one release.
  await writeFile(f.frame.ramws_path, Buffer.from([4]), { mode: 0o600 });
  const entry3TruncatedStatPromise = nextEntry();
  f.send({
    schema: 'surface_event/v0.2',
    event: 'frame_ready',
    data: { frame_ref: { ...f.frame, generation: 3, tick: 3, ts_ns: 3, sha256: declaredSha } },
  });
  const entry3TruncatedStat = instrumentEntry(await entry3TruncatedStatPromise);
  assert.equal(await deliverAuthorityFrame(entry3TruncatedStat, contents, streams, frameDiag), false);
  assert.equal(readerRefusals.length, 2);
  assert.equal(readerRefusals[1].reason, 'SIZE_MISMATCH');
  assert.equal(releaseCalls.length, 3);
  assert.equal(releaseCalls[2].count, 1, 'size-mismatched lease must be released exactly once');
  assert.deepEqual(releaseCalls[2].reasons, ['SIZE_MISMATCH']);
  assert.equal(dropNotifications.length, 2);
  assert.equal(dropNotifications[1].reason, 'SIZE_MISMATCH');

  // Goal 2b: truncate the RAM file mid-flight (after acquirePublishedLease stat sees 3 bytes, before readOwnedBytes reads) -> IO_ERROR and one release.
  await writeFile(f.frame.ramws_path, declaredBytes, { mode: 0o600 });
  beforeReadHook = async () => {
    await writeFile(f.frame.ramws_path, Buffer.from([4]), { mode: 0o600 });
  };
  const entry4MidFlightPromise = nextEntry();
  f.send({
    schema: 'surface_event/v0.2',
    event: 'frame_ready',
    data: { frame_ref: { ...f.frame, generation: 4, tick: 4, ts_ns: 4, sha256: declaredSha } },
  });
  const entry4MidFlight = instrumentEntry(await entry4MidFlightPromise);
  assert.equal(await deliverAuthorityFrame(entry4MidFlight, contents, streams, frameDiag), false);
  assert.equal(readerRefusals.length, 3);
  assert.ok(
    ['SIZE_MISMATCH', 'IO_ERROR'].includes(readerRefusals[2].reason),
    `expected SIZE_MISMATCH or IO_ERROR on mid-flight truncation, got ${readerRefusals[2].reason}`,
  );
  assert.equal(releaseCalls.length, 4);
  assert.equal(releaseCalls[3].count, 1, 'mid-flight truncated lease must be released exactly once');
  assert.equal(dropNotifications.length, 3);
  assert.equal(dropNotifications[2].reason, readerRefusals[2].reason);

  // Floor unmoved proof: because generations 2, 3, and 4 were all refused without advancing lastAccepted (still 1),
  // publishing generation 2 with valid bytes matching declaredSha verifies and delivers cleanly!
  await writeFile(f.frame.ramws_path, declaredBytes, { mode: 0o600 });
  const entry2ValidPromise = nextEntry();
  f.send({
    schema: 'surface_event/v0.2',
    event: 'frame_ready',
    data: { frame_ref: { ...f.frame, generation: 2, tick: 5, ts_ns: 5, sha256: declaredSha } },
  });
  const entry2Valid = instrumentEntry(await entry2ValidPromise);
  assert.equal(await deliverAuthorityFrame(entry2Valid, contents, streams, frameDiag), true);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].frameGeneration, 2);
  assert.deepEqual(Array.from(f.messages.at(-1).bytes), [4, 5, 6]);
  assert.equal(releaseCalls.length, 5);
  assert.equal(releaseCalls[4].count, 1);
  assert.deepEqual(releaseCalls[4].reasons, ['SNAPSHOT_VERIFIED']);
});

test('RV10-04: consecutive intent timeouts separated only by frame traffic shut down', async t => {
  const makeSilenceableServer = async () => {
    const root = await mkdtemp(join(tmpdir(), 'mv-rv10-04-'));
    const ram = await mkdtemp('/dev/shm/mv-rv10-04-');
    const config = { session_id: 'host-test', core: registration('core'), peers: [registration('ui')] };
    await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const bytes = Buffer.from([1, 2, 3]);
    const path = join(ram, 'frame.rgb');
    await writeFile(path, bytes, { mode: 0o600 });
    const frame = {
      schema: 'frame_ref/v0.2',
      surface_id: 's1',
      generation: 1,
      tick: 1,
      ts_ns: 1,
      width: 1,
      height: 1,
      format: 'rgb24',
      ramws_path: path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      capture_us: 1,
    };
    const sockets = new Set();
    const requests = [];
    let peer = null;
    let seq = 0;
    let dropIntents = true;
    const send = body =>
      peer.write(
        JSON.stringify({
          schema: 'envelope/v0.2',
          msg_id: 'reply-' + ++seq,
          ts_ns: seq,
          from: config.core.endpoint,
          to: config.peers[0].endpoint,
          session_id: config.session_id,
          seq,
          nonce: 'nonce-' + seq,
          body,
        }) + '\n',
      );
    const server = createServer(socket => {
      peer = socket;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', data => {
        buffer += data;
        let offset;
        while ((offset = buffer.indexOf('\n')) >= 0) {
          const env = JSON.parse(buffer.slice(0, offset));
          buffer = buffer.slice(offset + 1);
          requests.push(env);
          if (env.body.schema === 'hello/v0.2') {
            send(config.core.hello);
          } else if (env.body.schema === 'ui_intent/v0.2' && !dropIntents) {
            send({
              schema: 'surface_event/v0.2',
              event: 'state_changed',
              data: { surface: { ...surface, control: env.body.op === 'take_control' ? 'human' : 'agent' } },
            });
          } else if (env.body.schema === 'action_proposal/v0.2') {
            send({
              schema: 'action_verdict/v0.2',
              proposal_id: env.body.proposal_id,
              decision: 'refused',
              reason_code: 'POLICY',
              core_seq: 1,
            });
          } else if (env.body.schema === 'surface_request/v0.2' && env.body.op === 'input') {
            const refuseInput = env.body.params?.surface_id === 's-refuse';
            send({
              schema: 'action_verdict/v0.2',
              proposal_id: env.body.params?.proposal_id,
              decision: refuseInput ? 'refused' : 'admitted',
              ...(refuseInput ? { reason_code: 'SURFACE_NOT_HUMAN_CONTROLLED' } : {}),
              core_seq: 2,
            });
          }
        }
      });
    });
    server.listen(join(root, 'metaviewer/core.sock'));
    await once(server, 'listening');
    await chmod(join(root, 'metaviewer/core.sock'), 0o600);
    t.after(async () => {
      for (const s of sockets) s.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
      await rm(ram, { recursive: true, force: true });
    });
    return {
      env: { MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: root },
      frame,
      requests,
      send,
      setDropIntents: v => {
        dropIntents = v;
      },
      createMessageChannel: () => ({
        port1: Object.assign(new EventEmitter(), { postMessage() {}, start() {}, close() {} }),
        port2: { close() {} },
      }),
    };
  };

  await Promise.all([
    (async () => {
      const f = await makeSilenceableServer();
      const bindings = await createMainBindings({ ...f });
      t.after(() => bindings.core.dispose());
      let shutdownBranchFrameEntry = null;
      bindings.wire.frames.subscribe(entry => {
        if (!entry.stateOnly) shutdownBranchFrameEntry = entry;
      });

      f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: { ...surface, control: 'human' } } });
      await waitForCondition(
        () => f.requests.some(r => r.body.schema === 'surface_request/v0.2' && r.body.op === 'frame_subscribe' && r.body.params?.surface_id === 's1'),
        'shutdown branch initial created event and frame_subscribe',
      );

      // 1st intent timeout on an active session is spared.
      await assert.rejects(
        bindings.core.request({
          op: 'intent',
          json: JSON.stringify({ schema: 'ui_intent/v0.2', request_id: 'rv10-04-t1', op: 'take_control', params: { surface_id: 's1' } }),
        }),
        /^Error: CORE_TIMEOUT$/,
      );
      assert.equal(bindings.core.getStatus().availability, 'live', 'first intent timeout must be spared');

      // Intervening frame_ready, action_proposal verdicts, and surface_input admissions/refusals
      // advance global received counter, but must NOT advance intent-reply progress (R3-T4-005).
      f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f.frame } });
      const propReply = await bindings.core.request({
        op: 'propose',
        json: JSON.stringify({
          schema: 'action_proposal/v0.2',
          proposal_id: 'r3-005-prop',
          surface_id: 's1',
          based_on_frame: { generation: 1, sha256: 'a'.repeat(64) },
          action: { type: 'click', x: 1, y: 1, button: 'left' },
          expectation: { type: 'state_sha256_change' },
          budget: { max_ms: 500, max_retries: 0 },
        }),
      });
      assert.equal(propReply.decision, 'refused');
      const admitInput = await bindings.core.request({
        op: 'input',
        batch: {
          schema: 'surface_input/v1',
          surface_id: 's1',
          stream_id: 1,
          seq: 1,
          events: [{ kind: 'key', keys: ['a'] }],
        },
      });
      assert.deepEqual(admitInput, { ok: true, accepted: 1 });
      const refuseInput = await bindings.core.request({
        op: 'input',
        batch: {
          schema: 'surface_input/v1',
          surface_id: 's-refuse',
          stream_id: 1,
          seq: 1,
          events: [{ kind: 'key', keys: ['a'] }],
        },
      });
      assert.equal(refuseInput.ok, false);
      await waitForCondition(
        () => shutdownBranchFrameEntry !== null,
        'shutdown branch intervening frame_ready entry',
      );
      assert.ok(shutdownBranchFrameEntry);

      // 2nd consecutive intent timeout without a matched intent reply must shut down.
      await assert.rejects(
        bindings.core.request({
          op: 'intent',
          json: JSON.stringify({ schema: 'ui_intent/v0.2', request_id: 'rv10-04-t2', op: 'take_control', params: { surface_id: 's1' } }),
        }),
        /^Error: CORE_TIMEOUT$/,
      );
      assert.equal(
        bindings.core.getStatus().availability,
        'unavailable',
        'second consecutive intent timeout separated only by frame_ready traffic must shut down',
      );
    })(),
    (async () => {
      // Recovery control: when a matched intent reply arrives after a spared timeout, a subsequent single timeout is spared again.
      const fRecover = await makeSilenceableServer();
      const bindingsRecover = await createMainBindings({ ...fRecover });
      t.after(() => bindingsRecover.core.dispose());
      let frameEntry = null;
      let destroyedStateEntry = null;
      bindingsRecover.wire.frames.subscribe(entry => {
        if (!entry.stateOnly) frameEntry = entry;
        else if (entry.state?.state === 'destroyed') destroyedStateEntry = entry;
      });
      fRecover.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface } });
      fRecover.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: fRecover.frame } });
      await waitForCondition(() => frameEntry !== null, 'recovery control initial frame_ready entry');
      assert.ok(frameEntry);
      assert.equal(frameEntry.resolveLatestState()?.state, 'active');

      await assert.rejects(
        bindingsRecover.core.request({
          op: 'intent',
          json: JSON.stringify({ schema: 'ui_intent/v0.2', request_id: 'rv10-04-r1', op: 'take_control', params: { surface_id: 's1' } }),
        }),
        /^Error: CORE_TIMEOUT$/,
      );
      assert.equal(bindingsRecover.core.getStatus().availability, 'live');

      fRecover.setDropIntents(false);
      assert.equal(
        await bindingsRecover.core.request({
          op: 'intent',
          json: JSON.stringify({ schema: 'ui_intent/v0.2', request_id: 'rv10-04-ok', op: 'take_control', params: { surface_id: 's1' } }),
        }),
        true,
      );

      fRecover.setDropIntents(true);
      await assert.rejects(
        bindingsRecover.core.request({
          op: 'intent',
          json: JSON.stringify({ schema: 'ui_intent/v0.2', request_id: 'rv10-04-r2', op: 'release_control', params: { surface_id: 's1' } }),
        }),
        /^Error: CORE_TIMEOUT$/,
      );
      assert.equal(bindingsRecover.core.getStatus().availability, 'live', 'timeout after matched intent reply must be spared');

      // RV10-01 hostBindings check: once surface is destroyed, frameEntry.resolveLatestState() returns null instead of stale active fallback.
      fRecover.send({
        schema: 'surface_event/v0.2',
        event: 'state_changed',
        data: { surface: { ...surface, state: 'destroyed' } },
      });
      await waitForCondition(
        () => destroyedStateEntry !== null && frameEntry.resolveLatestState() === null,
        'recovery control destroyed state_changed propagation',
      );
      assert.equal(frameEntry.resolveLatestState(), null, 'resolveLatestState must return null once surface is absent');
    })(),
  ]);
});

test('R3-ELECTRON-2 (tg6_electron#2): post-hello core.sock inode swap is refused with CORE_SEAMS_ABSENT and disposes client; unswapped reaches live', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mv-s-'));
  const config = { session_id: 'host-test', core: registration('core'), peers: [registration('ui')] };
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const sockPath = join(root, 'metaviewer/core.sock');
  const origSockPath = join(root, 'metaviewer/orig.sock');
  const replacementSockPath = join(root, 'metaviewer/next.sock');

  const legitSockets = new Set();
  const replacementSockets = new Set();
  let helloReceived = false;
  let swapPromise = null;
  let resolveHelloReplyEmitted;
  const helloReplyEmitted = new Promise(resolve => {
    resolveHelloReplyEmitted = resolve;
  });

  const legitServer = createServer(socket => {
    legitSockets.add(socket);
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const env = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (env.body?.schema === 'hello/v0.2') {
        helloReceived = true;
        socket.write(
          JSON.stringify({
            schema: 'envelope/v0.2',
            msg_id: 'reply-1',
            ts_ns: 0,
            from: config.core.endpoint,
            to: config.peers[0].endpoint,
            session_id: config.session_id,
            seq: 1,
            nonce: 'nonce-1',
            body: config.core.hello,
          }) + '\n',
        );
        swapPromise = (async () => {
          await rename(sockPath, origSockPath);
          await rename(replacementSockPath, sockPath);
        })();
        resolveHelloReplyEmitted();
      }
    });
  });
  legitServer.listen(sockPath);
  await once(legitServer, 'listening');
  await chmod(sockPath, 0o600);

  const replacementServer = createServer(socket => {
    replacementSockets.add(socket);
  });
  replacementServer.listen(replacementSockPath);
  await once(replacementServer, 'listening');
  await chmod(replacementSockPath, 0o600);

  const origInfo = await lstat(sockPath);
  const replacementInfo = await lstat(replacementSockPath);
  assert.notEqual(origInfo.ino, replacementInfo.ino);

  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const s of [...legitSockets, ...replacementSockets]) s.destroy();
    await new Promise(resolve => legitServer.close(resolve));
    await new Promise(resolve => replacementServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const origConnect = net.createConnection;
  const origLstat = fsPromises.lstat;
  let clientSocket = null;
  let socketStatCalls = 0;
  t.mock.method(net, 'createConnection', (...args) => {
    clientSocket = origConnect(...args);
    return clientSocket;
  });
  t.mock.method(fsPromises, 'lstat', async (...args) => {
    if (args[0] === sockPath && ++socketStatCalls === 2) {
      await helloReplyEmitted;
      await swapPromise;
    }
    return origLstat(...args);
  });
  syncBuiltinESMExports();

  await assert.rejects(
    createMainBindings({
      env: { MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: root },
      createMessageChannel: () => ({ port1: { close() {} }, port2: { close() {} } }),
    }),
    /CORE_SEAMS_ABSENT/,
  );

  assert.equal(helloReceived, true, 'client must pass pre-hello peer check and send hello before post-hello lstat');
  assert.equal(socketStatCalls, 2, 'post-hello lstat on core.sock must be reached');
  assert.ok(clientSocket, 'client socket must have been created');
  if (!clientSocket.destroyed) {
    await once(clientSocket, 'close');
  }
  assert.equal(clientSocket.destroyed, true, 'post-hello socket swap refusal must dispose the client connection');
  const swappedDiskInfo = await origLstat(sockPath);
  assert.equal(swappedDiskInfo.ino, replacementInfo.ino);
  assert.equal(replacementSockets.size, 0, 'replacement listener must never receive the initial connection');

  t.mock.restoreAll();
  syncBuiltinESMExports();

  // Post-hello mode change on the same socket inode (0o600 -> 0o660 after hello reply) is also refused and disposes client.
  const modeRoot = await mkdtemp(join(tmpdir(), 'mv-m-'));
  await mkdir(join(modeRoot, 'metaviewer'), { mode: 0o700 });
  const modeConfigPath = join(modeRoot, 'config.json');
  await writeFile(modeConfigPath, JSON.stringify(config), { mode: 0o600 });
  const modeSockPath = join(modeRoot, 'metaviewer/core.sock');
  let modeChmodPromise = null;
  let resolveModeHello;
  const modeHelloEmitted = new Promise(resolve => {
    resolveModeHello = resolve;
  });
  const modeServer = createServer(socket => {
    legitSockets.add(socket);
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const env = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (env.body?.schema === 'hello/v0.2') {
        socket.write(
          JSON.stringify({
            schema: 'envelope/v0.2',
            msg_id: 'reply-1',
            ts_ns: 0,
            from: config.core.endpoint,
            to: config.peers[0].endpoint,
            session_id: config.session_id,
            seq: 1,
            nonce: 'nonce-1',
            body: config.core.hello,
          }) + '\n',
        );
        modeChmodPromise = chmod(modeSockPath, 0o660);
        resolveModeHello();
      }
    });
  });
  modeServer.listen(modeSockPath);
  await once(modeServer, 'listening');
  await chmod(modeSockPath, 0o600);
  t.after(async () => {
    await new Promise(resolve => modeServer.close(resolve));
    await rm(modeRoot, { recursive: true, force: true });
  });

  let modeStatCalls = 0;
  let modeClientSocket = null;
  t.mock.method(net, 'createConnection', (...args) => {
    modeClientSocket = origConnect(...args);
    return modeClientSocket;
  });
  t.mock.method(fsPromises, 'lstat', async (...args) => {
    if (args[0] === modeSockPath && ++modeStatCalls === 2) {
      await modeHelloEmitted;
      await modeChmodPromise;
    }
    return origLstat(...args);
  });
  syncBuiltinESMExports();

  await assert.rejects(
    createMainBindings({
      env: { MV_CORE_CONFIG: modeConfigPath, XDG_RUNTIME_DIR: modeRoot },
      createMessageChannel: () => ({ port1: { close() {} }, port2: { close() {} } }),
    }),
    /CORE_SEAMS_ABSENT/,
  );
  assert.equal(modeStatCalls, 2);
  if (!modeClientSocket.destroyed) {
    await once(modeClientSocket, 'close');
  }
  assert.equal(modeClientSocket.destroyed, true);

  t.mock.restoreAll();
  syncBuiltinESMExports();

  // Negative control: unswapped core.sock reaches live state cleanly.
  const f = await fixture(t);
  const liveBindings = await createMainBindings({ ...f });
  t.after(() => liveBindings.core.dispose());
  assert.equal(liveBindings.core.getStatus().availability, 'live');
});



test('POLISH-2 closed create reaches socket and admits the following real frame', async t => {
  const f = await fixture(t);
  const bindings = await loadMainBindings(f.env, {createMessageChannel:f.createMessageChannel});
  t.after(() => bindings.core.dispose());
  const body = {schema:'surface_request/v0.2',op:'create',params:{kind:'browser',geometry:{w:1,h:1},profile_id:'test'}};
  const before = f.requests.length;
  for (const bad of [ {...body, extra:true}, {...body,op:'destroy'}, {...body,params:{...body.params,geometry:{w:0,h:1}}}, {...body,params:{...body.params,profile_id:'../bad'}} ]) {
    await assert.rejects(bindings.core.request(bad), /SURFACE_CREATE_INVALID/);
  }
  assert.equal(f.requests.length, before);
  const pending = bindings.core.request(body);
  await waitForCondition(() => f.requests.some(e => e.body.op === 'create'));
  assert.deepEqual(f.requests.find(e => e.body.op === 'create').body, body);
  const frame = new Promise(resolve => bindings.wire.frames.subscribe(resolve));
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  assert.equal((await pending).event,'created');
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  const entry = await frame;
  assert.ok(entry);
});
