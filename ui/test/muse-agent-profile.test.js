import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installedAgentProfiles} from '../electron/agentProviders.js';
import {AGENT_PROFILE_IDS,agentPromptState} from '../src/terminal/agentPromptGate.js';
const captured=JSON.parse(readFileSync(new URL('./fixtures/muse-ready.json',import.meta.url),'utf8')).output;
const env={HOME:'/host-person',PATH:'/usr/bin:/bin',XDG_RUNTIME_DIR:'/run/user/1000/app-fixture',API_TOKEN:'private-token',MUSE_AUTH_PATH:'/do-not-forward'};
function resolve(name){if(['muse','unshare'].includes(name))return {path:'/usr/bin/'+name};throw Error('missing');}
test('Muse is a host-owned Contributor max profile with a scoped runtime and no secret environment',()=>{
 for(const arm of [false,true]) {
  const profile=installedAgentProfiles({...env,...(arm?{MV_ARM64_CAPSULES:'1'}:{})},resolve,()=>({homedir:'/host-person'})).get('agent-muse');
  assert.ok(profile);assert.ok(AGENT_PROFILE_IDS.includes('agent-muse'));
  assert.deepEqual(profile.argv,['/usr/bin/unshare','--user','--map-current-user','--pid','--fork','--mount-proc','--','/usr/bin/muse','--contributor-mode','on','--model','muse-spark-1.3','--reasoning-effort','max']);
  assert.equal(profile.env.XDG_RUNTIME_DIR,env.XDG_RUNTIME_DIR);assert.equal(profile.env.HOME,'/host-person');
  assert.equal(profile.env.API_TOKEN,undefined);assert.equal(profile.env.MUSE_AUTH_PATH,undefined);
  assert.equal(profile.argv.includes('--trust-workspace'),false);assert.equal(profile.argv.includes('--disable-sandbox'),false);
 }
});
test('Muse requires its executable, namespace helper and actual attachment runtime',()=>{
 assert.equal(installedAgentProfiles(env,name=>{if(name==='unshare')throw Error('missing');return resolve(name);}).has('agent-muse'),false);
 assert.equal(installedAgentProfiles({...env,XDG_RUNTIME_DIR:undefined},resolve).has('agent-muse'),false);
});
test('Muse readiness recognizes captured input bytes but refuses banners, other CLIs and auth/trust',()=>{
 assert.equal(agentPromptState('agent-muse',captured),'ready');
 for(const text of ['Muse Code 1.4.14\nmuse-spark-1.3','OpenAI Codex\n› ','Type your message','Ask anything'])assert.equal(agentPromptState('agent-muse',text),'waiting');
 for(const text of ['Sign in to Meta','Choose authentication method','Do you trust this workspace?'])assert.equal(agentPromptState('agent-muse',captured+'\n'+text),'authentication');
 assert.equal(agentPromptState('agent-codex',captured),'waiting');
});

import {createTerminalDeckController} from '../src/terminal/terminalDeckModel.js';
import {workflowPrompt} from '../src/terminal/workflowPrompts.js';
function fixture(output) {
 const writes=[];let onData;
 const controller=createTerminalDeckController({hostProviders:[{id:'agent-muse',label:'Muse'}],broker:{async open(){return {session:'session-muse'};}},sessionFacade:{async attach({session}){const bytes=[...new TextEncoder().encode(output)];onData({session,seq:1,bytes,byteLength:bytes.length});},write:frame=>writes.push(frame),ack(){},close(){},onData(cb){onData=cb;return()=>{};},onExit(){return()=>{};}}});
 return {controller,writes};
}
test('Muse receives exactly one bracketed workflow paste, never Enter, after its real input marker',async()=>{
 const f=fixture(captured);try {
  const slot=await f.controller.launchProfile('agent-muse');
  const result=await f.controller.prepareAgentPrompt('no-automation','CAPSULE=surface-muse  IDENTITY=public-muse',slot.id,'agent-muse');
  assert.equal(result.pasted,true);assert.equal(f.writes.length,1);
  const text=new TextDecoder().decode(new Uint8Array(f.writes[0].bytes));
  assert.equal(text,'\x1b[200~'+workflowPrompt('no-automation').replace('<operator-pasted capsule identity line>','CAPSULE=surface-muse  IDENTITY=public-muse')+'\x1b[201~');
  assert.ok(text.endsWith('Task: \x1b[201~'));assert.equal(text.includes('\r'),false);
 } finally {f.controller.dispose();}
});
test('Muse sign-in and trust screens never receive a workflow prompt',async()=>{
 for(const stop of ['Sign in to Meta','Do you trust this directory?']) {
  const f=fixture(captured+'\n'+stop);try {
   const slot=await f.controller.launchProfile('agent-muse');
   assert.equal((await f.controller.prepareAgentPrompt('automate','CAPSULE=surface-muse  IDENTITY=public-muse',slot.id,'agent-muse')).pasted,false);
   assert.deepEqual(f.writes,[]);
  } finally {f.controller.dispose();}
 }
});
