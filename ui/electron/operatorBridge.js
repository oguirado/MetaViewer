import { isProtectedIdentity, isForeignIdentity } from './identityProtection.js';
import {adapterNetworkProbe} from './coreLauncher.js';
import {createButtonService,OPERATOR_STOP_BUDGET_MS} from './buttonBridge.js';
// @ts-check
/** [TARGET, unit decision] Host-only operator seam. The launcher supplies
 * MV_HANDOFF_PATHS as a JSON array of owner output.with_suffix('.handoff.json')
 * paths. A durable adjacent ack record is separate from the immutable owner
 * record. Egress writes publish the adapter's exact per-profile record, to take
 * effect on next capsule start; this seam does not mutate a running network.
 * No agent channel or credential operation is registered here. */
import * as fs from 'node:fs';
import { dirname, basename, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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
function readPrivate(root,name,inspect=(/** @type {fs.Stats} */_st)=>{}) {
  const fd=fs.openSync(join(root,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const st=fs.fstatSync(fd);
    if(!st.isFile() || st.uid!==process.getuid?.() || (st.mode&0o777)!==0o600 || st.size>65536) throw new Error('PRIVATE_FILE');
    inspect(st);
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
  const domains=row.allowed_domains===undefined || row.allowed_domains===null?[]:row.allowed_domains;
  const result={id:row.profile_id,label:row.account_label,domains,logged_in:'unknown',...(row.browser==='program'?{browser:'program'}:{})};
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
export const defaultIdentityTool = () => fileURLToPath(new URL('../../tools/mv_identity.py', import.meta.url));
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
/** Closed identity refusal codes surfaced across the host-to-renderer seam. */
const IDENTITY_REFUSALS = new Set(['IDENTITY_REFUSED','IDENTITY_PROTECTED','PROFILE_NOT_PROVISIONED','PROFILE_MISSING','IDENTITY_BOUND']);
/** [TARGET, unit decision] Missing native profile provisioning (uid 10001, 0700)
 * is a distinct operator prerequisite before login; other closed tool refusals
 * map to IDENTITY_REFUSED. Everything else means the tool could not run.
 * @param {string} stdout @returns {string|null} */
export function toolRefusedCode(stdout) {
  try {
    const reply=JSON.parse(stdout);
    if(!operatorKeys(reply,['schema','ok','error']) || reply.schema!=='metaviewer.identity/v1' || reply.ok!==false || typeof reply.error!=='string' || !/^[A-Z][A-Z0-9_-]{0,63}$/.test(reply.error) || TOOL_UNAVAILABLE.has(reply.error))return null;
    if(reply.error==='IDENTITY_PROTECTED' || reply.error==='PROFILE_MISSING' || reply.error==='PROFILE_NOT_PROVISIONED' || reply.error==='IDENTITY_BOUND')return reply.error;
    return 'IDENTITY_REFUSED';
  }catch{return null;}
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
    if(v?.id && (isForeignIdentity(v.id) || method==='delete' && isProtectedIdentity(v.id))){reject(new Error('IDENTITY_PROTECTED'));return;}
    const argv=[tool,method,...(method==='list'?[]:['--id',v.id]),...(method==='create'?['--label',v.label,...(v.browser==='program'?['--browser','program']:['--domains',v.domains.join(',')])]:[])];
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
        if(rc!==0)throw new Error(toolRefusedCode(stdout)??'IDENTITY_EXIT');
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
/** [TARGET, unit decision] Bounds of the run-dir handoff watcher. */
export const HANDOFF_DISCOVERY=Object.freeze({maxScan:4096,maxRuns:32,maxAgeMs:6*3600*1000,maxLatched:64,fileName:'memoryweb-run.handoff.json'});
// [TARGET, unit decision] File age is checked against this Electron process,
// not watcher installation or run-directory mtime. Older records need both the
// adapter's exact surface binding and a currently running identity container.
const HANDOFF_SESSION_START=Date.now()-process.uptime()*1000;
/** @param {NodeJS.ProcessEnv} env @returns {Map<string,number>} */
function runningHandoffContainers(env) {
  const options={env,encoding:/** @type {const} */('utf8'),timeout:1000,maxBuffer:65536,windowsHide:true};
  const reply=spawnSync('docker',['ps','--format','{{.Names}}'],options);
  if(reply.error || reply.status!==0)return new Map();
  const names=reply.stdout.trim().split('\n').filter(name=>/^srf-(id|pg)-[a-z0-9][a-z0-9-]{0,63}$/.test(name));
  if(!names.length || names.length>HANDOFF_DISCOVERY.maxLatched)return new Map();
  const inspected=spawnSync('docker',['inspect','--format','{{.Name}} {{.State.Running}} {{.State.StartedAt}}',...names],options);
  if(inspected.error || inspected.status!==0)return new Map();
  /** @type {Map<string,number>} */const running=new Map();
  for(const line of inspected.stdout.trim().split('\n')) {
    const [name,active,started]=line.split(' '),at=Date.parse(started);
    if(active==='true' && Number.isFinite(at) && at>0 && names.includes(name.replace(/^\//,'')))running.set(name.replace(/^\//,''),at);
  }
  return running;
}
/** @param {NodeJS.ProcessEnv} env @param {any} record @param {number} modified @param {()=>Map<string,number>} containers */
function survivingHandoff(env,record,modified,containers) {
  if(!env.MV_SRF_STATE_DIR)return false;
  try {
    return privateDirectory(join(env.MV_SRF_STATE_DIR,'human-bindings'),root=>{
      const b=readPrivate(root,record.surface_id+'.json');
      return b.schema==='metaviewer.human_binding/v0.3' && b.surface_id===record.surface_id
        && b.control_ready===true && ['agent','human'].includes(b.role)
        && typeof b.profile_id==='string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(b.profile_id)
        && typeof b.run_id==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(b.run_id)
        && (b.container==='srf-id-'+b.profile_id || b.container==='srf-pg-'+b.profile_id)
        // A recreated container may reuse the name while the old surface file remains.
        && (containers().get(b.container)??Infinity)<=modified;
    });
  }catch{return false;}
}
/** Newest recent private run directories of tools/mw_run_backend.py, as the fixed
 * handoff path inside each. Symlinked entries and foreign names are skipped; the
 * private-directory and private-file reads at latch time stay the trust gate.
 * @param {Record<string,string|undefined>} env @param {number} nowMs @returns {string[]} */
export function discoverHandoffPaths(env,nowMs) {
  const state=typeof env.MV_OPERATOR_STATE_HOME==='string' && env.MV_OPERATOR_STATE_HOME!==''?env.MV_OPERATOR_STATE_HOME:typeof env.XDG_STATE_HOME==='string' && env.XDG_STATE_HOME!==''?env.XDG_STATE_HOME:typeof env.HOME==='string' && env.HOME!==''?join(env.HOME,'.local/state'):'';
  // [TARGET, unit decision] Browser goals may export XDG_STATE_HOME in a shell
  // after the app starts. Watch the documented goal/tour RAM namespaces too;
  // every final record still passes the descriptor-based private-file gate.
  const roots=new Set([state,env.XDG_STATE_HOME,join('/dev/shm/vqa-cu',`metaviewer-program-${process.getuid?.()}`)]);
  try {
    const dir=fs.opendirSync('/dev/shm');
    try {
      for(let i=0;i<HANDOFF_DISCOVERY.maxScan;i++) {
        const entry=dir.readSync();if(!entry)break;
        if(entry.isDirectory() && /^metaviewer-(goal|tour)\.[A-Za-z0-9]+$/.test(entry.name))roots.add(join('/dev/shm',entry.name));
      }
    } finally {dir.closeSync();}
  }catch{/* RAM namespace unavailable: retain configured state discovery. */}
  const candidates=[...roots].filter(x=>typeof x==='string')
    .flatMap(root=>discoverRunHandoffs(/** @type {string} */(root),nowMs));
  /** @type {Map<string,{mtime:number,paths:string[]}>} */const runs=new Map();
  for(const path of candidates) {
    const dir=dirname(path);
    try {
      if(!runs.has(dir))runs.set(dir,{mtime:fs.lstatSync(dir).mtimeMs,paths:[]});
      runs.get(dir)?.paths.push(path);
    }catch{/* Raced removal. */}
  }
  return [...runs.entries()].sort((a,b)=>b[1].mtime-a[1].mtime||(a[0]<b[0]?-1:1))
    .slice(0,HANDOFF_DISCOVERY.maxRuns).flatMap(([,run])=>run.paths);
}
/** @param {string} state @param {number} nowMs @returns {string[]} */
function discoverRunHandoffs(state,nowMs) {
  if(!isAbsolute(state) || resolve(state)!==state)return [];
  const runs=join(state,'metaviewer/runs');
  /** @type {{name:string,mtime:number}[]} */const found=[];
  let dir;
  try {
    dir=fs.opendirSync(runs);
    for(let i=0;i<HANDOFF_DISCOVERY.maxScan;i++) {
      const entry=dir.readSync();if(!entry)break;
      if(!/^[0-9a-f]{32}$/.test(entry.name))continue;
      try {
        const st=fs.lstatSync(join(runs,entry.name));
        if(st.isDirectory() && nowMs-st.mtimeMs<=HANDOFF_DISCOVERY.maxAgeMs)found.push({name:entry.name,mtime:st.mtimeMs});
      }catch{/* Raced removal. */}
    }
  }catch{return [];}
  finally {try{dir?.closeSync();}catch{/* Already closed. */}}
  return found.sort((a,b)=>b.mtime-a.mtime||(a.name<b.name?-1:1)).slice(0,HANDOFF_DISCOVERY.maxRuns)
    .flatMap(x=>[HANDOFF_DISCOVERY.fileName,'browser-goal.handoff.json'].map(name=>join(runs,x.name,name)))
    .filter(path=>{try{return fs.lstatSync(path).isFile();}catch{return false;}});
}
/** @param {any} options */
export function createOperatorService({env=process.env,runIdentity,buttons,notify=()=>{},now=Date.now,sessionStartedAt=HANDOFF_SESSION_START}) {
  /** @type {Map<string,{path:string,record:any,acked:boolean}>} */ const latched=new Map();
  /** @type {string[]} */ let paths=[];
  let configError=false;
  try {paths=JSON.parse(env.MV_HANDOFF_PATHS??'[]');if(!Array.isArray(paths) || paths.length>64 || !paths.every(p=>typeof p==='string' && isAbsolute(p) && p.endsWith('.handoff.json')) || new Set(paths).size!==paths.length)throw new Error();}
  catch {paths=[];configError=true;}
  // [TARGET, unit decision] Run-dir discovery: each mw_run writes its handoff record under a
  // fresh uuid directory, so a fixed launcher list can never name it. When MV_HANDOFF_PATHS is
  // absent the host watches the newest private run directories instead.
  const discover=env.MV_HANDOFF_PATHS===undefined;
  const rows=()=>[...latched.values()].filter(x=>!x.acked).map(x=>x.record);
  const state=()=>({ok:true,rows:rows()});
  // refresh runs every second on the main thread: judge each old record once, or a stale
  // binding would block the UI on docker until the record ages out.
  /** @type {Map<string,number>} */const rejectedOld=new Map();
  function refresh() {
    let changed=false;
    /** @type {Map<string,number>|undefined} */let running;
    const containers=()=>running??=runningHandoffContainers(env);
    const candidates=discover?[...paths,...discoverHandoffPaths(env,now())]:paths;
    for(const path of candidates) {
      if(latched.has(path))continue;
      try {if(rejectedOld.get(path)===fs.statSync(path).mtimeMs)continue;}catch{/* The read below reports it. */}
      if(latched.size>=HANDOFF_DISCOVERY.maxLatched) {
        const spent=[...latched.entries()].find(([,x])=>x.acked);
        if(!spent)break;
        latched.delete(spent[0]);
      }
      try {
        privateDirectory(dirname(path),root=>{
          let modified=0;
          const record=readPrivate(root,basename(path),st=>{modified=st.mtimeMs;});if(!validHandoff(record))throw new Error('HANDOFF_RECORD');
          if(modified<sessionStartedAt && !survivingHandoff(env,record,modified,containers)) {rejectedOld.set(path,modified);return;}
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
      if(v?.id && (isForeignIdentity(v.id) || method==='identity.delete' && isProtectedIdentity(v.id)))return {ok:false,code:'IDENTITY_PROTECTED'};
      try {return assertOperatorReply(method,await runIdentity(method.split('.')[1],v));}
      catch(e){const code=/** @type {any} */(e)?.message;return {ok:false,code:IDENTITY_REFUSALS.has(code)?code:'IDENTITY_UNAVAILABLE'};}
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
export function installOperatorBridge({ipcMain,contents,env,tool,buttonRoot,demoRoot,clipboard,admit,openLogin,spawnTool=spawn,buttons=createButtonService({root:buttonRoot,demoRoot,clipboard,env,stopBudgetMs:OPERATOR_STOP_BUDGET_MS}),runIdentity=(()=>{const resolved=resolveIdentityTool({tool,env});return identityRunner({tool:resolved,env:identityEnvironment(env,resolved),spawnTool,openLogin});})()}) {
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
