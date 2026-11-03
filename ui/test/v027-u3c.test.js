import test from 'node:test';
import assert from 'node:assert/strict';
import { installAuthorityWire, WIRE_CHANNELS } from '../electron/authorityWire.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';
import { summarizeSurfaces } from '../electron/profilePicker.js';

const surface = {schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'agent',profile_id:'work'};

test('V027-CP06 lost browser stays destroyable and reserved until destroyed', async t => {
  let emit;
  const handlers = new Map(), capsuleStates = new Map(), requests = [];
  const frame = {origin:PRIVILEGED_ORIGIN,url:`${PRIVILEGED_ORIGIN}/index.html`};
  const contents = {id:7,mainFrame:frame,isDestroyed:()=>false,postMessage(){}};
  const binding = installAuthorityWire({
    ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},
    contents, core:{request:async request=>{requests.push(request);return {schema:'surface_event/v0.2',event:'created',data:{surface}};}},
    env:{MV_SRF_PROFILES:JSON.stringify({work:{Kind:'browser'}})}, argv:[], capsuleStates,
    frames:{subscribe:f=>{emit=f;return ()=>{};}},
    listIdentities:async()=>({ok:true,rows:[{id:'work'}]}), readFreeMemoryBytes:async()=>8*1024**3,
  });
  t.after(()=>binding.dispose());
  await emit({state:surface,stateOnly:true});
  await emit({state:{...surface,state:'lost'},stateOnly:true});
  assert.equal(capsuleStates.get('s1')?.state,'lost');
  assert.equal(summarizeSurfaces(capsuleStates).bound.has('work'),true);
  const create = () => handlers.get(WIRE_CHANNELS.createSurface)({sender:contents,senderFrame:frame});
  assert.equal((await create()).ok,false);
  assert.equal(requests.length,0);
  await emit({state:{...surface,state:'destroyed'},stateOnly:true});
  assert.equal(capsuleStates.has('s1'),false);
  assert.equal(summarizeSurfaces(capsuleStates).bound.has('work'),false);
  assert.equal((await create()).ok,true);
  assert.equal(requests.length,1);
});

import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parse } from '@vue/compiler-sfc';
import * as vue from 'vue';

