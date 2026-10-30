import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, symlinkSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createOperatorService, identityRunner, installOperatorBridge, publicIdentity } from '../electron/operatorBridge.js';
import { OPERATOR_METHODS, assertOperatorCall, assertOperatorReply, createOperatorFacade, validEgress } from '../electron/preload.js';
import { encodeMvSettings } from '../src/settings/settingsModel.js';
const open={schema:'metaviewer.capsule_egress/v1',mode:'open',domains:[]};
const proxy={...open,mode:'allowlisted',domains:['example.com']};
const handoff={schema:'metaviewer.handoff/v1',surface_id:'surface-1',step_index:7,reason:'captcha_wall',confidence:100,evidence_kinds:['ax_role_name']};
const native={profile_id:'account-a',account_label:'Account A',allowed_domains:['example.com'],last_login_unix:0};
const requests={ 'identity.list':[], 'identity.show':[{id:'account-a'}], 'identity.create':[{id:'account-a',label:'Account A',domains:['example.com']}], 'identity.delete':[{id:'account-a'}], 'identity.login':[{id:'account-a'}], 'egress.get':[{identity:'account-a'}], 'egress.set':[{identity:'account-a',record:proxy}], 'handoff.list':[], 'handoff.ack':[{surface_id:'surface-1',step_index:7,gesture:'operator-acknowledge'}] };
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'mv-idnet-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'run.handoff.json');writeFileSync(path,JSON.stringify(handoff),{mode:0o600});
  const env={MV_SRF_STATE_DIR:root,MV_SRF_NET_MODES:'["open","proxied"]',MV_HANDOFF_PATHS:JSON.stringify([path])};
  return {root,path,env};
}
test('all operator handlers admit only the window sender and exact positional arity',async t=>{
  const {env}=fixture(t),handlers=new Map();
  const bridge=installOperatorBridge({ipcMain:{handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)},contents:{send(){}},env,tool:'unused',admit:e=>e==='owner',runIdentity:async method=>['delete','login'].includes(method)?{ok:true}:{ok:true,rows:[publicIdentity(native)]}});
  t.after(()=>bridge.dispose());
  assert.equal(handlers.size,OPERATOR_METHODS.length);
  for(const method of OPERATOR_METHODS) {
    const h=handlers.get(`metaviewer:${method}`);
    await assert.rejects(h('foreign',...requests[method]),/SENDER/);
    await assert.rejects(h('owner',...requests[method],{}),/ARGS/);
    assert.doesNotThrow(()=>assertOperatorCall(method,requests[method]));
    const reply=await h('owner',...requests[method]);assert.equal(reply.ok,true);assertOperatorReply(method,reply);
  }
  assert.equal((await handlers.get('metaviewer:egress.get')('owner',...requests['egress.get'])).record.mode,'allowlisted');
  assert.equal((await handlers.get('metaviewer:handoff.list')('owner')).rows.length,0);
  await bridge.dispose();assert.equal(handlers.size,0);
});
test('MUT-ARGV-INJECTION: malicious ids, labels, unknown fields and extra tokens never spawn',async()=>{
  let calls=0;
  const service=createOperatorService({runIdentity:()=>{calls++;return {ok:true,rows:[]};}});
  for(const method of ['show','delete','login'])for(const id of ['a;touch x','aa --help','$(id)','aa\0'])await assert.rejects(service.request(`identity.${method}`,[{id}]),/PAYLOAD/);
  for(const label of ['x; echo hi','$(id)','`id`','x|id'])await assert.rejects(service.request('identity.create',[{id:'account-a',label,domains:['example.com']}]),/PAYLOAD/);
  await assert.rejects(service.request('identity.show',[{id:'account-a',argv:['--help']}]),/PAYLOAD/);
  await assert.rejects(service.request('identity.show',[{id:'account-a'},'--help']),/ARGS/);
  assert.equal(calls,0);
});
test('fixed argv templates for each identity verb and public result shaping',async()=>{
  for(const method of ['list','show','create','delete','login']) {
    let invocation;
    let opened;
    const runner=identityRunner({tool:'/trusted/tools/mv_identity.py',env:{PATH:'trusted',LD_PRELOAD:'forbidden',SECRET:'forbidden'},openLogin:url=>{opened=url;},spawnTool:(exe,argv,options)=>{
      invocation={exe,argv,options};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      process.nextTick(()=>{
        if(method==='login')child.stderr.write('Operator login view: http://127.0.0.1:4444/login (close with Ctrl+C or native view-stop)');
        const result=method==='list'?[native]:method==='delete'?{deleted:'account-a'}:method==='login'?{profile_id:'account-a',container:'srf-id-account-a',login_view_closed:true}:native;
        child.stdout.write(JSON.stringify({schema:'metaviewer.identity/v1',ok:true,result}));child.emit('close',0);
      });return child;
    }});
    const value=await runner(method,{id:'account-a',label:'Account A',domains:['example.com']});
    assert.deepEqual(invocation.options.env,{PATH:'trusted'});assert.equal(invocation.exe,'python3');assert.equal(invocation.options.shell,false);
    assert.deepEqual(invocation.argv,['/trusted/tools/mv_identity.py',method,...(method==='list'?[]:['--id','account-a']),...(method==='create'?['--label','Account A','--domains','example.com']:[])]);
    if(method==='login')assert.equal(opened,'http://127.0.0.1:4444/login');
    assertOperatorReply(`identity.${method}`,value);
  }
});
test('MUT-CREDENTIAL-FIELD: public reply and native metadata reject any extra field',async()=>{
  const row=publicIdentity(native);
  for(const last_login_unix of [undefined,null,0,123])assert.equal(publicIdentity({...native,last_login_unix}).logged_in,'unknown');
  for(const extra of ['password','cookies','profile','credential','payload']) {
    assert.throws(()=>publicIdentity({...native,[extra]:'SECRET'}));
    assert.throws(()=>assertOperatorReply('identity.list',{ok:true,rows:[{...row,[extra]:'SECRET'}]}));
    assert.throws(()=>assertOperatorReply('identity.login',{ok:true,[extra]:'SECRET'}));
  }
  let spawned=0;
  const facade=createOperatorFacade({invoke:async()=>{spawned++;return {ok:true,rows:[{...row,cookies:'SECRET'}]};}});
  await assert.rejects(facade.identity.list(),/REPLY/);assert.equal(spawned,1);
  await assert.rejects(facade.identity.show({id:'aa;bad'}),/PAYLOAD/);assert.equal(spawned,1);
  await assert.rejects(createOperatorFacade({nested:true}).identity.list(),/DISPLAY_ONLY/);
});
test('egress round trip, legacy, capability refusal and no-symlink private records',async t=>{
  const {env,root}=fixture(t),service=createOperatorService({env});
  assert.deepEqual((await service.request('egress.get',requests['egress.get'])).record,open);
  assert.equal((await service.request('egress.set',requests['egress.set'])).net_mode,'proxied');
  assert.deepEqual(JSON.parse(readFileSync(join(root,'egress/account-a.json'))),proxy);
  const legacy=createOperatorService({env:{...env,MV_SRF_NET_MODES:undefined}});
  assert.equal((await legacy.request('egress.set',requests['egress.set'])).code,'NET_PROXIED_UNSUPPORTED');
  await service.request('egress.set',[{identity:'account-a',record:open}]);
  assert.equal((await legacy.request('egress.get',requests['egress.get'])).net_mode,'legacy');
  unlinkSync(join(root,'egress/account-a.json'));symlinkSync(join(root,'run.handoff.json'),join(root,'egress/account-a.json'));
  assert.equal((await service.request('egress.get',requests['egress.get'])).ok,false);
  assert.equal((await service.request('egress.set',requests['egress.set'])).ok,false);
});
test('exact hostname negative controls and MUT-NET-GLOBAL-SETTING',()=>{
  assert.equal(validEgress(proxy),true);
  for(const domains of [[],['*.example.com'],['EXAMPLE.com'],['127.0.0.1'],['0x7f.0.0.1'],['example.local'],['example.com','example.com'],Array(257).fill('example.com')])assert.equal(validEgress({...proxy,domains}),false);
  for(const key of ['network','net_mode','egress'])assert.throws(()=>encodeMvSettings({scheme:'mv-light',density:'comfortable',wallFps:30,recordingFps:30,[key]:proxy}));
});
test('MUT-AUTO-DISMISS-HANDOFF: missing source never clears latch; durable ack never reopens',async t=>{
  const {env,path}=fixture(t),events=[];
  const service=createOperatorService({env,notify:v=>events.push(v)});
  assert.equal(service.refresh().rows.length,1);assert.equal(events.length,1);
  unlinkSync(path);assert.equal(service.refresh().rows.length,1);
  await assert.rejects(service.request('handoff.ack',[{surface_id:'surface-1',step_index:7}]),/PAYLOAD/);
  const reply=await service.request('handoff.ack',requests['handoff.ack']);assert.equal(reply.ok,true);
  writeFileSync(path,JSON.stringify(handoff),{mode:0o600});assert.equal(service.refresh().rows.length,0);
  assert.equal(createOperatorService({env}).refresh().rows.length,0);
});
test('handoff persistence failure keeps shown, including across refresh',async t=>{
  const {env,path}=fixture(t),service=createOperatorService({env});service.refresh();
  symlinkSync(path,path+'.ack.json');
  assert.equal((await service.request('handoff.ack',requests['handoff.ack'])).ok,false);
  assert.equal(service.refresh().rows.length,1);
  assert.equal(createOperatorService({env}).refresh().rows.length,1);
});
test('identity runner refuses oversized output, deadline expiry and non-loopback login views',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let child,opened=0;
  const runner=identityRunner({tool:'/trusted/tool.py',env:{},openLogin:()=>opened++,spawnTool:()=>{
    child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();return child;
  }});
  const oversized=runner('list');child.stdout.write(Buffer.alloc(65537));await assert.rejects(oversized,/LIMIT/);
  const late=runner('list');t.mock.timers.tick(30000);await assert.rejects(late,/TIMEOUT/);
  const login=runner('login',{id:'account-a'});child.stderr.write('Operator login view: http://example.com/login (close with Ctrl+C)');await assert.rejects(login,/LOGIN_URL/);assert.equal(opened,0);
});
