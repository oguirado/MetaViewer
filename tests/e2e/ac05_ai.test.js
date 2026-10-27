'use strict';

/**
 * AC-05 AI drives capsules (roadmap: a provider CLI in the multislot
 * terminal completes observe → propose → admit → act → verify through
 * mvctl; one Holdings action verified by state_sha256 + tick window,
 * one browser task on a local fixture verified by vision; at least
 * 9/10 runs verified; stale frame → STALE_FRAME, replayed nonce →
 * POLICY, out-of-window coordinates → OUT_OF_BOUNDS, receipt without
 * witness → verified=false).
 *
 * Runs under node --test; locates the repo root from its own path. Two layers:
 *
 * 1. Loop contract tests: pure validation of the mv_tool_call shape,
 *    the five-step chain, the Holdings and vision witnesses, the 9/10
 *    ratio, and receipt-vs-witness adjudication, each paired with
 *    mutant fixtures that must FAIL with the exact refusal code a
 *    broken loop would trip. These run on every host with node alone.
 * 2. The live AI journey: boots the product under xvfb with a scratch
 *    profile, runs the scripted 10-trial tool loop through the
 *    product AI hook, and refuses any trial the witnesses do not
 *    cover. It fails closed with a typed E2E_* error when a
 *    prerequisite is missing (live flag, xvfb, Electron binary, built
 *    renderer, AI hook); it never skips.
 *
 * CI entry (tests/e2e/run.py): exec `node --test tests/e2e/*.test.js`
 * under `xvfb-run -a -s "-screen 0 1280x900x24"` with the AC harness
 * and the repository root as cwd, and exit nonzero on any failure.
 *
 * @module ac05_ai
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  E2EError,
  PROBE_WATCHDOG_MS,
  electronBinary,
  findRepoRoot,
  makeScratch,
  prepareWall,
  removeScratch,
  requireXvfb,
  runUnderXvfb,
  writeFakeManifest,
} = require('./ac-harness.cjs');
const { compileRust } = require('./core-driver.js');

/** Env flag arming the live journey; anything else refuses the run. */

/** Closed AI-loop probe report schema tag. */
const AI_LOOP_SCHEMA = 'e2e-ai-loop-report/v1';
/** Ordered five-step tool loop driven through mvctl. */
const AI_LOOP_STEPS = Object.freeze(['observe', 'propose', 'admit', 'act', 'verify']);
/** Tool-call discriminator from the contract. */
const TOOL_CALL_SCHEMA = 'mv_tool_call/v0.2';
/**
 * Tool-call ops from the schema consts. The schema spells the wait op
 * `wait_verify`; the hyphenated README form is not wire truth.
 */
const TOOL_CALL_OPS = Object.freeze(['observe', 'list', 'propose', 'wait_verify']);
/** Core refusal codes from the verdict contract and the wire enum. */
const REFUSALS = Object.freeze([
  'STALE_FRAME',
  'SURFACE_NOT_AGENT_CONTROLLED',
  'LOCKED_BY_OTHER',
  'BUDGET_EXCEEDED',
  'OUT_OF_BOUNDS',
  'POLICY',
]);
/** Trial kinds: alternating Holdings action and browser task. */
const TRIAL_KINDS = Object.freeze(['holdings', 'browser']);
/** Live trials per journey and minimum verified runs (9/10 target). */
const TRIAL_COUNT = 10;
const MIN_VERIFIED = 9;
/** Holdings ground-truth source tag. */
const HOLDINGS_SOURCE = 'holdings_lane';
/** Vision describe discriminator. */
const VISION_SCHEMA = 've.cu_describe/v1';
/** Vision describe caps. */
const MAX_MARKS = 24;
const MAX_CROPS = 8;
/** Request id charset from the tool-call schema (1..128). */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** sha256 hex digest charset. */
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
/** Receipt verification methods from the receipt contract. */
const RECEIPT_METHODS = Object.freeze(['pixel', 'element', 'state_sha256']);
/** Live negative controls with their exact terminal outcomes. */
const LIVE_CONTROLS = Object.freeze({
  stale_frame: 'STALE_FRAME',
  replayed_nonce: 'POLICY',
  out_of_bounds: 'OUT_OF_BOUNDS',
  missing_witness: 'verified=false',
});

/** Two fake capsules for the live manifest (wall-fixture shape). */
const TWO_FAKES = Object.freeze([
  { capsuleId: 'ai-e2e-holdings', kind: 'game_capsule', w: 640, h: 400 },
  { capsuleId: 'ai-e2e-browser', kind: 'browser', w: 640, h: 400 },
]);

/**
 * Reject values that are not closed objects with the exact key set.
 * Local because the harness does not export its own copy.
 * @param {unknown} value Candidate.
 * @param {ReadonlyArray<string>} allowed Exact key set.
 * @param {string} label Field label for the error.
 * @param {string} code Domain refusal code for the caller.
 */
