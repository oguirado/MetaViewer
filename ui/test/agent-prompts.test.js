import test from 'node:test';
import assert from 'node:assert/strict';
import {installedAgentProfiles} from '../electron/agentProviders.js';
import {agentPromptState} from '../src/terminal/agentPromptGate.js';
import {createTerminalDeckController} from '../src/terminal/terminalDeckModel.js';
import {createPairedTerminals} from '../src/terminal/pairedTerminals.js';
import {workflowPrompt} from '../src/terminal/workflowPrompts.js';

const ready='\x1b[1mOpenAI Codex\x1b[0m\n› ';
function fixture({early='',exit=false}={}) {
  let onData,onExit,seq=0;const writes=[],opened=[];
  const emit=(text,session='session-1')=>onData({session,seq:++seq,bytes:[...new TextEncoder().encode(text)],byteLength:Buffer.byteLength(text)});
  const controller=createTerminalDeckController({hostProviders:[{id:'agent-codex',label:'Codex'}],
    broker:{async open(spec){opened.push(spec);return {session:'session-'+opened.length};}},
    sessionFacade:{async attach({session}){if(early)emit(early,session);if(exit)onExit({session,reason:'Exited (1)'});},
      write:frame=>writes.push(frame),ack(){},close(){},onData(cb){onData=cb;return()=>{};},onExit(cb){onExit=cb;return()=>{};}},
  });
  return {controller,emit,writes,opened,exit:()=>onExit({session:'session-1',reason:'Exited (1)'})};
}
test('installed agents are fixed host argv, missing binaries never become shell profiles',()=>{
  const calls=[],profiles=installedAgentProfiles({HOME:'/isolated-home'},name=>{calls.push(name);if(name!=='codex')throw Error('missing');return {path:'/tools/codex'};});
  assert.deepEqual(calls,['codex','gemini','opencode']);
  assert.deepEqual([...profiles.keys()],['agent-codex']);assert.deepEqual(profiles.get('agent-codex').argv,['/tools/codex']);
  assert.equal(profiles.get('agent-codex').cwd,'/isolated-home');assert.equal(profiles.get('agent-codex').env,undefined);
  assert.equal(installedAgentProfiles({},()=>({path:'relative'})).size,0);
});
test('known input prompt required; banners, shell and auth/trust questions never pass',()=>{
  assert.equal(agentPromptState('agent-codex',ready),'ready');
  for(const text of ['OpenAI Codex','bash$ ','Sign in with ChatGPT\n'+ready,'Do you trust the contents of this directory?\n'+ready])
    assert.notEqual(agentPromptState('agent-codex',text),'ready');
  assert.equal(agentPromptState('shell',ready),'waiting');
});
test('early output is retained and one bracketed prompt ends exactly at Task without Enter',async t=>{
  const f=fixture({early:ready});t.after(()=>f.controller.dispose());
  const slot=await f.controller.launchProfile('agent-codex');
  const reply=await f.controller.prepareAgentPrompt('no-automation','Capsule identity: surface-a',slot.id,'agent-codex');
  assert.equal(reply.pasted,true);assert.equal(f.writes.length,1);
  const bytes=new TextDecoder().decode(new Uint8Array(f.writes[0].bytes));
  assert.equal(bytes,'\x1b[200~'+workflowPrompt('no-automation').replace('<operator-pasted capsule identity line>','Capsule identity: surface-a')+'\x1b[201~');
  assert.ok(bytes.endsWith('Task: \x1b[201~'));assert.equal(bytes.includes('\r'),false);
  assert.equal(f.opened[0].command,'agent-codex');assert.deepEqual(f.opened[0].args,[]);
});
test('authentication, early exit, changed session and cancellation deliver no input',async t=>{
  for(const scenario of ['auth','exit','changed','cancel']) {
    const f=fixture({early:scenario==='auth'?'Sign in with ChatGPT\n'+ready:ready,exit:scenario==='exit'});t.after(()=>f.controller.dispose());
    const slot=await f.controller.launchProfile('agent-codex');
    const pending=f.controller.prepareAgentPrompt('automate','identity-a',slot.id,'agent-codex',()=>scenario!=='cancel');
    if(scenario==='changed')slot.sessionId='session-replaced';
    assert.equal((await pending).pasted,false,scenario);assert.deepEqual(f.writes,[],scenario);
  }
});
test('no output times out at the bounded deadline without input',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let now=0;t.mock.method(performance,'now',()=>now);
  const f=fixture();t.after(()=>f.controller.dispose());const slot=await f.controller.launchProfile('agent-codex');
  const pending=f.controller.prepareAgentPrompt('automate','identity-a',slot.id,'agent-codex');
  now=15000;t.mock.timers.tick(15000);assert.equal((await pending).pasted,false);assert.deepEqual(f.writes,[]);
  assert.match(f.controller.state.toastMessage,/15 seconds/);
});
test('explicit agent choice replaces only the paired slot and reopening preserves it',async()=>{
  const slots=new Map(),calls=[];let seq=0;
  const pairs=createPairedTerminals({findSlot:id=>slots.get(id),async launchProfile(profile,opts){calls.push([profile,opts]);const slot={id:opts.reuseSlotId??'slot-'+(++seq),status:'running'};slots.set(slot.id,{slot});return slot;}});
  const target={surfaceId:'surface-a',profileId:'identity-a'};
  const shell=await pairs.open(target),agent=await pairs.open(target,'agent-codex');
  assert.equal(agent.slotId,shell.slotId);assert.equal(agent.terminalProfile,'agent-codex');assert.match(agent.identityLine,/identity-a/);
  await pairs.open(target);assert.equal(calls.length,2);assert.equal(calls[1][1].reuseSlotId,shell.slotId);
});

