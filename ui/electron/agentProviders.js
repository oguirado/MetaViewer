// Host-owned CLI profiles. Renderer input never selects an executable or argv.
import {resolveHostBinary} from './roleHost.js';
export const AGENT_CLI_PROFILES=Object.freeze([
  {id:'agent-codex',binary:'codex',label:'Codex'},
  {id:'agent-gemini',binary:'gemini',label:'Gemini'},
  {id:'agent-opencode',binary:'opencode',label:'OpenCode'},
]);
/** @param {NodeJS.ProcessEnv} env @param {typeof resolveHostBinary} [resolve] */
export function installedAgentProfiles(env,resolve=resolveHostBinary) {
  const profiles=new Map();
  for(const entry of AGENT_CLI_PROFILES) {
    try {
      const {path}=resolve(entry.binary,env);
      if(typeof path!=='string' || !path.startsWith('/')) continue;
      profiles.set(entry.id,{argv:[path],...(typeof env.HOME==='string' && env.HOME.startsWith('/')?{cwd:env.HOME}:{}),label:entry.label,hint:'Agent CLI · authentication stays with you'});
    } catch { /* Missing CLI is omitted, never replaced with a shell. */ }
  }
  return profiles;
}
