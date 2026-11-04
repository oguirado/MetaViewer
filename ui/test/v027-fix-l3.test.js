// [TARGET, unit decision] Exercise actual source continuations with explicit barriers.
// MV_L3_BASELINE=1 runs the same assertions against the checked-in pre-fix source.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {ref} from 'vue';
import {buildCreateIntent} from '../src/catalog/catalogModel.js';
const root = new URL('../../',import.meta.url);
const paths = {
 catalog:'ui/src/catalog/CatalogLauncher.vue', identities:'ui/src/identities/IdentitiesDialog.vue',
 app:'ui/src/App.vue', canvas:'ui/src/surfaces/SurfaceCanvas.vue', role:'ui/src/surfaces/RoleSurface.vue',
 host:'ui/electron/roleHost.js', bindings:'ui/electron/hostBindings.js',
};
function source(key) {
 const path=paths[key];
 const text=process.env.MV_L3_BASELINE ? execFileSync('git',['show','HEAD:'+path],{cwd:root,encoding:'utf8'}) : readFileSync(new URL(path,root),'utf8');
 return path.endsWith('.vue') ? text.match(/<script setup>([\s\S]*?)<\/script>/)[1] : text;
}
function statements(key) {const text=source(key);return {text,ast:ts.createSourceFile('unit.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)};}
function find(key,predicate) {
 const {text,ast}=statements(key);let found;
 function visit(node) {if(!found && predicate(node,text))found=node; if(!found)ts.forEachChild(node,visit);}
 visit(ast);assert.ok(found,'source node exists: '+key);return text.slice(found.getStart(ast),found.end);
}
function fn(key,name) {return find(key,n=>ts.isFunctionDeclaration(n) && n.name?.text===name);}
function functions(key,names,env) {
 return Function('env',`with(env){${names.map(name=>fn(key,name)).join('\n')};return {${names.join(',')}};}`)(env);
}
function watchCode(key,prefix,env) {
 const code=find(key,(n,text)=>ts.isExpressionStatement(n) && (prefix==='identity-refresh' ? /watch\(\(\)=>props.open,open=>\{/.test(text.slice(n.getStart(),n.end)) : text.slice(n.getStart(),n.end).startsWith(prefix)));
 Function('env',`with(env){${code}}`)(env);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

for(const kind of ['Program','Window'])test(`B5-29: old ${kind} completion cannot close or unlock a reopened launcher`,async()=>{
 const barrier=deferred(),emits=[];
 const env={choiceGeneration:1,buildCreateIntent,pendingIntent:ref({kind:'program'}),programBinary:ref('/bin/editor'),programRole:ref('human'),programError:ref(''),programBusy:ref(false),choosingProgram:ref(true),selectedWindow:ref({xid:123,witness:'123:1',title:'Editor',program:'editor',width:800,height:600}),windowError:ref(''),windowBusy:ref(false),choosingWindow:ref(true),windowChoiceXid:ref(123),emit:(event,...args)=>{emits.push(event);if(event==='create')args[1](barrier.promise);}};
 const unit=functions('catalog',['confirm'+kind],env);
 const pending=unit['confirm'+kind]();
 env.choiceGeneration++;env[kind==='Program'?'programBusy':'windowBusy'].value=true;
 barrier.resolve({ok:true});await pending;
 assert.equal(emits.includes('update:visible'),false);
 assert.equal(env[kind==='Program'?'programBusy':'windowBusy'].value,true,'old finally must not unlock the new invocation');
});

test('B5-29: saved program completion is fenced after reopening and a fresh refresh is admitted',async()=>{
 const barrier=deferred(),emits=[];
 const env={isForeignIdentity:()=>false,identityErrorText:x=>x,invocationGeneration:1,busy:ref(false),error:ref(''),rows:ref([{id:'editor',browser:'program'}]),modeFor:()=>({available:true,binary:'/bin/editor'}),roleApi:{createProgram:()=>barrier.promise},props:{},emit:event=>emits.push(event)};
 const unit=functions('identities',['openIdentity'],env);const pending=unit.openIdentity('editor','human');env.invocationGeneration++;env.busy.value=true;
 barrier.resolve({ok:true});await pending;assert.deepEqual(emits,[]);assert.equal(env.busy.value,true);
 let listed=0;env.props={open:false};env.login=ref(false);env.pendingRelease=ref({profileId:'account-a',holder:'srf-id-orphan'});env.invoke=()=>{listed++;};env.watch=(_get,callback)=>{env.busy.value=true;callback(true);};
 watchCode('identities','identity-refresh',env);
 assert.equal(listed,1);assert.equal(env.busy.value,false);assert.equal(env.pendingRelease.value,null);
});

test('B5-30: a late valid identity clears only the obsolete NO_IDENTITY alert',async()=>{
 const barrier=deferred();
 const env={buildCreateIntent,api:{choices:()=>barrier.promise},choiceGeneration:0,props:{visible:true},pendingIntent:ref(null),roleChoice:ref('agent'),roleError:ref(''),roleEdited:ref(false),editedRoleChoice:ref('agent'),profileChoices:ref([]),profileChoice:ref(''),choosingRole:ref(false),emit:()=>{throw Error('must not auto-create');}};
 Object.defineProperty(env,'matchingProfiles',{get:()=>env.profileChoices});
 const name=find('catalog',n=>ts.isFunctionDeclaration(n) && /await api.choices/.test(n.getText())).match(/function (\w+)/)[1];
 const unit=functions('catalog',[name,'confirmRole'],env);const pending=unit[name]({type:{id:'identity-browser'}});unit.confirmRole();assert.match(env.roleError.value,/NO_IDENTITY/);
 barrier.resolve([{profileId:'healthy',role:'agent',available:true}]);await pending;assert.equal(env.profileChoice.value,'healthy');assert.equal(env.roleError.value,'');
});

test('B5-31: failed delete diagnostic survives a closed dialog and refresh without replay',async()=>{
 const barrier=deferred();let deletes=0;
 const env={invocationGeneration:1,failedDelete:'',busy:ref(false),login:ref(false),error:ref(''),pendingDelete:ref('account'),isForeignIdentity:()=>false,identityErrorText:(code,id)=>`${code}: ${id}`,props:{host:{identity:{delete:()=>{deletes++;return barrier.promise;},list:async()=>({ok:true,rows:[]})}}},rows:ref([])};
 const unit=functions('identities',['invoke'],env);const pending=unit.invoke('delete',{id:'account'});env.invocationGeneration++;env.busy.value=false;
 barrier.resolve({ok:false,code:'IDENTITY_BOUND'});await pending;
 env.invocationGeneration++;await unit.invoke('list');assert.match(env.error.value,/IDENTITY_BOUND.*account/);assert.equal(deletes,1);assert.equal(env.pendingDelete.value,'account');
});

test('B5-32: storyboard covering transitions preserve explicit panel closures',()=>{
 const env={wallView:{},settled:ref(true),desktopWallReady:true,revealed:new Set(['a']),closedPanels:ref(['a']),cancelFirstFrame(){},watch:(_get,callback)=>{callback('creative');callback('workspace');}};
 watchCode('app','watch(wallView, view => {',env);assert.deepEqual(env.closedPanels.value,['a']);assert.equal(env.settled.value,true);
});

for(const kind of ['Program','Window'])for(const failure of ['false','throw'])test(`B5-33: ${kind} ${failure} reveal preserves native success and exposes retry instructions`,async()=>{
 const env={hostActive:true,hostOutcome:ref(null),onCapsuleMode(){},pollNativeSurfaces:async()=>{},wall:ref({followSurface:async()=>{if(failure==='throw')throw Error('REVEAL');},revealSurface:()=>({ok:false})}),settled:ref(true),markPanelOpen:()=>{throw Error('not revealed');},setTimeout:callback=>{callback();},props:{},selectGlobalView(){},nextTick:async()=>{}};
 const old=globalThis.metaviewerRoles;globalThis.metaviewerRoles={createProgram:async()=>({ok:true,surfaceId:'s1',role:'human'}),createWindow:async()=>({ok:true,surfaceId:'s1'})};
 try {const names=['revealOpenedIdentity','createProgramCapsule','createWindowCapsule'];if(source('app').includes('function reportRevealPending'))names.push('reportRevealPending');
 const unit=functions('app',names,env);const reply=await unit['create'+kind+'Capsule']({binary:'/bin/editor',role:'human',window:{xid:123}});assert.equal(reply.ok,true);assert.match(env.hostOutcome.value?.message||'',/running.*Identities.*retry/);assert.match(env.hostOutcome.value.code,/REVEAL/);
 }finally{globalThis.metaviewerRoles=old;}
});

test('B5-34: stream replacement cancels old pointerup; a new stream press still clicks',()=>{
 let callback;const clicks=[];
 const press={pointerId:1,button:0,inFrame:true};
 const env={props:{streamId:1,surfaceId:'s'},activePress:{...press},closeInputGate(){},watch:(_get,cb)=>{callback=cb;},inputGateOpen:()=>true,POINTER_BUTTONS:['left'],clientToFramePoint:()=>({x:4,y:5}),inputPort:{queue:(...args)=>clicks.push(args)},showEcho(){}};
 const unit=functions('canvas',['onCanvasPointerUp'],env);
 watchCode('canvas','watch(() => props.streamId,',env);env.props.streamId=2;callback(2,1);
 unit.onCanvasPointerUp({pointerId:1,button:0});assert.deepEqual(clicks,[]);
 env.activePress={...press};callback(2,2);unit.onCanvasPointerUp({pointerId:1,button:0});assert.equal(clicks.length,1);assert.equal(clicks[0][1],2);
});

test('B5-35: retained scheduler history is baselined; subsequent presentations still count',()=>{
 let count=80000,painted=0;
 const env={scheduler:{getInstrumentation:()=>({presentCount:count,lastPresentedHandle:'h'+count})},props:{surfaceId:'s'},presentationBaselined:false,lastObservedPresentCount:0,lastObservedPresentedHandle:'',parseCaptureUsValue:()=>null,onFramePainted:()=>{painted++;},readFpsClock:()=>0,wallFpsWindowMs:1000,pruneFpsWindow(){},scheduleFpsFlush(){}};
 const unit=functions('canvas',['checkSchedulerPresentation'],env);unit.checkSchedulerPresentation();assert.equal(painted,0);count++;unit.checkSchedulerPresentation();assert.equal(painted,1);
});

function roleEnv() {
 const barrier=deferred(),calls=[];
 const env={nativeThemeSignature:'',nativePreview:ref(''),previewOccluded:ref(false),syncGeneration:0,ended:false,notifiedEnd:false,alive:true,mounted:true,busy:false,resync:false,transferring:false,signature:'',shown:true,api:{status:()=>barrier.promise,close:async()=>{calls.push('close');},stop:async()=>{calls.push('stop');return {ok:true};},detachWindow:async()=>{calls.push('detach');return {ok:true};},mount:async()=>{calls.push('mount');return {ok:true};},resize:async()=>{calls.push('resize');return {ok:true};}},props:{surfaceId:'s',control:'human',presentationActive:true},error:ref(''),progress:ref(''),resourceReleased:ref(false),hostWindow:ref({state:'active'}),hostXpra:ref(false),reopenableHostWindow:ref(false),viewState:ref('ready'),hasConnected:ref(true),recordingPaused:ref(false),menuOpen:ref(false),hiddenSessions:null,root:ref({getBoundingClientRect:()=>({})}),collectClipRects:()=>({}),floatingPresentation:()=>({}),clipRoleBounds:()=>({visible:true,bounds:{}}),subtractRoleOccluders:()=>({visible:true,bounds:{}}),isRoleElementPainted:()=>true,isModalActive:()=>false,wanted:()=>true,role:ref('human'),watching:ref(false),emit:()=>{},isGeometricallyShown:()=>true,releaseHiddenSession(){},setTimeout};
 return {env,barrier,calls};
}
test('B5-36: detach fences the pending status before it can mount or resize',async()=>{
 const {env,barrier,calls}=roleEnv();const unit=functions('role',['sync','revoke','detachHostWindow'],env);const pending=unit.sync();await flush();await unit.detachHostWindow();barrier.resolve({ok:true});await pending;assert.deepEqual(calls,['close','detach']);
});
test('B5-37: Stop progresses while status never settles and its late continuation stays fenced',async()=>{
 const {env,barrier,calls}=roleEnv();env.hostWindow.value=null;
 const unit=functions('role',['sync','revoke','lifecycle','detachHostWindow'],env);const pending=unit.sync();const stopping=unit.lifecycle('stop');await flush();
 // Settle even on the old implementation so the negative control cannot hang the runner.
 const progressed=calls.includes('stop');barrier.resolve({ok:true});await Promise.all([pending,stopping]);assert.equal(progressed,true);assert.equal(calls.includes('resize')||calls.includes('mount'),false);
});

test('B5-28: failed closes back off, stop automatic retries and retain visible custody; transient retry releases',async()=>{
 let callback,attempts=0,now=0,recover=false;
 const env={core:{},capsuleStates:new Map(),openingRoles:new Map(),epochs:new Map(),sessions:new Map([['s',{close:async()=>{attempts++;if(!recover)throw Error('CLOSE');}}]]),failedSessions:new Map(),closeRetries:new Map(),closing:new Map(),viewStates:new Map(),performance:{now:()=>now},roleFor:()=> 'human',authoritative:()=>({}),console:{info(){}},pruneProgramProfiles(){},status:()=>({control:'agent',role:'human'}),setInterval:cb=>{callback=cb;return {unref(){}};}};
 const names=['close'];if(source('host').includes('function closeSession'))names.push('closeSession');const unit=functions('host',names,env);Object.assign(env,unit);
 const code=find('host',n=>ts.isVariableDeclaration(n)&&n.name?.getText()==='timer'&&/setInterval/.test(n.getText()));Function('env',`with(env){const ${code};}`)(env);
 await assert.rejects(unit.close('s'));assert.equal(env.failedSessions.has('s'),true);assert.equal(env.viewStates.get('s')?.code,'XPRA_CLOSE_UNRESOLVED');
 callback();await flush();assert.equal(attempts,1,'no immediate retry');
 for(let i=0;i<20;i++){now+=100000;callback();await flush();}
 assert.equal(attempts,4,'bounded automatic attempts');recover=true;await unit.close('s');assert.equal(env.failedSessions.has('s'),false);assert.equal(env.viewStates.has('s'),false);
});

import {installRoleHost} from '../electron/roleHost.js';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
async function hostFixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'mv-l3-Música-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const states=new Map(),truth=new Map();let handler;
 const window=new EventEmitter();window.webContents={session:{registerPreloadScript(){},unregisterPreloadScript(){}}};
 const profile={Kind:'browser',NativeKind:'browser',Width:1280,Height:900,RAMRoot:'/dev/shm',Display:':0',role:'human'};
 const host=installRoleHost({electron:{ipcMain:{handle:(_key,fn)=>{handler=fn;},removeHandler(){}},app:{getPath:()=>dir}},window,core:{getHumanSurface:id=>truth.get(id)},capsuleStates:states,env:{MV_SRF_STATE_DIR:dir,MV_SRF_PROFILES:JSON.stringify({healthy:profile,broken:profile})},listIdentities:async()=>({ok:true,rows:[{id:'healthy'},{id:'broken'}]}),admit:()=>true});
 t.after(()=>host.dispose());
 return {dir,states,truth,call:(op,extra={})=>handler({}, {schema:'metaviewer.roles/v0.3',op,...extra})};
}
test('B5-27: a corrupt login marker leaves healthy identities selectable and diagnoses the bad row',async t=>{
 const f=await hostFixture(t);await mkdir(join(f.dir,'identity-markers'),{mode:0o700});await writeFile(join(f.dir,'identity-markers','broken.json'),'corrupt',{mode:0o600});
 const rows=await f.call('choices');assert.ok(Array.isArray(rows));assert.equal(rows.find(r=>r.profileId==='healthy').available,true);assert.equal(rows.find(r=>r.profileId==='healthy').markerError,null);assert.equal(rows.find(r=>r.profileId==='broken').markerError,'IDENTITY_MARKER_REFUSED');assert.equal(rows.find(r=>r.profileId==='broken').lastLogin,null);
});
test('B5-47: divergent authority is a lost diagnostic row while the healthy projection survives',async t=>{
 const f=await hostFixture(t);
 for(const id of ['healthy','broken']){const row={schema:'surface/v0.2',surface_id:'surface-'+id,profile_id:id,kind:'browser',state:'active',control:'human',visibility:'unfolded',display:':0',geometry:{w:1280,h:900}};f.states.set(row.surface_id,row);if(id==='healthy')f.truth.set(row.surface_id,row);}
 const rows=await f.call('surfaces');assert.ok(Array.isArray(rows));assert.equal(rows.find(r=>r.surface.profile_id==='healthy').surface.state,'active');const bad=rows.find(r=>r.surface.profile_id==='broken');assert.equal(bad.surface.state,'lost');assert.equal(bad.diagnostic,'SURFACE_AUTHORITY_MISMATCH');assert.equal((await f.call('mount',{surfaceId:'surface-broken',bounds:{x:0,y:0,width:100,height:100}})).ok,false);
});

test('B5-47: App displays authority mismatch and admits only the healthy row',async()=>{
 const nativeRows=ref([]),hostOutcome=ref(null),surface=id=>({schema:'surface/v0.2',surface_id:id,profile_id:id,state:'active',control:'human'});
 const env={nativePolling:false,hostActive:true,nativeApi:{surfaces:async()=>[{schema:'metaviewer.role_surface/v0.3',role:'human',surface:surface('healthy')},{schema:'metaviewer.role_surface/v0.3',role:'human',surface:{...surface('broken'),state:'lost'},diagnostic:'SURFACE_AUTHORITY_MISMATCH'}]},nativeLoaded:false,nativePollFailed:false,nativeRows,hostOutcome,nativeRevision:0,onCapsuleMode(){},nativeListeners:new Set(),nativeSnapshot:()=>({})};
 const unit=functions('app',['pollNativeSurfaces'],env);await unit.pollNativeSurfaces();assert.deepEqual(nativeRows.value.map(row=>row.id),['healthy']);assert.match(hostOutcome.value?.message || '',/broken.*other capsules remain available/);
});
