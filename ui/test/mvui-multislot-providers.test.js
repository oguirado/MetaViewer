import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_LAUNCH_ENTRY_ID,
  LAUNCH_MAX_ARGS,
  LAUNCH_MAX_ARG_BYTES,
  LAUNCH_REFUSALS,
  PROVIDER_DATA_REFUSAL,
  parseCustomLaunch,
  toKitMenuProviders,
  validateLaunchRequest,
} from '../src/multislot/multislotProviders.js';

const HOST_ENTRIES = Object.freeze([
  Object.freeze({ id: 'alpha', label: 'Alpha', hint: 'First host provider', argv: ['alpha', '--serve'] }),
  Object.freeze({ id: 'beta.tool', label: 'Beta Tool', hint: '', argv: ['beta'] }),
]);

test('menu maps shell first, then host entries with host-owned argv preserved verbatim', () => {
  const menu = toKitMenuProviders(HOST_ENTRIES);
  assert.equal(menu.length, 3);
  assert.deepEqual({ ...menu[0] }, { id: 'shell', label: 'System shell', hint: 'Interactive login shell', argv: [], command: 'shell' });
  assert.deepEqual({ ...menu[1] }, { id: 'alpha', label: 'Alpha', hint: 'First host provider', argv: ['alpha', '--serve'], command: undefined });
  assert.deepEqual(menu[2].argv, ['beta']);
  assert.ok(Object.isFrozen(menu));
  assert.ok(Object.isFrozen(menu[1]));
});

test('menu without host data is shell-only; input arrays are never mutated', () => {
  assert.equal(toKitMenuProviders([]).length, 1);
  assert.equal(toKitMenuProviders(undefined).length, 1);
  assert.deepEqual(HOST_ENTRIES[0].argv, ['alpha', '--serve']);
});

test('malformed host data throws instead of rendering a partial menu (negative controls)', () => {
  assert.throws(() => toKitMenuProviders([{ id: 'no-argv', label: 'No Argv', hint: '' }]), /argv/);
  assert.throws(() => toKitMenuProviders([{ id: 'shell', label: 'Impostor', hint: '', argv: ['x'] }]), /reserved/);
  assert.throws(() => toKitMenuProviders('not-an-array'), TypeError);
  assert.equal(PROVIDER_DATA_REFUSAL, 'ERR_PROVIDER_DATA_REJECTED');
});

function validate(payload, commands = ['shell', 'provider']) {
  return validateLaunchRequest(payload, { commands, menuIds: ['shell', 'alpha', 'beta.tool'] });
}

test('launch validation accepts shell, provider and custom commits on advertised commands', () => {
  const shell = validate({ entryId: 'shell', command: 'shell', args: [], title: 't', kind: 'k' });
  assert.equal(shell.ok, true);
  assert.deepEqual(shell.ok ? { ...shell.launch, args: [...shell.launch.args] } : null, {
    entryId: 'shell', command: 'shell', args: [], title: 't', kind: 'k',
  });
  const provider = validate({ entryId: 'alpha', command: 'provider', args: ['alpha', '--serve'], title: '', kind: '' });
  assert.equal(provider.ok, true);
  assert.equal(CUSTOM_LAUNCH_ENTRY_ID, 'custom');
  const custom = validate({ entryId: 'custom', command: 'provider', args: ['myexe', '-a'], title: '', kind: '' });
  assert.equal(custom.ok, true);
});

test('launch validation refuses unknown entries and unadvertised commands with typed codes', () => {
  const unknown = validate({ entryId: 'ghost', command: 'provider', args: [] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok ? null : unknown.refusal.code, LAUNCH_REFUSALS.ENTRY_UNKNOWN);
  const empty = validate({ entryId: '', command: 'provider', args: [] });
  assert.equal(empty.ok ? null : empty.refusal.code, LAUNCH_REFUSALS.ENTRY_UNKNOWN);
  const unadvertised = validateLaunchRequest(
    { entryId: 'alpha', command: 'provider', args: [] },
    { commands: ['shell'], menuIds: ['shell', 'alpha'] },
  );
  assert.equal(unadvertised.ok ? null : unadvertised.refusal.code, LAUNCH_REFUSALS.COMMAND_UNAVAILABLE);
});

test('launch validation refuses oversized, non-string and NUL argv (negative controls)', () => {
  assert.equal(LAUNCH_MAX_ARGS, 32);
  assert.equal(LAUNCH_MAX_ARG_BYTES, 4096);
  const tooMany = validate({ entryId: 'alpha', command: 'provider', args: new Array(33).fill('x') });
  assert.equal(tooMany.ok ? null : tooMany.refusal.code, LAUNCH_REFUSALS.ARGV_REJECTED);
  const nul = validate({ entryId: 'alpha', command: 'provider', args: ['a\0b'] });
  assert.equal(nul.ok ? null : nul.refusal.code, LAUNCH_REFUSALS.ARGV_REJECTED);
  const huge = validate({ entryId: 'alpha', command: 'provider', args: ['x'.repeat(4097)] });
  assert.equal(huge.ok ? null : huge.refusal.code, LAUNCH_REFUSALS.ARGV_REJECTED);
  const nonString = validate({ entryId: 'alpha', command: 'provider', args: ['ok', 7] });
  assert.equal(nonString.ok ? null : nonString.refusal.code, LAUNCH_REFUSALS.ARGV_REJECTED);
  const boundary = validate({ entryId: 'alpha', command: 'provider', args: ['x'.repeat(4096)] });
  assert.equal(boundary.ok, true);
});

test('custom launch parses executable plus whitespace-split args, never quoting', () => {
  assert.deepEqual(parseCustomLaunch('myexe', '-a  b'), { ok: true, argv: ['myexe', '-a', 'b'] });
  assert.deepEqual(parseCustomLaunch('  myexe  ', ' '), { ok: true, argv: ['myexe'] });
  assert.deepEqual(parseCustomLaunch('myexe', '"a b"'), { ok: true, argv: ['myexe', '"a', 'b"'] });
  assert.equal(parseCustomLaunch('', '-a').ok, false);
  assert.equal(parseCustomLaunch('-dash', '').ok, false);
  assert.equal(parseCustomLaunch('exe', new Array(40).join('a ')).ok, false);
  assert.ok(parseCustomLaunch('', '').error.length > 0);
});