test('readiness arriving at the deadline still refuses instead of pasting late',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let now=0;t.mock.method(performance,'now',()=>now);
  const f=fixture();t.after(()=>f.controller.dispose());const slot=await f.controller.launchProfile('agent-codex');
  const pending=f.controller.prepareAgentPrompt('automate','identity-a',slot.id,'agent-codex');
  now=14500;f.emit(ready);now=15000;t.mock.timers.tick(15000);
  assert.equal((await pending).pasted,false);assert.deepEqual(f.writes,[]);
});

const capturedCodexFrames=[
  '\x1b[?2004h\x1b[?1004h\x1b[>1u\x1b[?25l',
  '\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[c',
  '\x1b[?1049h\x1b[H\x1b[2J\x1b[4;1H╭───────────────────────────────────────────────╮\x1b[5;1H│ >_ \x1b[1mOpenAI Codex\x1b[0m \x1b[2m(v0.162.1)\x1b[0m                    │\x1b[8;1H│ \x1b[2mdirectory: \x1b[0m~/workspace                        │\x1b[9;1H╰───────────────────────────────────────────────╯\x1b[15;1H\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\x1b[17;3H\x1b[2m? for shortcuts\x1b[0m\x1b[15;3H\x1b[?25h',
  '\x1b[?25l\x1b[5;6H\x1b[1mOpenAI Codex\x1b[0m\x1b[17;3H\x1b[2m/skills to list\x1b[0m\x1b[15;3H\x1b[?25h',
  '\x1b]0;~/workspace\x07\x1b[11;1H│ ✨ \x1b[1mUpdate available!\x1b[0m 0.162.1 -> 0.166.0 │\x1b[12;1H│ Release notes: \x1b]8;;https://github.com/openai/codex/releases/latest\x07https://github.com/openai/codex/releases/latest\x1b]8;;\x07 │\x1b[19;1H\x1b[33m⚠ Heads up, you have less than 6% of your weekly limit left. Run /status for a breakdown.\x1b[0m\x1b[21;3H\x1b[33m⚠ weekly limit: only 6% left\x1b[0m \x1b[2m· /status\x1b[0m\x1b[21;86H\x1b[33m⚠ 2 warnings\x1b[0m\x1b[15;3H\x1b[?25h',
];

test('captured multi-chunk TUI stream with ST and BEL OSC sequences plus warning status lines reaches ready and pastes for fresh and 1-minute-idle sessions',async t=>{
  assert.equal(agentPromptState('agent-codex',capturedCodexFrames.join('')),'ready');
  t.mock.timers.enable({apis:['setTimeout']});let now=0;t.mock.method(performance,'now',()=>now);
  for(const kind of ['use-automation','automate','no-automation']) {
    const f=fixture();t.after(()=>f.controller.dispose());
    const slot=await f.controller.launchProfile('agent-codex');
    const pending=f.controller.prepareAgentPrompt(kind,'Capsule identity: surface-a',slot.id,'agent-codex');
    for(const [idx,chunk] of capturedCodexFrames.entries()) {
      now=idx*200;f.emit(chunk);t.mock.timers.tick(200);
    }
    now+=350;t.mock.timers.tick(350);
    const fresh=await pending;
    assert.equal(fresh.pasted,true,kind);assert.equal(f.writes.length,1,kind);
    const freshText=new TextDecoder().decode(new Uint8Array(f.writes[0].bytes));
    assert.equal(freshText,'\x1b[200~'+workflowPrompt(kind).replace('<operator-pasted capsule identity line>','Capsule identity: surface-a')+'\x1b[201~');
    assert.equal(freshText.includes('\r'),false);
    now+=60000;
    const idle=await f.controller.prepareAgentPrompt(kind,'Capsule identity: surface-a',slot.id,'agent-codex');
    assert.equal(idle.pasted,true,kind);assert.equal(f.writes.length,2,kind);
  }
});
