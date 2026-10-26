import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProviders,
  validateProviderArgv,
  parseCustomArgv,
  createProviderMenu,
  SYSTEM_SHELL_ENTRY,
  MAX_PROVIDERS,
  MAX_ARGV_LENGTH,
  MAX_ARG_BYTES,
  CUSTOM_MAX_ARGV,
  CUSTOM_MAX_ARG_BYTES,
} from '../src/terminal/providers.js';

/** @param {Record<string, unknown>} [over] */
const entry = (over = {}) => ({
  id: 'claude',
  label: 'Claude Code',
  hint: 'Provider CLI in login shell',
  argv: ['claude'],
  ...over,
});

test('limits match the specified broker caps', () => {
  assert.equal(MAX_PROVIDERS, 32);
  assert.equal(MAX_ARGV_LENGTH, 33);
  assert.equal(MAX_ARG_BYTES, 4096);
  assert.equal(CUSTOM_MAX_ARGV, 32);
  assert.equal(CUSTOM_MAX_ARG_BYTES, 4096);
});

test('SYSTEM_SHELL_ENTRY is the frozen exemplar system entry', () => {
  assert.deepEqual(SYSTEM_SHELL_ENTRY, {
    id: 'shell',
    label: 'System shell',
    hint: 'Interactive login shell',
    argv: [],
    command: 'shell',
  });
  assert.ok(Object.isFrozen(SYSTEM_SHELL_ENTRY));
  assert.ok(Object.isFrozen(SYSTEM_SHELL_ENTRY.argv));
});

test('normalizeProviders accepts valid entries and returns frozen deep copies', () => {
  const input = [
    entry(),
    entry({ id: 'codex', label: 'Codex', argv: ['codex', '--ask'] }),
    entry({ id: 'custom', label: 'Custom', hint: '', argv: ['sh', '-c', 'x'], command: 'provider' }),
  ];
  const before = structuredClone(input);
  const out = normalizeProviders(input);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { id: 'claude', label: 'Claude Code', hint: 'Provider CLI in login shell', argv: ['claude'], command: undefined });
  assert.deepEqual(out[1]?.argv, ['codex', '--ask']);
  assert.equal(out[2]?.command, 'provider');
  assert.ok(Object.isFrozen(out));
  for (const e of out) {
    assert.ok(Object.isFrozen(e));
    assert.ok(Object.isFrozen(e.argv));
  }
  // Deep copy: mutating the input afterwards leaves the output unchanged.
  input[0].id = 'mutated';
  input[0].argv.push('mutated');
  input.push(entry({ id: 'late', label: 'Late' }));
  assert.deepEqual(out[0]?.id, 'claude');
  assert.deepEqual(out[0]?.argv, ['claude']);
  assert.equal(out.length, 3);
  assert.deepEqual(input.slice(0, 3).map((e) => e.label), before.map((e) => e.label));
});

test('normalizeProviders trims id and label', () => {
  const [e] = normalizeProviders([entry({ id: '  codex ', label: '  Codex  ' })]);
  assert.equal(e?.id, 'codex');
  assert.equal(e?.label, 'Codex');
});

test('normalizeProviders accepts boundary ids, counts and byte sizes', () => {
  const okId = `a${'b'.repeat(126)}9`;
  assert.equal(okId.length, 128);
  const [e] = normalizeProviders([entry({ id: ` ${okId} ` })]);
  assert.equal(e?.id, okId);
  const many = Array.from({ length: 32 }, (_, i) => entry({ id: `p${i}`, label: `P${i}` }));
  assert.equal(normalizeProviders(many).length, 32);
  const arg4096 = 'a'.repeat(4096);
  const [b] = normalizeProviders([entry({ argv: ['exe', arg4096] })]);
  assert.equal(b?.argv[1], arg4096);
  const multi = 'é'.repeat(2048);
  assert.equal(new TextEncoder().encode(multi).length, 4096);
  normalizeProviders([entry({ argv: ['exe', multi] })]);
  const argv33 = ['exe', ...Array.from({ length: 32 }, (_, i) => `a${i}`)];
  assert.equal(normalizeProviders([entry({ argv: argv33 })])[0]?.argv.length, 33);
});

