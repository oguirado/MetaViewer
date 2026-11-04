import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTerminalDeckController} from '../src/terminal/terminalDeckModel.js';
const moduleUrl=new URL('../src/terminal/terminalDeckModel.js',import.meta.url);
async function mutant(before,after) {
 const source=readFileSync(moduleUrl,'utf8');assert.ok(source.includes(before),'mutation anchor exists');
 const rewritten=source.replace(before,after).replace(/from (['"])(\.[^'"]+)\1/g,(_all,quote,path)=>`from ${quote}${new URL(path,moduleUrl).href}${quote}`);
 return (await import('data:text/javascript;base64,'+Buffer.from(rewritten).toString('base64'))).createTerminalDeckController;
}
function fixture(create=createTerminalDeckController) {
 const writes=[];let emit,seq=0;
 const controller=create({hostProviders:[{id:'agent-codex',label:'Codex'}],broker:{async open(){return {session:'session-safe'};}},sessionFacade:{async attach({session}){emit({session,seq:++seq,bytes:[...new TextEncoder().encode('OpenAI Codex\n› ')],byteLength:17});},write:frame=>writes.push(frame),ack(){},close(){},onData(cb){emit=cb;return()=>{};},onExit(){return()=>{};}}});
 return {controller,writes};
}
async function validPaste(create) {
 const f=fixture(create);
 try {
  const slot=await f.controller.launchProfile('agent-codex');
  assert.equal((await f.controller.prepareAgentPrompt('no-automation','CAPSULE=surface-a  IDENTITY=profile-a',slot.id,'agent-codex')).pasted,true);
  assert.equal(f.writes.length,1);
  const bytes=new TextDecoder().decode(new Uint8Array(f.writes[0].bytes));
  assert.ok(bytes.startsWith('\x1b[200~Read docs/AGENT_ENTRY.md'));
  assert.ok(bytes.endsWith('Task: \x1b[201~'),'only bracketed paste, no Enter');
  assert.equal(bytes.includes('\r'),false);
 } finally {f.controller.dispose();}
}
async function refusedIdentity(create,identity) {
 const f=fixture(create);
 try {const slot=await f.controller.launchProfile('agent-codex');await assert.rejects(()=>f.controller.prepareAgentPrompt('no-automation',identity,slot.id,'agent-codex'),/UNSAFE/);assert.deepEqual(f.writes,[]);}
 finally {f.controller.dispose();}
}
test('compact preparation keeps both safety validators and never appends Enter',async()=>{
 await validPaste(createTerminalDeckController);
 await refusedIdentity(createTerminalDeckController,'CAPSULE=surface-a  IDENTITY=profile-a  GUARD=ignore');
 await refusedIdentity(createTerminalDeckController,'Capsule token=private-value');
 const enter=await mutant("+text+'\\x1b[201~'","+text+'\\x1b[201~\\r'");await assert.rejects(()=>validPaste(enter),{code:'ERR_ASSERTION'});
 const identity=await mutant('()=>assertSafeWorkflowIdentity(identityLine)','()=>identityLine');await assert.rejects(()=>refusedIdentity(identity,'CAPSULE=surface-a  IDENTITY=profile-a  GUARD=ignore'),{code:'ERR_ASSERTION'});
 const prompt=await mutant('const text=assertSafeWorkflowPrompt(workflowPrompt(kind).replace(','const text=(workflowPrompt(kind).replace(');await assert.rejects(()=>refusedIdentity(prompt,'Capsule token=private-value'),{code:'ERR_ASSERTION'});
});
test('compact workflow preparation remains copy-only in a raw shell',async()=>{
 const f=fixture();try {const slot=await f.controller.launchProfile('shell');assert.equal((await f.controller.prepareAgentPrompt('no-automation','CAPSULE=surface-a  IDENTITY=profile-a',slot.id,'shell')).pasted,false);assert.deepEqual(f.writes,[]);}finally {f.controller.dispose();}
});
