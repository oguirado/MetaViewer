// [TARGET, unit decision] Persist resolved program binaries outside frozen identity contracts.
import { mkdir, lstat, realpath, open, rename, unlink, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** @param {string} directory */
export function programBinaries(directory) {
  const pathFor = (/** @type {string} */ profile) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) throw Error('PROGRAM_BINARY_REFUSED');
    return join(directory, profile + '.json');
  };
  const witnessed = new Set();
  return {
    /** @param {any[]} rows */
    async reconcile(rows) {
      const current = new Set(rows.map(row=>row.id));
      for (const profile of witnessed) if (!current.has(profile)) {await this.forget(profile);witnessed.delete(profile);}
      for (const profile of current) witnessed.add(profile);
    },
    /** @param {string} profile */
    async read(profile) {
      return (await this.readLaunch(profile))?.binary ?? null;
    },
    /** @param {string} profile */
    async readLaunch(profile) {
      const path = pathFor(profile);
      let handle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = await handle.stat();
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 1024) throw Error('PROGRAM_BINARY_REFUSED');
        const marker = JSON.parse(await handle.readFile('utf8'));
        if (marker.schema !== 'metaviewer.program_binary/v1' || marker.profile_id !== profile || typeof marker.binary !== 'string' || !marker.binary.startsWith('/') || marker.binary.length > 256 || /[\x00-\x1f\x7f]/.test(marker.binary)) throw Error('PROGRAM_BINARY_REFUSED');
        if (marker.identityBound !== undefined && typeof marker.identityBound !== 'boolean') throw Error('PROGRAM_BINARY_REFUSED');
        if (marker.hostXpra !== undefined && typeof marker.hostXpra !== 'boolean') throw Error('PROGRAM_BINARY_REFUSED');
        return {binary:marker.binary,hostXpra:marker.hostXpra === true,...(marker.identityBound ? {identityBound:true} : {})};
      } catch (error) { if (/** @type {any} */(error).code === 'ENOENT') return null; throw error; }
      finally { await handle?.close(); }
    },
    /** @param {string} profile */
    async forget(profile) {
      await unlink(pathFor(profile)).catch(error=>{if(error.code !== 'ENOENT') throw error;});
    },
    /** Carry sidecar only after the core confirms the copy, including its operation identity.
     * @param {any} request @param {()=>Promise<any>} execute */
    async copyWith(request, execute) {
      const launch = await this.readLaunch(request.profile_id);
      const result = await execute();
      if (result?.schema === 'capsule_state_event/v0.2' && result.event === 'completed' && result.op === 'copy' && result.operation_id === request.operation_id &&
          result.profile_id === request.profile_id && result.slot_id === request.slot_id && launch) {
        await this.remember(request.destination_profile_id,launch.binary,launch.hostXpra,true);
      }
      return result;
    },
    async hostProfiles() {
      let files;
      try { files = await readdir(directory); } catch (error) { if (/** @type {any} */(error).code === 'ENOENT') return []; throw error; }
      const rows = [];
      for (const file of files.sort()) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(file)) continue;
        const id = file.slice(0,-5);
        try {
          const launch = await this.readLaunch(id);
          if (launch?.hostXpra) rows.push({id,browser:'program'});
        } catch { /* A refused sidecar cannot suppress unrelated valid programs. */ }
      }
      return rows;
    },
    /** @param {string} profile @param {string} binary @param {boolean} [hostXpra] @param {boolean} [identityBound] */
    async remember(profile, binary, hostXpra = false, identityBound = false) {
      if (typeof binary !== 'string' || !binary.startsWith('/') || binary.length > 256 || /[\x00-\x1f\x7f]/.test(binary)) throw Error('PROGRAM_BINARY_REFUSED');
      const path = pathFor(profile);
      await mkdir(directory, {mode:0o700,recursive:true});
      const st = await lstat(directory);
      if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw Error('PROGRAM_BINARY_REFUSED');
      const temporary = join(directory, '.' + randomUUID());
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({schema:'metaviewer.program_binary/v1',profile_id:profile,binary,hostXpra,...(identityBound ? {identityBound:true} : {})}));
        await handle.sync(); await handle.close(); await rename(temporary, path);
        return binary;
      } finally { await handle.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
  };
}
