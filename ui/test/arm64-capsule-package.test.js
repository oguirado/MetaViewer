import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsDefault from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter,once} from 'node:events';
import {arm64CapsuleSessionPlan,productionEntry} from '../tools/package.js';
import {validateRetailLaunch} from '../electron/main.js';

const commit='1'.repeat(40);
function fixedSystemPython(t, overrides={}) {
 const realpath=fsDefault.realpath,lstat=fsDefault.lstat;
 t.mock.method(fsDefault,'realpath',async (path,...args)=>path==='/usr/bin/python3'?'/usr/bin/python3.12':realpath(path,...args));
 t.mock.method(fsDefault,'lstat',async (path,...args)=>path==='/usr/bin/python3.12'?{isFile:()=>true,uid:0,mode:0o100755,...overrides}:lstat(path,...args));
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
}

async function fixture(t){
 const root=await fs.mkdtemp(join(tmpdir(),'arm-package-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const operator=join(root,'operator'),data=join(root,'data');
 await fs.mkdir(join(operator,'tools'),{recursive:true,mode:0o700});
 const dir=join(data,'metaviewer/capsules/arm64');await fs.mkdir(dir,{recursive:true,mode:0o700});
 const registry=join(dir,'setup.json');await fs.writeFile(registry,'{}\n',{mode:0o600});
 const pins={};for(const name of ['tools/arm64_capsules.py','tools/arm64_capsule_session.py','tools/arm64_capsule_reconcile.py','tools/mv_identity.py']){
  const bytes=Buffer.from('# fixture source only; never executed\n');await fs.writeFile(join(operator,name),bytes,{mode:0o644});pins[name]=createHash('sha256').update(bytes).digest('hex');
 }
 return {root,operator,data,registry,pins,env:{XDG_DATA_HOME:data,DISPLAY:':123',DBUS_SESSION_BUS_ADDRESS:'unix:path=/private/ui/bus',MV_HOSTED:'1',XAUTHORITY:'/private/ui/Xauthority'}};
}

test('x64 and existing internal sessions never inspect or launch setup',async()=>{
 const env={XDG_DATA_HOME:'/invalid/../path'};
 assert.equal(await arm64CapsuleSessionPlan(env,'x64','/app','/source',commit,{}),null);
 assert.equal(await arm64CapsuleSessionPlan({...env,MV_ARM64_CAPSULES:'1'},'arm64','/app','/source',commit,{}),null);
});
test('absent registry retains ordinary startup without requiring UI transport',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'arm-absent-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 assert.equal(await arm64CapsuleSessionPlan({XDG_DATA_HOME:root},'arm64','/app','/source',commit,{}),null);
});
test('wrapper uses fixed system interpreter and sealed helper paths, not registry execution fields',async t=>{
 fixedSystemPython(t);
 const f=await fixture(t);await fs.writeFile(f.registry,'{"python":{"path":"/untrusted/do-not-execute"}}\n',{mode:0o600});
 const plan=await arm64CapsuleSessionPlan(f.env,'arm64','/pack/metaviewer',f.operator,commit,f.pins);
 assert.match(plan.python,/^\/usr\/bin\/python3/);assert.equal(plan.helper,join(f.operator,'tools/arm64_capsule_session.py'));
 assert.deepEqual(plan.argv,['--app','/pack/metaviewer','--source-root',f.operator,'--expected-commit',commit]);
 assert.equal(plan.transport.mode,'private-ui');assert.equal(plan.transport.display,':123');
 assert.equal((await fs.readdir(join(f.operator,'tools'))).length,4);
});
test('trusted human invocation can preserve absent Xauthority without reading credentials',async t=>{
 fixedSystemPython(t);
 const f=await fixture(t);delete f.env.MV_HOSTED;delete f.env.XAUTHORITY;
 const plan=await arm64CapsuleSessionPlan(f.env,'arm64','/pack/metaviewer',f.operator,commit,f.pins);
 assert.equal(plan.transport.mode,'trusted-user-invocation');assert.equal(plan.transport.xauthority,null);
});
test('unsafe registry and modified helper refuse before child execution',async t=>{
 const f=await fixture(t);await fs.chmod(f.registry,0o644);
 await assert.rejects(arm64CapsuleSessionPlan(f.env,'arm64','/app',f.operator,commit,f.pins),/ARM64_SETUP_CUSTODY/);
 await fs.chmod(f.registry,0o600);await fs.appendFile(join(f.operator,'tools/arm64_capsules.py'),'# changed\n');
 await assert.rejects(arm64CapsuleSessionPlan(f.env,'arm64','/app',f.operator,commit,f.pins),/ARM64_SETUP_HELPER_PIN/);
});

test('generated bootstrap preserves retail and nested validation before setup effects',()=>{
 const guard=productionEntry.indexOf('const retail = validateRetailLaunch');
 const nested=productionEntry.indexOf("await import('./nested-display.js')");
 const setup=productionEntry.indexOf('const armPlan=await arm64CapsuleSessionPlan');
 assert.ok(guard>=0&&nested>guard&&setup>nested);
 assert.ok(productionEntry.includes("if(process.arch==='arm64' && process.env.MV_ARM64_CAPSULES!=='1')"));
 assert.ok(productionEntry.includes("'--launcher-pid',String(process.pid),'--launcher-start',launcherStart"));
 assert.ok(productionEntry.includes("const signals=['SIGTERM','SIGINT','SIGHUP']"));
 assert.ok(productionEntry.includes('process.removeListener(signal,fn)'));
});

async function generatedBoundary({argv=[],env={},signal=null,spawnFailure=null}={}) {
 const events=[];
 const fakeProcess=new EventEmitter();
 Object.assign(fakeProcess,{argv:['/pack/metaviewer',...argv],env,arch:'arm64',execPath:'/pack/metaviewer',resourcesPath:'/pack/resources',pid:123,
  exit(code){events.push(['exit',code]);throw new Error('MOCK_EXIT');}});
 const begin=productionEntry.indexOf('const retail = validateRetailLaunch');
 const end=productionEntry.indexOf('  let runtime = null;',begin);
 const source=productionEntry.slice(begin,end);
 assert.equal(source.split("await import('./nested-display.js')").length,2);
 // Only the dynamic module loader is replaced. The shipped dispatch, guard,
 // spawning, signal handlers and cleanup execute unchanged with inert effects.
 const body=source.replace("await import('./nested-display.js')",'await nestedDispatch()')+'\n}';
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const run=new AsyncFunction('process','validateRetailLaunch','app','protocol','mainModule','dirname','appRoot','join','root','fs','arm64CapsuleSessionPlan','ARM64_SETUP_HELPER_PINS','spawn','once','writeFdSync','nestedDispatch',body);
 const fakeFs={
  async readFile(path){return path==='/proc/self/stat'?'123 (launcher) S '+Array.from({length:19},(_,i)=>i===18?'777':'0').join(' '):JSON.stringify({commit});},
  async mkdtemp(){events.push(['transport-create']);return '/private/transport';},async chmod(){},async writeFile(){},async rm(){events.push(['transport-remove']);}
 };
 const spawn=()=>{events.push(['spawn']);if(spawnFailure==='throw')throw new Error('SPAWN_FAILED');const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
  child.kill=signum=>{events.push(['kill',signum]);return true;};
  setImmediate(()=>{if(spawnFailure==='error'){child.emit('error',new Error('SPAWN_FAILED'));return;}if(signal)fakeProcess.emit(signal);child.exitCode=0;child.emit('exit',0,null);});return child;};
 try {await run(fakeProcess,validateRetailLaunch,{exit(code){events.push(['retail-refused',code]);}},null,{},()=>'/pack','/app',join,'/pin',fakeFs,
  async()=>{events.push(['plan']);return {python:'/usr/bin/python3',helper:'/helper',argv:[],transport:{}};},{},spawn,once,
  (_fd,text)=>events.push(['stderr',text]),async()=>events.push(['nested']));}
 catch(error){assert.equal(error.message,'MOCK_EXIT');}
 return {events,process:fakeProcess};
}

test('actual generated boundary refuses hostile retail input before setup and preserves nested dispatch',async()=>{
 for(const options of [{argv:['--remote-debugging-port=9222']},{env:{PYTHONPATH:'/untrusted'}}]) {
  const {events}=await generatedBoundary(options);
  assert.equal(events.some(e=>e[0]==='retail-refused'),true);
  assert.equal(events.some(e=>['plan','spawn','transport-create'].includes(e[0])),false);
 }
 const nested=await generatedBoundary({argv:['--nested-depth=1']});
 assert.deepEqual(nested.events,[['nested']]);
});

test('actual generated delegation forwards each termination signal and removes private transport and listeners',async()=>{
 for(const signal of ['SIGTERM','SIGINT','SIGHUP']) {
  const {events,process:child}=await generatedBoundary({signal});
  assert.equal(events.filter(e=>e[0]==='spawn').length,1);
  assert.deepEqual(events.filter(e=>e[0]==='kill'),[['kill',signal]]);
  assert.equal(events.filter(e=>e[0]==='transport-remove').length,1);
  for(const name of ['SIGTERM','SIGINT','SIGHUP'])assert.equal(child.listenerCount(name),0);
 }
});

test('actual generated delegation retains refusal and removes transport on partial spawn failure',async()=>{
 for(const spawnFailure of ['throw','error']) {
  const {events,process:child}=await generatedBoundary({spawnFailure});
  assert.equal(events.filter(e=>e[0]==='transport-remove').length,1);
  assert.ok(events.some(e=>e[0]==='stderr'&&e[1].includes('ARM64_SETUP_REFUSED: SPAWN_FAILED')));
  assert.deepEqual(events.filter(e=>e[0]==='kill'),[]);
  assert.deepEqual(events.filter(e=>e[0]==='exit'),[['exit',2]]);
  for(const name of ['SIGTERM','SIGINT','SIGHUP'])assert.equal(child.listenerCount(name),0);
 }
});

for(const [name,metadata] of [['wrong owner',{uid:12345}],['writable interpreter',{mode:0o100775}],['nonexecutable interpreter',{mode:0o100644}],['nonregular interpreter',{isFile:()=>false}]]) {
 test('fixed interpreter metadata refuses '+name,async t=>{
  fixedSystemPython(t,metadata);const f=await fixture(t);
  await assert.rejects(arm64CapsuleSessionPlan(f.env,'arm64','/pack/metaviewer',f.operator,commit,f.pins),/ARM64_SETUP_PYTHON/);
 });
}
