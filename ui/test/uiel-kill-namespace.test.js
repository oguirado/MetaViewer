import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';

function requireNamespace(result) {
  assert.equal(result.status, 0,
    `PID namespace setup/test failed: ${result.error?.message || result.stderr || result.stdout}. ` +
    'Install util-linux unshare, enable unprivileged user namespaces and permit --map-root-user --pid --fork --mount-proc.');
}

// Mutation: replace validateTerminalKillTarget's own-process-group comparison with true.
test('U10 kill guard rejects unsafe targets in a distinct PID namespace and admits an owned child', { timeout: 15000 }, () => {
  const script = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { readFileSync, readlinkSync } from 'node:fs';
    import { validateTerminalKillTarget } from ${JSON.stringify(new URL('../electron/ptyBroker.js', import.meta.url).href)};
    import { validateKillTarget } from ${JSON.stringify(new URL('../electron/coreLauncher.js', import.meta.url).href)};
    assert.equal(process.pid, 1);
    assert.notEqual(readlinkSync('/proc/self/ns/pid'), ${JSON.stringify(readlinkSync('/proc/self/ns/pid'))});
    const getpgid = pid => Number(readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ')[2]);
    const ownPgid = getpgid(process.pid);
    const identity = { selfPid: process.pid, selfPgid: ownPgid, getpgid };
    const attempted = [];
    for (const pid of [0, 1, -1, ownPgid, process.pid, '2']) {
      assert.equal(validateKillTarget(pid, process.pid, ownPgid), false, String(pid));
      assert.equal(validateTerminalKillTarget(pid, identity), false, String(pid));
      if (validateTerminalKillTarget(pid, identity)) attempted.push(pid);
    }
    assert.deepEqual(attempted, []);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    try {
      assert.equal(validateKillTarget(child.pid, process.pid, ownPgid), true);
      assert.equal(validateTerminalKillTarget(child.pid, identity), true);
      assert.equal(validateTerminalKillTarget(child.pid, { ...identity, getpgid: () => ownPgid }), false);
      assert.equal(validateTerminalKillTarget(child.pid, { ...identity, getpgid: () => null }), false);
      assert.equal(validateTerminalKillTarget(child.pid, { ...identity, getpgid() { throw new Error('gone'); } }), false);
    } finally { child.kill('SIGKILL'); await exited; }
    console.log('UIEL_NAMESPACE_GUARDS_OK');
  `;
  const result = spawnSync(process.env.UNSHARE || 'unshare', ['--map-root-user', '--pid', '--fork', '--mount-proc',
    process.execPath, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  requireNamespace(result);
  assert.match(result.stdout, /UIEL_NAMESPACE_GUARDS_OK/);
  // Negative setup control: no missing prerequisite can become a silent skip.
  assert.throws(() => requireNamespace({ status: null, error: new Error('ENOENT') }),
    /Install util-linux unshare, enable unprivileged user namespaces/);
});