test('normalizeProviders throws TypeError on malformed entries', () => {
  const bad = [
    null,
    undefined,
    42,
    'x',
    {},
    { ...entry(), id: 7 },
    { ...entry(), id: '   ' },
    { ...entry(), id: 'has space' },
    { ...entry(), id: 'a/b' },
    { ...entry(), id: 'BAD!' },
    { ...entry(), id: 'x'.repeat(129) },
    { ...entry(), label: 9 },
    { ...entry(), label: '  ' },
    { ...entry(), hint: null },
    { ...entry(), hint: 3 },
    { ...entry(), argv: 'claude' },
    { ...entry(), argv: ['ok', 5] },
    { ...entry(), argv: ['a\0b'] },
    { ...entry(), argv: ['', 'x'] },
    { ...entry(), argv: ['-x'] },
    { ...entry(), command: 'exec' },
    { ...entry(), command: '' },
    { ...entry(), id: undefined },
    { ...entry(), label: undefined },
    { ...entry(), hint: undefined },
    { ...entry(), argv: undefined },
  ];
  for (const [i, v] of bad.entries()) {
    assert.throws(() => normalizeProviders([v]), TypeError, `case ${i}`);
  }
  assert.throws(() => normalizeProviders('nope'), TypeError);
  assert.throws(() => normalizeProviders({}), TypeError);
});

test('normalizeProviders throws RangeError on count, byte, duplicate and reserved violations', () => {
  const many = Array.from({ length: 33 }, (_, i) => entry({ id: `p${i}`, label: `P${i}` }));
  assert.throws(() => normalizeProviders(many), RangeError);
  assert.throws(() => normalizeProviders([entry({ argv: [] })]), RangeError);
  assert.throws(() => normalizeProviders([entry({ argv: Array.from({ length: 34 }, () => 'a') })]), RangeError);
  assert.throws(() => normalizeProviders([entry({ argv: ['exe', 'a'.repeat(4097)] })]), RangeError);
  assert.throws(() => normalizeProviders([entry({ id: 'dup' }), entry({ id: 'dup', label: 'Other' })]), RangeError);
  assert.throws(() => normalizeProviders([entry({ id: 'dup' }), entry({ id: ' dup ', label: 'Other' })]), RangeError);
  assert.throws(() => normalizeProviders([entry({ id: 'shell', argv: [] })]), RangeError);
  assert.throws(() => normalizeProviders([entry({ id: 'provider' })]), RangeError);
});

test('normalizeProviders rejects renderer-owned spawn fields (isolation negative control)', () => {
  for (const extra of [
    { exe: '/bin/evil' },
    { cwd: '/tmp' },
    { env: { PATH: '/tmp' } },
    { PATH: '/tmp' },
    { channel: 'raw' },
    { extra: 1 },
  ]) {
    assert.throws(() => normalizeProviders([entry(extra)]), TypeError, JSON.stringify(extra));
  }
});

test('validateProviderArgv accepts valid argv and returns a frozen copy', () => {
  const argv = ['codex', '--ask', 'explain this'];
  const out = validateProviderArgv(argv);
  assert.deepEqual([...out], argv);
  assert.ok(Object.isFrozen(out));
  argv.push('mutated');
  assert.equal(out.length, 3);
  assert.equal(validateProviderArgv(['x'])[0], 'x');
});

test('validateProviderArgv rejects malformed argv', () => {
  for (const v of ['x', {}, null, ['ok', 1], [['x']], ['a\0'], ['', 'a'], ['-c'], ['--help']]) {
    assert.throws(() => validateProviderArgv(v), TypeError, JSON.stringify(v));
  }
  assert.throws(() => validateProviderArgv([]), RangeError);
  assert.throws(() => validateProviderArgv(Array.from({ length: 34 }, () => 'a')), RangeError);
  assert.throws(() => validateProviderArgv(['a'.repeat(4097)]), RangeError);
  assert.throws(() => validateProviderArgv(['exe', '€'.repeat(1366)]), RangeError);
});

test('parseCustomArgv parses whitespace-separated args without quoting', () => {
  const ok = parseCustomArgv('mycli', '  a   b\tc\n');
  assert.deepEqual(ok, { argv: ['mycli', 'a', 'b', 'c'], error: '' });
  assert.ok(Object.isFrozen(ok.argv));
  assert.deepEqual(parseCustomArgv('  mycli  ', ''), { argv: ['mycli'], error: '' });
  assert.deepEqual(parseCustomArgv('mycli', '   '), { argv: ['mycli'], error: '' });
  // No shell evaluation: quotes stay literal.
  assert.deepEqual(parseCustomArgv('exe', '"a b" $(x)'), {
    argv: ['exe', '"a', 'b"', '$(x)'],
    error: '',
  });
  // Paths with spaces stay intact in the executable field.
  assert.deepEqual(parseCustomArgv('/opt/my tools/cli', '--help')[ 'argv' ], ['/opt/my tools/cli', '--help']);
});

test('parseCustomArgv accepts exactly 32 total argv', () => {
  const args = Array.from({ length: 31 }, (_, i) => `a${i}`).join(' ');
  const ok = parseCustomArgv('exe', args);
  assert.equal(ok.error, '');
  assert.equal(ok.argv?.length, 32);
  assert.deepEqual(parseCustomArgv('exe', 'a'.repeat(4096)).error, '');
});

