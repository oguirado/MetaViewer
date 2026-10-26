import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRetailLaunch, FORBIDDEN_ARGV_FLAGS } from '../electron/main.js';

test('validateRetailLaunch positive witness admits valid retail and nested invocations', () => {
  // Standard retail launch
  const standard = validateRetailLaunch(['node', 'main.js'], {});
  assert.deepEqual(standard, Object.freeze({ ok: true, nested: false }));

  // Admitted runtime switches
  const withSwitches = validateRetailLaunch(['node', 'main.js', '--user-data-dir=/tmp/userData', '--ozone-platform=wayland'], {});
  assert.deepEqual(withSwitches, Object.freeze({ ok: true, nested: false }));

  // Valid nested depth 1
  const nested = validateRetailLaunch(['node', 'main.js', '--nested-depth=1'], {});
  assert.deepEqual(nested, Object.freeze({ ok: true, nested: true }));
});

test('validateRetailLaunch matrix testing negative controls and exact refusal codes', () => {
  const baseArgv = ['node', 'main.js'];
  const baseEnv = {};

  // 1. Each forbidden flag bare
  for (const flag of FORBIDDEN_ARGV_FLAGS) {
    const verdict = validateRetailLaunch([...baseArgv, flag], baseEnv);
    assert.deepEqual(verdict, Object.freeze({ ok: false, code: 'RETAIL_FLAG' }), `Bare flag ${flag} must refuse with RETAIL_FLAG`);
  }

  // 2. Each forbidden flag with =value
  for (const flag of FORBIDDEN_ARGV_FLAGS) {
    const verdict = validateRetailLaunch([...baseArgv, `${flag}=value123`], baseEnv);
    assert.deepEqual(verdict, Object.freeze({ ok: false, code: 'RETAIL_FLAG' }), `Flag with value ${flag}=value123 must refuse with RETAIL_FLAG`);
  }

  // 3. Prefix lookalikes (e.g., --inspectX)
  for (const flag of ['--inspectX', '--debugX', '--importX', '--no-sandboxX']) {
    const verdict = validateRetailLaunch([...baseArgv, flag], baseEnv);
    assert.deepEqual(verdict, Object.freeze({ ok: false, code: 'UNKNOWN_SWITCH' }), `Prefix lookalike ${flag} must refuse with UNKNOWN_SWITCH`);
  }

  // 4. --nested-depth variants
  const invalidNestedVariants = [
    '--nested-depth=0',
    '--nested-depth=2',
    '--nested-depth=01',
    '--nested-depth=+1',
    '--nested-depth=1 ',
    '--nested-depth=1=1',
    '--nested-depth',
  ];
  for (const variant of invalidNestedVariants) {
    const verdict = validateRetailLaunch([...baseArgv, variant], baseEnv);
    assert.deepEqual(verdict, Object.freeze({ ok: false, code: 'NESTED_DEPTH' }), `Nested variant ${variant} must refuse with NESTED_DEPTH`);
  }

  // Repeated --nested-depth=1
  const repeatedNested = validateRetailLaunch([...baseArgv, '--nested-depth=1', '--nested-depth=1'], baseEnv);
  assert.deepEqual(repeatedNested, Object.freeze({ ok: false, code: 'NESTED_DEPTH' }));

  // 5. Unknown switches
  for (const unknown of ['--unknown-flag', '--foo=bar', '-x']) {
    const verdict = validateRetailLaunch([...baseArgv, unknown], baseEnv);
    assert.deepEqual(verdict, Object.freeze({ ok: false, code: 'UNKNOWN_SWITCH' }), `Unknown switch ${unknown} must refuse with UNKNOWN_SWITCH`);
  }

  // 6. Forbidden env names
  const forbiddenEnvs = [
    { ELECTRON_RUN_AS_NODE: '1' },
    { NODE_OPTIONS: '--require=evil' },
    { LD_PRELOAD: '/lib/evil.so' },
    { DYLD_INSERT_LIBRARIES: '/lib/evil.dylib' },
    { PYTHONPATH: '/tmp/python' },
    { BASH_ENV: '/tmp/bashrc' },
    { ENV: '/tmp/env' },
  ];
  for (const envObj of forbiddenEnvs) {
    const verdict = validateRetailLaunch(baseArgv, envObj);
    assert.deepEqual(verdict, Object.freeze({ ok: false, code: 'RETAIL_ENV' }), `Forbidden env ${Object.keys(envObj)[0]} must refuse with RETAIL_ENV`);
  }

  // 7. Non-string env values or malformed env
  for (const badEnv of [null, undefined, 'not-an-object', 123, []]) {
    const verdict = validateRetailLaunch(baseArgv, badEnv);
    assert.deepEqual(verdict, Object.freeze({ ok: false, code: 'ENV_SHAPE' }));
  }

  // 8. Argv bounds (257 items)
  const overMaxArgv = new Array(257).fill('arg');
  assert.deepEqual(validateRetailLaunch(overMaxArgv, baseEnv), Object.freeze({ ok: false, code: 'ARGV_SHAPE' }));

  // 9. 4097-char item
  const overMaxCharItem = ['node', 'a'.repeat(4097)];
  assert.deepEqual(validateRetailLaunch(overMaxCharItem, baseEnv), Object.freeze({ ok: false, code: 'ARGV_SHAPE' }));

  // 10. NUL item
  const nulItem = ['node', 'hello\0world'];
  assert.deepEqual(validateRetailLaunch(nulItem, baseEnv), Object.freeze({ ok: false, code: 'ARGV_SHAPE' }));
});
