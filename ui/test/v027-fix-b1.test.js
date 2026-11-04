import {unavailableArmCapsules} from '../src/catalog/catalogModel.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse, compileScript} from '@vue/compiler-sfc';
import {createTerminalDeckController, TERMINAL_REFUSAL_HINTS} from '../src/terminal/terminalDeckModel.js';
import {formatMemoryRefusalReason, createRefusalReason} from '../electron/profilePicker.js';
import {showStartupFailure, MainError, PRIVILEGED_ORIGIN} from '../electron/main.js';
import {installAuthorityWire, WIRE_CHANNELS} from '../electron/authorityWire.js';
import {hostOutcomeFor} from '../src/core/hostAdapters.js';
import {createCaptureState} from '../src/capture/capturePort.js';
import {installDisplayPortRouter} from '../src/frames/displayPortRouter.js';
import {EventEmitter} from 'node:events';
import * as vue from 'vue';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
function functions(path) {
  const {descriptor} = parse(read(path));
  const ast = compileScript(descriptor, {id:'v027-fix-b1'}).scriptSetupAst;
  return Object.fromEntries(ast.filter(n=>n.type==='FunctionDeclaration')
    .map(n=>[n.id.name, descriptor.scriptSetup.content.slice(n.start,n.end)]));
}
const app = functions('../src/App.vue');
const identities = functions('../src/identities/IdentitiesDialog.vue');
const canvas = functions('../src/surfaces/SurfaceCanvas.vue');
const catalog = functions('../src/catalog/CatalogLauncher.vue');
const ref = value => ({value});
const tick = async()=>{await new Promise(resolve=>setImmediate(resolve));};
function context(code, values) { const c=vm.createContext(values); vm.runInContext(code,c); return c; }

test('F07 refused Release keeps human arm; granted Release disarms only after acknowledgement',async()=>{
  for (const result of [{tone:'refusal',code:'POLICY'},true]) {
    let settle;
    const c=context(['withoutId','disarmWallInput','applyWallControl'].map(n=>app[n]).join('\n'),{
      nestedMode:{displayOnly:false},rows:ref([{id:'a',control:'human'}]),capsuleModes:ref({a:'agent'}),
      wallInputArmed:ref({a:true}),wallInputPending:ref({}),wallInputEscaped:ref({}),hostActive:true,
      props:{runtime:{intentBuilders:{control:()=>({op:'release_control'})}}},
      dispatch:()=>new Promise(resolve=>{settle=resolve;}),hostOutcome:ref(null),
    });
    c.applyWallControl('a','release_control');
    assert.equal(c.wallInputArmed.value.a,true,'pending release still visibly human');
    settle(result);await tick();
    assert.equal(c.wallInputArmed.value.a,result===true?undefined:true);
  }
});

test('F08 delayed enable preserves the other canvas typing destination',()=>{
  for (const tagName of ['CANVAS','INPUT','TEXTAREA','BODY']) {
    let focused=0;
    const c=context(canvas.isTypingInTextField+'\n'+canvas.focusCanvasOnEnable,{
      document:{activeElement:{tagName}},canvasRef:ref({}),unmounted:false,
      props:{inputEnabled:true},resolvedState:ref('live'),inputPort:{available:true},focusCanvas:()=>focused++,
    });
    c.focusCanvasOnEnable();assert.equal(focused,tagName==='BODY'?1:0,tagName);
  }
});