async function wallFactory() {
  const source = await readFile(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8');
  const script = parse(source).descriptor.script.content.replace(/^import .* from 'vue';$/m,'').replace(/\bexport /g,'');
  return vm.runInNewContext(script+';createWallWorkspaceController',{...vue});
}

test('Desktop tab replaces the provisional profile with the later native window title', async () => {
  const factory = await wallFactory();
  const row = {id:'s1',surfaceId:'s1',profile_id:'hw-c0000a',title:'hw-c0000a',backendLifecycle:'active'};
  const projection = {rows:[row]}, panels = [], titles = [];
  const api = {panels,groups:[],getPanel:id=>panels.find(p=>p.id===id),addPanel(options){
    const panel = {...options,api:{title:options.title,setTitle(title){titles.push(title);this.title=title;},setActive(){},close(){}}};
    panels.push(panel); return panel;
  }};
  const wall = factory({projectionView:{getProjection:()=>projection,getSnapshot:()=>({status:'live',stale:false,envelope:{projection}})}});
  assert.equal(wall.handleReady({api,windows:{state:()=>({}),show(){},hide(){},float(){},dock(){}}}).ok,true);
  assert.equal(wall.revealSurface('s1','tab').ok,true);
  assert.equal(panels[0].api.title,'hw-c0000a');
  // The core row arrives before the role surface poll supplies presentation metadata.
  row.title = 'Editor — notes.txt';
  wall.refreshPreset();
  assert.equal(panels[0].api.title,'Editor — notes.txt');
  wall.refreshPreset();
  assert.deepEqual(titles,['Editor — notes.txt']);
  assert.equal(panels.length,1);
  assert.equal(wall.revealSurface('unknown','tab').ok,false);
});

import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { createTerminalHost } from '../electron/terminalHost.js';

for (const exitBeforeAttach of [false,true]) test(`V027-TD06 host releases delivered exit (before attach: ${exitBeforeAttach})`, async t => {
  let exit;
  let kills=0;
  const host=createTerminalHost({
    env:{...process.env},createMessageChannel:()=>new MessageChannel(),
    pty:{spawn:()=>({pid:49999,onData(){},onExit(fn){exit=fn;},write(){},resize(){},kill(){kills++;exit({exitCode:0});}})},
  });
  t.after(()=>host.dispose());
  await host.setEnabled(true);
  const {session}=await host.open({command:'shell',cols:80,rows:24});
  if(exitBeforeAttach) exit({exitCode:0});
  const {port}=await host.attach({session});
  t.after(()=>port.close());
  const received=once(port,'message');
  if(!exitBeforeAttach) exit({exitCode:0});
  const [frame]=await received;
  assert.deepEqual(frame,{session,exitCode:0});
  const killsAfterExit=kills;
  await assert.rejects(()=>host.attach({session}),/TERMINAL_UNKNOWN_SESSION/);
  await assert.rejects(()=>host.close({session}),/TERMINAL_UNKNOWN_SESSION/);
  assert.equal(kills,killsAfterExit);
  // An unrelated running session still follows explicit close and is killed once.
  const second=await host.open({command:'shell',cols:80,rows:24});
  assert.equal(await host.close(second),true);
  assert.equal(kills,killsAfterExit+1);
});

import { createDesktopState, addDesktop, validateDesktopState } from '../electron/desktopLayout.js';
test('V027-LP08 validated gaps use the saved next desktop allocator', () => {
  const state=createDesktopState();
  state.views.agent.desktops.push({id:3,preset:null,layout:null});
  state.views.agent.next=4;
  assert.equal(validateDesktopState(state),true);
  assert.equal(addDesktop(state,'agent'),4);
  assert.equal(state.views.agent.next,5);
  assert.equal(validateDesktopState(state),true);
  assert.equal(addDesktop(createDesktopState(),'human'),2);
});

import { compileScript } from '@vue/compiler-sfc';
async function appScript() {
  const source=await readFile(new URL('../src/App.vue',import.meta.url),'utf8');
  const {descriptor}=parse(source);
  return {script:descriptor.scriptSetup.content,ast:compileScript(descriptor,{id:'u3c'}).scriptSetupAst};
}
test('V027-AS05 capsule navigation dismisses Settings only for an existing target', async () => {
  const {script,ast}=await appScript();
  const node=ast.find(n=>n.type==='FunctionDeclaration' && n.id.name==='openCapsule');
  const settingsOpen={value:true}, selectedCapsuleId={value:'first'}, calls=[];
  const open=vm.runInNewContext(script.slice(node.start,node.end)+';openCapsule',{
    nestedMode:{displayOnly:false},launcherOpen:{value:false},settingsOpen,selectedCapsuleId,
    rows:{value:[{id:'first'},{id:'second'}]},capsuleModes:{value:{}},
    wall:{value:{followSurface:id=>calls.push(id),revealSurface:()=>({ok:true})}},markPanelOpen(){},
  });
  open({id:'second'});
  assert.equal(settingsOpen.value,false);
  assert.equal(selectedCapsuleId.value,'second');
  assert.deepEqual(calls,['second']);
  settingsOpen.value=true;
  open({id:'missing'});
  assert.equal(settingsOpen.value,true);
});

import { filterWindowCandidates } from '../src/catalog/catalogModel.js';
async function catalogScript() {
  const source=await readFile(new URL('../src/catalog/CatalogLauncher.vue',import.meta.url),'utf8');
  const {descriptor}=parse(source);
  return {script:descriptor.scriptSetup.content,ast:compileScript(descriptor,{id:'u3c-catalog'}).scriptSetupAst};
}
test('V027-CL06 filtering the chosen window out disables attachment', async () => {
  const {script,ast}=await catalogScript();
  const node=ast.find(n=>n.type==='VariableDeclaration' && n.declarations.some(d=>d.id.name==='selectedWindow'));
  const windowChoices=vue.ref([{xid:1,title:'Editor',program:'editor'},{xid:2,title:'Files',program:'files'}]);
  const windowSearch=vue.ref(''), windowChoiceXid=vue.ref(1);
  const filteredWindows=vue.computed(()=>filterWindowCandidates(windowChoices.value,windowSearch.value));
  const selected=vm.runInNewContext(script.slice(node.start,node.end)+';selectedWindow',{computed:vue.computed,windowChoices,windowChoiceXid,filteredWindows});
  assert.equal(selected.value.xid,1);
  windowSearch.value='Files';
  assert.equal(selected.value,null);
  windowSearch.value='Editor';
  assert.equal(selected.value.xid,1);
});

import { buildCreateIntent } from '../src/catalog/catalogModel.js';
for (const kind of ['Program','Window']) test(`V027-CL05 Cancel waits for an in-flight ${kind.toLowerCase()} create`, async () => {
  const {script,ast}=await catalogScript();
  const nodes=ast.filter(n=>n.type==='FunctionDeclaration' && [`confirm${kind}`,`cancel${kind}`].includes(n.id.name));
  let settle;
  const pending=new Promise(resolve=>{settle=resolve;}), events=[];
  const ctx={buildCreateIntent,pendingIntent:{value:{kind:'program'}},
    programBinary:{value:'editor'},programRole:{value:'human'},
    selectedWindow:{value:{xid:1,witness:'a'.repeat(64),title:'Editor',program:'editor',width:800,height:600}},
    choosingProgram:{value:true},programError:{value:''},programBusy:{value:false},
    choosingWindow:{value:true},windowChoiceXid:{value:1},windowError:{value:''},windowBusy:{value:false},
    emit(event,value,complete){if(event==='create')complete(pending);else events.push(event);},
  };
  vm.createContext(ctx);
  vm.runInContext(nodes.map(n=>script.slice(n.start,n.end)).join('\n'),ctx);
  const creating=ctx[`confirm${kind}`]();
  assert.equal(ctx[`${kind.toLowerCase()}Busy`].value,true);
  try {
    ctx[`cancel${kind}`]();
    assert.equal(ctx[`choosing${kind}`].value,true);
    assert.deepEqual(events,[]);
  } finally {settle({ok:false,code:'CREATE_REFUSED'});await creating;}
  ctx[`cancel${kind}`]();
  assert.equal(ctx[`choosing${kind}`].value,false);
  assert.deepEqual(events,['update:visible']);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { installRoleHost } from '../electron/roleHost.js';
async function roleFixture(t,{profiles={},identities=[]}={}) {
  const root=await mkdtemp(join(tmpdir(),'u3c-role-'));
  const states=new Map(),requests=[];
  const window=new EventEmitter();window.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
  let handler,seq=0;
  const host=installRoleHost({
    electron:{ipcMain:{handle(_key,fn){handler=fn;},removeHandler(){}}},window,
    core:{getHumanSurface:id=>states.get(id),request:async q=>{requests.push(q);const surface={schema:'surface/v0.2',surface_id:'surface-'+(++seq),profile_id:q.params.profile_id,state:'active',control:'agent',visibility:'unfolded',geometry:q.params.geometry,display:':1',kind:q.params.kind};return {schema:'surface_event/v0.2',event:'created',data:{surface}};},stopSurface:async id=>({event:'state_changed',data:{surface:{...states.get(id),state:'destroyed'}}})},
    env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:JSON.stringify(profiles)},capsuleStates:states,
    admit:()=>true,readFreeMemoryBytes:async()=>8*1024**3,listIdentities:async()=>({ok:true,rows:identities}),
  });
  t.after(async()=>{await host.dispose();await rm(root,{recursive:true,force:true});});
  return {states,requests,call:(op,body={})=>handler({}, {schema:'metaviewer.roles/v0.3',op,...body})};
}
test('V027-ID02 lowercase admitted browser templates seed dynamic identities', async t => {
  const f=await roleFixture(t,{profiles:{template:{kind:'browser',native_kind:'browser',width:1280,height:900,ram_root:'/dev/shm/fixture',display:':1'}},identities:[{id:'template'},{id:'new-account'}]});
  const choices=await f.call('choices');
  assert.equal(choices.find(row=>row.profileId==='new-account')?.available,true);
  assert.equal(choices.some(row=>row.profileId==='foreign'),false);
});

test('V027-HP02 desktop-window Watch refuses before reading a missing Xpra binding', async t => {
  const f=await roleFixture(t);
  const created=await f.call('create-window',{choice:{xid:1,witness:'a'.repeat(64),title:'Editor',program:'editor',width:800,height:600}});
  assert.equal(created.ok,true);
  const mounted=await f.call('mount',{surfaceId:created.surfaceId,bounds:{x:0,y:0,width:800,height:600}});
  assert.equal(mounted.ok,false);
  assert.equal(mounted.code,'XPRA_BINDING_REFUSED');
  assert.equal(f.states.get(created.surfaceId).state,'active');
});

import { createCaptureState } from '../src/capture/capturePort.js';
test('V027-RS03 pending screenshots refuse duplicate requests and expose busy state', async () => {
  let settle,calls=0;
  const pending=new Promise(resolve=>{settle=resolve;});
  const state=createCaptureState({screenshot:async()=>{calls++;return pending;},recordStart:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),recordStop:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),list:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),subscribe:()=>()=>{}});
  const first=state.screenshot('s1');
  try {
    assert.equal(state.bySurface.s1.screenshotPending,true);
    const second=state.screenshot('s1');
    assert.equal(calls,1);
    assert.equal((await second).ok,false);
  } finally {settle({ok:false,code:'CAPTURE_UNAVAILABLE'});await first;state.dispose();}
  assert.notEqual(state.bySurface.s1.screenshotPending,true);
});

import { captureShotsFor } from '../src/recording/recordingModel.js';
test('V027-RS04 a sealed screenshot remains exportable when relisting fails', async () => {
  const shot={id:'shot1',surface_id:'s1',width:1,height:1,sha256:'a'.repeat(64),created_ms:0};
  const exported=[];
  const state=createCaptureState({screenshot:async()=>({ok:true,shot}),recordStart:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),recordStop:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),list:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),exportCapture:async id=>{exported.push(id);return {ok:true,export:{id,bytes:1,sha256:shot.sha256}};},subscribe:()=>()=>{}});
  try {
    assert.equal((await state.screenshot('s1')).ok,true);
    await state.refresh('s1');
    assert.equal(captureShotsFor(state,'s1')[0]?.id,'shot1');
    assert.equal(captureShotsFor(state,'other').length,0);
    assert.equal((await state.exportCapture('shot1')).ok,true);
    assert.deepEqual(exported,['shot1']);
  } finally {state.dispose();}
});
