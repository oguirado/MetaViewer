import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createButtonService,copyBounded,promptBlock} from '../electron/buttonBridge.js';
import {createOperatorFacade,assertOperatorCall} from '../electron/preload.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
function fixture({ignoreInt=false}={}){
  const children=[],calls=[],copies=[];
  const service=createButtonService({root,clipboard:{writeText:t=>copies.push(t)},env:{PATH:'/test',EVIL:'secret'},killGroup:(pid,signal)=>{
    const child=children.find(c=>c.pid===-pid);assert.ok(child,'owned process group');child.signals.push(signal);
    if(signal==='SIGKILL' || !ignoreInt)queueMicrotask(()=>child.emit('close',null));
  },spawnTool:(...args)=>{
    calls.push(args);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.pid=1000+children.length;child.signals=[];child.kill=s=>{child.signals.push(s);return true;};children.push(child);return child;
  }});
  return {service,children,calls,copies};
}
function close(child,result={sealed:true},rc=0){child.stdout.emit('data',Buffer.from(JSON.stringify({schema:'metaviewer.demo/v1',ok:true,result})+'\n'));child.emit('close',rc);}
test('MUT-PROMPT-VERBATIM: host clipboard is exactly the doc block including final LF',async()=>{
  const f=fixture();assert.deepEqual(await f.service.request('entry.copy',[]),{ok:true});
  const doc=readFileSync(new URL('../../docs/AGENT_ENTRY.md',import.meta.url),'utf8');
  const expected=doc.split(/```text\r?\n/)[1].split('```')[0];
  assert.deepEqual(Buffer.from(f.copies[0]),Buffer.from(expected));assert.equal(f.calls.length,0);
});
test('MUT-PROMPT-SOURCE: renderer paths and extra arguments never reach clipboard or spawn',async()=>{
  const f=fixture();for(const args of [[{path:'/tmp/evil'}],['docs/AGENT_ENTRY.md'],[{},{}]])await assert.rejects(f.service.request('entry.copy',args),/BUTTON_ARGS/);
  assert.deepEqual(f.copies,[]);assert.deepEqual(f.calls,[]);
});
test('MUT-CLIPBOARD-BOUND: bound uses UTF-8 bytes and rejects empty text',()=>{
  const copies=[],clipboard={writeText:t=>copies.push(t)};
  copyBounded(clipboard,'é'.repeat(8192));
  for(const text of ['', 'a'.repeat(16385),'é'.repeat(8193)])assert.throws(()=>copyBounded(clipboard,text),/CLIPBOARD_BOUND/);
  assert.equal(copies.length,1);assert.throws(()=>promptBlock('plain'),/PROMPT_SOURCE/);
  assert.throws(()=>promptBlock('```text\none\n```\n```text\ntwo\n```\n'),/PROMPT_SOURCE/);
  assert.equal(promptBlock('```text\r\nline\r\n```\r\n'),'line\r\n');
});
test('MUT-DEMO-ARGV: all malformed references refused before spawn at both boundaries',async()=>{
  const f=fixture(),transport=[];
  const api=createOperatorFacade({invoke:async(...args)=>{transport.push(args);return {ok:true};}});
  const shapes={'demo.start':{identity:'account',demo:'valid'},'demo.prompt':{demo:'valid',site:'site'},'demo.check':{site:'site'}};
  for(const [method,valid] of Object.entries(shapes)) {
    const [group,verb]=method.split('.');
    const refused=async args=>{
      assert.throws(()=>assertOperatorCall(method,args),/BUTTON_ARGS/);
      await assert.rejects(api[group][verb](...args),/BUTTON_ARGS/);
      await assert.rejects(f.service.request(method,args),/BUTTON_ARGS/);
      assert.deepEqual(f.calls,[]);assert.deepEqual(transport,[]);
    };
    for(const field of Object.keys(valid)) {
      for(const value of ['', 'a;id','a b','a\n','../demo','--help','$(id)','a|id','a'.repeat(field==='site'?65:41)])await refused([{...valid,[field]:value}]);
    }
    // Fields absent from the verb's schema are also forbidden, even if valid.
    for(const field of ['identity','demo','site'].filter(k=>!(k in valid)))await refused([{...valid,[field]:'valid'}]);
    await refused([{...valid,argv:['extra']}]);await refused([valid,'extra']);
  }
  await assert.rejects(f.service.request('demo.paste',[{text:'secret'}]));assert.deepEqual(f.calls,[]);
});
test('record announcement, SIGINT stop, sealed prompt and check use fixed argv and private env',async()=>{
  const f=fixture();const started=f.service.request('demo.start',[{identity:'account',demo:'demo'}]);
  f.children[0].stdout.emit('data',Buffer.from('{"url":"http://127.0.0.1:1234/"}\n'));
  assert.deepEqual(await started,{ok:true,url:'http://127.0.0.1:1234/'});
  assert.deepEqual(await f.service.request('demo.start',[{identity:'account',demo:'other'}]),{ok:false,code:'DEMO_BUSY'});
  const stopped=f.service.request('demo.stop',[]);assert.deepEqual(f.children[0].signals,['SIGINT']);close(f.children[0]);assert.deepEqual(await stopped,{ok:true});
  const prompted=f.service.request('demo.prompt',[{demo:'demo',site:'site'}]);f.children[1].stdout.emit('data',Buffer.from('```text\nprivate prompt\n```\n'));f.children[1].emit('close',0);assert.deepEqual(await prompted,{ok:true});assert.equal(f.copies[0],'private prompt\n');
  const checked=f.service.request('demo.check',[{site:'site'}]);close(f.children[2],{site:'site',validated:true});assert.deepEqual(await checked,{ok:true});
  assert.deepEqual(f.calls.map(c=>c[1].slice(1)),[['record','--identity','account','--demo','demo'],['prompt','--demo','demo','--site','site'],['check','--site','site']]);
  for(const [exe,argv,options] of f.calls){assert.equal(exe,'python3');assert.equal(argv[0],root+'tools/mv_demo.py');assert.equal(options.shell,false);assert.equal(options.detached,true);assert.equal(options.env.EVIL,undefined);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);}
});
test('refused recording cannot supply a prompt; malformed URLs and output refuse',async()=>{
  const f=fixture();assert.equal((await f.service.request('demo.prompt',[{demo:'demo',site:'site'}])).ok,false);
  const started=f.service.request('demo.start',[{identity:'account',demo:'demo'}]);f.children[0].stdout.emit('data',Buffer.from('{"url":"https://remote.example/"}\n'));assert.equal((await started).ok,false);
  const check=f.service.request('demo.check',[{site:'site'}]);close(f.children[1],{},6);assert.deepEqual(await check,{ok:false,code:'DEMO_REFUSED'});
});
test('preload exposes closed buttons and nested mode refuses before transport',async()=>{
  const calls=[];const api=createOperatorFacade({invoke:async(...args)=>{calls.push(args);return {ok:true};}});
  await api.entry.copy();assert.deepEqual(calls,[['metaviewer:entry.copy',[]]]);await assert.rejects(api.entry.copy({path:'evil'}));
  const nested=createOperatorFacade({nested:true,invoke:()=>assert.fail('nested transport')});await assert.rejects(nested.demo.stop(),/NESTED/);
});