function identityContext(extra={}) {
  return context(['openIdentity','invoke'].map(n=>identities[n]).join('\n'),{
    isForeignIdentity:()=>false,invocationGeneration:0,failedDelete:'',busy:ref(false),error:ref(''),login:ref(false),pendingDelete:ref(''),
    rows:ref([{id:'editor',browser:'program'}]),modesKnown:ref(true),modes:ref([{profileId:'editor',currentMode:'agent',surfaceId:'existing',available:true,binary:'editor'}]),
    modeFor:()=>({surfaceId:'existing',currentMode:'agent',available:true,binary:'editor'}),
    identityErrorText:code=>`identity tool: ${code}`,emit:()=>{},props:{host:{}},roleApi:{},...extra,
  });
}
test('F10 reopening a live saved program reveals its existing surface without creating a duplicate',async()=>{
  const calls=[];
  const c=identityContext({emit:(...args)=>calls.push(args),roleApi:{createProgram:async()=>{assert.fail('duplicate create');}}});
  await c.openIdentity('editor','agent');
  assert.ok(calls.some(([name,choice])=>name==='open-identity'&&choice.surfaceId==='existing'));
  assert.equal(c.error.value,'');
  // Closed saved programs retain the creation path.
  let creates=0;c.modeFor=()=>({currentMode:'closed',available:true,binary:'editor'});
  c.roleApi.createProgram=async()=>{creates++;return {ok:true};};
  await c.openIdentity('editor','human');assert.equal(creates,1);
});
test('F17 secondary identity refresh failure retains modes and announces unavailable status',async()=>{
  let calls=0;
  const c=identityContext({props:{host:{identity:{list:async()=>({ok:true,rows:[{id:'editor',browser:'program'}]})}}},
    metaviewerRoles:{choices:async()=>{calls++;throw Error('OFFLINE');}}});
  await c.invoke('list');
  assert.equal(calls,1,'secondary refresh must actually fail');
  assert.equal(c.modes.value[0]?.surfaceId,'existing');
  assert.equal(c.modesKnown.value,false,'stored data stays blocked while status is unknown');
  assert.match(c.error.value,/unavailable|could not|OFFLINE/i);
});
test('F24 program launch refusal retains host installation guidance',async()=>{
  const c=identityContext({modeFor:()=>({available:true,binary:'editor'}),
    roleApi:{createProgram:async()=>({ok:false,code:'HOST_PROGRAM_UNAVAILABLE',reason:'Install xpra and restart MetaViewer.'})}});
  await c.openIdentity('editor','human');
  assert.match(c.error.value,/Install xpra/);
  assert.doesNotMatch(c.error.value,/identity tool/);
});

test('F16/F44 program listing preserves lost/live binding even with unreadable saved launch',async()=>{
  const source=read('../electron/roleHost.js');
  const code=source.slice(source.indexOf('async function programs()'),source.indexOf('\n  /** @param {any} choice */',source.indexOf('async function programs()')));
  for (const state of ['active','lost']) for (const corrupt of [false,true]) {
    const c=context(code,{
      pruneProgramProfiles:()=>{},
      listIdentities:async()=>({ok:true,rows:[{id:'editor',browser:'program'}]}),
      savedPrograms:{hostProfiles:async()=>[],readLaunch:async()=>{if(corrupt)throw Error('CORRUPT');return {binary:'editor'};}},
      capsuleStates:new Map([['s1',{surface_id:'s1',profile_id:'editor',state}]]),
      isForeignIdentity:()=>false,roleFor:()=> 'agent',creating:false,transitions:new Set(),process:{env:{}},env:{},
      resolveHostBinary:()=>{throw Error('UNAVAILABLE');},
    });
    const [row]=await c.programs();
    assert.equal(row.surfaceId,'s1');assert.equal(row.currentMode,state==='lost'?'lost':'agent');
    assert.equal(row.available,!corrupt);
  }
});