test('parseCustomArgv rejects invalid custom input with argv null', () => {
  const bad = [
    ['', 'a'],
    ['   ', 'a'],
    ['-exe', ''],
    ['--help', ''],
    ['exe\0x', ''],
    ['exe', 'a\0b'],
    ['exe', 'a'.repeat(4097)],
    ['a'.repeat(4097), ''],
    ['exe', Array.from({ length: 32 }, () => 'a').join(' ')],
    [null, 'a'],
    ['exe', null],
    [42, 'a'],
  ];
  for (const [i, [exe, text]] of bad.entries()) {
    const r = parseCustomArgv(exe, text);
    assert.equal(r.argv, null, `case ${i}`);
    assert.ok(r.error.length > 0, `case ${i}`);
  }
});

test('createProviderMenu puts the shell first and gates on capabilities', () => {
  const entries = normalizeProviders([
    entry(),
    entry({ id: 'codex', label: 'Codex', argv: ['codex'] }),
  ]);
  const menu = createProviderMenu(entries, [
    { id: 'claude', available: true, reason: '' },
    { id: 'codex', available: false, reason: 'not installed' },
    { id: 'unknown', available: true, reason: '' },
  ]);
  assert.deepEqual(menu, [
    { id: 'shell', label: 'System shell', hint: 'Interactive login shell', command: 'shell', disabled: false },
    { id: 'claude', label: 'Claude Code', hint: 'Provider CLI in login shell', command: 'provider', disabled: false },
    { id: 'codex', label: 'Codex', hint: 'Provider CLI in login shell', command: 'provider', disabled: true },
  ]);
  assert.ok(Object.isFrozen(menu));
  for (const m of menu) assert.ok(Object.isFrozen(m));
  // Menu entries carry references only: no argv, exe, cwd or env keys.
  for (const m of menu) {
    assert.deepEqual(Object.keys(m).sort(), ['command', 'disabled', 'hint', 'id', 'label']);
  }
});

test('createProviderMenu disables entries missing a positive capability', () => {
  const entries = normalizeProviders([entry()]);
  const [shell, only] = createProviderMenu(entries, []);
  assert.equal(shell?.disabled, false);
  assert.equal(only?.disabled, true);
  const [shellOff] = createProviderMenu(entries, [{ id: 'shell', available: false, reason: 'restricted' }]);
  assert.equal(shellOff?.disabled, true);
  const [shellOn] = createProviderMenu(entries, [{ id: 'shell', available: true, reason: '' }]);
  assert.equal(shellOn?.disabled, false);
});

test('createProviderMenu honors explicit entry commands and stays inert', () => {
  const entries = normalizeProviders([entry({ command: 'provider' })]);
  const caps = [{ id: 'claude', available: true, reason: '' }];
  const a = createProviderMenu(entries, caps);
  const b = createProviderMenu(entries, caps);
  assert.deepEqual(a, b);
  assert.equal(a[1]?.command, 'provider');
  // Inert: inputs unchanged, no shared mutable state.
  assert.deepEqual(entries, normalizeProviders([entry({ command: 'provider' })]));
  assert.deepEqual(caps, [{ id: 'claude', available: true, reason: '' }]);
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
});

test('createProviderMenu rejects malformed inputs', () => {
  const entries = normalizeProviders([entry()]);
  const caps = [{ id: 'claude', available: true, reason: '' }];
  assert.throws(() => createProviderMenu('x', caps), TypeError);
  assert.throws(() => createProviderMenu(entries, 'x'), TypeError);
  assert.throws(() => createProviderMenu([null], caps), TypeError);
  assert.throws(() => createProviderMenu([{ id: 'shell', label: 'S', hint: '', argv: [] }], caps), TypeError);
  assert.throws(() => createProviderMenu([{ id: 'x', label: '', hint: '' }], caps), TypeError);
  assert.throws(() => createProviderMenu(entries, [null]), TypeError);
  assert.throws(() => createProviderMenu(entries, [{ id: '', available: true, reason: '' }]), TypeError);
  assert.throws(() => createProviderMenu(entries, [{ id: 'claude', available: 'yes', reason: '' }]), TypeError);
  assert.throws(() => createProviderMenu(entries, [{ id: 'claude', available: true, reason: 3 }]), TypeError);
  // Unknown capability fields are ignored for forward compatibility.
  const [shell, only] = createProviderMenu(entries, [{ id: 'claude', available: true, reason: '', extra: 1 }]);
  assert.equal(shell?.id, 'shell');
  assert.equal(only?.disabled, false);
});
