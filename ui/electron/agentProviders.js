// Host-owned CLI profiles. Renderer input never selects an executable or argv.
import {resolveHostBinary,HOST_BINARY_STANDARD_DIRS} from './roleHost.js';
import {userInfo} from 'node:os';
import {posix} from 'node:path';
import {validateProviderEnv,MAX_ENV_VALUE_BYTES,TERMINAL_MAX_PATH_SEGMENTS} from './ptyBroker.js';
import {claimMuseWorkspace} from './museWorkspace.js';
export const AGENT_CLI_PROFILES=Object.freeze([
  {id:'agent-codex',binary:'codex',label:'Codex'},
  {id:'agent-gemini',binary:'gemini',label:'Gemini'},
  {id:'agent-opencode',binary:'opencode',label:'OpenCode'},
  {id:'agent-muse',binary:'muse',label:'Muse'},
]);
/** @param {unknown} value */
function cleanAbsolute(value) {
  return typeof value==='string' && value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value)
    && posix.normalize(value)===value && Buffer.byteLength(value,'utf8')<=MAX_ENV_VALUE_BYTES;
}
/** Resolve only the OS account's CLI directory, never HOME supplied by a capsule.
 * @param {NodeJS.ProcessEnv} env @param {()=>{homedir?:unknown}} hostUser */
function armHostEnvironment(env,hostUser) {
  const home=hostUser().homedir;
  if(!cleanAbsolute(home) || !cleanAbsolute(env.XDG_RUNTIME_DIR)) throw Error('AGENT_HOST_ENV_UNAVAILABLE');
  const directories=[posix.join(/** @type {string} */ (home),'.local/bin'),...String(env.PATH ?? '').split(':'),...HOST_BINARY_STANDARD_DIRS];
  const paths=[...new Set(directories.filter(cleanAbsolute))];
  if(paths.length>TERMINAL_MAX_PATH_SEGMENTS) throw Error('AGENT_HOST_PATH_UNAVAILABLE');
  const path=paths.join(':');
  if(Buffer.byteLength(path,'utf8')>MAX_ENV_VALUE_BYTES) throw Error('AGENT_HOST_PATH_UNAVAILABLE');
  return validateProviderEnv({HOME:home,PATH:path,TERM:'xterm-256color',XDG_RUNTIME_DIR:env.XDG_RUNTIME_DIR},['HOME','PATH','TERM','XDG_RUNTIME_DIR']);
}
/** @param {NodeJS.ProcessEnv} env @param {typeof resolveHostBinary} [resolve]
 * @param {()=>{homedir?:unknown}} [hostUser] */
export function installedAgentProfiles(env,resolve=resolveHostBinary,hostUser=userInfo) {
  const profiles=new Map();
  let hostEnv;
  if(env.MV_ARM64_CAPSULES==='1') {
    try {hostEnv=armHostEnvironment(env,hostUser);}
    catch {return profiles;}
  }
  const discoveryEnv=hostEnv ?? env;
  for(const entry of AGENT_CLI_PROFILES) {
    try {
      const {path}=resolve(entry.binary,discoveryEnv);
      if(typeof path!=='string' || !path.startsWith('/')) continue;
      let launchEnv=hostEnv;
      let agentWorkspace;
      let argv=hostEnv && entry.id==='agent-codex'
        ? [path,'-c',`shell_environment_policy.set.XDG_RUNTIME_DIR=${JSON.stringify(hostEnv.XDG_RUNTIME_DIR)}`]
        : [path];
      if(entry.id==='agent-muse') {
        if(!cleanAbsolute(path) || !cleanAbsolute(discoveryEnv.HOME) || !cleanAbsolute(discoveryEnv.XDG_RUNTIME_DIR)
          || !cleanAbsolute(env.MV_OPERATOR_REPO)) throw Error('AGENT_HOST_ENV_UNAVAILABLE');
        const workspace=env.MV_MUSE_WORKSPACE===undefined ? /** @type {string} */ (env.MV_OPERATOR_REPO) : claimMuseWorkspace(env);
        agentWorkspace=workspace;
        const helper=resolve('unshare',discoveryEnv).path;
        if(!cleanAbsolute(helper)) throw Error('AGENT_NAMESPACE_UNAVAILABLE');
        argv=[helper,'--user','--map-current-user','--pid','--fork','--mount-proc','--',path,
          '--workspace',workspace,'--contributor-mode','on','--model','muse-spark-1.3','--reasoning-effort','max'];
        // The TUI keeps its normal sandbox and trust checks. The launcher must
        // neither initiate a login nor replace the installed CLI during a run.
        launchEnv=validateProviderEnv({HOME:discoveryEnv.HOME,PATH:discoveryEnv.PATH,TERM:'xterm-256color',
          XDG_RUNTIME_DIR:discoveryEnv.XDG_RUNTIME_DIR,MUSE_LOGIN:'0',MUSE_NO_AUTO_UPDATE:'1'},
          ['HOME','PATH','TERM','XDG_RUNTIME_DIR','MUSE_LOGIN','MUSE_NO_AUTO_UPDATE']);
      }
      profiles.set(entry.id,{argv,...(typeof discoveryEnv.HOME==='string' && discoveryEnv.HOME.startsWith('/')?{cwd:agentWorkspace??discoveryEnv.HOME}:{}),...(launchEnv?{env:launchEnv}:{}),label:entry.label,hint:'Agent CLI · authentication stays with you'});
    } catch { /* Missing CLI is omitted, never replaced with a shell. */ }
  }
  return profiles;
}
