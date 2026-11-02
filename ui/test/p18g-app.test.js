import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse,compileScript} from '@vue/compiler-sfc';
const source=readFileSync(process.env.P18G_APP_SOURCE || new URL('../src/App.vue',import.meta.url),'utf8');
const {descriptor}=parse(source),compiled=compileScript(descriptor,{id:'p18g-app'}),script=descriptor.scriptSetup.content;
const functions=Object.fromEntries(compiled.scriptSetupAst.filter(n=>n.type==='FunctionDeclaration').map(n=>[n.id.name,script.slice(n.start,n.end)]));
const ref=value=>({value});
function controlFixture(extra={}){
 const context={nestedMode:{displayOnly:false},rows:ref([{id:'tile',control:'agent',backendLifecycle:'active'}]),capsuleModes:ref({tile:'agent'}),wallInputPending:ref({}),wallInputArmed:ref({}),wallInputEscaped:ref({}),props:{runtime:{}},hostOutcome:ref(null),ARMABLE_LIFECYCLES:['active','standby','ceded'],hostActive:true,seenLiveSurfaces:new Set(['tile']),shellInputPort:{available:true},canvasStateFor:()=> 'live',dispatch:()=>undefined,...extra};
 vm.createContext(context);vm.runInContext(['withoutId','disarmWallInput','armWallInput','applyWallControl','reconcileWallInput'].map(n=>functions[n]).join('\n'),context);return context;
}
test('H1 missing or throwing intent builders clear pending control state',()=>{
 for(const runtime of [{},{intentBuilders:{control(){throw Error('BUILDER_FAILED');}}}]){
  const c=controlFixture({props:{runtime}});c.applyWallControl('tile','take_control');assert.equal(Object.keys(c.wallInputPending.value).length,0);
 }
});
test('H2 projection updates preserve an escaped live input-enabled row without an explicit arm',()=>{
 const c=controlFixture({wallInputEscaped:ref({tile:true}),rows:ref([{id:'tile',control:'human',backendLifecycle:'active'}])});c.reconcileWallInput();assert.equal(c.wallInputEscaped.value.tile,true);
});
test('H5 an acknowledged ended surface is forgotten even if replacement reveal fails',async()=>{
 const stopped=[];let submitted;const c={submitHost:fn=>(submitted=fn()),revealOpenedIdentity:async()=>false,onCapsuleStopped:id=>stopped.push(id)};
 vm.createContext(c);vm.runInContext(functions.onCapsuleLifecycle,c);c.onCapsuleLifecycle({surfaceId:'old',completion:Promise.resolve({ok:true,surfaceId:'new',role:'human'})});
 await assert.rejects(submitted,/TILE_REVEAL_UNPROVEN/);assert.deepEqual(stopped,['old']);
});
test('H3 old surface teardown after acknowledged switch is required even when reveal returns false',async()=>{
 const stopped=[];const c={pendingModeSwitch:ref({surfaceId:'old'}),metaviewerRoles:{switchMode:async()=>({ok:true,surfaceId:'new',role:'human'})},submitHost:fn=>fn(),revealOpenedIdentity:async()=>false,onCapsuleStopped:id=>stopped.push(id)};
 vm.createContext(c);vm.runInContext(functions.confirmModeSwitch,c);await c.confirmModeSwitch();assert.deepEqual(stopped,['old']);
});

test('H4 native poll errors mark the retained surface projection stale',async()=>{
 const declaration=compiled.scriptSetupAst.flatMap(n=>n.type==='VariableDeclaration'?n.declarations:[]).find(n=>n.id.name==='nativeSnapshot');
 const c={baseFeed:{getSnapshot:()=>({status:'live',stale:false,envelope:{epoch:1,projection:{rows:[]}}})},nativeRows:ref([{id:'human'}]),nativeRevision:1,nativePolling:false,nativeLoaded:true,nativePollFailed:false,hostActive:true,nativeApi:{surfaces:async()=>{throw Error('OFFLINE');}},nativeListeners:new Set(),mergedRows:()=>[{id:'human'}]};
 vm.createContext(c);vm.runInContext('const nativeSnapshot='+script.slice(declaration.init.start,declaration.init.end)+';globalThis.readSnapshot=nativeSnapshot;\n'+functions.pollNativeSurfaces,c);
 await c.pollNativeSurfaces().catch(()=>{});assert.equal(c.readSnapshot().stale,true);
});
