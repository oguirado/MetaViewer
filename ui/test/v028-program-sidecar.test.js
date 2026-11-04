import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {programBinaries} from '../electron/programBinaries.js';
import {installRoleHost} from '../electron/roleHost.js';

test('cold program sidecars never resurrect deleted identities as host programs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'v028-sidecars-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'program-binaries');
  const store=programBinaries(directory);
  await store.remember('standalone',process.execPath,true);
  await store.copyWith({profile_id:'standalone',destination_profile_id:'deleted-identity',
    operation_id:'copy-proof',slot_id:'slot-one'},async()=>({
      schema:'capsule_state_event/v0.2',op:'copy',event:'completed',profile_id:'standalone',
      operation_id:'copy-proof',slot_id:'slot-one',
    }));
  const reopened=programBinaries(directory);
  await reopened.reconcile([]);
  assert.deepEqual(await reopened.hostProfiles(),[{id:'standalone',browser:'program'}]);
  assert.equal((await reopened.readLaunch('deleted-identity')).identityBound,true);
});

test('program launcher requires identity rows for bound sidecars and retains standalone hosts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'v028-launcher-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=programBinaries(join(root,'program-binaries'));
  await store.remember('deleted-identity',process.execPath,true,true);
  await store.remember('live-identity',process.execPath,true,true);
  await store.remember('standalone',process.execPath,true);
  let identities=[{id:'live-identity',browser:'program'}];
  let handler;
  const window=new EventEmitter();
  window.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
  const host=installRoleHost({
    electron:{ipcMain:{handle(_key,fn){handler=fn;},removeHandler(){}}},window,core:{},
    env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:'{}'},capsuleStates:new Map(),admit:()=>true,
    listIdentities:async()=>({ok:true,rows:identities}),
  });
  t.after(()=>host.dispose());
  const programs=()=>handler({}, {schema:'metaviewer.roles/v0.3',op:'programs'});
  const rows=await programs();
  assert.deepEqual(rows.map(row=>row.profileId).sort(),['live-identity','standalone']);
  assert.equal(rows.find(row=>row.profileId==='live-identity').identityBound,true);
  identities=[];
  assert.deepEqual((await programs()).map(row=>row.profileId),['standalone']);
  assert.equal(await store.readLaunch('live-identity'),null);
});
