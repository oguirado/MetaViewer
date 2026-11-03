import {isAbsolute,normalize} from 'node:path';
import {constants,realpathSync,statSync,lstatSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
/** Protected host metadata; actual artifact admission remains with the daemon.
 * @param {NodeJS.ProcessEnv} env @param {string} [arch] @returns {string|null} */
export function guestCommandProfileOwnerSync(env,arch=process.arch) {
  const rewind=env.MV_REWIND_ENABLED==='1';
  if(rewind&&(env.MV_GUEST_COMMAND_ONLY||env.MV_HEADLESS_ONLY))return null;
  const path=rewind?env.MV_REWIND_PROFILE:env.MV_GUEST_COMMAND_PROFILE;
  const normal=(env.MV_ARM64_CAPSULES==='1'||rewind&&env.MV_REWIND_ONLY==='1') && !env.MV_GUEST_COMMAND_ONLY && !env.MV_HEADLESS_ONLY;
  const legacy=env.MV_GUEST_COMMAND_ONLY==='1' && !env.MV_HEADLESS_ONLY && !env.MV_ARM64_CAPSULES;
  if((!normal && !legacy) || arch!=='arm64' || !path || !isAbsolute(path) || normalize(path)!==path || path.startsWith('//'))return null;
  let fd;
  try {
    if(realpathSync(path)!==path)return null;
    const before=lstatSync(path,{bigint:true});
    if(!before.isFile())return null;
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const st=fstatSync(fd,{bigint:true});
    const fields=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
    const same=(/** @type {any} */ x,/** @type {any} */ y)=>fields.every(k=>x[k]===y[k]);
    if(!same(before,st) || !st.isFile() || st.uid!==BigInt(process.getuid?.() ?? -1) || (st.mode&0o077n)!==0n || st.nlink!==1n || st.size>65536n)return null;
    const bytes=Buffer.alloc(65537),length=readSync(fd,bytes,0,bytes.length,0);
    if(length!==Number(st.size) || !same(st,fstatSync(fd,{bigint:true})) || !same(st,lstatSync(path,{bigint:true})) || realpathSync(path)!==path)return null;
    const p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
    if(!p || Object.keys(p).sort().join(',')!=='config_template,controller_relative,files,guardian_unit,owner_id,python,python_prefix,runner,runtime_root,schema,state_root'
      || typeof p.python_prefix!=='string' || !isAbsolute(p.python_prefix) || realpathSync(p.python_prefix)!==p.python_prefix || !statSync(p.python_prefix).isDirectory()
      || p.schema!==(rewind?'mv-rewind-host/v1':'mv-guest-command-host/v1') || !/^actor-[0-9a-f]{64}$/.test(p.owner_id)
      || p.config_template?.schema!==(rewind?'rewind-host-config/v1':'guest-command-host-config/v1') || p.config_template?.runtime_admitted!==true
      || p.config_template?.owner_id!==p.owner_id)return null;
    return p.owner_id;
  } catch {return null;} finally {if(fd!==undefined)closeSync(fd);}
}

/** @param {NodeJS.ProcessEnv} env @param {string} [arch] */
export function requireGuestCommandMode(env,arch=process.arch){
 if(env.MV_GUEST_COMMAND_ONLY!=='1')return false;
 if(guestCommandProfileOwnerSync(env,arch)===null)throw Error('GUEST_COMMAND_PROFILE_INVALID');
 return true;
}

/** Sanitized host capabilities; no private paths or profile identity cross IPC.
 * @param {NodeJS.ProcessEnv} env @param {string} [arch] */
export function arm64CapsuleStatusSync(env,arch=process.arch) {
 const supported=arch==='arm64';
 const disabled=(/** @type {string} */ reason)=>({available:false,reason});
 const fallback={schema:'capsule_capabilities/v0.2',supported_host:supported,
  vm:disabled(supported?'Complete ARM64 capsule setup to enable the graphical VM.':'ARM64 capsules are unavailable on this host.'),
  microvm:disabled(supported?'Complete ARM64 capsule setup to enable MicroVM commands.':'ARM64 capsules are unavailable on this host.')};
 if(!supported)return fallback;
 const raw=env.MV_ARM64_CAPSULE_STATUS;
 if(raw===undefined||raw===''){
  if((env.MV_GUEST_COMMAND_ONLY==='1'||env.MV_REWIND_ENABLED==='1')&&guestCommandProfileOwnerSync(env,arch)!==null)fallback.microvm={available:true,reason:''};
  return fallback;
 }
 try {
  if(typeof raw!=='string'||Buffer.byteLength(raw)>4096)throw Error('status');
  const value=JSON.parse(raw);
  const row=(/** @type {any} */ v)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='available,reason'&&typeof v.available==='boolean'&&typeof v.reason==='string'&&[...v.reason].length<=256&&!/[\uD800-\uDFFF]/u.test(v.reason)&&!/[\x00-\x1f\x7f/\\]/.test(v.reason)&& (v.available||v.reason.trim().length>0);
  if(!value||Object.keys(value).sort().join(',')!=='microvm,vm'||!row(value.vm)||!row(value.microvm))throw Error('status');
  return {schema:'capsule_capabilities/v0.2',supported_host:true,vm:{...value.vm},microvm:{...value.microvm}};
 }catch{return {...fallback,vm:disabled('Capsule setup status is invalid.'),microvm:disabled('Capsule setup status is invalid.')};}
}
