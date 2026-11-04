import {lstatSync,realpathSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {posix} from 'node:path';

/** Host-created session data only. No renderer path or reusable shared root.
 * @param {NodeJS.ProcessEnv} env */
export function claimMuseWorkspace(env) {
  try {
  const root=env.MV_MUSE_WORKSPACE, runtime=env.XDG_RUNTIME_DIR;
  const refuse=()=>{throw Error('MUSE_WORKSPACE_UNAVAILABLE');};
  const clean=(/** @type {unknown} */ p)=>typeof p==='string' && p.startsWith('/') && posix.normalize(p)===p && !/[\x00-\x1f\x7f]/.test(p);
  if(!clean(root)||!clean(runtime)||!env.MV_SESSION_ID?.startsWith('pkg-'))return refuse();
  const workspace=/** @type {string} */ (root), session=/** @type {string} */ (runtime);
  if(!/^metaviewer-muse-[A-Za-z0-9_-]+$/.test(posix.basename(workspace)) || posix.dirname(session)!==workspace || !posix.basename(session).startsWith('mv-pkg-'))return refuse();
  for(const p of [workspace,session]) {
    const s=lstatSync(p);
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o700||realpathSync(p)!==p)return refuse();
  }
  const marker=posix.join(workspace,'.owner.json'), stat=lstatSync(marker);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o600||stat.nlink!==1||stat.size>512)return refuse();
  const owner=JSON.parse(readFileSync(marker,'utf8'));
  if(owner.schema!=='metaviewer.muse-session/v1'||!Number.isSafeInteger(owner.launcher_pid)||owner.launcher_pid<=1||!/^\d+$/.test(owner.launcher_start??''))return refuse();
  if(lstatSync(`/proc/${owner.launcher_pid}`).uid!==process.getuid?.())return refuse();
  const processStat=readFileSync(`/proc/${owner.launcher_pid}/stat`,'utf8');
  if(processStat.slice(processStat.lastIndexOf(')')+2).split(' ')[19]!==owner.launcher_start)return refuse();
  process.kill(owner.launcher_pid,0);
  const config=posix.join(session,'config.json');
  if(env.MV_CORE_CONFIG!==config)return refuse();
  const configStat=lstatSync(config);
  if(!configStat.isFile()||configStat.isSymbolicLink()||configStat.uid!==process.getuid?.()||(configStat.mode&0o777)!==0o600||configStat.size>65536)return refuse();
  if(JSON.parse(readFileSync(config,'utf8')).session_id!==env.MV_SESSION_ID)return refuse();
  // GTK places its per-session runtime state here, never its account store.
  const allowed=new Set(['.owner.json','metaviewer','memoryweb','dconf',posix.basename(session)]);
  for(const name of readdirSync(workspace)) {
    if(!allowed.has(name))return refuse();
    if(name!=='.owner.json') {
      const path=posix.join(workspace,name), st=lstatSync(path);
      if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o700||realpathSync(path)!==path)return refuse();
    }
  }
  writeFileSync(posix.join(workspace,'.app-claim.json'),JSON.stringify({session_id:env.MV_SESSION_ID,pid:process.pid}),{flag:'wx',mode:0o600});
  return workspace;
  } catch {
    throw Error('MUSE_WORKSPACE_UNAVAILABLE');
  }
}
