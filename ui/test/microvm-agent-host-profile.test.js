import test from 'node:test';
import assert from 'node:assert/strict';
import {installedAgentProfiles} from '../electron/agentProviders.js';
import {validateProviderEnv} from '../electron/ptyBroker.js';
const env={MV_ARM64_CAPSULES:'1',HOME:'/dev/shm/fixture/home',PATH:'/usr/bin:/bin',XDG_RUNTIME_DIR:'/run/user/1000/app-fixture',DBUS_SESSION_BUS_ADDRESS:'private-bus',API_TOKEN:'private-token',MV_HOST_HOME:'/spoofed',USERPROFILE:'/spoofed'};
test('ARM private-home app resolves and launches the host-user installed CLI without changing app env',()=>{
 const before={...env},calls=[];
 const profiles=installedAgentProfiles(env,(name,context)=>{calls.push({name,context});if(name==='codex' && context.PATH.split(':')[0]==='/host-person/.local/bin')return {path:'/host-person/.local/bin/codex'};throw Error('missing');},()=>({homedir:'/host-person'}));
 const profile=profiles.get('agent-codex');assert.ok(profile);
 assert.deepEqual(profile.argv,['/host-person/.local/bin/codex']);assert.equal(profile.cwd,'/host-person');
 assert.equal(profile.env.HOME,'/host-person');assert.equal(profile.env.XDG_RUNTIME_DIR,env.XDG_RUNTIME_DIR);
 assert.equal(profile.env.PATH.split(':')[0],'/host-person/.local/bin');
 assert.deepEqual(Object.keys(profile.env).sort(),['HOME','PATH','TERM','XDG_RUNTIME_DIR']);
 assert.deepEqual(validateProviderEnv(profile.env,Object.keys(profile.env)),profile.env);
 assert.deepEqual(env,before);assert.equal(calls.length,3);
 assert.ok(calls.every(call=>call.context.HOME==='/host-person' && !Object.hasOwn(call.context,'API_TOKEN')));
});
test('ARM never discovers a CLI in spoofed HOME and missing binaries stay absent',()=>{
 const paths=[];
 const profiles=installedAgentProfiles({...env,HOME:'/spoofed'},(name,context)=>{paths.push(context.PATH);if(context.PATH.includes('/spoofed/.local/bin'))return {path:'/spoofed/.local/bin/'+name};throw Error('missing');},()=>({homedir:'/host-person'}));
 assert.equal(profiles.size,0);assert.ok(paths.every(path=>!path.includes('/spoofed')));
});
test('ARM rejects missing or malformed trusted host home/runtime before resolving',()=>{
 for(const home of [undefined,'relative','/host/../spoofed','/host\nspoofed']){
  let calls=0;const profiles=installedAgentProfiles(env,()=>{calls++;return {path:'/usr/bin/codex'};},()=>({homedir:home}));assert.equal(profiles.size,0);assert.equal(calls,0);
 }
 let calls=0;assert.equal(installedAgentProfiles({...env,XDG_RUNTIME_DIR:undefined},()=>{calls++;return {path:'/usr/bin/codex'};},()=>({homedir:'/host-person'})).size,0);assert.equal(calls,0);
});
test('non-ARM profile behavior stays unchanged and never queries the login user',()=>{
 for(const flag of [undefined,'0','true']){
  const input={...env,MV_ARM64_CAPSULES:flag};
  const profile=installedAgentProfiles(input,name=>{if(name==='codex')return {path:'/tools/codex'};throw Error('missing');},()=>{throw Error('must not query user');}).get('agent-codex');
  assert.equal(profile.cwd,env.HOME);assert.equal(profile.env,undefined);assert.deepEqual(profile.argv,['/tools/codex']);
 }
});
