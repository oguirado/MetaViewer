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


for (const op of ['fold', 'unfold']) {
  test(`T5-R2-08 ${op} refuses another slot without changing selected presentation`, async () => {
    const f = await mountApp();
    try {
      const matching = gate.buildMultislotFoldIntent(op, id);
      for (const slot_id of ['cuk-ai-slot-surface-b', id, undefined]) {
        f.captured.slot.emit('submit-intent', {...matching, params:{slot_id}}, id);
        await flush();
        assert.equal(f.sent.length, 0, 'foreign and unbound slot ids never reach host');
        assert.equal(f.captured.slot.attrs.folded, false, 'rejected request never sets override');
      }
      f.captured.slot.emit('submit-intent', matching, id); await flush();
      assert.equal(f.sent.length, 1, 'negative control: bound slot reaches host');
      f.sent[0].resolve(true); await flush();
      assert.equal(f.captured.slot.attrs.folded, op === 'fold');
    } finally { f.close(); }
  });
}

test('negative control: removing slot ownership makes the cross-slot refusal oracle fail', async () => {
  const compile = mutatedCompiler('App.vue', source => source.replace(
    '|| body.params?.slot_id !== `cuk-ai-slot-${capsuleId}`', ''));
  const f = await mountApp({}, compile);
  try {
    await assert.rejects(async () => {
      const matching = gate.buildMultislotFoldIntent('fold', id);
      f.captured.slot.emit('submit-intent', {...matching,params:{slot_id:'cuk-ai-slot-surface-b'}}, id);
      await flush();
      assert.equal(f.sent.length, 0);
    }, {code:'ERR_ASSERTION'});
    f.sent[0].resolve(true); await flush();
    assert.equal(f.captured.slot.attrs.folded, true, 'mutant reproduces the cross-slot override');
  } finally { f.close(); }
});

function notice(state) {
  return {frame_ref:{schema:'frame_ref/v0.2',surface_id:id,generation:1,width:1,height:1,
    tick:0,ts_ns:0,capture_us:0,format:'rgb24',sha256:'a'.repeat(64)},
    surface:{schema:'surface/v0.2',surface_id:id,kind:'desktop_capsule',display:'Desktop',
      geometry:{w:1,h:1},profile_id:'default',state,visibility:'unfolded',control:'shared'}};
}
test('T5-R2-09 terminal lifecycle cannot project a live attachment; active lifecycles remain live', () => {
  let emit;
  const runtime = adapters.createAuthorityRuntime({subscribeFrames:cb=>{emit=cb;return()=>{};}});
  try {
    for (const state of ['active','lost','destroyed','standby','ceded']) {
      emit(notice(state));
      const row = runtime.projectionView.getProjection().rows[0];
      assert.equal(row.backendLifecycle, state);
      assert.equal(row.attachmentState, state === 'lost' ? 'disconnected' : state === 'destroyed' ? 'detached' : 'live');
    }
  } finally { runtime.dispose(); }
});
