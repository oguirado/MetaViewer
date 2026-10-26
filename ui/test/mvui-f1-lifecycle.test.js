import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as gate from '../src/multislot/multislotInputGate.js';
import * as attach from '../src/multislot/multislotAttach.js';
import * as providers from '../src/multislot/multislotProviders.js';
import * as copy from '../src/multislot/multislotCopy.js';
import * as sideFacade from '../src/terminal/sideTerminalFacade.js';
import * as terminalProviders from '../src/terminal/providers.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i=0;i<12;i++) { await Promise.resolve(); await vue.nextTick(); } };
let serial = 0;
function fakeFacade(options = {}) {
  const listeners = { data: new Set(), exit: new Set() };
  return {
    disposed: 0, closed: [], listeners,
    capabilities: async () => ({ commands: ['old-command'] }),
    attach: async () => ({ sessions: [{ session:'one', command:'session' }, { session:'two', command:'session' }] }),
    onData(fn) { listeners.data.add(fn); return () => listeners.data.delete(fn); },
    onExit(fn) { listeners.exit.add(fn); return () => listeners.exit.delete(fn); },
    close(value) { this.closed.push(value); }, ack() {}, write() {},
    dispose() { this.disposed++; }, ...options,
  };
}
async function mount(file, initial = {}, facades = []) {
  const children = {};
  const child = name => vue.defineComponent({ inheritAttrs:false, setup(_,ctx) {
    children[name] = ctx;
    return () => vue.h('section', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? []));
  }});
  const calls = { created:[], disposed:[], forgotten:[], registryDisposed:0 };
  const registry = {
    createSession(p) { calls.created.push(p.sessionId); }, beginAttach() {}, applyRestoreSnapshot() {}, writeOutputChunk() {}, setControlLease() {},
    disposeSession(id) { calls.disposed.push(id); }, forgetSession(id) { calls.forgotten.push(id); }, dispose() { calls.registryDisposed++; },
  };
  const deps = {
    '@xterm/xterm':{ Terminal:class {} }, '@xterm/addon-fit':{ FitAddon:class {} },
    '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue':child('slot'),
    '/.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue':child('bar'),
    '/.kit/capsule-ui-kit/src/side-terminal/SideTerminalPanel.vue':child('terminal'),
    'capsule-ui-kit/TerminalView':{ createStreamRegistry:() => registry },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js':{ createTerminalDocument:()=>({}) },
    '../terminal/sideTerminalFacade.js':{ ...sideFacade, createSideTerminalFacade:() => facades.shift() },
    './sideTerminalFacade.js':{ ...sideFacade, createSideTerminalFacade:() => facades.shift() },
    './providers.js':terminalProviders,
    './multislotInputGate.js':gate, './multislotAttach.js':attach,
    './multislotProviders.js':providers, '../multislot/multislotProviders.js':providers, './multislotCopy.js':copy,
  };
  globalThis.__f1Deps = deps;
  async function compile(file) {
    const { descriptor } = parse(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'));
    let code = compileScript(descriptor, { id:'f1', inlineTemplate:true }).content;
    code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
    code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('vue')).href));
      assert.ok(spec in deps, `Unmapped SFC dependency: ${spec}`);
      return `const ${bindings.trim()} = globalThis.__f1Deps[${JSON.stringify(spec)}];`;
    });
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
  }
  const brokerControls = await compile('terminal/BrokerLaunchControls.vue');
  deps['../terminal/BrokerLaunchControls.vue'] = brokerControls;
  deps['./BrokerLaunchControls.vue'] = brokerControls;
  const component = await compile(file);
  const props = vue.reactive(initial), root = { children:[] };
  const renderer = vue.createRenderer({
    createElement:tag=>({tag,children:[],props:{}}), createText:text=>({text}),createComment:text=>({text}),
    insert(node,parent) { node.parent=parent; parent.children.push(node); },
    remove(node) { const a=node.parent?.children; if(a) a.splice(a.indexOf(node),1); },
    setText(n,t) { n.text=t; }, setElementText(n,t) { n.text=t; }, patchProp(n,k,_old,v) { n.props[k]=v; },
    parentNode:n=>n.parent,nextSibling:()=>null,setScopeId() {},
  });
  const app = renderer.createApp({setup:()=>()=>vue.h(component,props)});
  app.mount(root); await flush();
  return { app, props, root, children, calls };
}
const binding = () => ({ session:'one', port:{} });
const text = n => [n.text ?? '', ...(n.children ?? []).map(text)].join(' ');
const nodes = n => [n, ...(n.children ?? []).flatMap(nodes)];

