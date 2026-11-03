import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { showStartupFailure, MainError, ELECTRON_PIN } from '../electron/main.js';
import { hostOutcomeFor } from '../src/core/hostAdapters.js';

test('boot and first-create dialogs name the failure and recovery without raw host diagnostics', () => {
  const dialogs = [];
  const blocking = [];
  const dialog = {
    showErrorBox: (title, content) => { blocking.push(title); dialogs.push({ title, content }); },
    showMessageBox: async options => { dialogs.push({ title: options.title, content: `${options.message}\n\n${options.detail}` }); },
  };
  showStartupFailure(dialog, new MainError('ADAPTER_UNAVAILABLE', 'private diagnostic'), 'boot');
  showStartupFailure(dialog, new MainError('SURFACE_CREATE_TIMEOUT', 'private diagnostic'), 'create');
  assert.match(dialogs[0].content, /ADAPTER_UNAVAILABLE.*could not start/);
  assert.match(dialogs[0].content, /MV_SRF_BIN_DIR.*restart MetaViewer/);
  assert.match(dialogs[1].content, /SURFACE_CREATE_TIMEOUT.*first capsule/);
  assert.match(dialogs[1].content, /Identities.*Add capsule/);
  assert.deepEqual(blocking, [], 'a startup failure must not hang on a modal with nobody at the screen');
  for (const row of dialogs) assert.doesNotMatch(row.content, /private diagnostic/);
  assert.doesNotThrow(() => showStartupFailure({ showErrorBox() { throw Error('display unavailable'); } }, null, 'boot'));
  assert.doesNotThrow(() => showStartupFailure(null, null, 'create'));
  showStartupFailure(dialog, { code: 'bad\ncode' }, 'boot');
  assert.match(dialogs[2].content, /^STARTUP_FAILED:/);
});

test('direct entry waits for Linux dialog readiness and reports refusal before exiting', async () => {
  const source = await readFile(new URL('../electron/main.js', import.meta.url), 'utf8');
  const direct = source.slice(source.indexOf('async function mainDirectEntry()'), source.lastIndexOf('\nif (typeof process'));
  const events = [];
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const electron = {
    protocol: {},
    app: { whenReady: () => { events.push('wait-ready'); return ready; }, exit: code => events.push(`exit:${code}`) },
    dialog: { showMessageBox: async options => { assert.match(options.message, /ADAPTER_UNAVAILABLE/); events.push('dialog'); } },
  };
  const boot = runInNewContext(direct.replaceAll('import.meta.url', 'entryURL') + '\nmainDirectEntry()', {
    entryURL: new URL('../electron/main.js', import.meta.url).href,
    createRequire: () => () => electron,
    process: { argv: [], env: {}, versions: { electron: ELECTRON_PIN } },
    console: { error() { events.push('stderr'); } },
    MainError, ELECTRON_PIN, showStartupFailure,
    validateRetailLaunch: () => ({ ok: true }), registerPrivilegedScheme() {},
    loadMainBindings: async () => { throw new MainError('ADAPTER_UNAVAILABLE', 'not live'); },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['stderr', 'wait-ready']);
  release();
  await boot;
  assert.deepEqual(events, ['stderr', 'wait-ready', 'dialog', 'exit:1']);
});

test('create failure copy explains core-only installation recovery without claiming a detected tier', () => {
  for (const code of ['SURFACE_CREATE_FAILED', 'ADAPTER_ERROR']) {
    const row = hostOutcomeFor({ code, message: 'untrusted', tone: 'refusal' });
    assert.equal(row.tone, 'refusal');
    assert.match(row.message, /core-only installation/);
    assert.match(row.message, /surface runtime/);
    assert.match(row.message, /Add capsule/);
    assert.doesNotMatch(row.message, /untrusted/);
  }
  assert.equal(hostOutcomeFor({ code: 'INTENT_ACKNOWLEDGED', message: '', tone: 'success' }).message, 'Request sent.');
  assert.equal(hostOutcomeFor(null), null);
});


test('CLI policy refusal exits before readiness, dialog, or host acquisition', async () => {
  const source = await readFile(new URL('../electron/main.js', import.meta.url), 'utf8');
  const direct = source.slice(source.indexOf('async function mainDirectEntry()'), source.lastIndexOf('\nif (typeof process'));
  for (const code of ['RETAIL_FLAG', 'RETAIL_ENV']) {
    const events = [];
    await runInNewContext(direct.replaceAll('import.meta.url', 'entryURL') + '\nmainDirectEntry()', {
      entryURL: new URL('../electron/main.js', import.meta.url).href,
      createRequire: () => () => ({
        app: { whenReady() { throw Error('must not wait'); }, exit: code => events.push(`exit:${code}`) },
        dialog: { showErrorBox() { events.push('dialog'); } },
      }),
      process: { argv: [], env: {}, versions: { electron: ELECTRON_PIN } },
      console: { error() { events.push('stderr'); } },
      MainError, ELECTRON_PIN, showStartupFailure,
      validateRetailLaunch: () => ({ ok: false, code }),
      loadMainBindings() { events.push('host'); },
    });
    assert.deepEqual(events, ['stderr', 'exit:1']);
  }
});
