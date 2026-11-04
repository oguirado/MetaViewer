import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

// A detached child owns a new session/group. Keep that identity until every
// non-zombie member has gone; never discover kill targets by executable name.
function identity(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(' ');
}

async function groupAlive(pid) {
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let text;
    try { text = await readFile(`/proc/${name}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    if (fields[2] === String(pid) && fields[3] === String(pid) && !['Z', 'X'].includes(fields[0])) return true;
  }
  return false;
}

/** Run a smoke wrapper with bounded cleanup, including inherited output pipes.
 * @param {string} file
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} options
 */
export async function executeSmoke(file, args, options = {}) {
  const {timeout = 0, maxBuffer = 1024 * 1024, ...rest} = options;
  let child, start, record, timer, interrupted, cleanupError, signalled = false;
  const killGroup = () => {
    if (!child?.pid || !start || signalled) return;
    try {
      let current;
      try { current = identity(child.pid); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
      if (current && (current[19] !== start || current[2] !== String(child.pid) || current[3] !== String(child.pid))) {
        throw new Error('PKG_SMOKE_PROCESS_IDENTITY_CHANGED');
      }
      // A remaining group pins its PGID even after the leader exits.
      process.kill(-child.pid, 'SIGKILL');
      signalled = true;
    } catch (error) {
      if (error.code === 'ESRCH') signalled = true;
      else cleanupError = error;
    }
  };
  const onSignal = signal => {
    interrupted = Object.assign(new Error(`PKG_SMOKE_INTERRUPTED: ${signal}`), {signal});
    killGroup();
  };
  const onTerm = () => onSignal('SIGTERM');
  const onInt = () => onSignal('SIGINT');
  try {
    return await new Promise((resolve, reject) => {
      const output = {stdout: [], stderr: []};
      const lengths = {stdout: 0, stderr: 0};
      child = spawn(file, args, {...rest, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
      child.once('error', reject);
      for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
        const available = Math.max(0, maxBuffer - lengths[name]);
        output[name].push(chunk.subarray(0, available));
        lengths[name] += chunk.length;
        if (lengths[name] > maxBuffer) {
          interrupted = Object.assign(new Error('PKG_SMOKE_OUTPUT_LIMIT'), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
          killGroup();
        }
      });
      child.once('close', (code, signal) => {
        killGroup();
        const stdout = Buffer.concat(output.stdout).toString();
        const stderr = Buffer.concat(output.stderr).toString();
        const error = code !== 0 || signal ? Object.assign(new Error('PKG_SMOKE_CHILD_EXIT'), {code, signal}) : null;
        const failure = cleanupError || interrupted || error;
        if (failure) reject(Object.assign(failure, {stdout, stderr}));
        else resolve({stdout, stderr});
      });
      child.once('exit', killGroup);
      if (child.pid) {
        try {
          const fields = identity(child.pid);
          start = fields[19];
          if (fields[2] !== String(child.pid) || fields[3] !== String(child.pid)) throw new Error('PKG_SMOKE_PROCESS_GROUP_REQUIRED');
          const state = process.env.MV_PACKAGE_SMOKE_STATE_DIR;
          if (state) {
            const path = join(state, `${child.pid}.pid`);
            writeFileSync(path, `${child.pid} ${start}\n`, {mode: 0o600, flag: 'wx'});
            record = path;
          }
        } catch (error) { killGroup(); reject(error); return; }
        process.on('SIGTERM', onTerm);
        process.on('SIGINT', onInt);
        if (timeout) timer = setTimeout(() => {
          interrupted = Object.assign(new Error('PKG_SMOKE_TIMEOUT'), {code: 'ETIMEDOUT'});
          killGroup();
        }, timeout);
      }
    });
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    killGroup();
    if (child?.pid && start) {
      for (let attempt = 0; attempt < 40 && await groupAlive(child.pid); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (cleanupError) throw cleanupError;
      if (await groupAlive(child.pid)) throw new Error('PKG_SMOKE_PROCESS_LEAK');
      if (record) await rm(record);
    }
  }
}