test('pending capabilities and attaches are canceled on replacement/null/unmount', async () => {
  for (const phase of ['capabilities','attach']) for (const action of ['replace','null','unmount']) {
    const wait=deferred(), first=fakeFacade({ [phase]:()=>wait.promise }), second=fakeFacade();
    const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding()},[first,second]);
    if(action==='unmount') f.app.unmount(); else { f.props.terminalBinding=action==='null'?null:binding(); await flush(); }
    wait.resolve(phase==='capabilities'?{commands:['stale']}:{sessions:[{session:'stale',command:'session'}]}); await flush();
    assert.equal(first.disposed,1,`${phase}/${action}: dispose exactly once after pending operation settles`);
    assert.ok(!f.calls.created.includes('stale'));
    assert.equal(first.listeners.data.size,0);
    if(action==='replace') assert.deepEqual(f.children.slot.attrs.sessions.map(s=>s.sessionId),['one','two']);
    if(action!=='unmount') f.app.unmount();
    assert.equal(f.calls.registryDisposed,1);
  }
});

test('props synchronize; presentation intents await parent acceptance; command authority shrinks', async () => {
  const first=fakeFacade(), second=fakeFacade({capabilities:async()=>({commands:['new-command']})});
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding(),brokerCommands:['parent-command'],folded:false,floating:false,surfaceHidden:false,terminalHidden:false},[first,second]);
  try {
    for(const type of ['fold','float','hide-surface','hide-terminal']) f.children.slot.emit('submit-intent',{type});
    await flush();
    for(const key of ['folded','floating','surface-hidden','terminal-hidden']) assert.equal(f.children.slot.attrs[key],false,key);
    Object.assign(f.props,{folded:true,floating:true,surfaceHidden:true,terminalHidden:true,brokerCommands:[]}); await flush();
    for(const key of ['folded','floating','surface-hidden','terminal-hidden']) assert.equal(f.children.slot.attrs[key],true,key);
    assert.deepEqual(f.children.slot.attrs.commands,['old-command']);
    f.props.terminalBinding=binding(); await flush();
    assert.deepEqual(f.children.slot.attrs.commands,['new-command']);
    f.props.terminalBinding=null; await flush();
    assert.deepEqual(f.children.slot.attrs.commands,[]);
  } finally { f.app.unmount(); }
});

test('one malformed or failed session cannot disconnect another; open result is attached', async () => {
  const facade=fakeFacade({attach:async()=>({sessions:[{session:'one',command:'session'},null,{session:'two',command:'session'}]}),open:async()=>({session:{session:'three',command:'session'}})});
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding(),brokerCommands:['session']},[facade]);
  try {
    assert.deepEqual(f.children.slot.attrs.sessions.map(s=>s.sessionId),['one','two']);
    for(const fn of facade.listeners.data) fn({session:'one',seq:2,bytes:[65],byteLength:1}); await flush();
    assert.equal(f.children.slot.attrs['attachment-state'],'live');
    assert.deepEqual(f.children.slot.attrs.sessions.map(s=>s.sessionId),['two']);
    assert.equal(f.children.slot.attrs['selected-session-id'],'two');
    f.children.slot.emit('launch-request',{entryId:'shell',command:'session',args:[]}); await flush();
    assert.ok(f.calls.created.includes('three'));
    assert.deepEqual(f.children.slot.attrs.sessions.map(s=>s.sessionId),['two','three']);
  } finally { f.app.unmount(); }
});

test('launch refusal mounts safe text and keeps code only in data attributes',async()=>{
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',brokerCommands:['session']});
  try {
    f.children.slot.emit('launch-request',{entryId:'shell',command:'session',args:[]}); await flush();
    assert.match(text(f.root),/Launch unavailable/);
    assert.doesNotMatch(text(f.root),/ERR_/);
    const alert=nodes(f.root).find(n=>n.props?.role==='alert');
    assert.equal(alert.props['data-error-code'],'ERR_LAUNCH_NO_BROKER');
    assert.doesNotMatch(nodes(f.root).find(n=>n.tag==='button').props['aria-label'],/ERR_/);
  } finally { f.app.unmount(); }
});