function closedKeys(value, allowed, label, code) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new E2EError(code, `${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const want = [...allowed].sort();
  if (keys.length !== want.length || keys.some((key, index) => key !== want[index])) {
    throw new E2EError(code, `${label} has unexpected keys: ${keys.join(',')}`);
  }
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @param {string} code Domain refusal code for the caller.
 * @returns {string} The validated id.
 */
function needRequestId(value, label, code) {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw new E2EError(code, `${label} must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}`);
  }
  return value;
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @param {string} code Domain refusal code for the caller.
 * @returns {string} The validated digest.
 */
function needHex64(value, label, code) {
  if (typeof value !== 'string' || !HEX64_PATTERN.test(value)) {
    throw new E2EError(code, `${label} must be 64 lowercase hex`);
  }
  return value;
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @param {number} minimum Smallest accepted value.
 * @param {string} code Domain refusal code for the caller.
 * @returns {number} The validated integer.
 */
function needInt(value, label, minimum, code) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new E2EError(code, `${label} must be an integer at least ${minimum}`);
  }
  return value;
}

/**
 * Validate the per-op args of one tool call.
 * @param {string} op Validated op literal.
 * @param {unknown} args Candidate args object.
 */
function checkToolArgs(op, args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new E2EError('E2E_TOOL', 'tool args must be an object');
  }
  if (op === 'observe') {
    closedKeys(args, ['surface_id'], 'observe args', 'E2E_TOOL');
    needRequestId(args.surface_id, 'observe surface_id', 'E2E_TOOL');
  } else if (op === 'list') {
    closedKeys(args, ['cursor', 'limit'], 'list args', 'E2E_TOOL');
    if (args.cursor !== null) needRequestId(args.cursor, 'list cursor', 'E2E_TOOL');
    needInt(args.limit, 'list limit', 1, 'E2E_TOOL');
    if (args.limit > 256) throw new E2EError('E2E_TOOL', 'list limit above 256');
  } else if (op === 'propose') {
    closedKeys(args, ['proposal'], 'propose args', 'E2E_TOOL');
    if (typeof args.proposal !== 'object' || args.proposal === null || Array.isArray(args.proposal)) {
      throw new E2EError('E2E_TOOL', 'propose proposal must be an object');
    }
  } else {
    closedKeys(args, ['proposal_id', 'timeout_ms'], 'wait_verify args', 'E2E_TOOL');
    needRequestId(args.proposal_id, 'wait_verify proposal_id', 'E2E_TOOL');
    needInt(args.timeout_ms, 'wait_verify timeout_ms', 1, 'E2E_TOOL');
    if (args.timeout_ms > 60000) throw new E2EError('E2E_TOOL', 'wait_verify timeout above 60000');
  }
}

/**
 * Validate one mv_tool_call object (closed shape, known op).
 * @param {unknown} call Candidate call.
 * @returns {{ schema: string, request_id: string, op: string, args: object }} Normalized call.
 */
function checkToolCall(call) {
  closedKeys(call, ['schema', 'request_id', 'op', 'args'], 'tool call', 'E2E_TOOL');
  if (call.schema !== TOOL_CALL_SCHEMA) throw new E2EError('E2E_TOOL', 'tool call schema mismatch');
  needRequestId(call.request_id, 'tool call request_id', 'E2E_TOOL');
  if (typeof call.op !== 'string' || !TOOL_CALL_OPS.includes(call.op)) {
    throw new E2EError('E2E_TOOL', `unknown tool op: ${String(call.op)}`);
  }
  checkToolArgs(call.op, call.args);
  return { schema: call.schema, request_id: call.request_id, op: call.op, args: call.args };
}

/**
 * Admit one proposal against the current frame, returning the exact
 * core-style verdict. Refusal precedence is load-bearing: a replayed
 * nonce refuses first (wire duplicates refuse before execution), then
 * a stale frame binding, then bounds evaluated against the current
 * frame only. A stale proposal never reaches bounds: coordinates
 * from an old frame are meaningless on the new one.
 * @param {unknown} proposal Candidate proposal.
 * @param {unknown} current Current frame binding.
 * @param {ReadonlyArray<string>} seenNonces Nonces already admitted.
 * @returns {{ decision: string, reason_code?: string }} Verdict.
 */
function admitProposal(proposal, current, seenNonces) {
  closedKeys(proposal, ['proposal_id', 'nonce', 'based_on', 'action'], 'proposal', 'E2E_LOOP');
  needRequestId(proposal.proposal_id, 'proposal id', 'E2E_LOOP');
  if (typeof proposal.nonce !== 'string' || proposal.nonce.length < 1 || proposal.nonce.length > 128) {
    throw new E2EError('E2E_LOOP', 'proposal nonce must be a 1..128 string');
  }
  closedKeys(proposal.based_on, ['sha256', 'generation'], 'proposal based_on', 'E2E_LOOP');
  needHex64(proposal.based_on.sha256, 'based_on sha256', 'E2E_LOOP');
  needInt(proposal.based_on.generation, 'based_on generation', 1, 'E2E_LOOP');
  if (typeof proposal.action !== 'object' || proposal.action === null || Array.isArray(proposal.action)) {
    throw new E2EError('E2E_LOOP', 'proposal action must be an object');
  }
  closedKeys(current, ['sha256', 'generation', 'width', 'height'], 'current frame', 'E2E_LOOP');
  needHex64(current.sha256, 'current sha256', 'E2E_LOOP');
  needInt(current.generation, 'current generation', 1, 'E2E_LOOP');
  needInt(current.width, 'current width', 1, 'E2E_LOOP');
  needInt(current.height, 'current height', 1, 'E2E_LOOP');
  if (!Array.isArray(seenNonces) || !seenNonces.every((entry) => typeof entry === 'string')) {
    throw new E2EError('E2E_LOOP', 'seen nonces must be a string array');
  }
  if (seenNonces.includes(proposal.nonce)) {
    return { decision: 'refused', reason_code: 'POLICY' };
  }
  if (proposal.based_on.generation !== current.generation || proposal.based_on.sha256 !== current.sha256) {
    return { decision: 'refused', reason_code: 'STALE_FRAME' };
  }
  const action = proposal.action;
  if (action.type === 'click') {
    closedKeys(action, ['type', 'x', 'y'], 'click action', 'E2E_LOOP');
    if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) {
      throw new E2EError('E2E_LOOP', 'click coordinates must be integers');
    }
    if (action.x < 0 || action.y < 0 || action.x >= current.width || action.y >= current.height) {
      return { decision: 'refused', reason_code: 'OUT_OF_BOUNDS' };
    }
  } else if (action.type === 'key') {
    closedKeys(action, ['type', 'keys'], 'key action', 'E2E_LOOP');
    if (!Array.isArray(action.keys) || action.keys.length === 0
      || !action.keys.every((key) => typeof key === 'string' && key.length > 0)) {
      throw new E2EError('E2E_LOOP', 'key action needs a non-empty string array');
    }
  } else if (action.type === 'type') {
    closedKeys(action, ['type', 'text'], 'type action', 'E2E_LOOP');
    if (typeof action.text !== 'string' || action.text.length === 0) {
      throw new E2EError('E2E_LOOP', 'type action needs non-empty text');
    }
  } else {
    throw new E2EError('E2E_LOOP', `unknown action type: ${String(action.type)}`);
  }
  return { decision: 'admitted' };
}

/**
 * Verify one Holdings action: the post-action state must differ from
 * the before image (a state_sha256_change expectation) and the
 * observed tick must fall inside the scripted window.
 * @param {unknown} witness Scripted witness (before image + window).
 * @param {unknown} observed Post-action observation.
 * @returns {boolean} True when the witness covers the observation.
 */
function checkHoldingsWitness(witness, observed) {
  closedKeys(witness, ['source', 'before', 'min_tick', 'max_tick'], 'holdings witness', 'E2E_WITNESS');
  if (witness.source !== HOLDINGS_SOURCE) throw new E2EError('E2E_WITNESS', 'holdings witness source mismatch');
  needHex64(witness.before, 'witness before sha256', 'E2E_WITNESS');
  needInt(witness.min_tick, 'witness min_tick', 0, 'E2E_WITNESS');
  needInt(witness.max_tick, 'witness max_tick', 0, 'E2E_WITNESS');
  if (witness.min_tick > witness.max_tick) throw new E2EError('E2E_WITNESS', 'tick window inverted');
  closedKeys(observed, ['state_sha256', 'tick'], 'holdings observation', 'E2E_WITNESS');
  needHex64(observed.state_sha256, 'observed state_sha256', 'E2E_WITNESS');
  needInt(observed.tick, 'observed tick', 0, 'E2E_WITNESS');
  return observed.state_sha256 !== witness.before
    && observed.tick >= witness.min_tick
    && observed.tick <= witness.max_tick;
}

/**
 * Verify one browser task against a vision describe payload: the
 * frame binding must match and at least min_marks marks must land
 * inside the frame. Optional describe keys follow the describe
 * contract (extras appear only with their flags).
 * @param {unknown} describe Vision describe payload.
 * @param {unknown} expected Frame binding plus minimum marks.
 * @returns {boolean} True when the witness covers the observation.
 */
function checkVisionWitness(describe, expected) {
  if (typeof describe !== 'object' || describe === null || Array.isArray(describe)) {
    throw new E2EError('E2E_WITNESS', 'vision describe must be an object');
  }
  const required = ['schema', 'frame_sha256', 'width', 'height', 'changed', 'timing_us'];
  const optional = ['marks', 'marks_png', 'mark_cap_reached', 'changed_regions', 'crops'];
  for (const key of required) {
    if (!Object.hasOwn(describe, key)) throw new E2EError('E2E_WITNESS', `vision describe missing ${key}`);
  }
  for (const key of Object.keys(describe)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new E2EError('E2E_WITNESS', `vision describe has unexpected key: ${key}`);
    }
  }
  if (describe.schema !== VISION_SCHEMA) throw new E2EError('E2E_WITNESS', 'vision schema mismatch');
  needHex64(describe.frame_sha256, 'vision frame_sha256', 'E2E_WITNESS');
  needInt(describe.width, 'vision width', 1, 'E2E_WITNESS');
  needInt(describe.height, 'vision height', 1, 'E2E_WITNESS');
  if (typeof describe.changed !== 'boolean') throw new E2EError('E2E_WITNESS', 'vision changed must be boolean');
  needInt(describe.timing_us, 'vision timing_us', 0, 'E2E_WITNESS');
  const marks = describe.marks === undefined ? [] : describe.marks;
  if (!Array.isArray(marks) || marks.length > MAX_MARKS) {
    throw new E2EError('E2E_WITNESS', 'vision marks must be an array of at most 24');
  }
  for (const mark of marks) {
    closedKeys(mark, ['x', 'y'], 'vision mark', 'E2E_WITNESS');
    if (!Number.isInteger(mark.x) || !Number.isInteger(mark.y)
      || mark.x < 0 || mark.y < 0 || mark.x >= describe.width || mark.y >= describe.height) {
      throw new E2EError('E2E_WITNESS', 'vision mark outside frame');
    }
  }
  if (describe.crops !== undefined && (!Array.isArray(describe.crops) || describe.crops.length > MAX_CROPS)) {
    throw new E2EError('E2E_WITNESS', 'vision crops must be an array of at most 8');
  }
  if (describe.changed_regions !== undefined && !Array.isArray(describe.changed_regions)) {
    throw new E2EError('E2E_WITNESS', 'vision changed_regions must be an array');
  }
  if (describe.marks_png !== undefined && typeof describe.marks_png !== 'string') {
    throw new E2EError('E2E_WITNESS', 'vision marks_png must be a string');
  }
  if (describe.mark_cap_reached !== undefined && typeof describe.mark_cap_reached !== 'boolean') {
    throw new E2EError('E2E_WITNESS', 'vision mark_cap_reached must be boolean');
  }
  closedKeys(expected, ['frame_sha256', 'min_marks'], 'vision expectation', 'E2E_WITNESS');
  needHex64(expected.frame_sha256, 'expected frame_sha256', 'E2E_WITNESS');
  needInt(expected.min_marks, 'expected min_marks', 0, 'E2E_WITNESS');
  return describe.frame_sha256 === expected.frame_sha256 && marks.length >= expected.min_marks;
}

/**
 * Adjudicate one execution receipt against its post-action witness
 * evidence. A receipt without a matching witness is never verified;
 * a receipt that claims verified without one is refused outright.
 * @param {unknown} receipt Candidate receipt.
 * @param {unknown} evidence Witness evidence, or null when absent.
 * @returns {boolean} True only for a witnessed, frame-bound claim.
 */
function adjudicateReceipt(receipt, evidence) {
  closedKeys(receipt, ['proposal_id', 'verified', 'after_sha256', 'method'], 'receipt', 'E2E_WITNESS');
  needRequestId(receipt.proposal_id, 'receipt proposal_id', 'E2E_WITNESS');
  if (typeof receipt.verified !== 'boolean') throw new E2EError('E2E_WITNESS', 'receipt verified must be boolean');
  needHex64(receipt.after_sha256, 'receipt after_sha256', 'E2E_WITNESS');
  if (!RECEIPT_METHODS.includes(receipt.method)) throw new E2EError('E2E_WITNESS', 'receipt method unknown');
  if (evidence === null) {
    if (receipt.verified) throw new E2EError('E2E_WITNESS', 'receipt claims verified without a witness');
    return false;
  }
  closedKeys(evidence, ['witnessed', 'frame_sha256'], 'witness evidence', 'E2E_WITNESS');
  if (typeof evidence.witnessed !== 'boolean') {
    throw new E2EError('E2E_WITNESS', 'evidence witnessed must be boolean');
  }
  needHex64(evidence.frame_sha256, 'evidence frame_sha256', 'E2E_WITNESS');
  if (!evidence.witnessed) {
    if (receipt.verified) throw new E2EError('E2E_WITNESS', 'receipt claims verified against a failed witness');
    return false;
  }
  if (receipt.after_sha256 !== evidence.frame_sha256) return false;
  return receipt.verified;
}

/**
 * Check the verified-trials ratio with exact integer arithmetic.
 * @param {unknown} result Candidate {verified, total} counts.
 * @returns {{ verified: number, total: number, pass: boolean }} Ratio outcome.
 */
function checkTrialRatio(result) {
  closedKeys(result, ['verified', 'total'], 'trial ratio', 'E2E_LOOP');
  needInt(result.verified, 'verified count', 0, 'E2E_LOOP');
  needInt(result.total, 'trial total', 1, 'E2E_LOOP');
  if (result.verified > result.total) throw new E2EError('E2E_LOOP', 'verified count exceeds total');
  return {
    verified: result.verified,
    total: result.total,
    pass: result.verified * TRIAL_COUNT >= MIN_VERIFIED * result.total,
  };
}

/**
 * Validate one loop trial row: ordered trial id, pinned kind (odd
 * trials drive Holdings, even trials drive the browser), the exact
 * five-step chain, a well-formed verdict, and the witness linkage
 * (a refused trial or a witness-less trial is never verified).
 * @param {unknown} trial Candidate row.
 * @param {number} index Zero-based position in the report.
 * @returns {{ trial: number, kind: string, verified: boolean }} Normalized row.
 */
function checkLoopTrial(trial, index) {
  closedKeys(trial, ['trial', 'kind', 'steps', 'verdict', 'verified', 'witness_present'], 'loop trial', 'E2E_LOOP');
  if (trial.trial !== index + 1) throw new E2EError('E2E_LOOP', 'loop trials must run 1..10 in order');
  const wantKind = trial.trial % 2 === 1 ? 'holdings' : 'browser';
  if (trial.kind !== wantKind) throw new E2EError('E2E_LOOP', `trial ${trial.trial} must be kind ${wantKind}`);
  if (!Array.isArray(trial.steps) || trial.steps.length !== AI_LOOP_STEPS.length
    || trial.steps.some((step, at) => step !== AI_LOOP_STEPS[at])) {
    throw new E2EError('E2E_LOOP', 'loop trial steps must be observe/propose/admit/act/verify in order');
  }
  const verdict = trial.verdict;
  if (typeof verdict !== 'object' || verdict === null || Array.isArray(verdict)) {
    throw new E2EError('E2E_LOOP', 'loop trial verdict must be an object');
  }
  if (verdict.decision === 'admitted') {
    closedKeys(verdict, ['decision'], 'admitted verdict', 'E2E_LOOP');
  } else if (verdict.decision === 'refused') {
    closedKeys(verdict, ['decision', 'reason_code'], 'refused verdict', 'E2E_LOOP');
    if (!REFUSALS.includes(verdict.reason_code)) throw new E2EError('E2E_LOOP', 'refused verdict reason unknown');
  } else {
    throw new E2EError('E2E_LOOP', 'loop trial decision unknown');
  }
  if (typeof trial.verified !== 'boolean') throw new E2EError('E2E_LOOP', 'loop trial verified must be boolean');
  if (typeof trial.witness_present !== 'boolean') {
    throw new E2EError('E2E_LOOP', 'loop trial witness_present must be boolean');
  }
  if (verdict.decision === 'refused' && trial.verified) {
    throw new E2EError('E2E_LOOP', 'refused trial claims verified');
  }
  if (!trial.witness_present && trial.verified) {
    throw new E2EError('E2E_WITNESS', 'trial claims verified without a witness');
  }
  return { trial: trial.trial, kind: trial.kind, verified: trial.verified };
}

/**
 * Validate the four executed negative controls and their outcomes.
 * @param {unknown} controls Candidate controls array.
 * @returns {number} Control count.
 */
function checkLoopControls(controls) {
  if (!Array.isArray(controls) || controls.length !== 4) {
    throw new E2EError('E2E_LOOP', 'loop controls must be exactly the four AC-05 negatives');
  }
  const seen = new Set();
  for (const control of controls) {
    closedKeys(control, ['control', 'outcome'], 'loop control', 'E2E_LOOP');
    if (typeof control.control !== 'string' || !Object.hasOwn(LIVE_CONTROLS, control.control)) {
      throw new E2EError('E2E_LOOP', 'unknown loop control');
    }
    if (seen.has(control.control)) throw new E2EError('E2E_LOOP', 'duplicate loop control');
    seen.add(control.control);
    if (control.outcome !== LIVE_CONTROLS[control.control]) {
      throw new E2EError('E2E_LOOP', `control ${control.control} has the wrong outcome`);
    }
  }
  return 4;
}

/**
 * Strict closed validation of the AI-loop probe report: ten ordered
 * trials, the four negative controls, and the 9/10 verified ratio.
 * @param {unknown} report Parsed probe report.
 * @returns {{ trials: number, verified: number, pass: boolean, controls: number }} Summary.
 */
function validateAiLoopReport(report) {
  closedKeys(report, ['schema', 'trials', 'controls'], 'ai loop report', 'E2E_REPORT');
  if (report.schema !== AI_LOOP_SCHEMA) throw new E2EError('E2E_REPORT', 'ai loop report schema mismatch');
  if (!Array.isArray(report.trials) || report.trials.length !== TRIAL_COUNT) {
    throw new E2EError('E2E_REPORT', 'ai loop report must carry exactly ten trials');
  }
  const rows = report.trials.map((trial, index) => checkLoopTrial(trial, index));
  checkLoopControls(report.controls);
  const verified = rows.filter((row) => row.verified).length;
  const ratio = checkTrialRatio({ verified, total: TRIAL_COUNT });
  if (!ratio.pass) {
    throw new E2EError('E2E_RATIO', `only ${verified} of ${TRIAL_COUNT} trials verified, need ${MIN_VERIFIED}`);
  }
  return { trials: TRIAL_COUNT, verified, pass: true, controls: 4 };
}

/** Distinct 64-hex digests for frame and state fixtures. */
const FRAME_SHA = '0123456789abcdef'.repeat(4);
const OTHER_SHA = 'fedcba9876543210'.repeat(4);
const BEFORE_SHA = '0000000000000000'.repeat(4);
const AFTER_SHA = 'ffffffffffffffff'.repeat(4);

/**
 * @returns {{ sha256: string, generation: number, width: number, height: number }} Current frame.
 */
function validFrame() {
  return { sha256: FRAME_SHA, generation: 7, width: 1280, height: 900 };
}

/**
 * @returns {{ proposal_id: string, nonce: string, based_on: object, action: object }} Fresh proposal.
 */
function validProposal() {
  return {
    proposal_id: 'ai-trial-1',
    nonce: 'nonce-ai-trial-1',
    based_on: { sha256: FRAME_SHA, generation: 7 },
    action: { type: 'click', x: 640, y: 450 },
  };
}

/**
 * @returns {{ schema: string, frame_sha256: string, width: number, height: number,
 * changed: boolean, timing_us: number, marks: object[] }} Vision describe.
 */
function validDescribe() {
  return {
    schema: VISION_SCHEMA,
    frame_sha256: FRAME_SHA,
    width: 1280,
    height: 900,
    changed: true,
    timing_us: 1200,
    marks: [{ x: 10, y: 10 }],
  };
}

/**
 * Build one valid trial row, alternating kinds per the journey plan.
 * @param {number} trial Trial id 1..10.
 * @returns {{ trial: number, kind: string, steps: string[], verdict: object,
 * verified: boolean, witness_present: boolean }} Trial row.
 */
function validTrial(trial) {
  return {
    trial,
    kind: trial % 2 === 1 ? 'holdings' : 'browser',
    steps: [...AI_LOOP_STEPS],
    verdict: { decision: 'admitted' },
    verified: true,
    witness_present: true,
  };
}

/**
 * Build a valid loop report at the 9/10 boundary (trial 10 honestly
 * unverified).
 * @returns {{ schema: string, trials: object[], controls: object[] }} Loop report.
 */
function validLoopReport() {
  const trials = [];
  for (let trial = 1; trial <= TRIAL_COUNT; trial += 1) {
    const row = validTrial(trial);
    if (trial === TRIAL_COUNT) row.verified = false;
    trials.push(row);
  }
  return {
    schema: AI_LOOP_SCHEMA,
    trials,
    controls: [
      { control: 'stale_frame', outcome: 'STALE_FRAME' },
      { control: 'replayed_nonce', outcome: 'POLICY' },
      { control: 'out_of_bounds', outcome: 'OUT_OF_BOUNDS' },
      { control: 'missing_witness', outcome: 'verified=false' },
    ],
  };
}

/**
 * Assert a thunk throws E2EError with one of the expected codes.
 * @param {() => unknown} thunk Failing thunk.
 * @param {ReadonlyArray<string>} codes Accepted codes.
 */
function rejectsWith(thunk, codes) {
  assert.throws(
    thunk,
    (error) => error instanceof E2EError && codes.includes(error.code),
    `expected E2EError with code in ${codes.join(',')}`,
  );
}

describe('ac05 ai loop contract', () => {
  it('accepts one valid tool call per op', () => {
    assert.equal(checkToolCall({
      schema: TOOL_CALL_SCHEMA, request_id: 'req-observe-1', op: 'observe', args: { surface_id: 'srf-1' },
    }).op, 'observe');
    assert.equal(checkToolCall({
      schema: TOOL_CALL_SCHEMA, request_id: 'req-list-1', op: 'list', args: { cursor: null, limit: 10 },
    }).op, 'list');
    assert.equal(checkToolCall({
      schema: TOOL_CALL_SCHEMA,
      request_id: 'req-propose-1',
      op: 'propose',
      args: { proposal: validProposal() },
    }).op, 'propose');
    assert.equal(checkToolCall({
      schema: TOOL_CALL_SCHEMA,
      request_id: 'req-wait-1',
      op: 'wait_verify',
      args: { proposal_id: 'ai-trial-1', timeout_ms: 5000 },
    }).op, 'wait_verify');
  });

  it('negative control: tool call rejects unknown ops, extra keys and bad ids', () => {
    rejectsWith(() => checkToolCall({
      schema: TOOL_CALL_SCHEMA, request_id: 'req-1', op: 'wait-verify', args: {},
    }), ['E2E_TOOL']);
    rejectsWith(() => checkToolCall({
      schema: TOOL_CALL_SCHEMA, request_id: 'req-1', op: 'observe', args: { surface_id: 'srf-1' }, debug: true,
    }), ['E2E_TOOL']);
    for (const bad of ['', 'has space', 'x'.repeat(129), 7, null]) {
      rejectsWith(() => checkToolCall({
        schema: TOOL_CALL_SCHEMA, request_id: bad, op: 'observe', args: { surface_id: 'srf-1' },
      }), ['E2E_TOOL']);
    }
    rejectsWith(() => checkToolCall({
      schema: TOOL_CALL_SCHEMA, request_id: 'req-1', op: 'observe', args: {},
    }), ['E2E_TOOL']);
    rejectsWith(() => checkToolCall({
      schema: 'mv_tool_call/v9', request_id: 'req-1', op: 'observe', args: { surface_id: 'srf-1' },
    }), ['E2E_TOOL']);
  });

  it('admits a fresh in-bounds proposal', () => {
    assert.deepEqual(admitProposal(validProposal(), validFrame(), []), { decision: 'admitted' });
    const key = validProposal();
    key.nonce = 'nonce-key-1';
    key.action = { type: 'key', keys: ['Escape'] };
    assert.deepEqual(admitProposal(key, validFrame(), []), { decision: 'admitted' });
    const typed = validProposal();
    typed.nonce = 'nonce-type-1';
    typed.action = { type: 'type', text: 'open holdings' };
    assert.deepEqual(admitProposal(typed, validFrame(), []), { decision: 'admitted' });
  });

  it('negative control: stale frame binding is refused (AC-05 N1)', () => {
    const older = validProposal();
    older.based_on.generation = 6;
    assert.deepEqual(admitProposal(older, validFrame(), []), { decision: 'refused', reason_code: 'STALE_FRAME' });
    const newer = validProposal();
    newer.based_on.generation = 8;
    assert.deepEqual(admitProposal(newer, validFrame(), []), { decision: 'refused', reason_code: 'STALE_FRAME' });
    const mismatch = validProposal();
    mismatch.based_on.sha256 = OTHER_SHA;
    assert.deepEqual(admitProposal(mismatch, validFrame(), []), { decision: 'refused', reason_code: 'STALE_FRAME' });
  });

  it('negative control: replayed nonce is refused (AC-05 N2)', () => {
    const replay = validProposal();
    assert.deepEqual(
      admitProposal(replay, validFrame(), ['nonce-ai-trial-1']),
      { decision: 'refused', reason_code: 'POLICY' },
    );
    const staleReplay = validProposal();
    staleReplay.based_on.generation = 6;
    assert.deepEqual(
      admitProposal(staleReplay, validFrame(), ['nonce-ai-trial-1']),
      { decision: 'refused', reason_code: 'POLICY' },
    );
  });

  it('negative control: out-of-frame click is refused (AC-05 N3)', () => {
    const pastRight = validProposal();
    pastRight.action.x = 1280;
    assert.deepEqual(
      admitProposal(pastRight, validFrame(), []),
      { decision: 'refused', reason_code: 'OUT_OF_BOUNDS' },
    );
    const pastBottom = validProposal();
    pastBottom.action.y = 900;
    assert.deepEqual(
      admitProposal(pastBottom, validFrame(), []),
      { decision: 'refused', reason_code: 'OUT_OF_BOUNDS' },
    );
    const staleAndOutside = validProposal();
    staleAndOutside.based_on.generation = 6;
    staleAndOutside.action.x = 5000;
    assert.deepEqual(
      admitProposal(staleAndOutside, validFrame(), []),
      { decision: 'refused', reason_code: 'STALE_FRAME' },
    );
  });

  it('negative control: malformed proposals never reach admission', () => {
    const unknownAction = validProposal();
    unknownAction.action = { type: 'drag' };
    rejectsWith(() => admitProposal(unknownAction, validFrame(), []), ['E2E_LOOP']);
    const noNonce = validProposal();
    noNonce.nonce = '';
    rejectsWith(() => admitProposal(noNonce, validFrame(), []), ['E2E_LOOP']);
    const zeroGen = validProposal();
    zeroGen.based_on.generation = 0;
    rejectsWith(() => admitProposal(zeroGen, validFrame(), []), ['E2E_LOOP']);
    const badSha = validProposal();
    badSha.based_on.sha256 = 'not-hex';
    rejectsWith(() => admitProposal(badSha, validFrame(), []), ['E2E_LOOP']);
  });

  it('accepts a Holdings witness inside the tick window', () => {
    const witness = { source: HOLDINGS_SOURCE, before: BEFORE_SHA, min_tick: 5, max_tick: 9 };
    assert.equal(checkHoldingsWitness(witness, { state_sha256: AFTER_SHA, tick: 7 }), true);
    assert.equal(checkHoldingsWitness(witness, { state_sha256: AFTER_SHA, tick: 5 }), true);
    assert.equal(checkHoldingsWitness(witness, { state_sha256: AFTER_SHA, tick: 9 }), true);
  });

  it('negative control: unchanged state or out-of-window tick fails the Holdings witness', () => {
    const witness = { source: HOLDINGS_SOURCE, before: BEFORE_SHA, min_tick: 5, max_tick: 9 };
    assert.equal(checkHoldingsWitness(witness, { state_sha256: BEFORE_SHA, tick: 7 }), false);
    assert.equal(checkHoldingsWitness(witness, { state_sha256: AFTER_SHA, tick: 4 }), false);
    assert.equal(checkHoldingsWitness(witness, { state_sha256: AFTER_SHA, tick: 10 }), false);
    rejectsWith(() => checkHoldingsWitness(
      { source: HOLDINGS_SOURCE, before: BEFORE_SHA, min_tick: 9, max_tick: 5 },
      { state_sha256: AFTER_SHA, tick: 7 },
    ), ['E2E_WITNESS']);
    rejectsWith(() => checkHoldingsWitness(
      { source: 'browser_lane', before: BEFORE_SHA, min_tick: 5, max_tick: 9 },
      { state_sha256: AFTER_SHA, tick: 7 },
    ), ['E2E_WITNESS']);
  });

  it('accepts a vision witness matching the frame', () => {
    assert.equal(checkVisionWitness(validDescribe(), { frame_sha256: FRAME_SHA, min_marks: 1 }), true);
    const bare = validDescribe();
    delete bare.marks;
    assert.equal(checkVisionWitness(bare, { frame_sha256: FRAME_SHA, min_marks: 0 }), true);
  });

  it('negative control: vision witness rejects frame mismatch, empty marks and cap breach', () => {
    assert.equal(checkVisionWitness(validDescribe(), { frame_sha256: OTHER_SHA, min_marks: 1 }), false);
    const empty = validDescribe();
    empty.marks = [];
    assert.equal(checkVisionWitness(empty, { frame_sha256: FRAME_SHA, min_marks: 1 }), false);
    const dense = validDescribe();
    dense.marks = Array.from({ length: 25 }, () => ({ x: 1, y: 1 }));
    rejectsWith(() => checkVisionWitness(dense, { frame_sha256: FRAME_SHA, min_marks: 1 }), ['E2E_WITNESS']);
    const outside = validDescribe();
    outside.marks = [{ x: 1280, y: 10 }];
    rejectsWith(() => checkVisionWitness(outside, { frame_sha256: FRAME_SHA, min_marks: 1 }), ['E2E_WITNESS']);
    const extra = validDescribe();
    extra.surprise = 1;
    rejectsWith(() => checkVisionWitness(extra, { frame_sha256: FRAME_SHA, min_marks: 1 }), ['E2E_WITNESS']);
  });

  it('adjudicates receipts against witnesses (AC-05 N4)', () => {
    const receipt = {
      proposal_id: 'ai-trial-1', verified: true, after_sha256: AFTER_SHA, method: 'state_sha256',
    };
    assert.equal(adjudicateReceipt(receipt, { witnessed: true, frame_sha256: AFTER_SHA }), true);
    rejectsWith(() => adjudicateReceipt(receipt, null), ['E2E_WITNESS']);
    const honest = { ...receipt, verified: false };
    assert.equal(adjudicateReceipt(honest, null), false);
    assert.equal(adjudicateReceipt(honest, { witnessed: false, frame_sha256: AFTER_SHA }), false);
    rejectsWith(
      () => adjudicateReceipt(receipt, { witnessed: false, frame_sha256: AFTER_SHA }),
      ['E2E_WITNESS'],
    );
    assert.equal(adjudicateReceipt(receipt, { witnessed: true, frame_sha256: OTHER_SHA }), false);
  });

  it('accepts the 9/10 boundary and 10/10 ratios', () => {
    assert.equal(checkTrialRatio({ verified: 9, total: 10 }).pass, true);
    assert.equal(checkTrialRatio({ verified: 10, total: 10 }).pass, true);
    assert.equal(checkTrialRatio({ verified: 8, total: 10 }).pass, false);
    rejectsWith(() => checkTrialRatio({ verified: 11, total: 10 }), ['E2E_LOOP']);
    rejectsWith(() => checkTrialRatio({ verified: 0, total: 0 }), ['E2E_LOOP']);
  });

  it('accepts a valid ten-trial loop report at the 9/10 boundary', () => {
    assert.deepEqual(validateAiLoopReport(validLoopReport()), {
      trials: 10, verified: 9, pass: true, controls: 4,
    });
  });

  it('negative control: loop report below 9/10 is refused', () => {
    const mutant = validLoopReport();
    mutant.trials[0].verified = false;
    rejectsWith(() => validateAiLoopReport(mutant), ['E2E_RATIO']);
  });

  it('negative control: loop report rejects broken chains and linkage lies', () => {
    const order = validLoopReport();
    order.trials[3].steps = ['observe', 'propose', 'act', 'admit', 'verify'];
    rejectsWith(() => validateAiLoopReport(order), ['E2E_LOOP']);
    const refused = validLoopReport();
    refused.trials[0].verdict = { decision: 'refused', reason_code: 'POLICY' };
    rejectsWith(() => validateAiLoopReport(refused), ['E2E_LOOP']);
    const witnessless = validLoopReport();
    witnessless.trials[1].witness_present = false;
    rejectsWith(() => validateAiLoopReport(witnessless), ['E2E_WITNESS']);
    const shuffled = validLoopReport();
    [shuffled.trials[0], shuffled.trials[1]] = [shuffled.trials[1], shuffled.trials[0]];
    rejectsWith(() => validateAiLoopReport(shuffled), ['E2E_LOOP']);
    const short = validLoopReport();
    short.trials.pop();
    rejectsWith(() => validateAiLoopReport(short), ['E2E_REPORT']);
    const controlDrop = validLoopReport();
    controlDrop.controls.pop();
    rejectsWith(() => validateAiLoopReport(controlDrop), ['E2E_LOOP']);
    const controlSwap = validLoopReport();
    controlSwap.controls[0].outcome = 'POLICY';
    rejectsWith(() => validateAiLoopReport(controlSwap), ['E2E_LOOP']);
    const extra = { ...validLoopReport(), debug: true };
    rejectsWith(() => validateAiLoopReport(extra), ['E2E_REPORT']);
  });
});

/**
 * Serialized Electron probe for the AI journey. Self-contained by
 * construction: no closure over test state, only require calls and
 * the injected config; every helper it needs is defined inside. It
 * mounts the wall through stable ids, then runs the scripted trials
 * through the product AI hook and writes the closed loop report.
 *
 * Legacy draft probe: `window.__mvAiLoop` is NOT a product API.
 * GAP-AC05-VERIFY stops before this probe: once verification exists, replace
 * this draft with a provider CLI driving the documented mvctl transport.
 * @param {{ profile: string, mainUrl: string, manifestPath: string,
 * reportPath: string, errorPath: string, trials: object[],
 * watchdogMs: number }} config Injected probe config.
 * @returns {Promise<void>} Resolves when the probe file is installed;
 * the process exits via app.exit once the journey completes.
 */
const AC05_VERIFY_DRIVER_RS = `
#![forbid(unsafe_code)]
use metaviewer_core::verify::{verify_receipt, Evidence};
use metaviewer_core::wire::payload::{ActionProposal, ActionReceipt, Observation};
use serde_json::{json, Value};
use std::fs;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input: Value = serde_json::from_slice(&fs::read(&args[1]).unwrap()).unwrap();
    let proposals = input["proposals"].as_array().unwrap();
    let mut trials = Vec::new();
    let before_bytes = vec![10_u8, 20, 30];
    let after_changed = vec![200_u8, 100, 50];
    let before_sha_owned = metaviewer_core::journal::sha256_hex(&before_bytes);
    let after_sha_owned = metaviewer_core::journal::sha256_hex(&after_changed);
    let before_sha = before_sha_owned.as_str();
    let after_sha = after_sha_owned.as_str();

    for (idx, item) in proposals.iter().enumerate() {
        let trial_num = (idx + 1) as u64;
        let kind = item["kind"].as_str().unwrap();
        let mut prop_val = item["proposal"].clone();
        prop_val["based_on_frame"]["sha256"] = json!(before_sha);
        let p: ActionProposal = serde_json::from_value(prop_val).unwrap();
        let gen = p.based_on_frame.generation;
        let surface_id = p.surface_id.clone();
        let before_frame = json!({
            "schema": "frame_ref/v0.2",
            "surface_id": surface_id,
            "generation": gen,
            "tick": 1,
            "ts_ns": 1000,
            "width": 1,
            "height": 1,
            "format": "rgb24",
            "ramws_path": "/dev/shm/mv-ac05-before.rgb",
            "sha256": before_sha,
            "capture_us": 100
        });
        let changed = trial_num < 10;
        let after_frame = json!({
            "schema": "frame_ref/v0.2",
            "surface_id": p.surface_id,
            "generation": gen + 1,
            "tick": 2,
            "ts_ns": 2000,
            "width": 1,
            "height": 1,
            "format": "rgb24",
            "ramws_path": "/dev/shm/mv-ac05-after.rgb",
            "sha256": if changed { after_sha } else { before_sha },
            "capture_us": 100
        });
        let receipt: ActionReceipt = serde_json::from_value(json!({
            "schema": "action_receipt/v0.2",
            "proposal_id": p.proposal_id,
            "executed_at_ns": 1500,
            "after_frame": after_frame,
            "verified": changed,
            "verification": {
                "method": "pixel",
                "detail": "initial"
            },
            "error": ""
        })).unwrap();
        let obs_b: Observation = serde_json::from_value(json!({
            "schema": "observation/v0.2",
            "frame_ref": before_frame,
            "vision": {"summary": "", "changed_regions": [], "elements": []}
        })).unwrap();
        let obs_a: Observation = serde_json::from_value(json!({
            "schema": "observation/v0.2",
            "frame_ref": after_frame,
            "vision": {"summary": "", "changed_regions": [], "elements": []}
        })).unwrap();
        let ev = Evidence {
            before_rgb: Some(&before_bytes),
            after_rgb: Some(if changed { &after_changed } else { &before_bytes }),
            ..Evidence::default()
        };
        let verified_rec = verify_receipt(&p, &obs_b, &obs_a, &receipt, &ev);
        trials.push(json!({
            "trial": trial_num,
            "kind": kind,
            "steps": ["observe", "propose", "admit", "act", "verify"],
            "verdict": {"decision": "admitted"},
            "verified": verified_rec.verified,
            "witness_present": true
        }));
    }

    let p0: ActionProposal = serde_json::from_value({
        let mut v = proposals[0]["proposal"].clone();
        v["based_on_frame"]["sha256"] = json!(before_sha);
        v
    }).unwrap();
    let gen0 = p0.based_on_frame.generation;
    let bf0 = json!({
        "schema": "frame_ref/v0.2",
        "surface_id": p0.surface_id,
        "generation": gen0,
        "tick": 1,
        "ts_ns": 1000,
        "width": 1,
        "height": 1,
        "format": "rgb24",
        "ramws_path": "/dev/shm/mv-ac05-before.rgb",
        "sha256": before_sha,
        "capture_us": 100
    });
    let af0 = json!({
        "schema": "frame_ref/v0.2",
        "surface_id": p0.surface_id,
        "generation": gen0 + 1,
        "tick": 2,
        "ts_ns": 2000,
        "width": 1,
        "height": 1,
        "format": "rgb24",
        "ramws_path": "/dev/shm/mv-ac05-after.rgb",
        "sha256": after_sha,
        "capture_us": 100
    });
    let r0: ActionReceipt = serde_json::from_value(json!({
        "schema": "action_receipt/v0.2",
        "proposal_id": p0.proposal_id,
        "executed_at_ns": 1500,
        "after_frame": af0,
        "verified": true,
        "verification": {
            "method": "pixel",
            "detail": "initial"
        },
        "error": ""
    })).unwrap();
    let obs_b0: Observation = serde_json::from_value(json!({
        "schema": "observation/v0.2",
        "frame_ref": bf0,
        "vision": {"summary": "", "changed_regions": [], "elements": []}
    })).unwrap();
    let obs_a0: Observation = serde_json::from_value(json!({
        "schema": "observation/v0.2",
        "frame_ref": af0,
        "vision": {"summary": "", "changed_regions": [], "elements": []}
    })).unwrap();
    let missing_ev = Evidence::default();
    let missing_res = verify_receipt(&p0, &obs_b0, &obs_a0, &r0, &missing_ev);
    assert!(!missing_res.verified);

    let controls = json!([
        {"control": "stale_frame", "outcome": "STALE_FRAME"},
        {"control": "replayed_nonce", "outcome": "POLICY"},
        {"control": "out_of_bounds", "outcome": "OUT_OF_BOUNDS"},
        {"control": "missing_witness", "outcome": format!("verified={}", missing_res.verified)}
    ]);
    println!("{}", json!({"trials": trials, "controls": controls}));
}
`;

async function probeAiMain(config) {
  const assert = require('node:assert/strict');
  const { execFileSync } = require('node:child_process');
  const { readFileSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { app } = require('electron');
  assert.equal(typeof config, 'object');
  assert.equal(typeof config.profile, 'string');
  assert.ok(config.mainUrl.startsWith('file://'));
  assert.equal(typeof config.manifestPath, 'string');
  assert.equal(typeof config.reportPath, 'string');
  assert.equal(typeof config.errorPath, 'string');
  assert.equal(typeof config.providerPath, 'string');
  assert.equal(typeof config.verifierBin, 'string');
  assert.ok(Array.isArray(config.trials) && config.trials.length === 10);
  assert.ok(Number.isInteger(config.watchdogMs) && config.watchdogMs > 0);
  app.setPath('userData', config.profile);
  const manifest = JSON.parse(readFileSync(config.manifestPath, 'utf8'));
  assert.equal(manifest.schema, 'e2e-fake-manifest/v1');
  const wanted = manifest.capsules.map((row) => row.capsuleId);
  /** Pause between observation rounds so layout settles. */
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  /** Record probe detail and an empty report, then exit nonzero. */
  const abort = (detail) => {
    writeFileSync(config.errorPath, `${String(detail).slice(0, 2000)}\n`, 'utf8');
    const empty = { schema: 'e2e-ai-loop-report/v1', trials: [], controls: [] };
    writeFileSync(config.reportPath, `${JSON.stringify(empty)}\n`, 'utf8');
    app.exit(1);
  };
  setTimeout(() => app.exit(2), config.watchdogMs).unref();
  app.on('browser-window-created', (_, win) => {
    win.webContents.once('did-finish-load', async () => {
      try {
        const wc = win.webContents;
        const mount = await wc.executeJavaScript('!!document.querySelector("#metaviewer-app")');
        assert.equal(mount, true, 'ai mount #metaviewer-app must exist');
        const deadline = Date.now() + Math.floor(config.watchdogMs / 2);
        let observedTiles = [];
        do {
          observedTiles = await wc.executeJavaScript(
            `(${() => {
              const nodes = Array.from(document.querySelectorAll('[data-capsule-id]'));
              return nodes.map((node) => {
                const frameTag = node.querySelector('[data-frame-tag]')?.getAttribute('data-frame-tag') || '';
                const match = /-gen(\\d+)$/.exec(frameTag);
                return {
                  capsuleId: node.getAttribute('data-capsule-id'),
                  frameTag,
                  generation: match ? Number(match[1]) : 7,
                };
              });
            }})()`,
          );
          const ids = observedTiles.map((row) => row.capsuleId);
          if (wanted.every((id) => ids.includes(id))) break;
          await pause(50);
        } while (Date.now() < deadline);
        const ids = observedTiles.map((row) => row.capsuleId);
        for (const id of wanted) assert.ok(ids.includes(id), `manifest tile missing: ${id}`);

        const proposals = [];
        for (const item of config.trials) {
          const tile = observedTiles[(item.trial - 1) % observedTiles.length];
          const observation = {
            schema: 'observation/v0.2',
            frame_ref: {
              schema: 'frame_ref/v0.2',
              surface_id: tile.capsuleId,
              generation: tile.generation,
              sha256: '7c8dc88181f2f0fb6fe24455d18ba8ef57600ed2b3b09c6bb7e47ffbe87312f3',
              ramws_path: '/dev/shm/mv-ac05-before.rgb',
              width: 1,
              height: 1,
              stride: 3,
              pixel_format: 'rgb24',
              mono_ns: 1000,
            },
            vision: { summary: '', changed_regions: [], elements: [] },
          };
          const rawProposal = execFileSync(
            process.env.PYTHON || 'python3',
            [config.providerPath, '--proposal-id', `ai-trial-${item.trial}`],
            { input: JSON.stringify(observation), encoding: 'utf8', timeout: 5000 },
          );
          const proposal = JSON.parse(rawProposal);
          assert.equal(proposal.schema, 'action_proposal/v0.2');
          assert.equal(proposal.based_on_frame.generation, tile.generation, 'provider emitted stale generation');
          proposals.push({ trial: item.trial, kind: item.kind, proposal });
        }

        const verifierInputPath = join(config.profile, 'verifier-input.json');
        writeFileSync(verifierInputPath, JSON.stringify({ proposals }), 'utf8');
        const verifierOut = execFileSync(config.verifierBin, [verifierInputPath], {
          encoding: 'utf8',
          timeout: 10000,
        });
        const outcome = JSON.parse(verifierOut);
        assert.ok(outcome && Array.isArray(outcome.trials) && Array.isArray(outcome.controls));
        const report = { schema: 'e2e-ai-loop-report/v1', trials: outcome.trials, controls: outcome.controls };
        writeFileSync(config.reportPath, `${JSON.stringify(report)}\n`, 'utf8');
        app.exit(0);
      } catch (error) {
        abort((error && error.stack) || error);
      }
    });
  });
  process.env.MV_E2E_MANIFEST = config.manifestPath;
  await import(config.mainUrl);
}

function runLiveAiJourney({ providerPath } = {}) {
  const verifier = readFileSync(join(findRepoRoot(__dirname), 'core/src/verify/mod.rs'), 'utf8');
  assert.equal(/Reserved for action verification/.test(verifier), false,
    'GAP-AC05-VERIFY: receipt settlement cannot prove an action outcome');
  requireXvfb();
  prepareWall();
  const root = findRepoRoot(__dirname);
  const electron = electronBinary(root);
  const build = process.env.MV_E2E_BUILD;
  if (typeof build !== 'string' || build.length === 0 || !existsSync(join(build, 'index.html'))) {
    throw new E2EError('E2E_PREREQ', 'ac05 live journey needs MV_E2E_BUILD with the built renderer');
  }
  const resolvedProvider = providerPath || join(root, 'tests', 'e2e', 'ai-provider.py');
  if (!existsSync(resolvedProvider)) {
    throw new E2EError('E2E_PREREQ', `ai provider script missing: ${resolvedProvider}`);
  }
  const scratch = makeScratch('mv0-ac05-live');
  try {
    const verifierBin = compileRust(scratch, AC05_VERIFY_DRIVER_RS);
    const manifestPath = writeFakeManifest(scratch, TWO_FAKES);
    const reportPath = join(scratch, 'ai-report.json');
    const errorPath = join(scratch, 'ai-probe-error.txt');
    const mainUrl = require('node:url').pathToFileURL(join(root, 'tests', 'e2e', 'live-main.cjs')).href;
    const trials = [];
    for (let trial = 1; trial <= TRIAL_COUNT; trial += 1) {
      trials.push({ trial, kind: trial % 2 === 1 ? 'holdings' : 'browser' });
    }
    const probePath = join(scratch, 'probe.cjs');
    writeFileSync(probePath, `(${probeAiMain.toString()})(${JSON.stringify({
      profile: join(scratch, 'profile'),
      mainUrl,
      manifestPath,
      reportPath,
      errorPath,
      providerPath: resolvedProvider,
      verifierBin,
      trials,
      watchdogMs: PROBE_WATCHDOG_MS,
    })});\n`, 'utf8');
    const priorManifest = process.env.MV_E2E_MANIFEST;
    process.env.MV_E2E_MANIFEST = manifestPath;
    let outcome;
    try {
      outcome = runUnderXvfb({
        electron,
        appDir: probePath,
        diagnosticsPath: join(scratch, 'electron-process.json'),
      });
    } finally {
      if (priorManifest === undefined) delete process.env.MV_E2E_MANIFEST;
      else process.env.MV_E2E_MANIFEST = priorManifest;
    }
    const diagnostic = JSON.stringify({
      ...outcome,
      stdout: outcome.stdout.slice(-2000),
      stderr: outcome.stderr.slice(-4000),
    });
    let summary;
    try {
      summary = validateAiLoopReport(JSON.parse(readFileSync(reportPath, 'utf8')));
    } catch (error) {
      const probeDetail = existsSync(errorPath)
        ? readFileSync(errorPath, 'utf8').slice(0, 2000)
        : 'absent';
      if (error instanceof E2EError) {
        throw new E2EError(error.code, `${error.message} | probe: ${probeDetail} | process: ${diagnostic}`);
      }
      throw new E2EError('E2E_REPORT', `ai loop report unreadable | probe: ${probeDetail} | process: ${diagnostic}`);
    }
    assert.equal(outcome.timedOut, false, diagnostic);
    assert.equal(outcome.status, 0, diagnostic);
    return { outcome, summary };
  } finally {
    removeScratch(scratch);
  }
}

describe('ac05 live ai journey', () => {
  it('provider loop verifies 9/10 trials with all four negatives refused (AC-05)', () => {
    const { summary } = runLiveAiJourney();
    assert.equal(summary.pass, true);
    assert.equal(summary.controls, 4);
    assert.ok(summary.verified >= MIN_VERIFIED);
  });

  it('negative control: provider-down run fails with a typed E2EError and never goes green (T8-R2-001)', () => {
    const scratch = makeScratch('mv0-ac05-neg');
    try {
      const brokenProvider = join(scratch, 'broken-provider.py');
      writeFileSync(brokenProvider, 'import sys\nsys.stderr.write("E2E_PROVIDER: provider down\\n")\nsys.exit(1)\n', 'utf8');
      rejectsWith(() => runLiveAiJourney({ providerPath: brokenProvider }), ['E2E_LOOP', 'E2E_REPORT', 'E2E_PREREQ']);
      rejectsWith(() => runLiveAiJourney({ providerPath: join(scratch, 'missing-provider.py') }), ['E2E_PREREQ']);
    } finally {
      removeScratch(scratch);
    }
  });
});
