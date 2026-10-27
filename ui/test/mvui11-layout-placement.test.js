import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { compileSfc, mountComponent, nodes, text, flush, childStub, SidebarIcon, UiButton } from './mvui2-terminal-mount.mjs';
import * as gate from '../src/multislot/multislotInputGate.js';
import * as attach from '../src/multislot/multislotAttach.js';
import * as providers from '../src/multislot/multislotProviders.js';
import * as copy from '../src/multislot/multislotCopy.js';
import * as facade from '../src/terminal/sideTerminalFacade.js';
import * as adapters from '../src/core/hostAdapters.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

const id = 'surface-a';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const button = (f, suffix) => nodes(f.root).find(n => n.props?.id === `mv-multislot-${id}-${suffix}`);
function assertBody(body, op, params) {
  assert.deepEqual(Object.keys(body).sort(), ['op','params','request_id','schema']);
  assert.equal(body.schema, 'ui_intent/v0.2');
  assert.match(body.request_id, /^[A-Za-z0-9._:-]+$/);
  assert.equal(body.op,op); assert.deepEqual(body.params,params);
  assert.ok(Object.isFrozen(body)); assert.ok(Object.isFrozen(body.params));
}

test('placement builders emit exact closed bodies and reject malformed bounds before submission', () => {
  const slot_id = `cuk-ai-slot-${id}`;
  const cases = [
    [gate.buildMultislotHideIntent(id),'hide',{slot_id}],
    [gate.buildMultislotShowIntent(id),'show',{slot_id}],
    [gate.buildMultislotMoveIntent(id,'group-a',0),'move',{slot_id,group_id:'group-a',index:0}],
    [gate.buildMultislotTabIntent(id,'group-a',255),'tab',{slot_id,group_id:'group-a',index:255}],
    [gate.buildMultislotFloatIntent(id,{x:0,y:16383,width:1,height:16384}),'float',
      {slot_id,x_px:0,y_px:16383,width_px:1,height_px:16384}],
  ];
  for(const [body,op,params] of cases) assertBody(body,op,params);
  assert.equal(new Set(cases.map(([b])=>b.request_id)).size,cases.length);
  for(const value of [-1,256,1.5,'1',null,NaN,Infinity]) for(const build of [gate.buildMultislotMoveIntent,gate.buildMultislotTabIntent]) {
    assert.throws(()=>build(id,'group-a',value));
  }
  for(const key of ['x','y','width','height']) for(const value of [-1,16385,0.5,'1',null,NaN,Infinity]) {
    assert.throws(()=>gate.buildMultislotFloatIntent(id,{x:0,y:0,width:1,height:1,[key]:value}));
  }
  for(const group of ['', 'a/b','x '.repeat(65),null]) assert.throws(()=>gate.buildMultislotMoveIntent(id,group,0));
  for(const raw of ['', ' 1','1.0','1e2','-1','256',null]) assert.throws(()=>gate.parsePlacementIndex(raw));
  assert.equal(gate.parsePlacementIndex('255'),255);
  assert.equal(gate.roundFloatBox({x:NaN,y:1,width:1,height:1}),null);
});

