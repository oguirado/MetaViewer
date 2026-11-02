// [TARGET, unit decision] Persist resolved program binaries outside frozen identity contracts.
import { mkdir, lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** @param {string} directory */
export function programBinaries(directory) {
  const pathFor = (/** @type {string} */ profile) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) throw Error('PROGRAM_BINARY_REFUSED');
    return join(directory, profile + '.json');
  };
  return {
    /** @param {string} profile */
    async read(profile) {
      const path = pathFor(profile);
      let handle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = await handle.stat();
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 1024) throw Error('PROGRAM_BINARY_REFUSED');
        const marker = JSON.parse(await handle.readFile('utf8'));
        if (marker.schema !== 'metaviewer.program_binary/v1' || marker.profile_id !== profile || typeof marker.binary !== 'string' || !marker.binary.startsWith('/') || marker.binary.length > 256 || /[\x00-\x1f\x7f]/.test(marker.binary)) throw Error('PROGRAM_BINARY_REFUSED');
        return marker.binary;
      } catch (error) { if (/** @type {any} */(error).code === 'ENOENT') return null; throw error; }
      finally { await handle?.close(); }
    },
    /** @param {string} profile @param {string} binary */
    async remember(profile, binary) {
      if (typeof binary !== 'string' || !binary.startsWith('/') || binary.length > 256 || /[\x00-\x1f\x7f]/.test(binary)) throw Error('PROGRAM_BINARY_REFUSED');
      const path = pathFor(profile);
      await mkdir(directory, {mode:0o700,recursive:true});
      const st = await lstat(directory);
      if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw Error('PROGRAM_BINARY_REFUSED');
      const temporary = join(directory, '.' + randomUUID());
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({schema:'metaviewer.program_binary/v1',profile_id:profile,binary}));
        await handle.sync(); await handle.close(); await rename(temporary, path);
        return binary;
      } finally { await handle.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
  };
}
