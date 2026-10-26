const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('ARG-ci-4: removing executable admission makes installer controls fail', (t) => {
  const root = path.resolve(__dirname, '../..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-electron-mutant-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(root, '.github/workflows/install_electron.cjs'), 'utf8');
  const guard = '  fs.accessSync(binary, fs.constants.X_OK);';
  assert.equal(source.split(guard).length, 2, 'mutation anchor must be unique');
  for (const relative of ['.github/workflows', 'tests/ci']) {
    fs.mkdirSync(path.join(scratch, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(scratch, '.github/workflows/install_electron.cjs'), source.replace(guard, ''));
  fs.copyFileSync(path.join(root, 'tests/ci/install_electron.test.cjs'),
    path.join(scratch, 'tests/ci/install_electron.test.cjs'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', 'tests/ci/install_electron.test.cjs'], {
    cwd: scratch, encoding: 'utf8', timeout: 30000, env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Missing expected exception/);
});
