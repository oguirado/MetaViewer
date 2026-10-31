import {adapterNetworkProbe} from './coreLauncher.js';
import {createButtonService} from './buttonBridge.js';
// @ts-check
/** [TARGET, unit decision] Host-only operator seam. The launcher supplies
 * MV_HANDOFF_PATHS as a JSON array of owner output.with_suffix('.handoff.json')
 * paths. A durable adjacent ack record is separate from the immutable owner
 * record. Egress writes publish the adapter's exact per-profile record, to take
 * effect on next capsule start; this seam does not mutate a running network.
 * No agent channel or credential operation is registered here. */
import * as fs from 'node:fs';
import { dirname, basename, join, isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BUTTON_METHODS, OPERATOR_METHODS, assertOperatorCall, assertOperatorReply, operatorKeys, validEgress, validHandoff } from './preload.js';

/** Hold every directory descriptor during traversal, refusing symlinks. The
 * final directory and files must be private and owned by the current uid.
 * @param {string} path @param {(root:string)=>any} work */
export function privateDirectory(path,work) {
  if(!isAbsolute(path) || resolve(path)!==path) throw new Error('PRIVATE_PATH');
  let fd=fs.openSync('/',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  try {
    for(const part of path.split('/').filter(Boolean)) {
      const next=fs.openSync(`/proc/self/fd/${fd}/${part}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
      fs.closeSync(fd);fd=next;
    }
    const st=fs.fstatSync(fd);
    if(st.uid!==process.getuid?.() || (st.mode&0o777)!==0o700) throw new Error('PRIVATE_PATH');
    return work(`/proc/self/fd/${fd}`);
  } finally {fs.closeSync(fd);}
}
/** @param {string} root @param {string} name */
function readPrivate(root,name) {
  const fd=fs.openSync(join(root,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const st=fs.fstatSync(fd);
    if(!st.isFile() || st.uid!==process.getuid?.() || (st.mode&0o777)!==0o600 || st.size>65536) throw new Error('PRIVATE_FILE');
    const buffer=Buffer.alloc(65537); const n=fs.readSync(fd,buffer,0,buffer.length,0);
    if(n>65536) throw new Error('PRIVATE_FILE');
    return JSON.parse(buffer.subarray(0,n).toString('utf8'));
  } finally {fs.closeSync(fd);}
}
/** @param {string} root @param {string} name @param {any} value */
function writePrivate(root,name,value) {
  try { readPrivate(root,name); } catch(e) {if(/** @type {any} */(e).code!=='ENOENT')throw e;}
  const tmp=join(root,`.operator-${randomUUID()}`);
  const fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try {fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  try {fs.renameSync(tmp,join(root,name));const d=fs.openSync(root,fs.constants.O_RDONLY);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
  finally {try{fs.unlinkSync(tmp);}catch(e){if(/** @type {any} */(e).code!=='ENOENT')throw e;}}
  if(JSON.stringify(readPrivate(root,name))!==JSON.stringify(value)) throw new Error('PERSISTENCE_FAILED');
}
/** @param {any} row */
export function publicIdentity(row) {
  const allowed=['profile_id','browser','account_label','allowed_domains','created_unix','last_login_unix'];
  if(!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).some(k=>!allowed.includes(k))) throw new Error('IDENTITY_REPLY');
  // [TARGET, unit decision] Login history cannot prove current authentication.
  // The native tool has no current-session witness; null is not a logged-out state.
  const result={id:row.profile_id,label:row.account_label,domains:row.allowed_domains,logged_in:'unknown'};
  assertOperatorReply('identity.show',{ok:true,rows:[result]});
  return result;
}
/** [TARGET, unit decision] The packaged resources do not ship tools/mv_identity.py;
 * the operator-owned checkout named by MV_OPERATOR_REPO (the same trust root as
 * the demo tool) supplies it when the bundled path is absent.
 * @param {{tool:string,env?:NodeJS.ProcessEnv,exists?:(path:string)=>boolean}} options */
export function resolveIdentityTool({tool,env=process.env,exists=p=>fs.existsSync(p)}) {
  if(typeof tool==='string' && exists(tool))return tool;
  const repo=env.MV_OPERATOR_REPO;
  if(typeof repo==='string' && isAbsolute(repo) && resolve(repo)===repo) {
    const candidate=join(repo,'tools/mv_identity.py');
    if(exists(candidate))return candidate;
  }
  return tool;
}
/** [TARGET, unit decision] MV_MW_HOME is required by the tool only to prove
 * store separation; when the launcher does not set it, default to the tool
 * checkout's gitignored memoryweb/ directory. The runner still copies only its
 * fixed allowlist.
 * @param {NodeJS.ProcessEnv} env @param {string} tool */
export function identityEnvironment(env,tool) {
  if(typeof env.MV_MW_HOME==='string' || typeof tool!=='string' || !isAbsolute(tool))return env;
  return {...env,MV_MW_HOME:join(dirname(dirname(tool)),'memoryweb')};
}
/** Tool codes that mean the tool or its native binaries could not operate
 * (missing configuration, unreadable store, native binary absent). */
const TOOL_UNAVAILABLE = new Set(['IDENTITY_UNAVAILABLE','NATIVE_UNAVAILABLE','ABSOLUTE_PATH_REQUIRED']);
/** A refusal is the tool's own closed reply: exit != 0 with a single JSON line
 * {schema, ok:false, error} naming a decision (bound, invalid, native refusal).
 * Anything else means the tool could not run.
 * @param {string} stdout */
function toolRefused(stdout) {
  try {
    const reply=JSON.parse(stdout);
    return operatorKeys(reply,['schema','ok','error']) && reply.schema==='metaviewer.identity/v1' && reply.ok===false && typeof reply.error==='string' && /^[A-Z][A-Z0-9_-]{0,63}$/.test(reply.error) && !TOOL_UNAVAILABLE.has(reply.error);
  }catch{return false;}
}
/** Bound for the tool's own cleanup (view-stop waits up to 180 s) before SIGKILL. */
const LOGIN_STOP_GRACE_MS=200000;
/** Spawn one fixed tool, never a shell. Login stderr is inspected solely for
 * the tool's loopback operator-view announcement; it is never sent to the UI.
 * Login is stopped with SIGINT (the tool's documented Ctrl+C close, which runs
 * its cleanup of the login-pending reservation); SIGTERM would skip that cleanup.
 * @param {any} options */
export function identityRunner({tool,env=process.env,spawnTool=spawn,openLogin=async()=>{}}) {
  /** @type {Set<()=>void>} */ const live=new Set();
  const run=(/** @type {string} */method,/** @type {any} */v)=>new Promise((accept,reject)=>{
    const argv=[tool,method,...(method==='list'?[]:['--id',v.id]),...(method==='create'?['--label',v.label,'--domains',v.domains.join(',')]:[])];
    const child=spawnTool('python3',argv,{shell:false,env:Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR','TZ','HOME','XDG_RUNTIME_DIR','XDG_STATE_HOME','XDG_CONFIG_HOME','MV_SRF_BIN_DIR','MV_SRF_STATE_DIR','SRF_IDENTITY_STORE_ROOT','MV_MW_HOME'].filter(k=>typeof env[k]==='string').map(k=>[k,env[k]])),stdio:['ignore','pipe','pipe'],detached:true});
    let stdout='',stderr='',bytes=0,settled=false,opened=false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let killTimer;
    const signalGroup=(/** @type {NodeJS.Signals} */signal)=>{try{if(child.pid)process.kill(-child.pid,signal);}catch{/* Already exited. */}};
    const terminate=()=>{
      if(method!=='login'){signalGroup('SIGTERM');return;}
      signalGroup('SIGINT');
      if(!killTimer){killTimer=setTimeout(()=>signalGroup('SIGKILL'),LOGIN_STOP_GRACE_MS);killTimer.unref?.();}
    };
    live.add(terminate);
    const timer=setTimeout(()=>{terminate();finish(new Error('IDENTITY_TIMEOUT'));},method==='login'?1800000:30000);
    /** @param {any} error @param {any} [value] */
    function finish(error,value) {if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else accept(value);}
    /** @param {any} b @param {boolean} err */
    function data(b,err) {
      bytes+=b.length;
      if(bytes>65536){terminate();finish(new Error('IDENTITY_LIMIT'));return;}
      if(err)stderr+=b.toString('utf8');else stdout+=b.toString('utf8');
      if(method==='login' && !opened) {
        const found=stderr.match(/Operator login view: (http:\/\/\S+) \(close/);
        if(found) {
          let url;try{url=new URL(found[1]);}catch{terminate();finish(new Error('LOGIN_URL'));return;}
          if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password){terminate();finish(new Error('LOGIN_URL'));return;}
          opened=true;Promise.resolve(openLogin(url.href)).catch(()=>{terminate();finish(new Error('LOGIN_VIEW'));});
        }
      }
    }
    child.stdout.on('data',(/** @type {any} */b)=>data(b,false));child.stderr.on('data',(/** @type {any} */b)=>data(b,true));
    child.once('error',(/** @type {any} */e)=>{live.delete(terminate);finish(e);});
    child.once('close',(/** @type {number} */rc)=>{
      live.delete(terminate);clearTimeout(killTimer);
      try {
        if(rc!==0)throw new Error(toolRefused(stdout)?'IDENTITY_REFUSED':'IDENTITY_EXIT');
        const reply=JSON.parse(stdout);
        if(!operatorKeys(reply,['schema','ok','result']) || reply.schema!=='metaviewer.identity/v1' || reply.ok!==true || (method==='login' && !opened))throw new Error('IDENTITY_REPLY');
        if(method==='delete') {if(!operatorKeys(reply.result,['deleted']) || reply.result.deleted!==v.id)throw new Error('IDENTITY_REPLY');finish(null,{ok:true});}
        else if(method==='login') {if(!operatorKeys(reply.result,['profile_id','container','login_view_closed']) || reply.result.profile_id!==v.id || reply.result.login_view_closed!==true)throw new Error('IDENTITY_REPLY');finish(null,{ok:true});}
        else {
          const rows=method==='list'?reply.result:[reply.result];
          if(!Array.isArray(rows) || rows.length>256)throw new Error('IDENTITY_REPLY');
          const result={ok:true,rows:rows.map(publicIdentity)};
          if(method!=='list' && result.rows[0].id!==v.id)throw new Error('IDENTITY_REPLY');
          finish(null,result);
        }
      }catch(e){finish(e);}
    });
  });
  /** App teardown: ask every in-flight child to stop through the same path. */
  run.dispose=()=>{for(const stop of [...live])stop();};
  return run;
}
/** @param {any} options */
export function createOperatorService({env=process.env,runIdentity,buttons,notify=()=>{}}) {
  /** @type {Map<string,{path:string,record:any,acked:boolean}>} */ const latched=new Map();
  /** @type {string[]} */ let paths=[];
  let configError=false;
  try {paths=JSON.parse(env.MV_HANDOFF_PATHS??'[]');if(!Array.isArray(paths) || paths.length>64 || !paths.every(p=>typeof p==='string' && isAbsolute(p) && p.endsWith('.handoff.json')) || new Set(paths).size!==paths.length)throw new Error();}
  catch {paths=[];configError=true;}
  const rows=()=>[...latched.values()].filter(x=>!x.acked).map(x=>x.record);
  const state=()=>({ok:true,rows:rows()});
  function refresh() {
    let changed=false;
    for(const path of paths) {
      if(latched.has(path))continue;
      try {
        privateDirectory(dirname(path),root=>{
          const record=readPrivate(root,basename(path));if(!validHandoff(record))throw new Error('HANDOFF_RECORD');
          let acked=false;
          try {const ack=readPrivate(root,basename(path)+'.ack.json');acked=operatorKeys(ack,['schema','surface_id','step_index']) && ack.schema==='metaviewer.handoff_ack/v1' && ack.surface_id===record.surface_id && ack.step_index===record.step_index;}catch{/* No proven ack: keep visible. */}
          latched.set(path,{path,record,acked});changed=true;
        });
      } catch { /* A missing or failed read never clears a latched notification. */ }
    }
    if(changed)notify(state());
    return state();
  }
  /** @param {string} method @param {any[]} args */
  async function request(method,args) {
    assertOperatorCall(method,args);
    if(BUTTON_METHODS.includes(method))return buttons.request(method,args);
    const v=args[0];
    if(method.startsWith('identity.')) {
      try {return assertOperatorReply(method,await runIdentity(method.split('.')[1],v));}
      catch(e){return {ok:false,code:/** @type {any} */(e)?.message==='IDENTITY_REFUSED'?'IDENTITY_REFUSED':'IDENTITY_UNAVAILABLE'};}
    }
    if(method.startsWith('egress.')) {
      try {
        let modes=['legacy'];if(env.MV_SRF_NET_MODES!==undefined){modes=JSON.parse(env.MV_SRF_NET_MODES);if(!Array.isArray(modes)||!modes.length||!modes.every(x=>['legacy','open','proxied'].includes(x)))throw new Error('MODES');}
        const probe=adapterNetworkProbe(env);
        if(probe)modes=probe.reason==='ok'?[...probe.modes]:['legacy'];
        if(method==='egress.set' && v.record.mode==='open' && !modes.includes('open') && v.confirm!==true)return {ok:false,code:'NET_OPEN_PREREQ'};
        if(method==='egress.set' && v.record.mode==='allowlisted' && !modes.includes('proxied'))return {ok:false,code:'NET_PROXIED_UNSUPPORTED'};
        const record=privateDirectory(env.MV_SRF_STATE_DIR,root=>{
          try{fs.mkdirSync(join(root,'egress'),{mode:0o700});}catch(e){if(/** @type {any} */(e).code!=='EEXIST')throw e;}
          // Use the pinned state descriptor; validate the child descriptor itself.
          const fd=fs.openSync(join(root,'egress'),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
          try {
            const st=fs.fstatSync(fd);if(st.uid!==process.getuid?.() || (st.mode&0o777)!==0o700)throw new Error('PRIVATE_PATH');
            const dir=`/proc/self/fd/${fd}`,name=v.identity+'.json';
            if(method==='egress.set')writePrivate(dir,name,v.record);
            let value;try{value=readPrivate(dir,name);}catch(e){if(/** @type {any} */(e).code!=='ENOENT')throw e;value={schema:'metaviewer.capsule_egress/v1',mode:'open',domains:[]};}
            if(!validEgress(value))throw new Error('EGRESS_RECORD');return value;
          }finally{fs.closeSync(fd);}
        });
        return {ok:true,record,reason:probe?.reason ?? 'binary_missing',net_mode:record.mode==='allowlisted'?(modes.includes('proxied')?'proxied':'legacy'):(modes.includes('open')?'open':'legacy')};
      }catch{return {ok:false,code:'NET_EGRESS_IO'};}
    }
    refresh();
    if(configError)return {ok:false,code:'HANDOFF_UNAVAILABLE'};
    if(method==='handoff.list')return state();
    const matches=[...latched.values()].filter(x=>x.record.surface_id===v.surface_id && x.record.step_index===v.step_index);
    if(!matches.length)return {ok:false,code:'HANDOFF_UNAVAILABLE'};
    try {
      for(const item of matches)if(!item.acked)privateDirectory(dirname(item.path),root=>writePrivate(root,basename(item.path)+'.ack.json',{schema:'metaviewer.handoff_ack/v1',surface_id:v.surface_id,step_index:v.step_index}));
      for(const item of matches)item.acked=true;
      notify(state());return {ok:true};
    }catch{return {ok:false,code:'HANDOFF_UNAVAILABLE'};}
  }
  return {request,refresh};
}
/** @param {any} options */
export function installOperatorBridge({ipcMain,contents,env,tool,buttonRoot,demoRoot,clipboard,admit,openLogin,spawnTool=spawn,buttons=createButtonService({root:buttonRoot,demoRoot,clipboard,env}),runIdentity=(()=>{const resolved=resolveIdentityTool({tool,env});return identityRunner({tool:resolved,env:identityEnvironment(env,resolved),spawnTool,openLogin});})()}) {
  let disposed=false;
  const service=createOperatorService({env,runIdentity,buttons,notify:(/** @type {any} */v)=>{if(!disposed)contents.send('metaviewer:handoff.state',v);}});
  /** @type {string[]} */ const installed=[];
  try {
    for(const method of OPERATOR_METHODS) {
      const channel=`metaviewer:${method}`;
      ipcMain.handle(channel,async(/** @type {any} */event,/** @type {any[]} */...args)=>{
        if(disposed || !admit(event))throw new Error('OPERATOR_SENDER');
        return assertOperatorReply(method,await service.request(method,args));
      });installed.push(channel);
    }
  }catch(e){for(const c of installed)ipcMain.removeHandler(c);throw e;}
  const timer=setInterval(()=>service.refresh(),1000);timer.unref();
  return {async dispose(){disposed=true;clearInterval(timer);for(const c of installed)ipcMain.removeHandler(c);runIdentity.dispose?.();await buttons.dispose();}};
}