function browserContext(open) {
  let submitted;
  const views=[];
  const c=context(app.onCreateCapsule,{
    nestedMode:{displayOnly:false},props:{authorityHost:{createSurface:async()=>true}},
    metaviewerRoles:{open},pendingModeSwitch:ref(null),browserCreatePending:ref(false),browserCreateNotice:ref(''),
    rows:ref([]),capsuleModes:ref({}),nextTick:async()=>{},
    selectGlobalView:mode=>views.push(mode),revealOpenedIdentity:()=>{},
    submitHost:fn=>{submitted=fn();submitted.catch(()=>{});return submitted;},
  });
  c.onCreateCapsule({kind:'identity-browser',choice:{profileId:'work',role:'human'}});
  return {c,views,done:()=>submitted};
}
test('F18/F21 delayed browser create has progress and preserves the view until success',async()=>{
  let settle;
  const f=browserContext(()=>new Promise(resolve=>{settle=resolve;}));
  await tick();assert.deepEqual(f.views,[]);assert.equal(f.c.browserCreatePending.value,true);
  settle({ok:true,surfaceId:'s1',role:'human'});await f.done();
  assert.deepEqual(f.views,['human']);assert.equal(f.c.browserCreatePending.value,false);
  assert.match(parse(read('../src/App.vue')).descriptor.template.content,/v-if="browserCreatePending"[^>]*role="status"/);
  const busy=browserContext(async()=>({ok:false,code:'SURFACE_CREATE_BUSY'}));
  await busy.done();assert.match(busy.c.browserCreateNotice.value,/already starting/);assert.deepEqual(busy.views,[]);
});
test('F20 a bound lost browser offers Stop recovery, never mode switch',async()=>{
  const f=browserContext(async()=>({ok:false,code:'PROFILE_ALREADY_BOUND',surfaceId:'lost',currentMode:'lost',requestedMode:'human'}));
  await assert.rejects(f.done(),e=>/Stop lost capsule/.test(e.reason));
  assert.equal(f.c.pendingModeSwitch.value,null);assert.deepEqual(f.views,[]);
});
test('F22 busy mode switch keeps a retry confirmation and never removes the old surface',async()=>{
  const current={surfaceId:'s1'};
  const c=context(app.confirmModeSwitch,{
    pendingModeSwitch:ref(current),metaviewerRoles:{switchMode:async()=>({ok:false,code:'SURFACE_CREATE_BUSY'})},
    submitHost:fn=>fn(),revealOpenedIdentity:assert.fail,onCapsuleStopped:assert.fail,
  });
  await c.confirmModeSwitch();assert.equal(c.pendingModeSwitch.value,current);
});
test('F19 late identity choices cannot replace an explicitly edited role',async()=>{
  let settle;
  const c=context(catalog.onCreate,{
    disabledArmKinds:{get value(){return unavailableArmCapsules(c.props.arm64Capabilities);}},
    props:{visible:true},api:{choices:()=>new Promise(resolve=>{settle=resolve;})},
    buildCreateIntent:()=>({ok:true,intent:{kind:'browser'}}),choiceGeneration:0,
    pendingIntent:ref(null),roleChoice:ref('agent'),roleEdited:ref(false),editedRoleChoice:ref('agent'),roleError:ref(''),
    profileChoices:ref([]),profileChoice:ref(''),choosingRole:ref(false),
  });
  c.matchingProfiles={get value(){return c.profileChoices.value;}};
  const pending=c.onCreate({type:{id:'browser'}});
  c.roleChoice.value='human';c.roleEdited.value=true;c.editedRoleChoice.value='human';
  settle([{profileId:'work',available:true,role:'agent'}]);await pending;
  assert.equal(c.roleChoice.value,'human');
});

test('F06 adapter exit after boot publishes the degraded status, and teardown stops delivery',()=>{
  const source=read('../electron/main.js');
  const bootStart=source.indexOf("if (!retail.nested && adapter !== null) {\n    try {");
  assert.ok(bootStart>=0);
  const boot=source.slice(bootStart,source.indexOf('\n  if (!retail.nested)',bootStart));
  const callbackStart=source.indexOf('onStatus: (status) => {',source.indexOf('bindings.adapter = createAdapterLauncher'));
  const callback=source.slice(callbackStart,source.indexOf('\n          },',callbackStart)+12);
  const sent=[],adapter={},sinks=new WeakMap();
  const c=context(boot+'\nconst callback={'+callback+'}; globalThis.changed=callback.onStatus;',{
    retail:{nested:false},adapter:Object.assign(adapter,{getStatus:()=>({availability:'live'})}),
    contentsHandle:{send:(channel,payload)=>sent.push({channel,payload})},
    adapterStatusSinks:sinks,bindings:{adapter},env:{},bootedAdapters:new WeakSet([adapter]),console:{error(){}},
  });
  c.changed({availability:'degraded',code:'ADAPTER_EXIT',userMessage:'Restart MetaViewer.'});
  assert.equal(sent.length,2);assert.equal(sent[1].channel,'metaviewer:adapter-status');
  assert.equal(sent[1].payload.code,'ADAPTER_EXIT');
  sinks.delete(adapter);c.changed({availability:'degraded',code:'ADAPTER_EXIT'});assert.equal(sent.length,2);
  assert.match(source,/adapterStatusSinks\.delete\(adapter\)/);
});

