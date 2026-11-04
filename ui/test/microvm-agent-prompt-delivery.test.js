import test from 'node:test';
import assert from 'node:assert/strict';
import {createTerminalDeckController} from '../src/terminal/terminalDeckModel.js';
const target={kind:'microvm',workloadId:'workload-fixture',generation:3,ownerId:'actor-fixture',profileId:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64'};
const identity='MICROVM=workload-fixture  GENERATION=3  OWNER=actor-fixture';
test('MicroVM context reaches gated agent paste and mismatched identity refuses before writing',async t=>{
  let onData;const writes=[];
  const controller=createTerminalDeckController({hostProviders:[{id:'agent-codex',label:'Codex'}],broker:{async open(){return {session:'session-fixture'};}},sessionFacade:{async attach({session}){const text='OpenAI Codex\n› ';onData({session,seq:1,bytes:[...new TextEncoder().encode(text)],byteLength:Buffer.byteLength(text)});},write:frame=>writes.push(frame),ack(){},close(){},onData(cb){onData=cb;return()=>{};},onExit(){return()=>{};}}});
  t.after(()=>controller.dispose());const slot=await controller.launchProfile('agent-codex');
  await assert.rejects(()=>controller.prepareAgentPrompt('no-automation',identity,slot.id,'agent-codex'),/MICROVM/);assert.equal(writes.length,0);
  await assert.rejects(()=>controller.useWorkflowPrompt('no-automation',identity),/MICROVM/);
  assert.throws(()=>controller.copyWorkflowPrompt('no-automation',identity),/MICROVM/);
  await assert.rejects(()=>controller.prepareAgentPrompt('no-automation',identity.replace('=3','=4'),slot.id,'agent-codex',()=>true,target),/MICROVM/);assert.equal(writes.length,0);
  assert.equal((await controller.prepareAgentPrompt('no-automation',identity,slot.id,'agent-codex',()=>true,target)).pasted,true);
  const text=new TextDecoder().decode(new Uint8Array(writes[0].bytes));assert.match(text,/MicroVM Direct task/);assert.ok(text.endsWith('Task: \x1b[201~'));assert.equal(text.includes('\r'),false);
});
