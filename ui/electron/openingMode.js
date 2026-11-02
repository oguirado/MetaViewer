import { isForeignIdentity } from './identityProtection.js';
// Private additive host-to-adapter request. Frozen surface requests stay byte-compatible.
import { mkdir, lstat, realpath, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

/** @param {string} stateDir @param {string} profileId @param {string} mode @param {string} [hostBinary] */
export async function stageOpeningMode(stateDir, profileId, mode, hostBinary) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId) || !['human','agent'].includes(mode)) throw Error('CAPSULE_MODE_INVALID');
  if (hostBinary !== undefined && (typeof hostBinary !== 'string' || !hostBinary.startsWith('/') || hostBinary.length > 256)) throw Error('CAPSULE_MODE_INVALID');
  if (isForeignIdentity(profileId)) throw Object.assign(Error('IDENTITY_PROTECTED'), {code:'IDENTITY_PROTECTED'});
  const directory = join(stateDir, 'opening-modes');
  await mkdir(directory, {mode:0o700, recursive:true});
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw Error('CAPSULE_MODE_DIRECTORY');
  const path = join(directory, profileId + '.json');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const payload = hostBinary ? {schema:'metaviewer.opening_mode/v0.3',profile_id:profileId,mode,host_binary:hostBinary} : {schema:'metaviewer.opening_mode/v0.3',profile_id:profileId,mode};
  try { await handle.writeFile(JSON.stringify(payload)); await handle.sync(); }
  catch(error) {await unlink(path);throw error;}
  finally { await handle.close(); }
  return async () => { try { await unlink(path); } catch (error) { if (/** @type {any} */(error).code !== 'ENOENT') throw error; } };
}
