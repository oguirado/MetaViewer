import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installRoleHost} from '../electron/roleHost.js';

// The launcher Recent group is fed by the role host's own host-program launch,
// not by a direct catalog call: create-program then list-apps over the real IPC handler.
test('a host launch of an installed app feeds the launcher Recent group; a refused launch does not',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mv-recent-launch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dataHome=join(root,'data'),bin=join(root,'bin'),state=join(root,'state');
  await mkdir(join(dataHome,'applications'),{recursive:true});await mkdir(bin);await mkdir(state);
  const editor=join(bin,'recent-proof-editor');
  await writeFile(editor,'#!/bin/sh\nexit 0\n',{mode:0o755});
  await writeFile(join(dataHome,'applications','recent-proof-editor.desktop'),`[Desktop Entry]\nType=Application\nName=Recent Proof Editor\nExec=${editor} %U\n`);
  const states=new Map(),handlers=new Map(),creates=[];
  let refuseCreate=true;
  const core={getHumanSurface:id=>states.get(id),async request(message){
    creates.push(message);
    if(refuseCreate)return {schema:'surface_event/v0.2',event:'refused',data:{code:'SURFACE_CAPACITY_OR_QUARANTINE'}};
    const surface={surface_id:'surface-'+creates.length,profile_id:message.params.profile_id,state:'active',control:'human'};
    states.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
  }};
  const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
  const host=installRoleHost({electron:{ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)}},window:parent,core,
    env:{MV_SRF_STATE_DIR:state,MV_SRF_PROFILES:'{}',XDG_DATA_HOME:dataHome},capsuleStates:states,admit:()=>true,readFreeMemoryBytes:async()=>16*1024**3,
    listIdentities:async()=>({ok:true,rows:[]}),provisionProgramIdentity:async()=>({ok:true}),stageMode:async()=>async()=>{}});
  t.after(()=>host.dispose());
  const call=(op,extra={})=>Promise.resolve(handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op,...extra})).catch(error=>({ok:false,error}));
  const launch=()=>call('create-program',{choice:{binary:editor,hostXpra:true,role:'human'}});

  let listed=await call('list-apps');
  const app=listed.apps.find(item=>item.name==='Recent Proof Editor');
  assert.ok(app,'the installed app is listed');assert.equal(app.binary,editor);
  assert.deepEqual(listed.recent,[]);

  // Negative control: a launch the core refuses leaves Recent empty.
  const refused=await launch();
  assert.notEqual(refused.ok,true);assert.equal(creates.length,1);
  listed=await call('list-apps');assert.deepEqual(listed.recent,[]);

  refuseCreate=false;
  const opened=await launch();
  assert.equal(opened.ok,true);assert.equal(opened.path,editor);assert.equal(creates.length,2);
  listed=await call('list-apps');
  assert.deepEqual(listed.recent,[app.id]);
});
