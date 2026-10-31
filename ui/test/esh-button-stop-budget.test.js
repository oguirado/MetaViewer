import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createButtonService,OPERATOR_STOP_BUDGET_MS,DISPOSE_BUDGET_MS} from '../electron/buttonBridge.js';
import {installOperatorBridge} from '../electron/operatorBridge.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sealed={schema:'metaviewer.demo/v1',ok:true,result:{sealed:true}};
function fixture(options={}) {
  const children=[];
  const service=createButtonService({root,clipboard:{writeText(){}},env:{PATH:'/test'},...options,
    killGroup:(pid,signal)=>{const c=children.find(x=>x.pid===-pid);assert.ok(c);c.signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>c.emit('close',null));},
    spawnTool:()=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.pid=2000+children.length;c.signals=[];children.push(c);return c;}});
  return {service,children};
}
const PENDING=Symbol('pending');
/** Resolve to PENDING instead of hanging when a mutant never settles the promise (mock timers do not run setImmediate). */
const within=promise=>Promise.race([promise,new Promise(r=>setImmediate(()=>r(PENDING)))]);
async function started(f,demo='demo') {
  const p=f.service.request('demo.start',[{identity:'account',demo}]);
  f.children.at(-1).stdout.emit('data',Buffer.from('{"url":"http://127.0.0.1:1234/"}\n'));
  return p;
}
test('ESH-STOP-1: a slow but successful seal (mv_demo waits up to 180 s) is not SIGKILLed and unlocks the prompt',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({stopBudgetMs:OPERATOR_STOP_BUDGET_MS});
  await started(f);
  const stopping=f.service.request('demo.stop',[]);
  t.mock.timers.tick(180000+60000);await Promise.resolve();
  assert.deepEqual(f.children[0].signals,['SIGINT']);
  const c=f.children[0];c.stdout.emit('data',Buffer.from(JSON.stringify(sealed)+'\n'));c.emit('close',0);
  assert.deepEqual(await stopping,{ok:true});
  const prompt=f.service.request('demo.prompt',[{demo:'demo',site:'site'}]);
  assert.equal(f.children.length,2);
  f.children[1].emit('close',1);await prompt;
});
test('ESH-STOP-2 negative control: the same slow seal is killed under the legacy 10 s budget and the prompt stays refused',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();
  await started(f);
  const stopping=f.service.request('demo.stop',[]);
  t.mock.timers.tick(DISPOSE_BUDGET_MS);
  assert.deepEqual(await stopping,{ok:false,code:'DEMO_REFUSED'});
  assert.deepEqual(f.children[0].signals,['SIGINT','SIGKILL']);
  assert.deepEqual(await f.service.request('demo.prompt',[{demo:'demo',site:'site'}]),{ok:false,code:'DEMO_REFUSED'});
});
test('ESH-STOP-3: the operator budget still escalates and quit-time dispose keeps the short budget',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({stopBudgetMs:OPERATOR_STOP_BUDGET_MS});
  await started(f);
  const stopping=f.service.request('demo.stop',[]);
  t.mock.timers.tick(OPERATOR_STOP_BUDGET_MS-1);await Promise.resolve();
  assert.deepEqual(f.children[0].signals,['SIGINT']);
  t.mock.timers.tick(1);assert.deepEqual(await stopping,{ok:false,code:'DEMO_REFUSED'});
  await started(f,'next');
  const disposed=f.service.dispose();
  t.mock.timers.tick(DISPOSE_BUDGET_MS);await disposed;
  assert.deepEqual(f.children[1].signals,['SIGINT','SIGKILL']);
  assert.ok(OPERATOR_STOP_BUDGET_MS>=180000+60000);
});
test('ESH-STOP-5: quit-time dispose during an in-flight 300 s operator Stop re-arms the escalation to 10 s',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({stopBudgetMs:OPERATOR_STOP_BUDGET_MS});
  await started(f);
  const stopping=f.service.request('demo.stop',[]);
  t.mock.timers.tick(5000);await Promise.resolve();
  const disposed=f.service.dispose();
  t.mock.timers.tick(DISPOSE_BUDGET_MS-1);await Promise.resolve();
  assert.deepEqual(f.children[0].signals,['SIGINT']);
  t.mock.timers.tick(1);
  assert.notEqual(await within(disposed),PENDING);
  assert.deepEqual(f.children[0].signals,['SIGINT','SIGKILL']);
  assert.deepEqual(await within(stopping),{ok:false,code:'DEMO_REFUSED'});
});
test('ESH-STOP-6: output overflow during an in-flight operator Stop escalates after 10 s, not 300 s',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({stopBudgetMs:OPERATOR_STOP_BUDGET_MS});
  await started(f);
  const stopping=f.service.request('demo.stop',[]);
  f.children[0].stderr.emit('data',Buffer.alloc(65537));
  t.mock.timers.tick(DISPOSE_BUDGET_MS);
  assert.deepEqual(await within(stopping),{ok:false,code:'DEMO_REFUSED'});
  assert.deepEqual(f.children[0].signals,['SIGINT','SIGKILL']);
});
test('ESH-STOP-7: after a re-armed Stop the child seals cleanly and no stale 300 s timer SIGKILLs a possibly reused group',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({stopBudgetMs:OPERATOR_STOP_BUDGET_MS});
  await started(f);
  const stopping=f.service.request('demo.stop',[]);
  const disposed=f.service.dispose();
  const c=f.children[0];c.stdout.emit('data',Buffer.from(JSON.stringify(sealed)+'\n'));c.emit('close',0);
  assert.deepEqual(await within(stopping),{ok:true});
  assert.notEqual(await within(disposed),PENDING);
  t.mock.timers.tick(OPERATOR_STOP_BUDGET_MS);
  assert.deepEqual(c.signals,['SIGINT']);
});
test('ESH-STOP-4: installOperatorBridge wires the operator Stop budget by default',async t=>{
  const source=(await import('node:fs')).readFileSync(new URL('../electron/operatorBridge.js',import.meta.url),'utf8');
  assert.match(source,/createButtonService\(\{[^}]*stopBudgetMs:OPERATOR_STOP_BUDGET_MS/);
  assert.equal(typeof installOperatorBridge,'function');
});
test('ESH-CHECK-1: a check result declaring a non-user source is refused; user or undeclared source passes',async t=>{
  for(const [source,ok] of [[undefined,true],['user',true],['builtin',false],['',false]]) {
    const f=fixture();
    const p=f.service.request('demo.check',[{site:'site'}]);
    const result={site:'site',validated:true,...(source===undefined?{}:{source})};
    f.children[0].stdout.emit('data',Buffer.from(JSON.stringify({schema:'metaviewer.demo/v1',ok:true,result})+'\n'));f.children[0].emit('close',0);
    assert.equal((await p).ok,ok,String(source));
  }
});
