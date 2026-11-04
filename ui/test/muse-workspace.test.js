import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claimMuseWorkspace} from '../electron/museWorkspace.js';
function setup(t){const root=mkdtempSync(join(tmpdir(),'metaviewer-muse-'));chmodSync(root,0o700);t.after(()=>rmSync(root,{recursive:true,force:true}));const runtime=join(root,'mv-pkg-fixture');mkdirSync(runtime,{mode:0o700});mkdirSync(join(root,'memoryweb'),{mode:0o700});writeFileSync(join(root,'.owner.json'),JSON.stringify({schema:'metaviewer.muse-session/v1',launcher_pid:process.pid,launcher_start:readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19]}),{mode:0o600});writeFileSync(join(runtime,'config.json'),JSON.stringify({session_id:'pkg-fixture'}),{mode:0o600});return {root,runtime,env:{MV_MUSE_WORKSPACE:root,XDG_RUNTIME_DIR:runtime,MV_SESSION_ID:'pkg-fixture',MV_CORE_CONFIG:join(runtime,'config.json')}};}
test('Muse workspace binds one app session to an exclusive owner-only state root',t=>{const f=setup(t);assert.equal(claimMuseWorkspace(f.env),f.root);assert.throws(()=>claimMuseWorkspace(f.env),/MUSE_WORKSPACE/);assert.throws(()=>claimMuseWorkspace({...f.env,MV_SESSION_ID:'pkg-other'}),/MUSE_WORKSPACE/);});
test('Muse workspace refuses broad, permissive, aliased and foreign runtime roots',t=>{const f=setup(t);for(const patch of [{MV_MUSE_WORKSPACE:tmpdir()},{XDG_RUNTIME_DIR:tmpdir()},{MV_SESSION_ID:''}])assert.throws(()=>claimMuseWorkspace({...f.env,...patch}),/MUSE_WORKSPACE/);chmodSync(f.root,0o755);assert.throws(()=>claimMuseWorkspace(f.env),/MUSE_WORKSPACE/);chmodSync(f.root,0o700);const alias=join(f.root,'alias');symlinkSync(f.runtime,alias);assert.throws(()=>claimMuseWorkspace({...f.env,XDG_RUNTIME_DIR:alias}),/MUSE_WORKSPACE/);});
test('Muse workspace refuses unowned launch markers and unrelated files',t=>{const f=setup(t);writeFileSync(join(f.root,'unexpected'), 'data');assert.throws(()=>claimMuseWorkspace(f.env),/MUSE_WORKSPACE/);rmSync(join(f.root,'unexpected'));writeFileSync(join(f.root,'.owner.json'),JSON.stringify({schema:'metaviewer.muse-session/v1',launcher_pid:999999999}));assert.throws(()=>claimMuseWorkspace(f.env),/MUSE_WORKSPACE/);});

import {installedAgentProfiles} from '../electron/agentProviders.js';
test('private Muse profile uses only session data as its writable workspace, guides stay outside',t=>{
 const f=setup(t);const profile=installedAgentProfiles({...f.env,HOME:'/host-person',PATH:'/usr/bin:/bin',MV_OPERATOR_REPO:'/readonly-guides'},name=>{if(['muse','unshare'].includes(name))return {path:'/usr/bin/'+name};throw Error('missing');}).get('agent-muse');
 assert.ok(profile);assert.equal(profile.cwd,f.root);assert.equal(profile.argv[profile.argv.indexOf('--workspace')+1],f.root);
 assert.equal(profile.argv.includes('/readonly-guides'),false);assert.equal(profile.env.XDG_RUNTIME_DIR,f.runtime);
 assert.equal(profile.argv.includes('--trust-workspace'),false);assert.equal(profile.argv.includes('--disable-sandbox'),false);
});

import {museRuntimeParent} from '../tools/package.js';
test('session runtime moves into the exact private workspace without moving general temporary files',()=>{
 const env={XDG_RUNTIME_DIR:'/run/user/1000/metaviewer-muse-fixture',MV_MUSE_WORKSPACE:'/run/user/1000/metaviewer-muse-fixture'};
 assert.equal(museRuntimeParent(env,'/tmp/default'),env.MV_MUSE_WORKSPACE);
 assert.equal(museRuntimeParent({},'/tmp/default'),'/tmp/default');
 assert.throws(()=>museRuntimeParent({...env,XDG_RUNTIME_DIR:'/run/user/1000'},'/tmp/default'),/MUSE_WORKSPACE/);
 assert.throws(()=>museRuntimeParent({MV_MUSE_WORKSPACE:'relative'},'/tmp/default'),/MUSE_WORKSPACE/);
});
