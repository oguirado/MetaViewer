import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createButtonService} from '../electron/buttonBridge.js';
import {installDemoControl,assertDemoRequest} from '../electron/demoControl.js';
import {privateDirectory} from '../electron/operatorBridge.js';
import {createOperatorFacade,assertButtonReply} from '../electron/preload.js';
const tool=fileURLToPath(new URL('../../tools/mv_demo.py',import.meta.url));
const sleep=()=>new Promise(r=>setTimeout(r,5));
async function until(predicate){for(let i=0;i<400;i++){if(await predicate())return;await sleep();}throw Error('bounded observation timed out');}
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'mv-demo-control-'));
  await mkdir(join(root,'tools'));await mkdir(join(root,'runtime'),{mode:0o700});
  const script=`import json,signal,time,sys,os
from pathlib import Path
root=Path(__file__).resolve().parents[1]
verb=sys.argv[1]
if verb=='record':
    stop=False
    def seal(*_):
        global stop
        stop=True
    signal.signal(signal.SIGINT,seal)
    print(json.dumps({'url':'http://127.0.0.1:1234/'}),flush=True)
    while not stop: signal.pause()
    (root/'stopping').write_text('SIGINT')
    deadline=time.monotonic()+3
    while not (root/'release').exists() and time.monotonic()<deadline: time.sleep(.005)
    print(json.dumps({'schema':'metaviewer.demo/v1','ok':True,'result':{'evidence':str(root/'evidence'),'schema':'metaviewer.demo/v1','sha256':{'events.jsonl':'a'*64}}}),flush=True)
elif verb=='prompt':
    print(chr(96)*3+'text');print('Author checked evidence.');print(chr(96)*3)
else:
    print(json.dumps({'schema':'metaviewer.demo/v1','ok':True,'result':{'site':'site','validated':True,'source':'home'}}))
`;
  await writeFile(join(root,'tools/mv_demo.py'),script);
  const env={...process.env,XDG_RUNTIME_DIR:join(root,'runtime'),MV_SESSION_ID:'pkg-synthetic'};
  const states=[];
  const buttons=createButtonService({root,env,clipboard:{writeText:()=>{}},onState:()=>states.push(buttons.state())});
  const server=installDemoControl({env,buttons,privateDirectory});
  t.after(async()=>{await writeFile(join(root,'release'),'stop');await buttons.dispose();await server.dispose();await rm(root,{recursive:true,force:true});});
  await until(async()=>{try{return (await stat(server.path)).isSocket();}catch{return false;}});
  return {root,env,buttons,server,states};
}
function client(args,env){
  const p=spawn('python3',[tool,...args],{env,stdio:['ignore','pipe','pipe']});
  let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
  const done=once(p,'close').then(([rc])=>({rc,out,err}));
  return {p,done,output:()=>out};
}
for(const origin of ['client-sigint','host-stop'])test(`real CLI and host Stop share recorder sealing: ${origin}`,async t=>{
  const f=await fixture(t),c=client(['record','--identity','example','--demo','sample'],f.env);
  t.after(()=>{if(c.p.exitCode===null)c.p.kill('SIGINT');});
  await until(()=>c.output().includes('http://127.0.0.1:1234/'));
  assert.equal(f.buttons.state().phase,'recording');
  let stopped;
  if(origin==='client-sigint')c.p.kill('SIGINT');
  else stopped=f.buttons.request('demo.stop',[]);
  await until(()=>f.buttons.state().phase==='sealing');
  assert.equal(f.buttons.state().identity,'example');
  await until(async()=>{try{return await readFile(join(f.root,'stopping'),'utf8')==='SIGINT';}catch{return false;}});
  assert.equal(f.buttons.state().phase,'sealing','ownership retained while native seal is unfinished');
  await writeFile(join(f.root,'release'),'seal');
  const result=await c.done;assert.equal(result.rc,0,result.err);
  assert.equal(JSON.parse(result.out.trim().split('\n').at(-1)).result.schema,'metaviewer.demo/v1');
  if(stopped)assert.deepEqual(await stopped,{ok:true});
  assert.equal(f.buttons.state().phase,'idle');
  assert.ok(f.states.some(s=>s.phase==='recording'));
});
test('CLI prompt/check stay on the host and malformed/session-mismatched requests cannot spawn',async t=>{
  const f=await fixture(t);
  const prompt=await client(['prompt','--demo','sample','--site','site'],f.env).done;
  assert.equal(prompt.rc,0,prompt.err);assert.ok(prompt.out.startsWith(String.fromCharCode(96).repeat(3)+'text\nAuthor checked evidence.\n'));
  const checked=await client(['check','--site','site'],f.env).done;
  assert.equal(JSON.parse(checked.out).result.source,'home');
  for(const row of [{schema:'metaviewer.demo_control/v1',session_id:'other',method:'demo.start',args:[{identity:'example',demo:'sample'}]},
    {schema:'metaviewer.demo_control/v1',session_id:'pkg-synthetic',method:'demo.start',args:[{identity:'example',demo:'sample',pid:1}]}]){
    const s=connect(f.server.path);s.write(JSON.stringify(row)+'\n');const [reply]=await once(s,'data');s.end();
    assert.equal(JSON.parse(reply).reply.ok,false);assert.equal(f.buttons.state().phase,'idle');
  }
  assert.throws(()=>assertDemoRequest({schema:'metaviewer.demo_control/v1',session_id:'pkg-synthetic',method:'sh',args:[]}),/DEMO_REQUEST/);
});
test('preload admits only closed real recorder states and nested subscribers are refused',()=>{
  assert.throws(()=>assertButtonReply('demo.state',{ok:true}),/BUTTON_REPLY/);
  assert.throws(()=>assertButtonReply('demo.state',{schema:'metaviewer.demo_state/v1',ok:true,phase:'idle',identity:'example',demo:'sample'}),/BUTTON_REPLY/);
  const callbacks=[],delivered=[];
  const api=createOperatorFacade({subscribe:(_channel,cb)=>{callbacks.push(cb);return ()=>{};}});
  api.demo.subscribe(v=>delivered.push(v));callbacks[0]({schema:'metaviewer.demo_state/v1',ok:true,phase:'recording',identity:'example',demo:'sample'});
  callbacks[0]({ok:true,phase:'recording',identity:'example',demo:'sample'});
  assert.equal(delivered.length,1);
  assert.throws(()=>createOperatorFacade({nested:true}).demo.subscribe(()=>{}),/NESTED/);
});

test('demo control rejects non-array args before invoking a host operation', async t => {
  const f = await fixture(t);
  for (const [method,args] of [['demo.stop',''], ['demo.check',{length:1,0:{site:'site'}}]]) {
    const row={schema:'metaviewer.demo_control/v1',session_id:'pkg-synthetic',method,args};
    assert.throws(()=>assertDemoRequest(row),/DEMO_REQUEST/);
    const socket=connect(f.server.path);
    socket.write(JSON.stringify(row)+'\n');
    const [reply]=await once(socket,'data');
    socket.end();
    assert.deepEqual(JSON.parse(reply).reply,{ok:false,code:'DEMO_REFUSED'});
    assert.equal(f.buttons.state().phase,'idle');
  }
});
