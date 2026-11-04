import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {installRoleHost} from '../electron/roleHost.js';

test('existing program identity is reused without trying to provision it again',async t=>{
  const root=await mkdtemp(join(tmpdir(),'switch-program-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const binary=join(root,'editor');await writeFile(binary,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const handlers=new Map(),states=new Map();let provisions=0,creates=0;
  const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript:()=> 'p',unregisterPreloadScript(){}}};
  const host=installRoleHost({electron:{ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler(){}}},window:parent,
    env:{MV_SRF_PROFILES:'{}',MV_SRF_STATE_DIR:root,MV_SRF_BIN_DIR:root},capsuleStates:states,admit:()=>true,
    readFreeMemoryBytes:async()=>32*1024**3,
    listIdentities:async()=>({ok:true,rows:[{id:'editor',browser:'program'}]}),
    provisionProgramIdentity:async()=>{provisions++;return {ok:false,code:'IDENTITY_UNAVAILABLE'};},
    core:{getHumanSurface:id=>states.get(id),request:async()=>{creates++;const surface={surface_id:'program',profile_id:'editor',state:'active',control:'human'};states.set('program',surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};}}});
  t.after(()=>host.dispose());
  const result=await handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op:'create-program',choice:{binary,role:'human'}});
  assert.equal(result.ok,true);assert.equal(provisions,0);assert.equal(creates,1);
});
