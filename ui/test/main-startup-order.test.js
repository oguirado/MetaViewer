import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { MainError, ELECTRON_PIN, registerPrivilegedScheme } from '../electron/main.js';

test('direct entry registers synchronously before a delayed host bootstrap and registers only once', async () => {
  const source = await readFile(new URL('../electron/main.js', import.meta.url), 'utf8');
  const direct = source.slice(source.indexOf('async function mainDirectEntry()'), source.lastIndexOf('\nif (typeof process'));
  const events = [];
  let ready = false, release;
  const host = new Promise(resolve => { release = resolve; });
  const protocol = { registerSchemesAsPrivileged(specs) {
    assert.equal(ready, false, 'Electron rejects registration after ready');
    events.push('register');
    assert.deepEqual(specs, [{ scheme: 'app', privileges: { standard: true, secure: true } }]);
  } };
  const electron = { protocol, app: { exit() { events.push('exit'); } } };
  const promise = runInNewContext(direct.replaceAll('import.meta.url', 'entryURL') + '\nmainDirectEntry()', {
    entryURL: new URL('../electron/main.js', import.meta.url).href, URL,
    createRequire: () => () => electron,
    process: { argv: ['electron', '/app/main.js'], env: {}, versions: { electron: ELECTRON_PIN } },
    console: { error(message) { events.push(message); }, log() {} },
    MainError, ELECTRON_PIN, registerPrivilegedScheme,
    validateRetailLaunch: () => ({ ok: true }),
    loadMainBindings: () => { events.push('bindings'); return host; },
    bootProductionMain: async () => { registerPrivilegedScheme(protocol); events.push('boot'); },
    fileURLToPath: () => '/app/ui', DEFAULT_GEOMETRY: {}, createLayoutBridge: () => ({}),
  });
  assert.deepEqual(events, ['register', 'bindings']);
  ready = true;
  release({ core: {}, wire: {} });
  await promise;
  assert.deepEqual(events, ['register', 'bindings', 'boot']);
});

test('failed privilege registration remains retryable and never admits a boot', () => {
  let refuse = true, calls = 0;
  const protocol = { registerSchemesAsPrivileged() { calls++; if (refuse) throw new Error('refused'); } };
  assert.throws(() => registerPrivilegedScheme(protocol), /refused/);
  refuse = false;
  registerPrivilegedScheme(protocol);
  registerPrivilegedScheme(protocol);
  assert.equal(calls, 2);
});
