'use strict';
// [TARGET, unit decision] Mutation receipts for each AC validator. Compile each
// mutation in memory; neither the product nor the nominal tests are rewritten.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const mutations = [
  {
    file: 'ac02_wall.test.js', name: 'reciprocal distinct frame swaps',
    before: 'if (expectedOwner !== tile.capsuleId) {',
    after: 'if (false && expectedOwner !== tile.capsuleId) {',
    defect: 'accept foreign frame ownership',
  },
  {
    file: 'ac03_lifecycle.test.js', name: 'destroyed or lost ids are never revived',
    before: 'if (state.has(id)) throw', after: 'if (false && state.has(id)) throw',
    defect: 'revive a tombstoned surface',
  },
  {
    file: 'ac04_control.test.js', name: 'proposal admitted during human control',
    before: 'if (witness.during_control_verdict !== REFUSAL_TAKEOVER) {',
    after: 'if (false && witness.during_control_verdict !== REFUSAL_TAKEOVER) {',
    defect: 'admit during human takeover',
  },
  {
    file: 'ac05_ai.test.js', name: 'stale frame binding is refused',
    before: "return { decision: 'refused', reason_code: 'STALE_FRAME' };",
    after: "return { decision: 'admitted' };",
    defect: 'admit a stale frame',
  },
  {
    file: 'ac06_multislot.test.js', name: 'READ-mode keystroke delivered is refused',
    before: "if (mode === 'read') {", after: "if (false) {",
    defect: 'treat READ as WRITE',
  },
  {
    file: 'ac07_ram_first.test.js', name: 'disk_start without destination capability',
    before: "checkRecordId(params.destination_capability_id, 'destination_capability_id', 'E2E_DESTINATION');",
    after: "params.destination_capability_id ??= 'implicit-mutant-capability';\n    checkRecordId(params.destination_capability_id, 'destination_capability_id', 'E2E_DESTINATION');",
    defect: 'invent a missing destination capability',
  },
];
if (process.env.MV_AC_MUTATION) {
  const mutation = mutations.find(({ file }) => file === process.env.MV_AC_MUTATION);
  assert.ok(mutation, 'unknown AC mutation');
  const target = join(__dirname, mutation.file);
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = function load(module, filename) {
    if (filename !== target) return original(module, filename);
    const source = readFileSync(filename, 'utf8');
    assert.equal(source.split(mutation.before).length, 2, 'mutation anchor must be unique');
    module._compile(source.replace(mutation.before, mutation.after), filename);
  };
} else {
  for (const mutation of mutations) {
    const command = [ '--test', '--test-reporter=tap', '--test-name-pattern', mutation.name,
      join(__dirname, mutation.file) ];
    const nominal = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 30000 });
    assert.equal(nominal.status, 0, nominal.stdout + nominal.stderr);
    const planted = spawnSync(process.execPath, ['--require', __filename, ...command], {
      env: { ...process.env, MV_AC_MUTATION: mutation.file },
      encoding: 'utf8', timeout: 30000,
    });
    const output = planted.stdout + planted.stderr;
    assert.equal(planted.status, 1, output);
    assert.match(output, /ERR_ASSERTION/, output);
    assert.doesNotMatch(output, /E2E_PREREQ|mutation anchor must be unique/);
    console.log(`${mutation.file}: nominal rc=${nominal.status}; mutation rc=${planted.status}; ${mutation.defect}`);
  }
}