test('F09/F51 Bootstrap paste destination and selected identity are visible beside workflow actions',()=>{
  const source=read('../src/terminal/TerminalDeckView.vue');
  const template=parse(source).descriptor.template.content;
  assert.match(template,/Paste Copy ID for AI here/);
  assert.match(template,/class="mv-terminal-deck__identity-pill"/);
  assert.match(template,/Capsule ID:/);
  assert.match(template,/:value="focusedPair\?\.surfaceId \?\? pastedBootstrapText"/);
  assert.match(template,/placeholder="Paste AI ID…"/);
  assert.match(template,/:id="domId\('terminal-deck-bootstrap-paste-target'\)"/);
  assert.match(template,/:readonly="!!focusedPair"/);
  assert.match(template,/@input="onBootstrapInput"/);
  assert.match(source,/focusedPair\.value\?\.identityLine \?\? pastedBootstrapText\.value/);
});

test('F52 repeated close during grace leaves no stale confirmation, without any exit event',async()=>{
  let finishClose;
  const controller=createTerminalDeckController({
    closeGraceMs:0,broker:{setEnabled:async()=>true,open:async()=>({session:'test-session'}),close:()=>new Promise(resolve=>{finishClose=resolve;})},
    sessionFacade:{attach:async()=>({session:'test-session'}),write(){},resize(){},ack(){},close(){}},
  });
  try {
    await controller.launchProfile('shell');const id=controller.state.focusedSlotId;assert.ok(id);
    await controller.requestCloseSlot(id);const closing=controller.confirmPendingClose();
    while (!finishClose) await tick();
    await controller.requestCloseSlot(id);
    finishClose(true);await closing;
    assert.equal(controller.state.pendingCloseSlotId,null);
  } finally {controller.dispose();}
});

test('F53 repeated desktop Stop while detach awaits acknowledgement dispatches only once',async()=>{
  const role=functions('../src/surfaces/RoleSurface.vue');
  let settle,calls=0;
  const c=context(role.detachHostWindow,{
    ended:false,menuOpen:ref(true),progress:ref(''),error:ref(''),props:{surfaceId:'window'},
    revoke:async()=>{},api:{detachWindow:()=>{calls++;return new Promise(resolve=>{settle=resolve;});}},emit:()=>{},
  });
  const first=c.detachHostWindow();await tick();const second=c.detachHostWindow();await tick();
  assert.equal(calls,1);settle({ok:true});await Promise.all([first,second]);
});

test('F58 unavailable memory measurement differs from measured shortage',()=>{
  assert.match(formatMemoryRefusalReason(null),/could not|unavailable|cannot.*read/i);
  assert.match(formatMemoryRefusalReason(1024**3),/Not enough.*1\.0 GiB/);
});

test('F34 first-create failures give memory/runtime recovery without blaming identities',async()=>{
  for (const code of ['RAM_ADMISSION_REFUSED','ADAPTER_SETUP']) {
    let notice;
    await showStartupFailure({showMessageBox:async options=>{notice=options;}},new MainError(code,'private host diagnostic'),'create');
    assert.doesNotMatch(notice.detail,/Open Identities|private host diagnostic/);
    assert.match(notice.detail,code==='RAM_ADMISSION_REFUSED'?/memory.*[Cc]lose|[Cc]lose.*memory/:/doctor --capsules/);
  }
});

