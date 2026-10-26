import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterNested, installReadOnlyLayout } from '../electron/nesting.js';
import { writeManifest, validateOutput } from '../tools/package.js';

test('depth one enters only the supplied display capability', async () => {
  let calls = 0;
  const value = await enterNested(['--nested-depth=1', '--user-data-dir=/profile/app', '--ozone-platform=x11'], {}, async () => { calls++; return 'display'; });
  assert.equal(value, 'display');
  assert.equal(calls, 1);
});

test('deeper, malformed, duplicate, unsafe and unnested launches refuse before display', async () => {
  for (const argv of [[], ['--nested-depth=2'], ['--nested-depth=3'], ['--nested-depth=-1'], ['--nested-depth=01'], ['--nested-depth=1', '--nested-depth=1'], ['--nested-depth=1', '--no-sandbox'], ['--nested-depth=1', '--remote-debugging-port=9222']]) {
    await assert.rejects(enterNested(argv, {}, async () => assert.fail('display must remain unreachable')), /NESTED_DEPTH|RETAIL_FLAG/);
  }
  await assert.rejects(enterNested(['--nested-depth=1'], { NODE_OPTIONS: '--inspect' }, async () => assert.fail()), /RETAIL_ENV/);
});

test('manifest hashes sorted relative files and rejects symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-manifest-'));
  try {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'z'), 'abc');
    await writeFile(join(root, 'sub/a'), '');
    const manifest = `${root}.sha256`;
    await writeManifest(root, manifest);
    const lines = (await readFile(manifest, 'utf8')).trim().split('\n');
    assert.deepEqual(lines, [
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  sub/a',
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  z',
    ]);
    await symlink('z', join(root, 'link'));
    await assert.rejects(writeManifest(root, manifest), /Symlink/);
    await rm(manifest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('output gate rejects missing and repository-contained destinations', () => {
  for (const value of [undefined, '', '.', 'build', '/repo', '/repo/out']) {
    assert.throws(() => validateOutput(value, '/repo'), /MV_PKG_OUT/);
  }
  assert.equal(validateOutput('/outside/build', '/repo'), '/outside/build');
});


test('display layout admits only its top frame and never persists', () => {
  const handlers = new Map();
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
  installReadOnlyLayout({ handle: (name, handler) => handlers.set(name, handler) }, contents);
  const load = handlers.get('metaviewer:layout.load');
  const save = handlers.get('metaviewer:layout.save');
  const event = { sender: contents, senderFrame: frame };
  assert.equal(load(event), null);
  assert.throws(() => load({ sender: {}, senderFrame: frame }), /sender refused/);
  assert.throws(() => load({ sender: contents, senderFrame: { ...frame } }), /sender refused/);
  assert.throws(() => load(event, 'unexpected'), /sender refused/);
  assert.throws(() => save(event, '{}'), /persistence is disabled/);
});
