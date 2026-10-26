'use strict';
// [TARGET, unit decision] A hosted core-only slice is explicit. LIVE has no
// authority-serving process on this branch and must fail closed, never skip.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { compileRust, replay } = require('../core-driver.js');
const { E2EError, makeScratch, removeScratch } = require('../harness.js');
function requireLive(env = process.env) {
  if (env.MV_E2E_LIVE !== '1') throw new E2EError('E2E_GATE', 'LIVE requires MV_E2E_LIVE=1');
  throw new E2EError('E2E_PREREQ', 'BLOCKED: core/src/bin has no authority-serving entry; '
    + 'daemon-adapter/cmd/mv-daemon-adapter/main.go calls daemon.Run without Runtime; '
    + 'ui production boot lacks the authority frame/proposal connection. CLI observe remains unsupported_operation.');
}
function hosted() {
  const scratch = makeScratch('mv-slice');
  try {
    const source = readFileSync(join(__dirname, 'scenario.rs'), 'utf8');
    const binary = compileRust(scratch, source);
    const state = JSON.parse(execFileSync(binary, [join(scratch, 'state_dir'), '--full'], { encoding: 'utf8' }));
    const root = join(scratch, 'state_dir/sessions/session-1');
    const journal = join(root, 'journal.jsonl');
    const a = replay(journal, root).trim();
    const b = replay(journal, root).trim();
    if (a !== b) throw new Error('E2E_REPLAY: digest diverged');
    return { mode: 'hosted-core-only', digest: a, state };
  } finally { removeScratch(scratch); }
}
module.exports = { hosted, requireLive };
if (require.main === module) {
  try { console.log(JSON.stringify(process.argv.includes('--live') ? requireLive() : hosted())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
