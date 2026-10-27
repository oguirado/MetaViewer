import test from 'node:test';
import assert from 'node:assert/strict';
import net, { createServer } from 'node:net';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, mkdir, chmod, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMainBindings, INTENT_OPS as HOST_INTENT_OPS } from '../electron/hostBindings.js';
import { loadMainBindings, bootProductionMain, ELECTRON_PIN, CHANNELS } from '../electron/main.js';
import { deliverAuthorityFrame, WIRE_CHANNELS, INTENT_OPS as WIRE_INTENT_OPS, validateIntentBody } from '../electron/authorityWire.js';
import { installPreload } from '../electron/preload.js';

const surface = {schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'agent',profile_id:'test'};
const registration = component => ({endpoint:{component,instance:component+'-test'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});
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
    const verdict=await bindings.core.request({op:'propose',json:JSON.stringify({schema:'action_proposal/v0.2',proposal_id:'p'})});
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
  await new Promise(resolve => setTimeout(resolve, 20));
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

test('W2-REALAPP regression: preload wall port consumer paints surface canvas and ACKs frame_delivery', async t => {
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let putImage = null;
  const attrs = new Map([['data-state', 'connecting']]);
  const canvas = {
    width: 0,
    height: 0,
    hidden: true,
    removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
    getContext(kind) {
      assert.equal(kind, '2d');
      return {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: img => { putImage = img; },
      };
    },
  };
  const waiting = { hidden: false, style: { display: '' } };
  const section = {
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: k => attrs.get(k),
    querySelector: sel => (sel === 'canvas.mv-surface__canvas' ? canvas : sel === '.mv-surface__waiting' ? waiting : null),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'app://metaviewer' }, postMessage() {} },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: id => (id === 'metaviewer-app' ? {} : id === 'mv-surface-canvas-s1' ? section : null),
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
  t.after(api.authority.subscribeFrames(v => seen.push(v)));

  const acks = [];
  const port2 = new EventEmitter();
  port2.postMessage = msg => acks.push(msg);
  port2.start = () => {};
  port2.close = () => {};

  const sha = createHash('sha256').update(Buffer.from([10, 20, 30])).digest('hex');
  ipcListener(
    { ports: [port2] },
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

  assert.equal(acks.length, 1);
  assert.equal(acks[0].schema, 'frame_ack/v0.2');
  assert.equal(acks[0].outcome, 'PRESENTED');
  assert.equal(acks[0].frameGeneration, 1);
  assert.equal(canvas.hidden, false);
  assert.equal(waiting.hidden, true);
  assert.equal(waiting.style.display, 'none');
  assert.equal(attrs.get('data-state'), 'live');
  assert.equal(attrs.get('data-frame'), sha);
  assert.deepEqual([...putImage.data], [10, 20, 30, 255]);
});