test('F35 native RAM refusal after local admission retains reservation reclaim guidance',()=>{
  const source=read('../electron/roleHost.js');
  const start=source.indexOf("const reason = code === 'CAPSULE_LIMIT_REACHED'",source.indexOf('async function createProgram'));
  const end=source.indexOf('\n      }',start);
  assert.ok(start>=0&&end>start);
  const detail='Retained reservations prevent admission. Run the documented reservation reclaim command.';
  const c=vm.createContext({code:'RAM_ADMISSION_REFUSED',reply:{data:{detail}},freeBytes:8*1024**3,live:0,
    formatMemoryRefusalReason,refuse:code=>Object.assign(Error(code),{code}),createRefusalReason:()=> 'generic'});
  assert.throws(()=>vm.runInContext(source.slice(start,end),c),error=>error.reason===detail);
});

test('F37 ADAPTER_SETUP create refusal supplies runtime doctor recovery',async t=>{
  const handlers=new Map(),frame={origin:PRIVILEGED_ORIGIN,url:`${PRIVILEGED_ORIGIN}/index.html`};
  let notice;
  const contents={id:7,mainFrame:frame,isDestroyed:()=>false,postMessage(){},send:(_channel,value)=>{notice=value;}};
  const binding=installAuthorityWire({
    ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},contents,
    core:{request:async()=>({schema:'surface_event/v0.2',event:'error',data:{code:'ADAPTER_SETUP'}})},
    env:{MV_SRF_PROFILES:JSON.stringify({work:{Kind:'browser'}})},argv:[],capsuleStates:new Map(),
    frames:{subscribe:()=>()=>{}},listIdentities:async()=>({ok:true,rows:[{id:'work'}]}),readFreeMemoryBytes:async()=>8*1024**3,
  });
  t.after(()=>binding.dispose());
  const reply=await handlers.get(WIRE_CHANNELS.createSurface)({sender:contents,senderFrame:frame});
  assert.equal(reply.code,'ADAPTER_SETUP');assert.match(notice.reason,/doctor --capsules/);
  assert.doesNotMatch(notice.reason,/Docker/,'setup refusal does not establish Docker as its cause');
});
test('F38 core-only create refusal supplies the documented capsule installation command',()=>{
  assert.match(hostOutcomeFor({code:'SURFACE_CREATE_FAILED',tone:'refusal',message:''}).message,/metaviewer-judge\.sh install --capsules/);
});
test('F46/F47 role picker makes busy and absent identities actionable without dispatching',()=>{
  for (const profile of [{profileId:'work',available:true,busy:true},null]) {
    let creates=0;
    const c=context(catalog.confirmRole,{matchingProfiles:ref(profile?[profile]:[]),profileChoice:ref('work'),
      roleError:ref(''),pendingIntent:ref({}),roleChoice:ref('human'),choosingRole:ref(true),emit:()=>creates++});
    c.confirmRole();assert.equal(creates,0);assert.equal(c.choosingRole.value,true);
    assert.match(c.roleError.value,profile?/starting|wait/i:/Identities/);
  }
});
test('F50 terminal package failures give reinstall guidance instead of build/preload internals',()=>{
  for (const code of ['TERMINAL_UNAVAILABLE','NATIVE_ABSENT','TERMINAL_ATTACH_FAILED']) {
    assert.match(TERMINAL_REFUSAL_HINTS[code],/reinstall|repair/i);
    assert.doesNotMatch(TERMINAL_REFUSAL_HINTS[code],/node-pty|build-native|MessagePort|preload/);
  }
});

