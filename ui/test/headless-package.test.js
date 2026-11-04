import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {headlessAgentInstance,productionEntry} from '../tools/package.js';
import {scrubAdapterEnv,requireHeadlessMode} from '../electron/coreLauncher.js';
test('fixed agent is host-only, matches protected profile, and is absent in normal mode',async()=>{
 const root=await mkdtemp('/dev/shm/mv-headless-pkg-');
 try {
  const path=root+'/profile',instance='agent-test-owned';
  const owner_id='actor-'+createHash('sha256').update('agent:'+instance).digest('hex');
  await writeFile(path,JSON.stringify({schema:'mv-headless-host/v1',owner_id,python:{},python_prefix:'/usr',runner:{},controller_relative:'mc06-controller/controller.py',files:[],guardian_unit:'test.service',state_root:root,runtime_root:root,config_template:{schema:'mc06-host-config/v1',runtime_admitted:true,owner_id}}),{mode:0o600});
  const env={MV_HEADLESS_ONLY:'1',MV_HEADLESS_PROFILE:path,MV_HEADLESS_AGENT_INSTANCE:instance};
  assert.equal(await headlessAgentInstance(env),instance);
  assert.equal(await headlessAgentInstance({...env,MV_HEADLESS_ONLY:'0'}),null);
  for(const v of [undefined,'','../foreign','agent-other'])await assert.rejects(headlessAgentInstance({...env,MV_HEADLESS_AGENT_INSTANCE:v}));
  await chmod(path,0o644);await assert.rejects(headlessAgentInstance(env));
  assert.ok(productionEntry.includes(headlessAgentInstance.toString().replace('export ','')));
  const scrubbed=scrubAdapterEnv({...env,PATH:'/usr/bin:/bin',MV_HEADLESS_GUARDIAN_UNIT:'test.service',UNTRUSTED_EXTRA:'no'},root);
  assert.equal(scrubbed.MV_HEADLESS_ONLY,'1');assert.equal(scrubbed.MV_HEADLESS_AGENT_INSTANCE,instance);assert.equal(scrubbed.MV_HEADLESS_GUARDIAN_UNIT,'test.service');assert.equal(scrubbed.UNTRUSTED_EXTRA,undefined);
 } finally {await rm(root,{recursive:true});}
});

test('explicit invalid headless mode cannot become normal graphical mode',()=>{
 assert.equal(requireHeadlessMode({},'arm64'),false);
 assert.throws(()=>requireHeadlessMode({MV_HEADLESS_ONLY:'1'},'arm64'),/HEADLESS_PROFILE_INVALID/);
 assert.throws(()=>requireHeadlessMode({MV_HEADLESS_ONLY:'1',MV_HEADLESS_PROFILE:'/absent/profile'},'x64'),/HEADLESS_PROFILE_INVALID/);
});
test('invalid-mode guard removal mutant is detected by the same refusal assertion',()=>{
 const text=requireHeadlessMode.toString();
 const mutated=text.replace("throw Error('HEADLESS_PROFILE_INVALID')",'return false');
 assert.notEqual(mutated,text);
 const mutant=new Function('headlessProfileOwnerSync','return ('+mutated+')')(()=>null);
 assert.throws(()=>assert.throws(()=>mutant({MV_HEADLESS_ONLY:'1'}),/HEADLESS_PROFILE_INVALID/),assert.AssertionError);
});
import {spawnSync} from 'node:child_process';
import {headlessProfileOwnerSync} from '../electron/coreLauncher.js';
test('both profile readers reject a FIFO within a bounded child lifetime',async()=>{
 const root=await mkdtemp('/dev/shm/mv-headless-fifo-');
 try {
  const path=root+'/profile';const made=spawnSync('/usr/bin/mkfifo',['-m','600',path]);assert.equal(made.status,0);
  const code=`import {headlessProfileOwnerSync} from ${JSON.stringify(new URL('../electron/coreLauncher.js',import.meta.url).href)};import {headlessAgentInstance} from ${JSON.stringify(new URL('../tools/package.js',import.meta.url).href)};const env=${JSON.stringify({MV_HEADLESS_ONLY:'1',MV_HEADLESS_PROFILE:path,MV_HEADLESS_AGENT_INSTANCE:'agent-test'})};if(headlessProfileOwnerSync(env,'arm64')!==null)throw Error('accepted');let refused=false;try{await headlessAgentInstance(env);}catch{refused=true;}if(!refused)throw Error('accepted');console.log('refused');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{timeout:1500,maxBuffer:2048,encoding:'utf8'});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'refused');
 }finally{await rm(root,{recursive:true});}
});
test('python_prefix is required and extra or invalid fields cannot enable the mode',async()=>{
 const root=await mkdtemp('/dev/shm/mv-headless-fields-');
 try{
  const path=root+'/profile',instance='agent-fields',owner_id='actor-'+createHash('sha256').update('agent:'+instance).digest('hex');
  const profile={schema:'mv-headless-host/v1',owner_id,python:{},python_prefix:'/usr',runner:{},controller_relative:'mc06-controller/controller.py',files:[],guardian_unit:'test.service',state_root:root,runtime_root:root,config_template:{schema:'mc06-host-config/v1',owner_id,runtime_admitted:true}};
  const env={MV_HEADLESS_ONLY:'1',MV_HEADLESS_PROFILE:path,MV_HEADLESS_AGENT_INSTANCE:instance};
  await writeFile(path,JSON.stringify(profile),{mode:0o600});assert.equal(headlessProfileOwnerSync(env,'arm64'),owner_id);assert.equal(await headlessAgentInstance(env),instance);
  const missing={...profile};delete missing.python_prefix;
  for(const bad of [missing,{...profile,python_prefix:7},{...profile,python_prefix:'/absent-prefix'},{...profile,extra:'unadmitted'}]){
   await writeFile(path,JSON.stringify(bad));assert.equal(headlessProfileOwnerSync(env,'arm64'),null);await assert.rejects(headlessAgentInstance(env));
  }
 }finally{await rm(root,{recursive:true});}
});