test('side overlay rebinds, forwards events and disposes on unmount',async()=>{
  const a=fakeFacade(), b=fakeFacade(), updates=[], states=[];
  const f=await mount('terminal/SideTerminalOverlay.vue',{terminalBinding:binding(),open:true,'onUpdate:open':v=>updates.push(v),onStateChange:v=>states.push(v)},[a,b]);
  assert.equal(f.children.terminal.attrs.facade,a);
  f.props.terminalBinding=binding(); await flush();
  assert.equal(a.disposed,1); assert.equal(f.children.terminal.attrs.facade,b);
  f.children.terminal.emit('update:open',false); f.children.terminal.emit('state-change',{state:'live'});
  assert.deepEqual(updates,[false]); assert.deepEqual(states,[{state:'live'}]);
  f.app.unmount(); assert.equal(b.disposed,1);
});

test('pump acknowledges cumulative bytes only after accepted output; failures roll back registry',()=>{
  for(const stage of ['createSession','beginAttach','applyRestoreSnapshot']) {
    let fail=true; const events=[], removed=[], acks=[], order=[]; let receive;
    const registry=Object.fromEntries(['createSession','beginAttach','applyRestoreSnapshot','setControlLease'].map(k=>[k,()=>{if(k===stage&&fail)throw Error('registry');}]));
    Object.assign(registry,{writeOutputChunk(){order.push('write');},disposeSession:id=>removed.push(id),forgetSession() {}});
    const facade={onData:fn=>{receive=fn;return()=>{};},onExit:()=>()=>{},close(){},ack:value=>{order.push('ack');acks.push(value);}};
    const pump=attach.createMultislotPump({registry,facade,capsuleId:'cap-01',getInputMode:()=> 'read',onEvent:e=>events.push(e)});
    assert.throws(()=>pump.attachSession({session:'one',command:'session'}));
    assert.deepEqual(pump.sessionIds(),[]); assert.deepEqual(removed,['one']);
    fail=false; pump.attachSession({session:'one',command:'session',bytes:5});
    receive({session:'one',seq:1,bytes:[65,66],byteLength:2});
    assert.deepEqual(order,['write','ack']); assert.deepEqual(acks,[{session:'one',seq:1,bytes:7}]);
    receive({session:'one',seq:3,bytes:[65],byteLength:1});
    assert.deepEqual(pump.sessionIds(),[]); assert.deepEqual(removed,['one','one']); assert.equal(acks.length,1);
    pump.dispose();
  }
});

test('parent updates independently synchronize all presentation props',async()=>{
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01'});
  try {
    for(const key of ['folded','floating','surfaceHidden','terminalHidden']) f.props[key]=true;
    await flush();
    for(const key of ['folded','floating','surface-hidden','terminal-hidden']) assert.equal(f.children.slot.attrs[key],true,key);
    for(const key of ['folded','floating','surfaceHidden','terminalHidden']) f.props[key]=false;
    await flush();
    for(const key of ['folded','floating','surface-hidden','terminal-hidden']) assert.equal(f.children.slot.attrs[key],false,key);
  } finally { f.app.unmount(); }
});

test('removed parent and previous capability commands lose launch authority',async()=>{
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding(),brokerCommands:['parent-command']},[fakeFacade(),fakeFacade({capabilities:async()=>({commands:['new-command']})})]);
  try {
    f.props.brokerCommands=[]; await flush();
    assert.deepEqual(f.children.slot.attrs.commands,['old-command']);
    f.props.terminalBinding=binding(); await flush();
    assert.deepEqual(f.children.slot.attrs.commands,['new-command']);
  } finally { f.app.unmount(); }
});

test('new session handles attach on open and stale open results never enter new binding',async()=>{
  for(const stale of [false,true]) {
    const wait=deferred(), first=fakeFacade({open:()=>wait.promise}), second=fakeFacade();
    const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding(),brokerCommands:['session']},[first,second]);
    try {
      f.children.slot.emit('launch-request',{entryId:'shell',command:'session',args:[]}); await flush();
      if(stale) {f.props.terminalBinding=binding(); await flush();}
      wait.resolve({session:'three'}); await flush();
      assert.equal(f.calls.created.includes('three'),!stale);
      if(stale) assert.ok(first.closed.some(p=>p.session==='three'));
    } finally {f.app.unmount();}
  }
});

