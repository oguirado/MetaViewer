import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {guestCommandProfileOwnerSync,arm64CapsuleStatusSync,requireGuestCommandMode} from '../electron/guestCommandProfile.js';
import {headlessAgentInstance,arm64CapsuleSessionPlan,OPERATOR_RESOURCES} from '../tools/package.js';
import {scrubAdapterEnv} from '../electron/coreLauncher.js';

test('protected rewind bootstrap uses dedicated agent binding, refuses mixed modes, remains absent on x64',async()=>{
 const root=await mkdtemp('/dev/shm/rw-profile-');
 try{
  const instance='agent-rewind-test',owner='actor-'+createHash('sha256').update('agent:'+instance).digest('hex'),file=root+'/profile.json';
  const profile={schema:'mv-rewind-host/v1',owner_id:owner,guardian_unit:'own.service',python:{path:'/python',sha256:'a'.repeat(64)},python_prefix:await realpath('/usr'),runner:{path:'/runner',sha256:'b'.repeat(64)},controller_relative:'rewind_runtime/controller.py',files:[],config_template:{schema:'rewind-host-config/v1',owner_id:owner,runtime_admitted:true},state_root:root,runtime_root:root};
  await writeFile(file,JSON.stringify(profile),{mode:0o600});
  const env={MV_REWIND_ENABLED:'1',MV_REWIND_ONLY:'1',MV_REWIND_PROFILE:file,MV_REWIND_AGENT_INSTANCE:instance,MV_GUEST_COMMAND_AGENT_INSTANCE:'wrong-legacy-binding'};
  assert.equal(guestCommandProfileOwnerSync(env,'arm64'),owner);assert.equal(await headlessAgentInstance(env),instance);
  assert.equal(requireGuestCommandMode(env,'arm64'),true);
  for(const broken of [{...env,MV_REWIND_ENABLED:undefined},{...env,MV_REWIND_ONLY:'0'},{...env,MV_HEADLESS_ONLY:'1'},{...env,MV_REWIND_PROFILE:'/absent'}])assert.throws(()=>requireGuestCommandMode(broken,'arm64'));
  assert.throws(()=>requireGuestCommandMode(env,'x64'));
  assert.equal(requireGuestCommandMode({...env,MV_REWIND_ONLY:undefined,MV_ARM64_CAPSULES:'1'},'arm64'),false);
  assert.equal(guestCommandProfileOwnerSync(env,'x64'),null);assert.equal(arm64CapsuleStatusSync(env,'x64').supported_host,false);
  assert.equal(arm64CapsuleStatusSync(env,'arm64').microvm.available,true);
  for(const key of ['MV_GUEST_COMMAND_ONLY','MV_HEADLESS_ONLY'])assert.equal(guestCommandProfileOwnerSync({...env,[key]:'1'},'arm64'),null);
  assert.equal(guestCommandProfileOwnerSync({...env,MV_REWIND_ENABLED:undefined},'arm64'),null);
  await assert.rejects(headlessAgentInstance({...env,MV_REWIND_AGENT_INSTANCE:'other-agent'}));
  await assert.rejects(headlessAgentInstance({...env,MV_REWIND_AGENT_INSTANCE:undefined}));
  const cleaned=scrubAdapterEnv({...env,PATH:'/usr/bin:/bin',UNTRUSTED:'x'},root);
  for(const key of ['MV_REWIND_ENABLED','MV_REWIND_ONLY','MV_REWIND_PROFILE','MV_REWIND_AGENT_INSTANCE'])assert.equal(cleaned[key],env[key]);
  assert.equal(cleaned.UNTRUSTED,undefined);
  assert.equal(await arm64CapsuleSessionPlan(env,'arm64','/app','/root','a'.repeat(40),{}),null);
 }finally{await rm(root,{recursive:true});}
});

test('packaged public closure includes the rewind runner/controller without private native assets',()=>{
 for(const file of ['daemon-adapter/tools/rewind_runner.py','daemon-adapter/rewind_runtime/controller.py','daemon-adapter/rewind_runtime/native.py','daemon-adapter/guest_command_runtime/wire.py'])assert.ok(OPERATOR_RESOURCES.includes(file),file);
 assert.ok(!OPERATOR_RESOURCES.some(name=>/\.(?:mem|state|qcow2|ext4)$/.test(name)||name.includes('guest-command-broker/target')||name.includes('verified-release')));
});
