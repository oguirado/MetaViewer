import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as authority from '../electron/authorityWire.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';

const frozen = (fps) => JSON.stringify({
  schema: 'settings/v0.2', theme: 'metaviewer-dark', providers: [],
  recording_destination: null,
  limits: { memory_bytes: 1024, max_fps: fps, ring_bytes: 1024 },
});
const refusal = { code: 'SETTINGS_RECORDING_FPS' };

async function fixture(t, api = authority) {
  const root = await mkdtemp(join(tmpdir(), 'mv-maxfps-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: root };
  const store = api.createSettingsStore(env);
  const notices = [];
  t.after(store.subscribe(value => notices.push(value)));
  const handlers = new Map();
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const calls = [];
  const record = name => value => calls.push([name, value]);
  const wire = api.installAuthorityWire({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: ch => handlers.delete(ch) },
    contents, env, argv: ['--nested-depth=0'],
    core: {
      request: async () => true,
      requestCadence: record('core.requestCadence'), setCadence: record('core.setCadence'),
      setRecordingFps: fps => {
        api.validateCadence({ recordingFps: fps });
        record('core.setRecordingFps')(fps);
      },
    },
    frames: {
      subscribe: () => () => {},
      requestCadence: record('frames.requestCadence'), setCadence: record('frames.setCadence'),
    },
    frameDiag: { recordCadence: record('diag.recordCadence') },
  });
  t.after(() => wire.dispose());
  const event = { sender: contents, senderFrame: frame };
  return {
    root, store, notices, calls, wire, path: join(root, 'metaviewer', 'settings.json'),
    save: text => handlers.get(api.WIRE_CHANNELS.saveSettings)(event, text),
    load: () => handlers.get(api.WIRE_CHANNELS.loadSettings)(event),
  };
}

async function refusesBeforeWrite(t, api = authority) {
  const f = await fixture(t, api);
  const initial = JSON.stringify({ scheme: 'mv-light', density: 'compact', wallFps: 3, recordingFps: 18 });
  await f.save(initial);
  const before = await stat(f.path, { bigint: true });
  const calls = structuredClone(f.calls);
  const notices = structuredClone(f.notices);
  for (const fps of [61, 100, 120]) {
    // The frozen contract admits this value; the product projection must refuse it.
    assert.equal(api.decodeSettingsV02(frozen(fps)).limits.max_fps, fps);
    for (const save of [f.save, text => f.store.save(text)]) {
      await assert.rejects(save(frozen(fps)), refusal);
      assert.equal(await readFile(f.path, 'utf8'), initial, 'refusal must preserve durable bytes');
      const after = await stat(f.path, { bigint: true });
      assert.equal(after.ino, before.ino, 'refusal must not replace the file');
      assert.equal(after.mtimeNs, before.mtimeNs);
      assert.equal(f.wire.recordingFps, 18);
      assert.equal(f.wire.requestedWallFps, 3);
      assert.deepEqual(f.calls, calls, 'refusal must not fan out');
      assert.deepEqual(f.notices, notices, 'refusal must not notify store subscribers');
      assert.deepEqual(await readdir(join(f.root, 'metaviewer')), ['settings.json']);
    }
  }
}

test('frozen max_fps refusal precedes durable replacement, memory updates and fan-out', refusesBeforeWrite);

test('unsupported frozen max_fps is refused before creating storage', async t => {
  const f = await fixture(t);
  await assert.rejects(f.save(frozen(100)), refusal);
  await assert.rejects(f.store.save(frozen(100)), refusal);
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.notices, []);
});

test('supported frozen cadence saves and loads; preexisting unsupported storage loads defaults safely', async t => {
  const f = await fixture(t);
  for (const fps of [1, 30, 60]) {
    const text = frozen(fps);
    assert.equal(authority.validateSettings(text).recordingFps, fps);
    assert.equal(await f.save(text), true);
    assert.equal(await readFile(f.path, 'utf8'), text);
    assert.equal(await f.load(), text);
    assert.equal(f.wire.recordingFps, fps);
    assert.deepEqual(f.calls.at(-2), ['core.setRecordingFps', fps]);
  }
  for (const fps of [61, 100, 120]) {
    await writeFile(f.path, frozen(fps));
    assert.equal(await f.load(), null);
    assert.equal(f.wire.recordingFps, authority.DEFAULT_SETTINGS.recordingFps);
    assert.equal(f.wire.requestedWallFps, authority.DEFAULT_SETTINGS.wallFps);
    assert.equal(await readFile(f.path, 'utf8'), frozen(fps));
  }
});

test('VALIDATE_AFTER_WRITE mutation is killed by the durable-state witness', async t => {
  const sourceUrl = new URL('../electron/authorityWire.js', import.meta.url);
  let source = await readFile(sourceUrl, 'utf8');
  const validation = '  validateCadence({ recordingFps: parsed.recordingFps });';
  const rename = '        await rename(temp,path);';
  assert.equal(source.split(validation).length, 2, 'projection mutation anchor is unique');
  assert.equal(source.split(rename).length, 2, 'durable-write mutation anchor is unique');
  source = source.replace(validation, '').replace(rename, `${rename}
        validateCadence({ recordingFps: parsed.recordingFps });`);
  // A disposable module uses the real dependencies and source-root identity.
  source = source.replaceAll('import.meta.url', JSON.stringify(sourceUrl.href))
    .replace(/from '(\.\/[^']+)'/g, (_, path) => `from ${JSON.stringify(new URL(path, sourceUrl).href)}`);
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  await assert.rejects(refusesBeforeWrite(t, mutant), error =>
    error.code === 'ERR_ASSERTION' && /refusal must preserve durable bytes/.test(error.message));
});