test('exits remove only the affected selection and unmount releases every remaining session',async()=>{
  const facade=fakeFacade();
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding()},[facade]);
  for(const fn of facade.listeners.exit) fn({session:'one'}); await flush();
  assert.equal(f.children.slot.attrs['attachment-state'],'live');
  assert.equal(f.children.slot.attrs['selected-session-id'],'two');
  assert.deepEqual(f.calls.disposed,['one']);
  assert.deepEqual(f.calls.forgotten,['one']);
  f.app.unmount();
  assert.deepEqual(f.calls.disposed,['one','two']);
  assert.deepEqual(f.calls.forgotten,['one','two']);
  assert.equal(f.calls.registryDisposed,1);
  assert.equal(facade.listeners.data.size,0); assert.equal(facade.listeners.exit.size,0);
});

test('accepted output replenishes facade credit; registry rejection never acknowledges',()=>{
  for(const reject of [false,true]) {
    const acks=[], order=[], disposed=[];let receive;
    const facade={onData:fn=>{receive=fn;return()=>{};},onExit:()=>()=>{},close(){},ack:p=>{order.push('ack');acks.push(p);}};
    const registry={createSession(){},beginAttach(){},applyRestoreSnapshot(){},setControlLease(){},disposeSession:id=>disposed.push(id),forgetSession(){},writeOutputChunk(){order.push('write');if(reject)throw Error('backpressure');}};
    const pump=attach.createMultislotPump({facade,registry,capsuleId:'cap-01',getInputMode:()=> 'read'});
    pump.attachSession({session:'one',command:'session'});
    receive({session:'one',seq:1,bytes:[65,66],byteLength:2});
    assert.deepEqual(acks,reject?[]:[{session:'one',seq:1,bytes:2}]);
    assert.deepEqual(order,reject?['write']:['write','ack']);
    if(reject) {assert.deepEqual(disposed,['one']);assert.deepEqual(pump.sessionIds(),[]);}
    pump.dispose();
  }
});

test('late attach allocation is released after unmount as well as before await resolution',async()=>{
  const wait=deferred(); let resource=false;
  const facade=fakeFacade({attach:async()=>{await wait.promise;resource=true;return {sessions:[]};},dispose(){resource=false;}});
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding()},[facade]);
  f.app.unmount(); wait.resolve(); await flush(); assert.equal(resource,false);
});


test('omitted presentation props retain local controls used by App',async()=>{
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01'});
  try {
    for(const type of ['fold','float','hide-surface','hide-terminal']) f.children.slot.emit('submit-intent',{type});
    await flush();
    for(const key of ['folded','floating','surface-hidden','terminal-hidden']) assert.equal(f.children.slot.attrs[key],true,key);
    for(const type of ['unfold','dock-back','show-surface','show-terminal']) f.children.slot.emit('submit-intent',{type});
    await flush();
    for(const key of ['folded','floating','surface-hidden','terminal-hidden']) assert.equal(f.children.slot.attrs[key],false,key);
  } finally {f.app.unmount();}
});


test('broker launch binds its owner, attaches the session and never renders success as refusal', async () => {
  const broker={async open() { assert.equal(this, broker); return {session:'three'}; }};
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding(),terminalBroker:broker},[fakeFacade()]);
  try {
    assert.ok(!nodes(f.root).some(n=>n.props?.['aria-label']==='Recording'));
    f.children.slot.emit('launch-request',{entryId:'shell',command:'shell',args:[]}); await flush();
    assert.ok(f.calls.created.includes('three'));
    assert.ok(!nodes(f.root).some(n=>n.props?.role==='alert'));
    assert.doesNotMatch(text(f.root),/Waiting for terminal connection|TERMINAL_OPENED/);
  } finally { f.app.unmount(); }
});

test('broker stale launch closes on its owner after unmount', async () => {
  const wait=deferred(), closed=[];
  const broker={open:()=>wait.promise,close(p){assert.equal(this,broker);closed.push(p);}};
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding(),terminalBroker:broker},[fakeFacade()]);
  f.children.slot.emit('launch-request',{entryId:'shell',command:'shell',args:[]}); await flush();
  f.app.unmount(); wait.resolve({session:'late'}); await flush();
  assert.deepEqual(closed,[{session:'late'}]);
  assert.ok(!f.calls.created.includes('late'));
});