test('F28 active native window disappearing retains its own last title on the lost core row',async()=>{
  const source=read('../src/App.vue'),{descriptor}=parse(source);
  const ast=compileScript(descriptor,{id:'v027-title'}).scriptSetupAst;
  const node=ast.find(n=>n.type==='VariableDeclaration'&&n.declarations.some(d=>d.id.name==='mergedRows'));
  const base=[{id:'s1',title:'hw-profile',backendLifecycle:'active'},{id:'s2',title:'other-profile',backendLifecycle:'active'}];
  let listed=[{schema:'metaviewer.role_surface/v0.3',role:'agent',surface:{schema:'surface/v0.2',surface_id:'s1',profile_id:'hw-profile',state:'active',control:'agent'},hostWindow:{title:'Editor — notes'}}];
  const c=context(descriptor.scriptSetup.content.slice(node.start,node.end)+'\n'+app.pollNativeSurfaces+'\nglobalThis.merged=mergedRows;',{
    baseFeed:{getProjection:()=>({rows:base})},nativeRows:ref([]),nativeWindowMetadata:new Map(),
    nativePolling:false,hostActive:true,nativeApi:{surfaces:async()=>listed},nativeLoaded:false,nativePollFailed:false,nativeRevision:0,
    onCapsuleMode:()=>{},nativeListeners:new Set(),nativeSnapshot:()=>({}),
  });
  await c.pollNativeSurfaces();assert.equal(c.merged()[0].title,'Editor — notes');
  listed=[];base[0].backendLifecycle='lost';await c.pollNativeSurfaces();
  assert.equal(c.merged()[0].title,'Editor — notes');assert.equal(c.merged()[1].title,'other-profile');
  assert.equal(c.merged()[0].hostWindow,undefined,'lost rows retain title only');
  listed=[{schema:'metaviewer.role_surface/v0.3',role:'human',surface:{schema:'surface/v0.2',surface_id:'s1',profile_id:'hw-profile',state:'active',control:'human'}}];
  base[0].backendLifecycle='active';await c.pollNativeSurfaces();
  assert.equal(c.merged()[0].title,'hw-profile');assert.equal(c.merged()[0].hostWindow,undefined);
  assert.equal(c.nativeWindowMetadata.size,0,'live rows without native host metadata release the retained title');
  base.splice(0,1);await c.pollNativeSurfaces();assert.equal(c.nativeWindowMetadata.size,0);
});
test('F29 sealed recording remains exportable after Stop even when relisting refuses',async()=>{
  const recording={id:'rec1',surface_id:'s1',frames:3,duration_ms:42,sealed:true,sha256:'a'.repeat(64)};
  const state=createCaptureState({
    recordStart:async()=>({ok:true,recording_id:'rec1'}),recordStop:async()=>({ok:true,recording}),
    screenshot:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),list:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),
    subscribe:()=>()=>{},exportCapture:async()=>({ok:true,export:{id:'rec1',bytes:1,sha256:recording.sha256}}),
  });
  try {
    await state.toggleRecord('s1');assert.equal((await state.toggleRecord('s1')).ok,true);
    await state.refresh('s1');const row=state.rows.find(r=>r.id==='rec1');
    assert.equal(row?.sealed,true);assert.equal(row.frames,3);assert.equal(row.surface_id,'s1');
    assert.equal((await state.exportCapture('rec1')).ok,true);
  } finally {state.dispose();}
});

test('F54/F55 preset refresh preserves focus; manual sizing survives viewport refresh',()=>{
  const script=parse(read('../src/wall/WallWorkspace.vue')).descriptor.script.content
    .replace(/^import .* from 'vue';$/m,'').replace(/\bexport /g,'');
  const factory=vm.runInNewContext(script+';createWallWorkspaceController',{...vue});
  const groups=[],panels=[];let sizes=0;
  const makeGroup=()=>{const g={size:1,api:{location:{type:'grid'},boundingBox:{width:500,height:800},setSize:()=>sizes++}};groups.push(g);return g;};
  const group=makeGroup();
  const api={width:1000,height:800,groups,panels,activePanel:null,getPanel:id=>panels.find(p=>p.id===id),addPanel(){}};
  for (const id of ['panel-a','panel-b']) {
    const p={id,group,api:{setActive:()=>{api.activePanel=p;},moveTo:({group,position})=>{p.group=position==='center'?group:makeGroup();},updateParameters(){},setTitle(){}}};panels.push(p);
  }
  api.activePanel=panels[1];
  const projection={rows:[{id:'a',backendLifecycle:'active'},{id:'b',backendLifecycle:'active'}]};
  const controller=factory({projectionView:{getProjection:()=>projection}});
  assert.equal(controller.handleReady({api,windows:{state:()=>({hidden:false,floating:false}),show(){},hide(){},float(){},dock(){}}}).ok,true);
  assert.equal(controller.setPreset('side-by-side').ok,true);
  api.activePanel=panels[1];api.width=1200;controller.refreshPreset();
  assert.equal(api.activePanel,panels[1]);
  assert.equal(controller.resizeTile('a','wider').ok,true);const afterManual=sizes;
  api.width=1400;controller.refreshPreset();assert.equal(sizes,afterManual,'custom size must not be replaced by equal preset rectangles');
});
test('F59 closed parked display peer releases its stream, while temporary unbind can rebind',()=>{
  const router=installDisplayPortRouter({target:{postMessage(){}}});
  const port=new EventEmitter();let closed=0;port.postMessage=()=>{};port.close=()=>closed++;port.start=()=>{};
  const spec={surfaceId:'s1',onState:()=>{},onFrame:()=>true,visible:true};
  try {
    router.bindSurface(spec);router.receiveNotice({type:'metaviewer:display-port',schema:'display_port/v1',surface_id:'s1'},[port]);
    router.unbindSurface('s1');assert.equal(router.getStats().activeStreams,1);
    router.bindSurface(spec);assert.equal(router.getStats().activeStreams,1);
    router.unbindSurface('s1');port.emit('close');assert.equal(router.getStats().activeStreams,0);assert.equal(closed,1);
  } finally {router.dispose();}
});


