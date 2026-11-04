import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPackagedBootLifecycle,productionEntry} from '../tools/package.js';
import {scrubChildEnv,ALLOWED_CORE_ENV} from '../electron/coreLauncher.js';

async function fixture() {
 const root=await mkdtemp('/dev/shm/mv-core-optin-');
 const home=join(root,'home');await mkdir(home,{mode:0o700});
 const instance='agent-rewind-optin',owner_id='actor-'+createHash('sha256').update('agent:'+instance).digest('hex');
 const profile={schema:'mv-rewind-host/v1',owner_id,python:{},python_prefix:'/usr',runner:{},controller_relative:'rewind_runtime/controller.py',files:[],guardian_unit:'synthetic.scope',state_root:root,runtime_root:root,config_template:{schema:'rewind-host-config/v1',runtime_admitted:true,owner_id}};
 const profilePath=join(root,'profile.json');await writeFile(profilePath,JSON.stringify(profile),{mode:0o600});
 return {root,profile,profilePath,env:{HOME:home,XDG_RUNTIME_DIR:root,TMPDIR:root,PATH:'/usr/bin:/bin',MV_REWIND_ENABLED:'1',MV_REWIND_PROFILE:profilePath,MV_REWIND_AGENT_INSTANCE:instance,SECRET_TOKEN:'synthetic-must-not-leak',DISPLAY:':9999'}};
}
function check(env,enabled){
 assert.deepEqual([...ALLOWED_CORE_ENV],['LANG','LC_ALL','PATH','TMPDIR','TZ']);
 assert.equal(env.MV_REWIND_ENABLED,enabled?'1':undefined);
 for(const name of ['MV_REWIND_PROFILE','MV_REWIND_AGENT_INSTANCE','SECRET_TOKEN','DISPLAY'])assert.equal(env[name],undefined,name);
 assert.deepEqual(Object.keys(env).sort(),['MV_CORE_CONFIG','PATH','TMPDIR','XDG_RUNTIME_DIR','XDG_STATE_HOME',...(enabled?['MV_REWIND_ENABLED']:[])].sort());
}
async function lifecycle(env){
 let captured;
 const boot=await createPackagedBootLifecycle({env,scrubChildEnv,spawn:(_cmd,_args,options)=>{captured=options.env;const c=new EventEmitter();c.pid=undefined;c.exitCode=0;c.signalCode=null;return c;},app:{on(){},removeAllListeners(){},exit(){}},processObj:{pid:process.pid,on(){}}});
 await boot.stop();return captured;
}
test('real packaged lifecycle forwards only validated Rewind opt-in beyond frozen core environment',async()=>{
 const f=await fixture();try{check(await lifecycle({...f.env}),true);const normal={...f.env};delete normal.MV_REWIND_ENABLED;check(await lifecycle(normal),false);check(await lifecycle({...f.env,MV_REWIND_ENABLED:'0'}),false);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('real packaged lifecycle refuses invalid profile or mismatched agent before core spawn',async()=>{
 const f=await fixture();try{await writeFile(f.profilePath,JSON.stringify({...f.profile,config_template:{...f.profile.config_template,runtime_admitted:false}}));await assert.rejects(lifecycle({...f.env}),/HEADLESS_AGENT_BINDING/);await writeFile(f.profilePath,JSON.stringify(f.profile));await assert.rejects(lifecycle({...f.env,MV_REWIND_AGENT_INSTANCE:'agent-foreign'}),/HEADLESS_AGENT_BINDING/);}finally{await rm(f.root,{recursive:true,force:true});}
});
async function generated(f,env,source=productionEntry){
 const app=join(f.root,'app'),electron=join(app,'electron');await mkdir(electron,{recursive:true});await writeFile(join(app,'package.json'),'{"type":"module"}');await writeFile(join(electron,'package-pin.json'),JSON.stringify({version:'0.2.5',commit:'a'.repeat(40)}));
 await writeFile(join(electron,'main.js'),"export const validateRetailLaunch=()=>({ok:true});export const mainDirectEntry=()=>{};export const registerPrivilegedScheme=()=>{};");
 await writeFile(join(electron,'coreLauncher.js'),`export {scrubChildEnv} from ${JSON.stringify(new URL('../electron/coreLauncher.js',import.meta.url).href)};export const validateKillTarget=()=>false;`);
 const needle='  verifyBootSeal(appRoot);';assert.equal(source.split(needle).length,2);await writeFile(join(electron,'entry.js'),source.replace(needle,'  /* Existing seal independently tested; fixture has no packaged assets. */'));
 const fakeElectron="export const app={on(){},removeAllListeners(){},whenReady:async()=>{},requestSingleInstanceLock:()=>true,exit:c=>process.exit(c)};export const protocol={};export const BrowserWindow={};";
 const fakeSpawn="export function execFile(){throw Error('UNEXPECTED_EXECFILE');} export function spawn(path,args,options){process.stdout.write('CAPTURED_CORE_ENV '+JSON.stringify(options.env)+'\\n');throw Error('STOP_AFTER_CAPTURE');}";
 const bootstrap=`import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){const v=s==='electron'?${JSON.stringify(fakeElectron)}:s==='node:child_process'?${JSON.stringify(fakeSpawn)}:null;return v?{url:'data:text/javascript,'+encodeURIComponent(v),shortCircuit:true}:next(s,c);}});await import(${JSON.stringify(pathToFileURL(join(electron,'entry.js')).href)});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',bootstrap],{env,encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(result.signal,null,result.stderr);assert.equal(result.error,undefined);
 const line=result.stdout.split('\n').find(v=>v.startsWith('CAPTURED_CORE_ENV '));return {result,env:line?JSON.parse(line.slice('CAPTURED_CORE_ENV '.length)):null};
}
test('actual generated production entry forwards protected flag and no private profile/path fields',async()=>{
 const f=await fixture();try{const result=await generated(f,{...f.env});assert.ok(result.env,result.result.stderr);check(result.env,true);const normal={...f.env};delete normal.MV_REWIND_ENABLED;const control=await generated(f,normal);assert.ok(control.env,control.result.stderr);check(control.env,false);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('actual generated entry rejects invalid protected profile before core environment exists',async()=>{
 const f=await fixture();try{await writeFile(f.profilePath,JSON.stringify({...f.profile,owner_id:'actor-foreign'}));const result=await generated(f,{...f.env});assert.equal(result.env,null);assert.equal(result.result.status,1);assert.match(result.result.stderr,/HEADLESS_AGENT_BINDING/);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('dropping generated forwarding is killed by the same real core-environment assertion',async()=>{
 const f=await fixture();try{const old=productionEntry.replace("...(rewindCoreEnabled && agentInstance ? {MV_REWIND_ENABLED:'1'} : {}), ",'');assert.notEqual(old,productionEntry);const result=await generated(f,{...f.env},old);assert.ok(result.env,result.result.stderr);assert.throws(()=>check(result.env,true),assert.AssertionError);}finally{await rm(f.root,{recursive:true,force:true});}
});
