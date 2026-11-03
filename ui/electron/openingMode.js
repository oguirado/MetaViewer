import { isForeignIdentity } from './identityProtection.js';
// Private additive host-to-adapter request. Frozen surface requests stay byte-compatible.
import { mkdir, lstat, realpath, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

/** @param {string} stateDir @param {string} profileId @param {string} mode @param {string|{xid:number,witness:string,title:string,program:string,width?:number,height?:number,display?:string,xauthority?:string}} [target] @param {boolean} [hostXpra] */
export async function stageOpeningMode(stateDir, profileId, mode, target, hostXpra = false) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId) || !['human','agent'].includes(mode)) throw Error('CAPSULE_MODE_INVALID');
  /** @type {any} */
  let payload = {schema:'metaviewer.opening_mode/v0.3',profile_id:profileId,mode};
  if (target !== undefined) {
    if (typeof target === 'string') {
      if ((mode !== 'agent' && mode !== 'human') || !target.startsWith('/') || target.length > 256) throw Error('CAPSULE_MODE_INVALID');
      payload = {schema:'metaviewer.opening_mode/v0.3',profile_id:profileId,mode,host_binary:target};
    } else if (target && typeof target === 'object' && !Array.isArray(target)) {
      const width = target.width === undefined ? 1280 : target.width;
      const height = target.height === undefined ? 900 : target.height;
      if (mode !== 'agent'
          || !Number.isSafeInteger(target.xid) || target.xid <= 0 || target.xid > 0xffffffff
          || typeof target.witness !== 'string' || !target.witness.trim() || target.witness.length > 128 || /[\x00-\x1f\x7f\s]/.test(target.witness.trim())
          || typeof target.title !== 'string' || !target.title.trim() || target.title.length > 512 || /[\x00-\x1f\x7f]/.test(target.title)
          || typeof target.program !== 'string' || !target.program.trim() || target.program.length > 256 || /[\x00-\x1f\x7f]/.test(target.program)
          || !Number.isSafeInteger(width) || width < 1 || width > 4096
          || !Number.isSafeInteger(height) || height < 1 || height > 4096) throw Error('CAPSULE_MODE_INVALID');
      payload = {schema:'metaviewer.opening_mode/v0.3',profile_id:profileId,mode,host_window:{xid:target.xid,witness:target.witness.trim(),title:target.title.trim(),program:target.program.trim(),width,height,...(typeof target.display === 'string' && target.display ? {display:target.display} : {}),...(typeof target.xauthority === 'string' && target.xauthority.startsWith('/') ? {xauthority:target.xauthority} : {})}};
    } else {
      throw Error('CAPSULE_MODE_INVALID');
    }
  }
  if (hostXpra) {
    if (typeof target !== 'string') throw Error('CAPSULE_MODE_INVALID');
    payload.host_xpra = true;
  }
  if (isForeignIdentity(profileId)) throw Object.assign(Error('IDENTITY_PROTECTED'), {code:'IDENTITY_PROTECTED'});
  const directory = join(stateDir, 'opening-modes');
  await mkdir(directory, {mode:0o700, recursive:true});
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw Error('CAPSULE_MODE_DIRECTORY');
  const path = join(directory, profileId + '.json');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(payload)); await handle.sync(); }
  catch(error) {await unlink(path);throw error;}
  finally { await handle.close(); }
  return async () => { try { await unlink(path); } catch (error) { if (/** @type {any} */(error).code !== 'ENOENT') throw error; } };
}