test('V027 program listing rechecks binding after saved launch settles',async()=>{
  const source=read('../electron/roleHost.js');
  const code=source.slice(source.indexOf('async function programs()'),source.indexOf('\n  /** @param {any} choice */',source.indexOf('async function programs()')));
  for (const state of ['active','lost']) for (const corrupt of [false,true]) {
    let settle;
    const capsuleStates=new Map();
    const c=context(code,{
      pruneProgramProfiles:()=>{},
      listIdentities:async()=>({ok:true,rows:[{id:'editor',browser:'program'}]}),
      savedPrograms:{hostProfiles:async()=>[],readLaunch:()=>new Promise((resolve,reject)=>{settle=()=>corrupt?reject(Error('CORRUPT')):resolve({binary:'editor'});})},
      capsuleStates,isForeignIdentity:()=>false,roleFor:()=> 'agent',creating:false,transitions:new Set(),process:{env:{}},env:{},
      resolveHostBinary:()=>{throw Error('UNAVAILABLE');},
    });
    const pending=c.programs();await tick();assert.equal(typeof settle,'function');
    capsuleStates.set('s1',{surface_id:'s1',profile_id:'editor',state});settle();
    const [row]=await pending;
    assert.equal(row.surfaceId,'s1');assert.equal(row.currentMode,state==='lost'?'lost':'agent');
    assert.equal(row.available,!corrupt);
  }
});

test('V027 recording Stop replaces the active manifest row from a refresh race',async()=>{
  const recording={id:'rec1',surface_id:'s1',frames:3,duration_ms:42,sealed:true,sha256:'a'.repeat(64)};
  let stop,listCount=0;
  const active={id:'rec1',kind:'recording',surface_id:'s1',phase:'recording',frames:1,duration_ms:0,sealed:false,created_ms:123};
  const state=createCaptureState({
    recordStart:async()=>({ok:true,recording_id:'rec1'}),recordStop:()=>new Promise(resolve=>{stop=resolve;}),
    screenshot:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),
    list:async()=>++listCount===1?{ok:true,rows:[active]}:{ok:false,code:'CAPTURE_UNAVAILABLE'},
    subscribe:()=>()=>{},exportCapture:async()=>({ok:true,export:{id:'rec1',bytes:1,sha256:recording.sha256}}),
  });
  try {
    await state.toggleRecord('s1');const pending=state.toggleRecord('s1');
    await state.refresh('s1');assert.equal(state.rows[0].sealed,false);
    stop({ok:true,recording});await pending;await tick();
    assert.equal(state.rows.filter(r=>r.id==='rec1').length,1);
    assert.equal(state.rows[0].sealed,true);assert.equal(state.rows[0].created_ms,123);
    assert.equal((await state.exportCapture('rec1')).ok,true);
  } finally {state.dispose();}
});

test('V027 profile picker setup refusal gives runtime doctor guidance',()=>{
  assert.match(createRefusalReason('ADAPTER_SETUP'),/doctor --capsules/);
});
