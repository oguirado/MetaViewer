'use strict';
// [TARGET, unit decision] LIVE probes the actual registered socket and adapter;
// a production refusal fails the gate and is reported without synthetic events.
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { compileRust, replay, buildEnv } = require('../core-driver.js');
const { E2EError, makeScratch, removeScratch } = require('../harness.js');
function requireLive(env = process.env) {
  if (env.MV_E2E_LIVE !== '1') throw new E2EError('E2E_GATE', 'LIVE requires MV_E2E_LIVE=1');
  for (const key of ['MV_E2E_CORE_BIN', 'MV_E2E_ADAPTER_BIN', 'MV_E2E_REPLAY_BIN',
    'MV_SRF_BIN_DIR', 'MV_SRF_LIVE_PROFILE', 'MV_SRF_LIVE_RAM_ROOT', 'MV_SRF_STATE_DIR',
    'SRF_IDENTITY_STORE_ROOT', 'SRF_PROXY_REGISTRY']) {
    if (!env[key]) throw new E2EError('E2E_PREREQ', `LIVE requires ${key}`);
  }
}
function live() {
  requireLive();
  const scratch = makeScratch('mv-live-verify');
  try {
    const verifier = compileRust(scratch, readFileSync(join(__dirname, 'verify-receipt.rs'), 'utf8'));
    const result = spawnSync(process.env.PYTHON || 'python3',
      [join(__dirname, 'live.py')], { encoding: 'utf8', timeout: 120000,
        env: { ...process.env, MV_E2E_VERIFY_BIN: verifier } });
    if (result.error) throw result.error;
    if (!result.stdout.trim()) throw new E2EError('E2E_LIVE', result.stderr || 'probe returned no evidence');
    const report = JSON.parse(result.stdout);
    checkLiveResult(report, result.status);
    return { ...report, runner_rc: result.status };
  } finally { removeScratch(scratch); }
}
function checkLiveResult(report, status) {
  if (!['DONE', 'BLOCKED'].includes(report.status)
      || status !== (report.status === 'DONE' ? 0 : 1)) {
    throw new E2EError('E2E_LIVE', 'probe exit status contradicts its report');
  }
  const required = ['capsule_frame_ui_fanout', 'observe_propose_dispatch_receipt',
    'receipt_binding_negative_control',
    'stale_no_state_change', 'human_cancel_release_refresh',
    'action_journal_replay_corruption', 'electron_tile'];
  if (report.status === 'DONE' && (report.container_cleanup !== 'PASS'
      || report.process_cleanup?.status !== 'PASS' || report.process_cleanup?.temporary_tree_absent !== true
      || report.process_cleanup?.socket_absent !== true || report.ram_cleanup?.status !== 'PASS'
      || report.verify_verdict?.status !== 'verified' || report.verify_verdict?.receipt?.verified !== true
      || report.verify_negative_control?.status !== 'PASS'
      || report.verify_negative_control?.baseline?.verified !== true
      || report.verify_negative_control?.different_surface?.verified !== false
      || report.verify_negative_control?.stale_generation?.verified !== false
      || required.some(key => report.assertions?.[key] !== 'PASS'))) {
    throw new E2EError('E2E_LIVE', 'DONE requires every LIVE assertion and cleanup to pass');
  }
}
function hosted(externalScratch) {
  const scratch = externalScratch || makeScratch('mv-slice');
  try {
    const source = readFileSync(join(__dirname, 'scenario.rs'), 'utf8');
    const binary = compileRust(scratch, source);
    const stateA = JSON.parse(execFileSync(binary, [join(scratch, 'run-a'), '--full'],
      { env: buildEnv(), encoding: 'utf8' }));
    const stateB = JSON.parse(execFileSync(binary, [join(scratch, 'run-b'), '--full'],
      { env: buildEnv(), encoding: 'utf8' }));
    const rootA = join(scratch, 'run-a/sessions/session-1');
    const rootB = join(scratch, 'run-b/sessions/session-1');
    const journalAPath = join(rootA, 'journal.jsonl');
    const journalBPath = join(rootB, 'journal.jsonl');
    const journalA = readFileSync(journalAPath, 'utf8');
    const journalB = readFileSync(journalBPath, 'utf8');
    if (journalA !== journalB) throw new Error('E2E_REPLAY: journal bytes diverged across two runs');
    if (JSON.stringify(stateA) !== JSON.stringify(stateB)) {
      throw new Error('E2E_REPLAY: state diverged across two runs');
    }
    const a = replay(journalAPath, rootA).trim();
    const b = replay(journalBPath, rootB).trim();
    if (a !== b) throw new Error('E2E_REPLAY: digest diverged');
    const mutated = journalB.replace('"session-1"', '"session-2"');
    if (mutated === journalB) throw new Error('E2E_REPLAY: negative control mutation was a no-op');
    const corruptPath = join(rootB, 'journal.corrupt.jsonl');
    writeFileSync(corruptPath, mutated);
    let corruptThrew = false;
    try {
      replay(corruptPath, rootB);
    } catch (err) {
      corruptThrew = String(err.message || err).includes('E2E_REPLAY');
    }
    if (!corruptThrew) throw new Error('E2E_REPLAY: corrupted journal was not rejected');
    return { mode: 'hosted-core-only', digest: a, state: stateA };
  } finally {
    if (!externalScratch) removeScratch(scratch);
  }
}
module.exports = { hosted, requireLive, live, checkLiveResult };
if (require.main === module) {
  try {
    const result = process.argv.includes('--live') ? live() : hosted();
    console.log(JSON.stringify(result));
    if (result.status === 'BLOCKED') process.exitCode = 1;
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
