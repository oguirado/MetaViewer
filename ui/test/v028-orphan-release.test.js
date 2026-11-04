import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// Stub only the native recovery boundary, retaining the real role IPC handler,
// admission, create reply validation and shared observer evidence set.
const roleUrl = new URL('../electron/roleHost.js', import.meta.url);
const recoveryModule = 'data:text/javascript;base64,' + Buffer.from(`
export const defaultIdentityTool=()=>'/synthetic/identity-tool';
export const resolveIdentityTool=({tool})=>tool;
export const identityEnvironment=env=>env;
export const identityRunner=()=>globalThis.__orphanRecovery;
`).toString('base64');
const source = (await readFile(roleUrl, 'utf8')).replaceAll('import.meta.url',JSON.stringify(roleUrl.href)).replace(/(['"])(\.\/[^'"]+)\1/g, (_all, _quote, path) =>
  JSON.stringify(path === './operatorBridge.js' ? recoveryModule : new URL(path, roleUrl).href));
const { installRoleHost } = await import('data:text/javascript;base64,' + Buffer.from(source+'\n//# sourceURL=roleHost-orphan-fixture.js').toString('base64'));

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'orphan-release-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const handlers = new Map(), unavailable = new Set(['account-a']), calls = [];
  const states = new Map();
  let result = {schema:'surface_event/v0.2',event:'error',data:{code:'adapter',detail:'other refusal'}};
  let failRecovery = false;
  globalThis.__orphanRecovery = async (method, request) => {
    if (method === 'recovery') return {held:true,holder:'srf-id-orphan'};
    calls.push(request);
    if (failRecovery) throw Error('IDENTITY_BOUND');
    return {ok:true};
  };
  t.after(()=>delete globalThis.__orphanRecovery);
  const window = new EventEmitter();window.webContents = {session:{registerPreloadScript:()=> 'preload',unregisterPreloadScript:()=>{}}};
  const host = installRoleHost({electron:{ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:()=>{}}},
    window, env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:JSON.stringify({'account-a':{Kind:'browser'}})}, capsuleStates:states,
    core:{request:async()=>{if(result instanceof Error)throw result;return result;}}, admit:()=>true,
    listIdentities:async()=>({ok:true,rows:[{id:'account-a'}]}),
    unavailableIdentities:unavailable,recoveryAdapterPid:()=>4242,
    readFreeMemoryBytes:async()=>16*1024**3,stageMode:async()=>async()=>{},
  });
  t.after(()=>host.dispose());
  const request = (op,choice) => handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op,choice});
  return {unavailable,calls,request,set result(value){result=value;},set failRecovery(value){failRecovery=value;}};
}
const choice = {profileId:'account-a',holder:'srf-id-orphan'};

test('failed create preserves observer evidence for subsequent Release',async t=>{
  const f=fixture(t);
  for (const result of [new Error('transport disconnected'),{schema:'surface_event/v0.2',event:'error',data:{code:'adapter',detail:'other refusal'}}]) {
    f.unavailable.add('account-a');f.result=result;
    const reply=await f.request('create',{profileId:'account-a',role:'agent'});
    assert.equal(reply.ok,false);
    assert.equal(f.unavailable.has('account-a'),true);
    assert.equal((await f.request('release-identity',choice)).ok,true);
    assert.equal(f.calls.at(-1).observerPid,4242);
  }
});

test('only verified release clears observer evidence before later custody',async t=>{
  const f=fixture(t);f.failRecovery=true;
  assert.equal((await f.request('release-identity',choice)).ok,false);
  assert.equal(f.unavailable.has('account-a'),true);
  f.failRecovery=false;
  assert.equal((await f.request('release-identity',choice)).ok,true);
  assert.equal(f.unavailable.has('account-a'),false);
  assert.equal((await f.request('release-identity',choice)).ok,true);
  assert.equal(f.calls.at(-1).observerPid,null);
});

test('verified create clears old observer evidence',async t=>{
  const f=fixture(t);
  f.result={schema:'surface_event/v0.2',event:'created',data:{surface:{surface_id:'surface-a',profile_id:'account-a',state:'active',control:'agent'}}};
  assert.equal((await f.request('create',{profileId:'account-a',role:'agent'})).ok,true);
  assert.equal(f.unavailable.has('account-a'),false);
});