test('overlay close preserves enable state; mounted broker controls have canonical anchors and no inline styles', async () => {
  const calls=[], broker={setEnabled:async v=>calls.push(v),open:async()=>({session:'new'})};
  const f=await mount('terminal/SideTerminalOverlay.vue',{terminalBroker:broker,open:true});
  try {
    let input=nodes(f.root).find(n=>n.tag==='input');
    await input.props.onChange({target:{checked:true}}); await flush();
    f.props.open=false; await flush(); f.props.open=true; await flush();
    input=nodes(f.root).find(n=>n.tag==='input');
    assert.equal(input.props.checked,true);
    const controls=nodes(f.root).filter(n=>['input','button'].includes(n.tag));
    assert.ok(controls.length>1);
    for(const n of controls) {
      assert.match(n.props.id,/^mv-terminal-broker-/);
      assert.match(n.props['data-semantic-anchor'],/^terminal\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/);
      assert.equal(n.props.style,undefined);
      if(n.tag==='button') assert.equal(n.props.disabled,false);
    }
    assert.deepEqual(calls,[true]);
  } finally { f.app.unmount(); }
});

test('multislot broker opt-in gates actual launch commands and uses capsule anchors', async()=>{
  const calls=[], broker={setEnabled:async()=>{},open:async()=>{calls.push('open');return {session:'new'};}};
  const f=await mount('multislot/MultislotHost.vue',{capsuleId:'cap-01',terminalBinding:binding(),terminalBroker:broker},[fakeFacade()]);
  try {
    assert.ok(!f.children.slot.attrs.commands.includes('shell'));
    f.children.slot.emit('launch-request',{entryId:'shell',command:'shell',args:[]});await flush();
    assert.deepEqual(calls,[]);
    const input=nodes(f.root).find(n=>n.tag==='input');
    assert.match(input.props['data-semantic-anchor'],/^capsule\/cap-01\//);
    await input.props.onChange({target:{checked:true}});await flush();
    assert.ok(f.children.slot.attrs.commands.includes('shell'));
    f.children.slot.emit('launch-request',{entryId:'shell',command:'shell',args:[]});await flush();
    assert.deepEqual(calls,['open']);
    assert.ok(f.calls.created.includes('new'));
    assert.ok(f.children.slot.attrs.sessions.some(s=>s.sessionId==='new'));
    assert.ok(!nodes(f.root).some(n=>n.props?.role==='alert'));
  } finally { f.app.unmount(); }
});

test('syncLease isolates a failed registry session and still updates later sessions',()=>{
  let fail=false; const updated=[], events=[];
  const registry={createSession(){},beginAttach(){},applyRestoreSnapshot(){},writeOutputChunk(){},disposeSession(){},forgetSession(){},setControlLease(p){
    if(fail&&p.sessionId==='one')throw Error('lease failure'); updated.push(p.sessionId);
  }};
  const facade=fakeFacade();
  const pump=attach.createMultislotPump({facade,registry,capsuleId:'cap-01',getInputMode:()=> 'read',onEvent:e=>events.push(e)});
  pump.attachSession({session:'one',command:'shell'});pump.attachSession({session:'two',command:'shell'});
  updated.length=0;fail=true;
  assert.doesNotThrow(()=>pump.syncLease());
  assert.ok(updated.includes('two'));
  assert.deepEqual(pump.sessionIds(),['two']);
  assert.equal(events[0].type,'failed');
  pump.dispose();
});


test('mounted broker reports fixed success/status and refusal copy; stale launch is closed',async()=>{
  for(const mode of ['success','reject','stale']) {
    const wait=deferred(),closed=[],broker={open(){assert.equal(this,broker);return wait.promise;},close(p){closed.push(p);}};
    const f=await mount('terminal/BrokerLaunchControls.vue',{broker});
    const button=nodes(f.root).find(n=>n.tag==='button');
    const pending=button.props.onClick(); await flush();
    if(mode==='stale') f.app.unmount();
    if(mode==='reject') wait.resolve(Promise.reject(Error('ERR_PRIVATE raw host message')));
    else wait.resolve({session:'new'});
    await pending;await flush();
    if(mode==='stale') {assert.deepEqual(closed,[{session:'new'}]);continue;}
    try {
      const status=nodes(f.root).find(n=>n.props?.role==='status');
      assert.ok(status);
      assert.doesNotMatch(text(f.root),/ERR_|raw host message|Waiting for terminal connection/);
      assert.equal(status.text,mode==='success'?'Terminal session opened.':'This terminal launch is unavailable.');
      assert.ok(!nodes(f.root).some(n=>n.props?.role==='alert'));
    } finally {f.app.unmount();}
  }
});

test('enable acknowledgement is shared across mounted broker consumers and refusals leave it closed',async()=>{
  const broker={setEnabled:async()=>{throw Error('private');},open:async()=>({session:'new'})};
  const f=await mount('terminal/BrokerLaunchControls.vue',{broker});
  try {
    const input=nodes(f.root).find(n=>n.tag==='input');
    await input.props.onChange({target:{checked:true}});await flush();
    assert.equal(input.props.checked,false);
    assert.equal(nodes(f.root).find(n=>n.tag==='button').props.disabled,true);
    broker.setEnabled=async()=>{};
    await input.props.onChange({target:{checked:true}});await flush();
    const g=await mount('terminal/BrokerLaunchControls.vue',{broker});
    try {assert.equal(nodes(g.root).find(n=>n.tag==='input').props.checked,true);}
    finally {g.app.unmount();}
  } finally {f.app.unmount();}
});


for (const pending of [false, true]) test(`broker launch refuses ${pending ? 'while attachment is pending' : 'without a binding'}`, async () => {
    const wait=deferred(), calls=[];
    const broker={open:async()=>{calls.push('open');return {session:'orphan'};}};
    const f=await mount('multislot/MultislotHost.vue',{
      capsuleId:'cap-01',terminalBroker:broker,...(pending?{terminalBinding:binding()}:{}),
    },pending?[fakeFacade({attach:()=>wait.promise})]:[]);
    try {
      f.children.slot.emit('launch-request',{entryId:'shell',command:'shell',args:[]}); await flush();
      assert.deepEqual(calls,[],'must refuse before spawning an unattached session');
      assert.deepEqual(f.calls.created,[]);
      assert.ok(nodes(f.root).some(n=>n.props?.role==='alert'));
      assert.match(text(f.root),/Launch unavailable/);
    } finally {f.app.unmount();wait.resolve({sessions:[]});await flush();}
});

for (const action of ['replace','clear','rebind']) test(`pending broker open closes on its original owner after ${action}`, async () => {
    const wait=deferred(),closed=[],replacementClosed=[];
    const broker={open:()=>wait.promise,close(p){assert.equal(this,broker);closed.push(p);}};
    const replacement={open:async()=>({session:'replacement'}),close:p=>replacementClosed.push(p)};
    const f=await mount('multislot/MultislotHost.vue',{
      capsuleId:'cap-01',terminalBinding:binding(),terminalBroker:broker,
    },[fakeFacade(),fakeFacade()]);
    try {
      f.children.slot.emit('launch-request',{entryId:'shell',command:'shell',args:[]});await flush();
      if(action==='rebind') f.props.terminalBinding=binding();
      else f.props.terminalBroker=action==='replace'?replacement:null;
      await flush();
      wait.resolve({session:{session:'late',command:'shell'}});await flush();
      assert.deepEqual(closed,[{session:'late'}],action);
      assert.deepEqual(replacementClosed,[]);
      assert.ok(!f.calls.created.includes('late'));
      assert.ok(!f.children.slot.attrs.sessions.some(s=>s.sessionId==='late'));
      assert.equal(f.children.slot.attrs.launching,false);
    } finally {f.app.unmount();}
});

test('broker result is closed and refused when its attachment fails', async () => {
  const closed=[],broker={open:async()=>({session:{session:'invalid',command:''}}),close:p=>closed.push(p)};
  const f=await mount('multislot/MultislotHost.vue',{
    capsuleId:'cap-01',terminalBinding:binding(),terminalBroker:broker,
  },[fakeFacade()]);
  try {
    f.children.slot.emit('launch-request',{entryId:'shell',command:'shell',args:[]});await flush();
    assert.deepEqual(closed,[{session:'invalid'}]);
    assert.ok(!f.calls.created.includes('invalid'));
    assert.ok(nodes(f.root).some(n=>n.props?.role==='alert'));
  } finally {f.app.unmount();}
});