for(const action of ['stop','dispose','fail'])test(`MUT-STOP-HANG: ${action} escalates the process group and releases ownership`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({ignoreInt:true});
  const started=f.service.request('demo.start',[{identity:'account',demo:'demo'}]);
  f.children[0].stdout.emit('data',Buffer.from('{"url":"http://127.0.0.1:1234/"}\n'));
  await started;
  let completed=false;
  const pending=action==='stop'?f.service.request('demo.stop',[]):action==='dispose'?f.service.dispose():(f.children[0].stderr.emit('data',Buffer.alloc(65537)),f.service.request('demo.stop',[]));
  void pending.then(()=>{completed=true;});
  assert.deepEqual(f.children[0].signals,['SIGINT']);
  t.mock.timers.tick(9999);await Promise.resolve();assert.equal(completed,false);
  t.mock.timers.tick(1);await pending;
  assert.deepEqual(f.children[0].signals,['SIGINT','SIGKILL']);
  if(action!=='dispose')assert.deepEqual(await pending,{ok:false,code:'DEMO_REFUSED'});
  assert.deepEqual(await f.service.request('demo.stop',[]),{ok:false,code:'DEMO_NOT_RECORDING'});
  const next=f.service.request('demo.start',[{identity:'account',demo:'next'}]);
  f.children[1].stdout.emit('data',Buffer.from('{"url":"http://localhost:1234/"}\n'));
  assert.equal((await next).ok,true);
  const disposed=f.service.dispose();t.mock.timers.tick(10000);await disposed;
});
test('failed startup retains ownership until bounded cleanup exits',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture({ignoreInt:true});
  const started=f.service.request('demo.start',[{identity:'account',demo:'demo'}]);
  f.children[0].stdout.emit('data',Buffer.from('{"url":"https://remote.example/"}\n'));
  assert.deepEqual(await f.service.request('demo.check',[{site:'site'}]),{ok:false,code:'DEMO_BUSY'});
  t.mock.timers.tick(10000);assert.deepEqual(await started,{ok:false,code:'DEMO_REFUSED'});
  assert.deepEqual(f.children[0].signals,['SIGINT','SIGKILL']);await f.service.dispose();
});

test('failure after announcement clears active after exit without another Stop',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture({ignoreInt:true});
  const started=f.service.request('demo.start',[{identity:'account',demo:'demo'}]);
  f.children[0].stdout.emit('data',Buffer.from('{"url":"http://localhost:1234/"}\n'));await started;
  f.children[0].stderr.emit('data',Buffer.alloc(65537));
  t.mock.timers.tick(10000);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(await f.service.request('demo.stop',[]),{ok:false,code:'DEMO_NOT_RECORDING'});
  await f.service.dispose();
});
