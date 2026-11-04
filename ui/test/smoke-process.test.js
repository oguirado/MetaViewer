import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSmoke } from '../tools/smokeProcess.js';

async function alive(pid) {
  try { return !/\) [ZX] /.test(await readFile(`/proc/${pid}/stat`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('real xvfb-run/strace failure cleans the recorded session and ownership receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-smoke-xvfb-'));
  const state = join(root, 'state');
  await mkdir(state, {mode: 0o700});
  const previous = process.env.MV_PACKAGE_SMOKE_STATE_DIR;
  process.env.MV_PACKAGE_SMOKE_STATE_DIR = state;
  let owned;
  try {
    const work = executeSmoke('xvfb-run', ['-a', 'strace', '-f', '-o', join(root, 'trace'),
      process.execPath, '-e', `const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
setTimeout(()=>process.exit(37),300);`], {timeout: 1500, env: {...process.env, TMPDIR: root}})
      .then(value => ({value}), error => ({error}));
    const names = await readdir(state);
    assert.equal(names.length, 1);
    const receipt = (await readFile(join(state, names[0]), 'utf8')).trim().split(' ');
    owned = Number(receipt[0]);
    assert.ok(owned > 1 && /^\d+$/.test(receipt[1]));
    const result = await work;
    assert.ok(result.error, 'a failed smoke remains a failure');
    assert.match(await readFile(join(root, 'trace'), 'utf8'), /exit_group\(37\)/);
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const text = await readFile(`/proc/${name}/stat`, 'utf8').catch(error => {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return '';
        throw error;
      });
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      assert.ok(fields[3] !== String(owned) || ['Z', 'X'].includes(fields[0]), 'no live Xvfb, tracer or application member');
    }
    assert.deepEqual(await readdir(state), []);
  } finally {
    if (previous === undefined) delete process.env.MV_PACKAGE_SMOKE_STATE_DIR;
    else process.env.MV_PACKAGE_SMOKE_STATE_DIR = previous;
    if (owned) try { process.kill(-owned, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await rm(root, {recursive: true, force: true});
  }
});

test('installer SIGTERM kills the detached smoke group and clears its receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-smoke-signal-'));
  const state = join(root, 'state');
  const pidfile = join(root, 'child.pid');
  await mkdir(state, {mode: 0o700});
  const runner = join(root, 'runner.mjs');
  await writeFile(runner, `import {executeSmoke} from ${JSON.stringify(new URL('../tools/smokeProcess.js', import.meta.url).href)};
try { await executeSmoke(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}],{timeout:5000}); }
catch(error) { console.error(error.message); process.exitCode=23; }
`);
  const parent = spawn(process.execPath, [runner], {env: {...process.env, MV_PACKAGE_SMOKE_STATE_DIR: state}, stdio: ['ignore', 'pipe', 'pipe']});
  let pid;
  let stderr = '';
  parent.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => parent.once('close', resolve));
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await readFile(pidfile, 'utf8').catch(() => '');
      if (value) { pid = Number(value); break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(pid > 1, 'recorded smoke child reached its barrier');
    parent.kill('SIGTERM');
    assert.equal(await closed, 23);
    assert.match(stderr, /PKG_SMOKE_INTERRUPTED: SIGTERM/);
    assert.equal(await alive(pid), false);
    assert.deepEqual(await readdir(state), []);
  } finally {
    parent.kill('SIGKILL');
    if (pid && await alive(pid)) process.kill(pid, 'SIGKILL');
    await closed;
    await rm(root, {recursive: true, force: true});
  }
});

test('missing smoke executable is refused without a cleanup hang', async () => {
  await assert.rejects(executeSmoke('/absent-smoke-fixture', [], {timeout: 100}), {code: 'ENOENT'});
});

for (const mode of ['failure', 'timeout', 'success']) {
  test(`smoke ${mode} removes its recorded descendants and preserves an unrelated process`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mv-smoke-test-'));
    const receipt = join(root, 'pids');
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    let pids = [];
    try {
      // Model xvfb-run -> strace -> app -> core. The wrapper can exit while
      // descendants ignore TERM and retain its output descriptors.
      const script = join(root, 'tree.mjs');
      await writeFile(script, `import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
appendFileSync(process.argv[2], process.pid+'\\n');
process.on('SIGTERM',()=>{});
const depth=Number(process.argv[3]);
if(depth) spawn(process.execPath,[process.argv[1],process.argv[2],String(depth-1)],{stdio:'inherit'});
if(depth===3 && ${JSON.stringify(mode)}!=='timeout') setTimeout(()=>process.exit(${mode === 'failure' ? 37 : 0}),400);
setInterval(()=>{},1000);
`);
      let deadline;
      const result = await Promise.race([
        executeSmoke(process.execPath, [script, receipt, '3'],
          {timeout: 900, maxBuffer: 4096}).then(value => ({value}), error => ({error})),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('smoke cleanup hung')), 1800); }),
      ]).finally(() => clearTimeout(deadline));
      pids = (await readFile(receipt, 'utf8')).trim().split('\n').map(Number);
      assert.equal(pids.length, 4, 'the complete descendant chain started');
      assert.equal(await alive(foreign.pid), true, 'foreign process survives');
      assert.deepEqual(await Promise.all(pids.map(alive)), [false, false, false, false]);
      if (mode === 'success') assert.ok(result.value);
      else assert.ok(result.error);
      if (mode === 'failure') assert.equal(result.error.code, 37);
    } finally {
      // Only identities recorded by this fixture may be signalled.
      if (!pids.length) pids = (await readFile(receipt, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
      for (const pid of [...pids, foreign.pid]) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await rm(root, {recursive: true, force: true});
    }
  });
}
