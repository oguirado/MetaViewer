import test from 'node:test';
import assert from 'node:assert/strict';
import {agentPromptState} from '../src/terminal/agentPromptGate.js';
import {createTerminalDeckController} from '../src/terminal/terminalDeckModel.js';
import {workflowPrompt} from '../src/terminal/workflowPrompts.js';

// Synthetic, scrubbed first screens shaped like full-screen TUIs: alternate screen,
// cursor-addressed redraws, colour runs and box drawing around the input prompt.
// They are not byte captures of a real CLI; they pin the gate branch per profile.
const tui=(...lines)=>'\x1b[?1049h\x1b[?25l\x1b[2J'+lines.map((line,i)=>`\x1b[${i+2};3H\x1b[0m${line}\x1b[K`).join('')+'\x1b[?25h';
const screens={
  'agent-gemini':tui('\x1b[38;5;75m██ GEMINI-LIKE BANNER\x1b[0m','Tips for getting started:','╭──────────────────────────────────────────╮','│ \x1b[2m> Type your message or @path/to/file\x1b[22m │','╰──────────────────────────────────────────╯'),
  'agent-opencode':tui('\x1b[1mopencode\x1b[0m \x1b[2mv0.0.0\x1b[0m','┃ \x1b[2mAsk anything...\x1b[0m','\x1b[2menter send\x1b[0m'),
};
const login={
  'agent-gemini':tui('How would you like to authenticate for this project?','● 1. Login with Google','  2. Use an API key'),
  'agent-opencode':tui('\x1b[1mopencode\x1b[0m','Select a provider to log in','Enter your API key:'),
};

test('each non-default agent CLI is ready only on its own input prompt',()=>{
  for(const profile of ['agent-gemini','agent-opencode']){
    assert.equal(agentPromptState(profile,screens[profile]),'ready',profile);
    assert.equal(agentPromptState(profile,login[profile]),'authentication',profile);
    // Negative controls: a shell, a bare banner and another CLI's prompt keep waiting.
    for(const text of ['user@host:~$ ',tui('\x1b[1mbanner only\x1b[0m'),...Object.entries(screens).filter(([other])=>other!==profile).map(([,screen])=>screen)])
      assert.equal(agentPromptState(profile,text),'waiting',profile+' '+JSON.stringify(text.slice(-40)));
  }
});

function fixture(profile,early){
  let onData,seq=0;const writes=[],opened=[];
  const emit=(text,session)=>onData({session,seq:++seq,bytes:[...new TextEncoder().encode(text)],byteLength:Buffer.byteLength(text)});
  const controller=createTerminalDeckController({hostProviders:[{id:profile,label:profile}],
    broker:{async open(spec){opened.push(spec);return {session:'session-'+opened.length};}},
    sessionFacade:{async attach({session}){emit(early,session);},
      write:frame=>writes.push(frame),ack(){},close(){},onData(cb){onData=cb;return()=>{};},onExit(){return()=>{};}},
  });
  return {controller,writes,opened};
}

for(const profile of ['agent-gemini','agent-opencode']){
  test(`${profile} start pastes the workflow prompt once its TUI prompt is painted`,async t=>{
    const f=fixture(profile,screens[profile]);t.after(()=>f.controller.dispose());
    const slot=await f.controller.launchProfile(profile);
    assert.equal(f.opened[0].command,profile);
    const reply=await f.controller.prepareAgentPrompt('no-automation','Capsule identity: surface-a',slot.id,profile);
    assert.equal(reply.pasted,true);assert.equal(f.writes.length,1);
    const bytes=new TextDecoder().decode(new Uint8Array(f.writes[0].bytes));
    assert.equal(bytes,'\x1b[200~'+workflowPrompt('no-automation').replace('<operator-pasted capsule identity line>','Capsule identity: surface-a')+'\x1b[201~');
  });
  test(`${profile} login screen delivers no input`,async t=>{
    const f=fixture(profile,login[profile]);t.after(()=>f.controller.dispose());
    const slot=await f.controller.launchProfile(profile);
    assert.equal((await f.controller.prepareAgentPrompt('automate','identity-a',slot.id,profile)).pasted,false);
    assert.deepEqual(f.writes,[]);
  });
}
