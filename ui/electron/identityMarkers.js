// Operator confirmation metadata, separate from opaque browser profiles.
import { mkdir, lstat, realpath, open, rename, readFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** @param {string} directory */
export function identityMarkers(directory) {
  const pathFor = (/** @type {string} */ profile) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) throw Error('IDENTITY_MARKER_REFUSED');
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
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 1024) throw Error('IDENTITY_MARKER_REFUSED');
        const marker = JSON.parse(await handle.readFile('utf8'));
        if (marker.schema !== 'metaviewer.login_confirmation/v0.3' || marker.profile_id !== profile || marker.source !== 'operator' || !Number.isSafeInteger(marker.confirmed_unix_ms) || marker.confirmed_unix_ms < 1) throw Error('IDENTITY_MARKER_REFUSED');
        return marker.confirmed_unix_ms;
      } catch (error) { if (/** @type {any} */(error).code === 'ENOENT') return null; throw error; }
      finally { await handle?.close(); }
    },
    /** Only the explicit human-tile confirmation calls this writer. @param {string} profile */
    async confirm(profile) {
      const path = pathFor(profile);
      await mkdir(directory, {mode:0o700,recursive:true});
      const st = await lstat(directory);
      if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw Error('IDENTITY_MARKER_REFUSED');
      const temporary = join(directory, '.' + randomUUID());
      const handle = await open(temporary, 'wx', 0o600);
      try {
        const confirmed = Date.now();
        await handle.writeFile(JSON.stringify({schema:'metaviewer.login_confirmation/v0.3',profile_id:profile,source:'operator',confirmed_unix_ms:confirmed}));
        await handle.sync(); await handle.close(); await rename(temporary, path);
        return confirmed;
      } finally { await handle.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
  };
}
