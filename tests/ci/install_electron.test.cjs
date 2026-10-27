const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install } = require('../../.github/workflows/install_electron.cjs');

function fixture(t) {
  const ui = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-electron-ci-'));
  t.after(() => fs.rmSync(ui, { recursive: true, force: true }));
  const write = (name, value) => {
    const dest = path.join(ui, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(value));
  };
  write('package.json', { dependencies: { electron: '44.9.2' } });
  write('package-lock.json', { packages: { 'node_modules/electron': {
    version: '44.9.2', integrity: 'sha512-fixture',
  } } });
  write('node_modules/electron/package.json', { version: '44.9.2' });
  write('node_modules/electron/checksums.json', {
    [`electron-v44.9.2-linux-${process.arch}.zip`]: 'a'.repeat(64),
  });
  fs.mkdirSync(path.join(ui, 'node_modules/electron/dist'));
  const binary = path.join(ui, 'node_modules/electron/dist/electron');
  fs.writeFileSync(binary, '#!/bin/sh\n');
  fs.chmodSync(binary, 0o755);
  return { ui, write, binary };
}

test('explicit installer precedes executable version verification under xvfb', (t) => {
  const { ui, binary } = fixture(t);
  const calls = [];
  install(ui, (command, args, options) => {
    calls.push({ command, args, options });
    return 'v44.9.2\n';
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [path.join(ui, 'node_modules/electron/install.js')]);
  assert.equal(calls[1].command, 'xvfb-run');
  assert.deepEqual(calls[1].args, ['-a', binary, '--version']);
});

test('negative controls reject drift or missing checksum before any download', (t) => {
  for (const [name, data] of [
    ['package.json', { dependencies: { electron: 'latest' } }],
    ['package-lock.json', { packages: { 'node_modules/electron': { version: '44.9.1', integrity: 'x' } } }],
    ['package-lock.json', { packages: { 'node_modules/electron': { version: '44.9.2' } } }],
    ['node_modules/electron/package.json', { version: '44.9.1' }],
    ['node_modules/electron/checksums.json', {}],
  ]) {
    const { ui, write } = fixture(t);
    write(name, data);
    assert.throws(() => install(ui, () => assert.fail('must not execute')));
  }
});

test('negative controls reject missing binary, nonexecutable binary and wrong version', (t) => {
  for (const mode of ['missing', 'nonexecutable', 'version']) {
    const { ui, binary } = fixture(t);
    if (mode === 'missing') fs.unlinkSync(binary);
    if (mode === 'nonexecutable') fs.chmodSync(binary, 0o644);
    const expected = mode === 'missing' ? { code: 'ENOENT' }
      : mode === 'nonexecutable' ? { code: 'EACCES' }
      : /installed Electron version differs/;
    assert.throws(() => install(ui, () => mode === 'version' ? 'v44.9.1\n' : 'v44.9.2\n'), expected);
  }
});

test('installer failure propagates and cannot reach the version check', (t) => {
  const { ui } = fixture(t);
  let calls = 0;
  assert.throws(() => install(ui, () => { calls++; throw new Error('download failed'); }), /download failed/);
  assert.equal(calls, 1);
});

test('checksum, architecture and dist overrides cannot bypass admission', (t) => {
  const { ui } = fixture(t);
  const overrides = {
    electron_use_remote_checksums: '1',
    npm_config_electron_use_remote_checksums: '1',
    ELECTRON_OVERRIDE_DIST_PATH: '/untrusted',
    ELECTRON_INSTALL_ARCH: 'untrusted',
    npm_config_arch: 'untrusted',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const prior = { ...process.env };
  try {
    Object.assign(process.env, overrides);
    install(ui, (_command, _args, { env }) => {
      for (const key of Object.keys(overrides)) assert.equal(env[key], undefined);
      return 'v44.9.2\n';
    });
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});


test('D-Bus stdout noise is ignored but only an exact pinned version line passes', (t) => {
  const { ui } = fixture(t);
  const noise = '[2957:ERROR:dbus/bus.cc:406] Failed to connect to the bus\n';
  install(ui, () => noise + 'v44.9.2\r\n');
  for (const output of [noise, noise + 'prefix v44.9.2\n', 'v44.9.20\n',
    'v44.9.1\nv44.9.2\n', 'v44.9.2\nv44.9.2\n']) {
    assert.throws(() => install(ui, () => output), /installed Electron version differs/);
  }
});
