import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAttachRecord, cleanInstallSmoke, publishAttachPointer } from '../tools/package.js';

const moduleURL = new URL('../tools/package.js', import.meta.url).href;
const oldID = 'pkg-0f0e0d0c-0b0a-4908-8706-050403020100';
const newID = 'pkg-0f0e0d0c-0b0a-4908-8706-050403020101';
const record = (id, runtime) => buildAttachRecord({sessionId:id, pid:process.pid,
  runtime, configPath:join(runtime,'config.json'), env:{}});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'child did not reach the interleave barrier');
    await delay(10);
  }
}

test('B5-08 publication between old comparison and unlink preserves successor pair', {timeout:20000}, async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'l1-attach-'));
  let child;
  try {
    await publishAttachPointer(root, record(oldID, root));
    const ready = join(root, 'read');
    const release = join(root, 'release');
    // Pause the actual old process immediately after it reads current.json.
    // The successor publishes in a different process (the test process).
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { retractAttachPointerSync } from ${JSON.stringify(moduleURL)};
      const original = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        const result = original(path, ...args);
        if (String(path).endsWith('/attach/current.json')) {
          fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
          while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return result;
      };
      syncBuiltinESMExports();
      retractAttachPointerSync(${JSON.stringify(root)}, ${JSON.stringify(oldID)});
    `], {stdio:['ignore','pipe','pipe']});
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `child rc ${code}`)));
    });
    await until(() => existsSync(ready));
    const publication = publishAttachPointer(root, record(newID, root));
    // Let an unlocked successor finish while the old process is suspended.
    await delay(100);
    await fs.writeFile(release, 'release');
    await Promise.all([publication, exited]);
    const attach = join(root, 'metaviewer/attach');
    assert.equal(JSON.parse(await fs.readFile(join(attach,'current.json'), 'utf8')).session_id, newID);
    assert.match(await fs.readFile(join(attach,'current.env'), 'utf8'), new RegExp(newID));
  } finally {
    if (child?.exitCode === null) child.kill('SIGKILL');
    await fs.rm(root, {recursive:true, force:true});
  }
});

test('B5-48 smoke overlap refusal removes newly allocated temporary directory', async () => {
  const base = await fs.mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.l1-smoke-'));
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = base;
    await assert.rejects(cleanInstallSmoke('/unused.tar'), /MV_PKG_OUT must not overlap the repository/);
    assert.deepEqual(await fs.readdir(base), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await fs.rm(base, {recursive:true, force:true});
  }
});
