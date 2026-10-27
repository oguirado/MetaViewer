'use strict';
// U12: duplicate rejection already exists in core/tests/admission_journal.rs;
// this adds the process/purity boundary without changing the golden runner.
// Mutation: insert `let _ = std::time::SystemTime::now();` in mv-replay's run
// -> LD_PRELOAD refuses the clock call and the pure replay assertion fails.
// Mutation: replace mv-replay's `JournalError::Duplicate => 3,` with `=> 0,`
// -> the appended duplicate has a successful status and this gate fails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { createHash } = require('node:crypto');
const { runRust } = require('./core-driver.js');
const {
  E2EError,
  E2E_NATIVE_PREREQS,
  makeScratch,
  removeScratch,
  requireNativeTool,
  spawnNativeTool,
} = require('./ac-harness.cjs');
const fixture = require('../fixtures/golden_scenario.json');
const root = join(__dirname, '../..');

function fileHashes(directory) {
  const rows = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else {
        assert.equal(entry.isFile(), true, 'unexpected replay archive object');
        rows.push([relative(directory, child), statSync(child).mode & 0o777,
          createHash('sha256').update(readFileSync(child)).digest('hex')]);
      }
    }
  }
  visit(directory);
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

test('golden replay is unchanged with clock/network/model access blocked; duplicates refuse', () => {
  const scratch = makeScratch('mv-replay-purity');
  try {
    runRust(scratch, readFileSync(join(__dirname, 'e2e1_slice/scenario.rs'), 'utf8'));
    const receipts = execFileSync(process.env.CARGO || 'cargo',
      ['build', '--offline', '--bin', 'mv-replay', '--message-format=json'],
      { cwd: root, encoding: 'utf8', timeout: 180000 }).trim().split('\n').map(line => JSON.parse(line));
    const binaries = receipts.filter(row => row.reason === 'compiler-artifact'
      && row.target.name === 'mv-replay' && row.executable).map(row => row.executable);
    assert.equal(binaries.length, 1, 'E2E_PREREQ: fresh replay artifact required');
    const source = join(__dirname, 'replay-deny.c'), library = join(scratch, 'deny.so');
    const probe = join(scratch, 'deny-probe');
    const cc = requireNativeTool('cc');
    const strace = requireNativeTool('strace');
    execFileSync(cc, ['-Wall', '-Wextra', '-Werror', '-shared', '-fPIC', source, '-o', library], { timeout: 30000 });
    execFileSync(cc, ['-Wall', '-Wextra', '-Werror', '-DREPLAY_DENY_PROBE', source, '-o', probe], { timeout: 30000 });
    const blockedEnv = { ...process.env, LD_PRELOAD: library };
    for (const kind of ['clock', 'network', 'model']) {
      const control = spawnSync(probe, [kind], { env: blockedEnv, encoding: 'utf8', timeout: 5000 });
      assert.equal(control.status, 97, JSON.stringify(control));
      assert.match(control.stderr, new RegExp(`E2E_PURITY_DENIED: ${kind}`));
    }
    const archive = join(scratch, 'state_dir/sessions/session-1');
    const journal = join(archive, 'journal.jsonl');
    const args = ['--journal', journal, '--witness-root', archive];
    const before = fileHashes(archive);
    const run = options => spawnSync(binaries[0], args, {
      env: process.env, encoding: 'utf8', timeout: 10000, ...options,
    });
    const clean = run({});
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout, fixture.expected_digest + '\n');
    const trace = join(scratch, 'syscalls.txt');
    // Env applies only to the tracee, so the tracer can read its own clock.
    const blocked = spawnNativeTool('strace', ['-f', '-qq', '-o', trace,
      '-e', 'trace=%network,%process', '-e', 'inject=%network:error=EPERM',
      '-E', `LD_PRELOAD=${library}`, '--', binaries[0], ...args], {
      env: { ...process.env, STRACE: strace },
      spawnOptions: { timeout: 10000 },
    });
    assert.equal(blocked.status, 0, blocked.stderr || String(blocked.error));
    assert.equal(blocked.stderr, '');
    assert.equal(blocked.stdout, clean.stdout);
    const syscalls = readFileSync(trace, 'utf8');
    assert.equal((syscalls.match(/\bexecve\(/g) || []).length, 1, 'replay launched another program');
    assert.doesNotMatch(syscalls, /\b(socket|socketpair|connect|sendto|recvfrom|accept|clone|clone3|fork|vfork|execveat)\(/);
    assert.deepEqual(fileHashes(archive), before, 'replay changed the archive');
    const original = readFileSync(journal, 'utf8');
    const last = original.trimEnd().split('\n').at(-1);
    writeFileSync(journal, original + last + '\n');
    const duplicate = run({ env: blockedEnv });
    assert.equal(duplicate.status, 3, duplicate.stderr);
    assert.equal(duplicate.stdout, '');
    assert.match(duplicate.stderr, /Duplicate/);
    writeFileSync(journal, original);
    assert.deepEqual(fileHashes(archive), before);
    assert.equal(run({ env: blockedEnv }).stdout, clean.stdout);
  } finally { removeScratch(scratch); }
});

test('E2E-U29: native prerequisite probes for cc and strace resolve and fail with typed E2E_PREREQ when absent', () => {
  assert.deepEqual(Object.keys(E2E_NATIVE_PREREQS).sort(), ['cc', 'strace', 'xvfb-run']);
  for (const tool of ['cc', 'strace']) {
    const resolved = requireNativeTool(tool);
    assert.equal(typeof resolved, 'string');
    assert.equal(resolved.startsWith('/'), true, `expected absolute path for ${tool}: ${resolved}`);
  }

  // Negative controls: absent tool on empty PATH or nonexistent override throws typed E2E_PREREQ.
  for (const tool of ['cc', 'strace']) {
    assert.throws(
      () => requireNativeTool(tool, { env: {}, pathEnv: '' }),
      (err) => err instanceof E2EError && err.code === 'E2E_PREREQ' && err.message.includes(tool),
      `missing ${tool} on empty PATH must throw E2E_PREREQ`,
    );
    const envVar = E2E_NATIVE_PREREQS[tool].envVar;
    assert.throws(
      () => requireNativeTool(tool, { env: { [envVar]: `/nonexistent-mv-e2e-${tool}` }, pathEnv: '' }),
      (err) => err instanceof E2EError && err.code === 'E2E_PREREQ' && err.message.includes(tool),
      `nonexistent ${envVar} override must throw E2E_PREREQ`,
    );
    // Negative control: even with upfront probe removed (skipProbe: true), spawning an absent tool fails typed E2E_PREREQ, never obscure status===null.
    assert.throws(
      () => spawnNativeTool(tool, ['--version'], { env: {}, pathEnv: '', skipProbe: true }),
      (err) => err instanceof E2EError && err.code === 'E2E_PREREQ' && err.message.includes(tool),
      `probe removed + ${tool} absent must still fail with typed E2E_PREREQ`,
    );
  }
});
