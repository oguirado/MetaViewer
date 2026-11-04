import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHostBinary, HOST_BINARY_STANDARD_DIRS } from '../electron/roleHost.js';
import { buildCreateIntent, CATALOG_KINDS } from '../src/catalog/catalogModel.js';
import * as catalogModel from '../src/catalog/catalogModel.js';
import { copyCapsuleReadyLine } from '../src/wall/capsuleId.js';
import { workflowPrompt } from '../src/terminal/workflowPrompts.js';
import { compileSfc, childStub, mountComponent, flush, nodes, text } from './mvui2-terminal-mount.mjs';

test('B3-05 Host program intent resolves an absolute executable with spaces and accents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'v027-fix-j3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'Música programs');
  await mkdir(directory);
  const binary = join(directory, 'editor');
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const selected = buildCreateIntent({ kind: 'host-program', binary, role: 'human' });
  assert.equal(selected.ok, true);
  assert.equal(resolveHostBinary(selected.intent.binary, { PATH: '' }, []).path, binary);
  for (const bad of [binary + '-absent', './editor', '../editor', 'editor --flag',
    binary + ';id', binary + '\n', binary + '/..', '$(id)']) {
    assert.throws(() => resolveHostBinary(bad, { PATH: directory }, []), { code: 'HOST_PROGRAM_UNAVAILABLE' });
  }
});

test('B3-10 sanitized launcher PATH also searches the Snap executable directory', async t => {
  assert.ok(HOST_BINARY_STANDARD_DIRS.includes('/snap/bin'));
  const snap = await mkdtemp(join(tmpdir(), 'v027-fix-j3-snap-'));
  t.after(() => rm(snap, { recursive: true, force: true }));
  const binary = join(snap, 'fixture-editor');
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(resolveHostBinary('fixture-editor', { PATH: '/nonexistent' }, [snap]).path, binary);
  assert.throws(() => resolveHostBinary('absent-editor', { PATH: '/nonexistent' }, [snap]), { code: 'HOST_PROGRAM_UNAVAILABLE' });
});

test('B3-06 copying a capsule preserves the choice between goal and stored workflow modes', async () => {
  const writes = [];
  await copyCapsuleReadyLine({ surfaceId: 'surf-demo', profileId: 'demo' }, { writeText: line => writes.push(line) });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /goal mode/i);
  assert.match(writes[0], /stored.workflow mode/i);
  assert.match(writes[0], /--goal/);
  assert.match(writes[0], /compiled.*goal|goal.*compiled/i);
  writes.length = 0;
  await copyCapsuleReadyLine({ surfaceId: 'surf-demo' }, { writeText: line => writes.push(line) });
  assert.doesNotMatch(writes[0], /--goal|--identity|mw_run/);
});

test('B3-11 goal prompt distinguishes compiled goal support from stored-workflow refusal', () => {
  const prompt = workflowPrompt('no-automation');
  assert.match(prompt, /compiled.*browser goals|browser goals.*compiled/i);
  assert.match(prompt, /MW_COMPILED_BROWSER_UNAVAILABLE.*stored.workflow/);
  assert.doesNotMatch(prompt, /wait for the compiled browser build/);
});

test('B3-20 opening Desktop window explains empty X11 inventory and then a failed search', async t => {
  const previous = globalThis.metaviewerRoles;
  globalThis.metaviewerRoles = { listWindows: async () => [] };
  t.after(() => { globalThis.metaviewerRoles = previous; });
  const children = {};
  const component = await compileSfc('catalog/CatalogLauncher.vue', {
    './GroupedCapsuleDialog.vue': childStub('catalog', children, {type:{id:'desktop-window'}}),
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': childStub('icon', children),
    './catalogModel.js': catalogModel,
  });
  const mounted = mountComponent(component, { visible: true });
  t.after(() => mounted.app.unmount());
  children.catalog.emit('create', { type: { id: 'desktop-window' } });
  await flush();
  const empty = () => nodes(mounted.root).find(n => n.props?.id === 'shell/new-capsule/window-empty');
  assert.match(text(empty()), /X11/);
  assert.match(text(empty()), /Wayland/);
  assert.doesNotMatch(text(empty()), /match this filter/);
  const search = nodes(mounted.root).find(n => n.props?.id === 'shell/new-capsule/window-search');
  search.value = 'editor';
  search.props['onUpdate:modelValue']('editor');
  await flush();
  assert.match(text(empty()), /match this filter/);
  assert.match(CATALOG_KINDS.find(row => row.kind === 'desktop-window').description, /X11/);
});