// Compile in-memory regressions without mutating the production sources.
let mutantSerial = 0;
function mutatedCompiler(target, mutate) {
  return async (file, deps) => {
    if (file !== target) return compileSfc(file, deps);
    const original = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const changed = mutate(original);
    assert.notEqual(changed, original, 'negative control must change the source');
    const { descriptor } = parse(changed);
    let code = compileScript(descriptor, { id:'mvui11negative', inlineTemplate:true }).content;
    deps['capsule-ui-kit/ui'] ??= { UiButton };
    code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
    code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(import.meta.resolve('vue')));
      assert.ok(spec in deps, `Unmapped mutant dependency: ${spec}`);
      return `const ${bindings.trim()} = globalThis.__mvui11NegativeDeps[${JSON.stringify(spec)}];`;
    });
    globalThis.__mvui11NegativeDeps = deps;
    try {
      return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${mutantSerial++}`)).default;
    } finally { delete globalThis.__mvui11NegativeDeps; }
  };
}

async function mountHost(initial={}, terminalFacade=null, compile=compileSfc) {
  const children={}, emitted=[];
  const stub = vue.defineComponent({setup:()=>()=>vue.h('div')});
  const Host = await compile('multislot/MultislotHost.vue', {
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue':SidebarIcon,
    '@xterm/xterm':{Terminal:class {}}, '@xterm/addon-fit':{FitAddon:class {}},
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js':{createTerminalDocument:()=>({})},
    '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue':childStub('slot',children),
    '/.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue':childStub('bar',children),
    'capsule-ui-kit/TerminalView':{createStreamRegistry:()=>({createSession(){},beginAttach(){},applyRestoreSnapshot(){},setControlLease(){},writeOutputChunk(){},disposeSession(){},forgetSession(){}})},
    '../terminal/BrokerLaunchControls.vue':stub,
    '../terminal/sideTerminalFacade.js':terminalFacade ? {...facade,createSideTerminalFacade:()=>terminalFacade} : facade,
    './multislotInputGate.js':gate,'./multislotAttach.js':attach,
    './multislotProviders.js':providers,'./multislotCopy.js':copy,
  });
  const f=mountComponent(Host,{capsuleId:id,inputMode:'write',measureSlotBox:()=>({x:10,y:20,width:300,height:200}),
    onSubmitIntent:(...args)=>emitted.push(args),...initial});
  await flush();return {...f,children,emitted};
}

test('mounted slot routes all placement controls without local layout mutation; terminal stays mounted', async () => {
  const f=await mountHost();
  try {
    button(f,'group').props.onInput({target:{value:'group-a'}});
    button(f,'index').props.onInput({target:{value:'3'}});
    await flush();
    for(const op of ['move','tab','float','hide']) {
      if(op==='move'||op==='tab') button(f,op).props.onClick();
      else f.children.slot.emit('submit-intent',{type:op});
      await flush();
      assert.equal(f.emitted.at(-1)[0].op,op);
      assert.equal(f.children.slot.attrs.floating,false);
      assert.equal(nodes(f.root).find(n=>n.props?.class==='mv-multislot-pair').props.hidden,false);
    }
    assert.equal(f.emitted.length,4);
    assert.deepEqual(f.emitted[0][0].params,{slot_id:`cuk-ai-slot-${id}`,group_id:'group-a',index:3});
    assert.deepEqual(f.emitted[2][0].params,{slot_id:`cuk-ai-slot-${id}`,x_px:10,y_px:20,width_px:300,height_px:200});
    const liveSlot=f.children.slot;
    f.props.floating=true;f.props.groupId='group-a';f.props.placementIndex=3;
    await flush();
    assert.equal(f.children.slot,liveSlot,'moving does not replace the attached terminal host');
    assert.equal(f.children.slot.attrs.floating,true);
    f.props.hidden=true;await flush();
    assert.match(text(f.root),/Show slot/);
    assert.equal(button(f,'move').props.disabled,true);
    button(f,'visibility').props.onClick();await flush();
    assert.equal(f.emitted.at(-1)[0].op,'show');
    assert.equal(nodes(f.root).find(n=>n.props?.class==='mv-multislot-pair').props.hidden,true,'show awaits echo');
    f.props.hidden=false;await flush();
    assert.equal(nodes(f.root).find(n=>n.props?.class==='mv-multislot-pair').props.hidden,false);
    button(f,'index').props.onInput({target:{value:'256'}});button(f,'move').props.onClick();await flush();
    assert.equal(f.emitted.length,5,'bad index sends nothing');
    assert.match(text(f.root),/Choose a valid group/);assert.doesNotMatch(text(f.root),/ERR_INVALID_PLACEMENT_INPUT/);
    assert.equal(button(f,'placement-refusal').props['data-error-code'],'ERR_INVALID_PLACEMENT_INPUT');
  } finally {f.app.unmount();}
});

test('a moved capsule retains its attached terminal selection and output subscription', async () => {
  const listeners=new Set(); let attaches=0,disposes=0;
  const terminal={capabilities:async()=>({commands:['shell']}),attach:async()=>{attaches++;return {sessions:[{session:'attached',command:'shell'}]};},
    onData:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onExit:()=>()=>{},write(){},ack(){},dispose(){disposes++;}};
  const f=await mountHost({terminalBinding:{session:'attached',port:{}}},terminal);
  try {
    assert.equal(f.children.slot.attrs.sessions[0].sessionId,'attached');
    const before=f.children.slot.attrs['selected-session-id'];
    assert.equal(attaches,1);assert.equal(listeners.size,1);
    f.props.floating=true;f.props.groupId='group-b';f.props.placementIndex=2;await flush();
    assert.equal(f.children.slot.attrs.sessions[0].sessionId,'attached');
    assert.equal(f.children.slot.attrs['selected-session-id'],before);
    assert.equal(f.children.slot.attrs['terminal-hidden'],false);
    assert.equal(attaches,1);assert.equal(disposes,0);assert.equal(listeners.size,1);
  } finally {f.app.unmount();}
  assert.equal(disposes,1);assert.equal(listeners.size,0);
});

test('READ, agent, pending and hidden barriers disable controls and reject synthetic placement events', async () => {
  for(const initial of [{inputMode:'read'},{agentControlled:true},{layoutPending:true},{hidden:true}]) {
    const f=await mountHost(initial);
    try {
      assert.equal(button(f,'move').props.disabled,true);
      assert.equal(f.children.bar.attrs['float-disabled'],true);
      assert.ok(f.children.bar.attrs['float-reason']);
      for(const type of ['float','move','tab','hide']) f.children.slot.emit('submit-intent',{type});
      await flush();assert.equal(f.emitted.length,0);
      assert.ok(text(f.root).match(/WRITE|agent controls|pending|Show this slot/));
    } finally {f.app.unmount();}
  }
  const f=await mountHost({measureSlotBox:()=>null});
  try {f.children.slot.emit('submit-intent',{type:'float'});await flush();assert.equal(f.emitted.length,0);} finally {f.app.unmount();}
});

async function mountApp(initial={}, compile=compileSfc) {
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  globalThis.window={addEventListener(){},removeEventListener(){}};
  globalThis.document={documentElement:{dataset:{}},getElementById:()=>null};
  const captured={}, sent=[], echoes=[], local=[];
  const stub=vue.defineComponent({setup:()=>()=>vue.h('div')});
  const hostOutcome=await compileSfc('core/HostOutcome.vue',{'./hostAdapters.js':adapters});
  const slot=vue.defineComponent({setup:(_,ctx)=>{captured.slot=ctx;return()=>vue.h('section');}});
  const wall=vue.defineComponent({setup:(_,ctx)=>{captured.wall=ctx;ctx.expose({applyLayoutEcho:(...args)=>echoes.push(args)});return()=>vue.h('div');}});
  const App=await compile('App.vue',{
    './creative/CreativeCapsule.vue':stub,'./core/HostOutcome.vue':hostOutcome,'capsule-ui-kit/DockWorkspace':stub,
    '../.kit/capsule-ui-kit/src/index-shell.js':{ShellWorkspace:stub,TopBar:stub,Sidebar:stub,StatusBar:stub},
    './wall/EmptyWallView.vue':stub,'./catalog/CatalogLauncher.vue':stub,'./terminal/SideTerminalOverlay.vue':stub,
    './multislot/MultislotHost.vue':slot,'./recording/MvRecordingPanel.vue':stub,'./settings/MvSettingsPanel.vue':stub,
    './agent/AgentLaneHost.vue':stub,'./activity/ActivityStrip.vue':stub,
    './nested/nested.js':{resolveNestedMode,applyNestedWall},'capsule-ui-kit/ui':{UiButton:stub},
    'capsule-ui-kit/theme':{setKitScheme(){}},'./wall/WallWorkspace.vue':wall,'./surfaces/SurfaceCanvas.vue':stub,
    './surfaces/tileScheduler.js':{createTileScheduler},
  });
  const row=vue.reactive({id,surfaceId:id,title:'Capsule',generation:1,visibility:'unfolded',control:'human',backendLifecycle:'active'});
  const feed={getSnapshot:()=>null,getProjection:()=>({rows:[row]}),subscribe:()=>()=>{}};
  const f=mountComponent(App,{layout:{},scope:{},storage:{readRaw:async()=>null,writeAtomic:async()=>{}},
    fixture:{key:'multislot',ui:{},capsules:[{id}]},runtime:{projectionView:feed},
    authorityHost:{intent:body=>{const wait=deferred();sent.push({body,...wait});return wait.promise;}},onSubmitIntent:i=>local.push(i),...initial});
  await flush();captured.slot.emit('update:inputMode','write');await flush();
  return {...f,captured,sent,echoes,local,setRow:patch=>{Object.assign(row,patch);},close(){f.app.unmount();globalThis.window=oldWindow;globalThis.document=oldDocument;}};
}

test('App applies each placement only on committed echo; refusals and malformed acknowledgments keep layout', async () => {
  const f=await mountApp();
  try {
    const ops=[gate.buildMultislotMoveIntent(id,'group-a',2),gate.buildMultislotTabIntent(id,'group-b',1),
      gate.buildMultislotFloatIntent(id,{x:10,y:20,width:300,height:200}),gate.buildMultislotHideIntent(id),gate.buildMultislotShowIntent(id)];
    for(const body of ops) {
      const previous={...f.captured.slot.attrs};const before=f.echoes.length;
      f.captured.slot.emit('submit-intent',body,id);await flush();
      assert.deepEqual(f.sent.at(-1).body,body);assert.equal(f.captured.slot.attrs['layout-pending'],true);
      for(const key of ['hidden','floating','group-id','placement-index']) assert.equal(f.captured.slot.attrs[key],previous[key]);
      assert.equal(f.echoes.length,before);
      f.captured.slot.emit('submit-intent',body,id);await flush();assert.equal(f.sent.length,before+1,'pending duplicate rejected');
      f.sent.at(-1).resolve(true);await flush();
      assert.equal(f.echoes.length,before+1);assert.equal(f.captured.slot.attrs['layout-pending'],false);
      if(body.op==='move'||body.op==='tab') {assert.equal(f.captured.slot.attrs['group-id'],body.params.group_id);assert.equal(f.captured.slot.attrs['placement-index'],body.params.index);}
      if(body.op==='float') {assert.equal(f.captured.slot.attrs.floating,true);assert.equal(f.captured.slot.attrs['float-width'],300);}
      if(body.op==='hide'||body.op==='show') assert.equal(f.captured.slot.attrs.hidden,body.op==='hide');
    }
    for(const refusal of ['LAYOUT_UNKNOWN_SLOT','LAYOUT_ILLEGAL_TRANSITION','LAYOUT_INPUT_MODE_READ',false,1,{ok:true}]) {
      const before={...f.captured.slot.attrs};const count=f.echoes.length;
      f.captured.slot.emit('submit-intent',gate.buildMultislotMoveIntent(id,'refused',0),id);await flush();
      if(typeof refusal==='string') f.sent.at(-1).reject(Object.assign(new Error('private host text'),{code:refusal}));else f.sent.at(-1).resolve(refusal);
      await flush();assert.equal(f.echoes.length,count);
      for(const key of ['hidden','floating','group-id','placement-index']) assert.equal(f.captured.slot.attrs[key],before[key]);
      assert.equal(f.captured.slot.attrs['layout-pending'],false);
      assert.doesNotMatch(text(f.root),/LAYOUT_|private host text/);
      if(typeof refusal==='string') assert.equal(nodes(f.root).find(n=>n.props?.id==='mv-host-outcome').props['data-outcome-code'],refusal);
    }
  } finally {f.close();}
});

test('App rejects READ, agent, hidden transitions and invalid closed bodies, and closes bare control dispatch', async () => {
  const f=await mountApp();
  try {
    const good=gate.buildMultislotMoveIntent(id,'group-a',0);
    for(const bad of [{...good,extra:true},{...good,params:{...good.params,index:256}},
      {...good,params:{...good.params,extra:true}},{...good,params:{...good.params,slot_id:'other'}},
      {...good,params:{...good.params,index:'0'}},{...good,request_id:''}]) {
      f.captured.slot.emit('submit-intent',bad,id);await flush();assert.equal(f.sent.length,0);
    }
    f.captured.slot.emit('update:inputMode','read');await flush();f.captured.slot.emit('submit-intent',good,id);await flush();assert.equal(f.sent.length,0);
    f.captured.slot.emit('update:inputMode','write');await flush();
    f.setRow({control:'agent'});f.captured.slot.emit('submit-intent',good,id);await flush();assert.equal(f.sent.length,0);
    f.setRow({control:'human'});
    // Control events without the closed body never reach the host.
    for(const intent of [{op:'take_control',surfaceId:id},{type:'release_control',capsuleId:id}]) f.captured.wall.emit('submit-intent',intent);
    await flush();assert.equal(f.sent.length,0);assert.equal(f.local.length,2);
    f.captured.slot.emit('submit-intent',gate.buildMultislotHideIntent(id),id);await flush();f.sent.at(-1).resolve(true);await flush();
    f.captured.slot.emit('submit-intent',good,id);await flush();assert.equal(f.sent.length,1);
    f.captured.slot.emit('submit-intent',gate.buildMultislotShowIntent(id),id);await flush();assert.equal(f.sent.length,2);
    f.sent.at(-1).resolve(true);await flush();
  } finally {f.close();}
});

// Exercise the real wall controller, including the existing panel move API.
const source=readFileSync(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const wallModule=await import(`data:text/javascript;base64,${Buffer.from(source.replace("from 'vue'", `from ${JSON.stringify(import.meta.resolve('vue'))}`)).toString('base64')}`);
test('committed group placements move the existing panel and do not recreate its renderer',()=>{
  const calls=[],group={id:'target'},panel={id:`mv-surface-${id}`,api:{moveTo:p=>calls.push(['move',p]),setActive(){},close(){}}};
  const controller=wallModule.createWallWorkspaceController({projectionView:{getProjection:()=>({rows:[{id,surfaceId:id,backendLifecycle:'active'}]})}});
  const api={getPanel:()=>panel,addPanel:()=>{throw new Error('must retain renderer');},getGroup:()=>group,addGroup:()=>{throw new Error('existing group');}};
  const windows={state:()=>({hidden:false}),show(){},hide(){},float(){},dock:p=>calls.push(['dock',p])};
  assert.equal(controller.applyLayoutEcho(id,gate.buildMultislotMoveIntent(id,'target',2)).ok,false,'cold controller refuses');
  assert.equal(controller.handleReady({api,windows}).ok,true);
  for(const build of [gate.buildMultislotMoveIntent,gate.buildMultislotTabIntent]) assert.equal(controller.applyLayoutEcho(id,build(id,'target',2)).ok,true);
  assert.equal(calls.filter(([name])=>name==='move').length,2);
  assert.deepEqual(calls[1],['move',{group,position:'center',index:2}]);
  assert.equal(controller.applyLayoutEcho(id,{op:'move',params:{slot_id:id,group_id:'target',index:256}}).ok,false);
  assert.equal(calls.length,4,'invalid placement never touches the dock API');controller.dispose();
});

const layoutIndex = f => nodes(f.root).find(n => n.props?.class === 'mv-multislot-host').props['data-layout-index'];
async function assertCommittedIndex(f) {
  button(f,'group').props.onInput({target:{value:'group-b'}});
  button(f,'index').props.onInput({target:{value:'7'}});
  await flush();
  assert.equal(button(f,'index').props.value, '7');
  assert.equal(layoutIndex(f), 2, 'typing must retain committed index');
  button(f,'move').props.onClick();await flush();
  assert.equal(f.emitted.at(-1)[0].params.index, 7);
  assert.equal(layoutIndex(f), 2, 'submission must await authoritative echo');
  f.props.placementIndex=7;await flush();
  assert.equal(layoutIndex(f), 7, 'authoritative prop updates presentation');
}

test('layout index follows committed props while editing and submitting the draft', async () => {
  const f=await mountHost({placementIndex:2});
  try { assert.equal(layoutIndex(f),2); await assertCommittedIndex(f); } finally { f.app.unmount(); }
});

test('negative control: shadowed draft index fails the committed-index oracle', async () => {
  const compile=mutatedCompiler('multislot/MultislotHost.vue', source => source
    .replaceAll('placementIndexInput', 'placementIndex')
    .replace(':data-layout-index="props.placementIndex"', ':data-layout-index="placementIndex"'));
  const f=await mountHost({placementIndex:2},null,compile);
  try {
    // The original defect also loses the initial committed value.
    assert.equal(layoutIndex(f), '');
    button(f,'index').props.onInput({target:{value:'7'}});await flush();
    assert.equal(layoutIndex(f), '7', 'negative control reproduces input-driven presentation');
    await assert.rejects(() => assertCommittedIndex(f), {code:'ERR_ASSERTION'});
  } finally { f.app.unmount(); }
});

async function assertCleanPlacementTransitions(f, op) {
  const commit=async body => {
    const before={...f.captured.slot.attrs};
    f.captured.slot.emit('submit-intent',body,id);await flush();
    for(const key of ['floating','group-id','placement-index','float-x','float-y','float-width','float-height']) {
      assert.equal(f.captured.slot.attrs[key],before[key], 'pending requests retain committed fields');
    }
    f.sent.at(-1).resolve(true);await flush();
  };
  const dock=op === 'move' ? gate.buildMultislotMoveIntent : gate.buildMultislotTabIntent;
  await commit(dock(id,'group-a',2));
  await commit(gate.buildMultislotFloatIntent(id,{x:10,y:20,width:300,height:200}));
  assert.equal(f.captured.slot.attrs.floating,true);
  for(const [key,value] of [['float-x',10],['float-y',20],['float-width',300],['float-height',200]]) {
    assert.equal(f.captured.slot.attrs[key],value);
  }
  for(const key of ['group-id','placement-index']) assert.equal(f.captured.slot.attrs[key],undefined, 'float clears dock metadata');
  await commit(dock(id,'group-b',7));
  assert.equal(f.captured.slot.attrs.floating,false);
  assert.equal(f.captured.slot.attrs['group-id'],'group-b');
  assert.equal(f.captured.slot.attrs['placement-index'],7);
  for(const key of ['float-x','float-y','float-width','float-height']) assert.equal(f.captured.slot.attrs[key],undefined, 'dock clears float geometry');
}

for(const op of ['move','tab']) {
  test(`committed ${op}/float transitions clear incompatible metadata`, async () => {
    const f=await mountApp();
    try { await assertCleanPlacementTransitions(f,op); } finally { f.close(); }
  });
  for(const removed of ['delete next.groupId; delete next.index;', 'delete next.x; delete next.y; delete next.width; delete next.height;']) {
    test(`negative control: ${op} transition oracle rejects missing cleanup: ${removed}`, async () => {
      const compile=mutatedCompiler('App.vue', source => source.replace(removed,''));
      const f=await mountApp({},compile);
      try { await assert.rejects(() => assertCleanPlacementTransitions(f,op), {code:'ERR_ASSERTION'}); }
      finally { f.close(); }
    });
  }
}
