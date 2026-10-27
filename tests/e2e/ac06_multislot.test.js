'use strict';

/**
 * E2E AC-06 journey: AI multislot (capsule + attached login-shell terminal).
 *
 * Runs under node --test; locates the repo root from its own path. Two layers,
 * mirroring tests/e2e/e2e1_wall.test.js:
 *
 * 1. Multislot contract tests: pure validation of the pairing invariant
 *    (capsule + terminal travel together across move/tab/float/hide/show),
 *    the provider menu (shell first, closed ids, no renderer argv), the
 *    Copy-capsule-ID witness, the READ/WRITE input gate, and the PTY
 *    byte-plane caps. Each positive is paired with mutant fixtures that
 *    must FAIL closed. These run on every host with node alone.
 * 2. The live multislot journey, staged by the AC harness: walks the
 *    prerequisite chain (flag, xvfb, repo root, Electron binary, staged
 *    multislot live entry) and fails closed with a typed E2E_* error at
 *    the first missing piece; it never skips.
 *
 * Product contracts mirrored here (literals duplicated so drift fails
 * loudly at the fixture boundary, as harness.js does for SURFACE_KINDS):
 * ui/src/terminal/providers.js (PROVIDER_ID_RE, MAX_PROVIDERS,
 * SYSTEM_SHELL_ENTRY), ui/src/multislot/multislotInputGate.js (read/write
 * modes, ERR_INPUT_MODE_READ), ui/src/multislot/multislotCopy.js (copy
 * states), contracts/v0.2/terminal_session.schema.json (session id, PTY
 * byte caps). No OS CLI or wender/vision assertions: this lane drives the
 * terminal only through the product broker/UI surface.
 *
 * @module ac06_multislot
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { accessSync, constants, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  E2EError,
  MAX_REPORT_BYTES,
  electronBinary,
  findRepoRoot,
  makeScratch,
  removeScratch,
  requireXvfb,
  tileSelector,
  wallTileListSelector,
} = require('./ac-harness.cjs');

/** Env flag arming the live journey; anything else refuses the run. */

/** Closed multislot probe report schema tag. */
const MULTISLOT_REPORT_SCHEMA = 'e2e-multislot-report/v1';
/** Only probe phase this journey exercises. */
const MULTISLOT_PHASE = 'multislot';

/** Closed provider-id grammar; mirrors terminal/providers.js PROVIDER_ID_RE. */
const PROVIDER_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Maximum provider entries; mirrors terminal/providers.js MAX_PROVIDERS. */
const MAX_PROVIDERS = 32;
/** Fixed first menu row; mirrors SYSTEM_SHELL_ENTRY.id. */
const SHELL_ID = 'shell';
/** Broker command for provider rows. */
const PROVIDER_COMMAND = 'provider';
/** Reserved ids a provider entry must never claim. */
const RESERVED_IDS = Object.freeze([SHELL_ID, PROVIDER_COMMAND]);

/** Operator input modes; mirrors multislotInputGate.js. */
const MULTISLOT_INPUT_MODES = Object.freeze(['read', 'write']);
/** Typed reason carried by a dropped write; mirrors INPUT_GATE_REFUSAL. */
const INPUT_GATE_REFUSAL = 'ERR_INPUT_MODE_READ';

/** Copy states; mirrors multislotCopy.js MULTISLOT_COPY_STATES. */
const COPY_STATES = Object.freeze(['ready', 'copying', 'copied', 'unavailable']);

/** Capsule id charset; mirrors the harness tile-id contract. */
const CAPSULE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Broker session id; mirrors terminal_session.schema.json $defs/id. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Layout mutations the pair must survive together. */
const LAYOUT_MUTATIONS = Object.freeze(['move', 'tab', 'float', 'hide', 'show']);
/** Layouts a slot may rest in, including the initial docked state. */
const SLOT_LAYOUTS = Object.freeze(['docked', ...LAYOUT_MUTATIONS]);

/** PTY base64 string cap; mirrors terminal_session $defs/b64 maxLength. */
const B64_MAX_CHARS = 65536;
/** Decoded PTY chunk cap; mirrors terminal_session byte_count bound. */
const PTY_MAX_BYTES = 49152;
/** Custom argv caps; mirror terminal/providers.js CUSTOM_MAX_*. */
const CUSTOM_MAX_ARGV = 32;
const CUSTOM_MAX_ARG_BYTES = 4096;

/**
 * Reject objects with keys outside the closed set.
 * @param {Record<string, unknown>} value Object under test.
 * @param {ReadonlyArray<string>} allowed Exact key set.
 * @param {string} label Field label for the error.
 * @param {string} code Domain refusal code for the caller.
 */
function needClosedKeys(value, allowed, label, code) {
  const keys = Object.keys(value).sort();
  const want = [...allowed].sort();
  if (keys.length !== want.length || keys.some((key, index) => key !== want[index])) {
    throw new E2EError(code, `${label} has unexpected keys: ${keys.join(',')}`);
  }
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @param {string} code Refusal code.
 * @returns {number} The validated positive int.
 */
function needPositiveInt(value, label, code) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new E2EError(code, `${label} must be a positive integer`);
  }
  return value;
}

/**
 * @param {unknown} value Candidate.
 * @param {string} label Field label for the error.
 * @param {string} code Refusal code.
 * @returns {number} The validated non-negative int.
 */
function needNonNegativeInt(value, label, code) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new E2EError(code, `${label} must be a non-negative integer`);
  }
  return value;
}

/**
 * @param {unknown} mode Candidate projected mode.
 * @returns {'read'|'write'} Known mode, failing closed to `read`.
 */
function normalizeInputMode(mode) {
  return mode === 'write' ? 'write' : 'read';
}

/**
 * Validate one multislot slot: a capsule with its attached terminal.
 * @param {unknown} slot Candidate row.
 * @returns {{ capsuleId: string, sessionId: string, capsuleAlive: boolean,
 * sessionAlive: boolean, layout: string, inputMode: string, inputCount: number,
 * copiedText: string }} The validated row.
 */
function checkMultislotSlot(slot) {
  if (typeof slot !== 'object' || slot === null || Array.isArray(slot)) {
    throw new E2EError('E2E_REPORT', 'multislot slot must be an object');
  }
  const row = /** @type {Record<string, unknown>} */ (slot);
  needClosedKeys(
    row,
    ['capsuleId', 'sessionId', 'capsuleAlive', 'sessionAlive', 'layout', 'inputMode', 'inputCount', 'copiedText'],
    'multislot slot',
    'E2E_REPORT',
  );
  if (typeof row.capsuleId !== 'string' || !CAPSULE_ID_PATTERN.test(row.capsuleId)) {
    throw new E2EError('E2E_REPORT', 'slot capsuleId malformed');
  }
  if (typeof row.sessionId !== 'string' || !SESSION_ID_RE.test(row.sessionId)) {
    throw new E2EError('E2E_REPORT', 'slot sessionId malformed');
  }
  if (typeof row.capsuleAlive !== 'boolean' || typeof row.sessionAlive !== 'boolean') {
    throw new E2EError('E2E_REPORT', 'slot alive flags must be boolean');
  }
  if (typeof row.layout !== 'string' || !SLOT_LAYOUTS.includes(row.layout)) {
    throw new E2EError('E2E_REPORT', 'slot layout unknown');
  }
  if (typeof row.inputMode !== 'string' || !MULTISLOT_INPUT_MODES.includes(row.inputMode)) {
    throw new E2EError('E2E_REPORT', 'slot inputMode must be read or write');
  }
  needNonNegativeInt(row.inputCount, 'slot inputCount', 'E2E_REPORT');
  if (typeof row.copiedText !== 'string') {
    throw new E2EError('E2E_REPORT', 'slot copiedText must be a string');
  }
  return /** @type {{ capsuleId: string, sessionId: string, capsuleAlive: boolean, sessionAlive: boolean, layout: string, inputMode: string, inputCount: number, copiedText: string }} */ ({
    capsuleId: row.capsuleId,
    sessionId: row.sessionId,
    capsuleAlive: row.capsuleAlive,
    sessionAlive: row.sessionAlive,
    layout: row.layout,
    inputMode: row.inputMode,
    inputCount: row.inputCount,
    copiedText: row.copiedText,
  });
}

/**
 * Strict closed validation of the multislot probe report, including the
 * 1:1 pairing rule: no two slots may share one terminal session.
 * @param {unknown} value Parsed probe report.
 * @returns {{ slots: ReturnType<typeof checkMultislotSlot>[], errors: string[] }}
 * Normalized summary.
 */
function validateMultislotReport(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new E2EError('E2E_REPORT', 'multislot report must be an object');
  }
  const report = /** @type {Record<string, unknown>} */ (value);
  needClosedKeys(report, ['schema', 'phase', 'slots', 'errors'], 'multislot report', 'E2E_REPORT');
  if (report.schema !== MULTISLOT_REPORT_SCHEMA) {
    throw new E2EError('E2E_REPORT', 'multislot report schema mismatch');
  }
  if (report.phase !== MULTISLOT_PHASE) {
    throw new E2EError('E2E_REPORT', 'multislot report phase mismatch');
  }
  if (!Array.isArray(report.slots) || report.slots.length === 0) {
    throw new E2EError('E2E_REPORT', 'multislot report slots must be a non-empty array');
  }
  if (!Array.isArray(report.errors) || !report.errors.every((entry) => typeof entry === 'string')) {
    throw new E2EError('E2E_REPORT', 'multislot report errors must be a string array');
  }
  const slots = report.slots.map(checkMultislotSlot);
  const capsuleIds = slots.map((slot) => slot.capsuleId);
  if (new Set(capsuleIds).size !== capsuleIds.length) {
    throw new E2EError('E2E_REPORT', 'duplicate slot capsuleId');
  }
  const sessionIds = slots.map((slot) => slot.sessionId);
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new E2EError('E2E_PAIRING', 'two slots share one terminal session');
  }
  return { slots, errors: [...report.errors] };
}

/**
 * Read a multislot probe report file and validate it.
 * @param {string} path Absolute report path.
 * @returns {{ slots: ReturnType<typeof checkMultislotSlot>[], errors: string[] }}
 * Normalized summary.
 */
function readMultislotReport(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new E2EError('E2E_REPORT', 'report path must be a non-empty string');
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new E2EError('E2E_REPORT', 'multislot report unreadable');
  }
  if (text.length > MAX_REPORT_BYTES) {
    throw new E2EError('E2E_REPORT', 'multislot report exceeds byte cap');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new E2EError('E2E_REPORT', 'multislot report is not JSON');
  }
  return validateMultislotReport(value);
}

/**
 * Validate one travel-log row: the pair after one layout mutation.
 * @param {unknown} row Candidate row.
 * @returns {{ mutation: string, capsuleId: string, sessionId: string,
 * capsuleAlive: boolean, sessionAlive: boolean }} The validated row.
 */
function checkTravelRow(row) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new E2EError('E2E_PAIRING', 'travel row must be an object');
  }
  const record = /** @type {Record<string, unknown>} */ (row);
  needClosedKeys(
    record,
    ['mutation', 'capsuleId', 'sessionId', 'capsuleAlive', 'sessionAlive'],
    'travel row',
    'E2E_PAIRING',
  );
  if (typeof record.mutation !== 'string' || !LAYOUT_MUTATIONS.includes(record.mutation)) {
    throw new E2EError('E2E_PAIRING', 'travel mutation unknown');
  }
  if (typeof record.capsuleId !== 'string' || !CAPSULE_ID_PATTERN.test(record.capsuleId)) {
    throw new E2EError('E2E_PAIRING', 'travel capsuleId malformed');
  }
  if (typeof record.sessionId !== 'string' || !SESSION_ID_RE.test(record.sessionId)) {
    throw new E2EError('E2E_PAIRING', 'travel sessionId malformed');
  }
  if (typeof record.capsuleAlive !== 'boolean' || typeof record.sessionAlive !== 'boolean') {
    throw new E2EError('E2E_PAIRING', 'travel alive flags must be boolean');
  }
  return /** @type {{ mutation: string, capsuleId: string, sessionId: string, capsuleAlive: boolean, sessionAlive: boolean }} */ ({
    mutation: record.mutation,
    capsuleId: record.capsuleId,
    sessionId: record.sessionId,
    capsuleAlive: record.capsuleAlive,
    sessionAlive: record.sessionAlive,
  });
}

/**
 * The pairing invariant: capsule and terminal travel together. Every row
 * of the travel log keeps the same capsule and PTY session ids, and both
 * processes stay alive across move/tab/float/hide/show.
 * @param {unknown} log Candidate travel log.
 * @returns {{ capsuleId: string, sessionId: string, hops: number }} Pair summary.
 */
function checkPairingTravel(log) {
  if (!Array.isArray(log) || log.length === 0) {
    throw new E2EError('E2E_PAIRING', 'travel log must be a non-empty array');
  }
  const rows = log.map(checkTravelRow);
  const first = rows[0];
  for (const row of rows) {
    if (row.capsuleId !== first.capsuleId || row.sessionId !== first.sessionId) {
      throw new E2EError('E2E_PAIRING', `pair split at ${row.mutation}: capsule or session changed`);
    }
    if (row.capsuleAlive !== true || row.sessionAlive !== true) {
      throw new E2EError('E2E_PAIRING', `pair lost a process at ${row.mutation}`);
    }
  }
  return { capsuleId: first.capsuleId, sessionId: first.sessionId, hops: rows.length };
}

/**
 * Validate one reference-only provider menu row. Closed keys keep
 * renderer-supplied executable paths, cwd and env off the wire: launch
 * resolves the id host-side.
 * @param {unknown} row Candidate row.
 * @returns {{ id: string, label: string, hint: string, command: string, disabled: boolean }}
 * The validated row.
 */
function checkMenuRow(row) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new E2EError('E2E_PROVIDER', 'menu row must be an object');
  }
  const record = /** @type {Record<string, unknown>} */ (row);
  needClosedKeys(record, ['id', 'label', 'hint', 'command', 'disabled'], 'menu row', 'E2E_PROVIDER');
  if (typeof record.id !== 'string' || !PROVIDER_ID_RE.test(record.id)) {
    throw new E2EError('E2E_PROVIDER', 'menu id malformed');
  }
  if (typeof record.label !== 'string' || record.label.trim().length === 0) {
    throw new E2EError('E2E_PROVIDER', 'menu label must be non-empty');
  }
  if (typeof record.hint !== 'string') {
    throw new E2EError('E2E_PROVIDER', 'menu hint must be a string');
  }
  if (record.command !== SHELL_ID && record.command !== PROVIDER_COMMAND) {
    throw new E2EError('E2E_PROVIDER', 'menu command must be shell or provider');
  }
  if (typeof record.disabled !== 'boolean') {
    throw new E2EError('E2E_PROVIDER', 'menu disabled must be boolean');
  }
  return /** @type {{ id: string, label: string, hint: string, command: string, disabled: boolean }} */ ({
    id: record.id,
    label: record.label,
    hint: record.hint,
    command: record.command,
    disabled: record.disabled,
  });
}

/**
 * Validate the provider menu: the system shell row first, then at most
 * MAX_PROVIDERS host-owned provider rows with unique closed-grammar ids.
 * @param {unknown} menu Candidate menu.
 * @returns {{ ids: string[] }} Menu summary.
 */
function validateProviderMenu(menu) {
  if (!Array.isArray(menu) || menu.length === 0) {
    throw new E2EError('E2E_PROVIDER', 'provider menu must be a non-empty array');
  }
  const rows = menu.map(checkMenuRow);
  const [head, ...rest] = rows;
  if (head.id !== SHELL_ID || head.command !== SHELL_ID) {
    throw new E2EError('E2E_PROVIDER', 'provider menu must lead with the system shell row');
  }
  if (rest.length > MAX_PROVIDERS) {
    throw new E2EError('E2E_PROVIDER', `at most ${MAX_PROVIDERS} provider rows`);
  }
  const ids = rest.map((row) => row.id);
  for (const id of ids) {
    if (RESERVED_IDS.includes(id)) {
      throw new E2EError('E2E_PROVIDER', 'provider id is reserved');
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new E2EError('E2E_PROVIDER', 'duplicate provider id');
  }
  return { ids: rows.map((row) => row.id) };
}

/**
 * Validate a custom-executable argv: trimmed head, no leading dash, no
 * NUL, bounded element count and UTF-8 bytes. No quoting or shell
 * evaluation: arguments stay literal.
 * @param {unknown} argv Candidate executable plus args.
 * @returns {ReadonlyArray<string>} Frozen copy of the validated argv.
 */
function checkCustomArgv(argv) {
  if (!Array.isArray(argv)) {
    throw new E2EError('E2E_PROVIDER', 'custom argv must be an array');
  }
  if (argv.length === 0 || argv.length > CUSTOM_MAX_ARGV) {
    throw new E2EError('E2E_PROVIDER', `custom argv length must be 1..${CUSTOM_MAX_ARGV}`);
  }
  for (const item of argv) {
    if (typeof item !== 'string') {
      throw new E2EError('E2E_PROVIDER', 'custom argv items must be strings');
    }
    if (item.includes('\0')) {
      throw new E2EError('E2E_PROVIDER', 'custom argv items must not contain NUL');
    }
    if (Buffer.byteLength(item, 'utf8') > CUSTOM_MAX_ARG_BYTES) {
      throw new E2EError('E2E_PROVIDER', 'custom argv item exceeds the byte cap');
    }
  }
  const head = argv[0].trim();
  if (head.length === 0) {
    throw new E2EError('E2E_PROVIDER', 'custom executable must be non-empty');
  }
  if (head.startsWith('-')) {
    throw new E2EError('E2E_PROVIDER', 'custom executable must not start with a dash');
  }
  return Object.freeze([head, ...argv.slice(1)]);
}

/**
 * Validate the Copy-capsule-ID witness: a `copied` state proves the
 * clipboard holds exactly the host-issued capsule id.
 * @param {unknown} witness Candidate witness.
 * @returns {{ capsuleId: string, state: string }} Witness summary.
 */
function validateCopyWitness(witness) {
  if (typeof witness !== 'object' || witness === null || Array.isArray(witness)) {
    throw new E2EError('E2E_CLIPBOARD', 'copy witness must be an object');
  }
  const record = /** @type {Record<string, unknown>} */ (witness);
  needClosedKeys(record, ['capsuleId', 'copiedText', 'state'], 'copy witness', 'E2E_CLIPBOARD');
  if (typeof record.capsuleId !== 'string' || !CAPSULE_ID_PATTERN.test(record.capsuleId)) {
    throw new E2EError('E2E_CLIPBOARD', 'copy capsuleId malformed');
  }
  if (typeof record.state !== 'string' || !COPY_STATES.includes(record.state)) {
    throw new E2EError('E2E_CLIPBOARD', 'copy state unknown');
  }
  if (typeof record.copiedText !== 'string') {
    throw new E2EError('E2E_CLIPBOARD', 'copiedText must be a string');
  }
  if (record.state === 'copied' && record.copiedText !== record.capsuleId) {
    throw new E2EError('E2E_CLIPBOARD', 'clipboard holds a foreign capsule id');
  }
  return { capsuleId: record.capsuleId, state: record.state };
}

/**
 * Validate one input-gate audit row for a single keystroke. READ mode
 * never delivers and the capsule input counter stays put; WRITE mode
 * delivers exactly once. Unknown modes fail closed to READ.
 * @param {unknown} row Candidate row.
 * @returns {{ mode: string, delivered: boolean }} Row summary.
 */
function checkInputGateRow(row) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new E2EError('E2E_INPUT_GATE', 'input gate row must be an object');
  }
  const record = /** @type {Record<string, unknown>} */ (row);
  needClosedKeys(
    record,
    ['mode', 'delivered', 'reason', 'countBefore', 'countAfter'],
    'input gate row',
    'E2E_INPUT_GATE',
  );
  const mode = normalizeInputMode(record.mode);
  if (typeof record.delivered !== 'boolean') {
    throw new E2EError('E2E_INPUT_GATE', 'delivered must be boolean');
  }
  if (typeof record.reason !== 'string') {
    throw new E2EError('E2E_INPUT_GATE', 'reason must be a string');
  }
  needNonNegativeInt(record.countBefore, 'countBefore', 'E2E_INPUT_GATE');
  needNonNegativeInt(record.countAfter, 'countAfter', 'E2E_INPUT_GATE');
  if (mode === 'read') {
    if (record.delivered !== false) {
      throw new E2EError('E2E_INPUT_GATE', 'READ-mode keystroke was delivered');
    }
    if (record.reason !== INPUT_GATE_REFUSAL) {
      throw new E2EError('E2E_INPUT_GATE', 'READ-mode drop carries no typed refusal');
    }
    if (record.countAfter !== record.countBefore) {
      throw new E2EError('E2E_INPUT_GATE', 'READ-mode keystroke advanced the capsule input counter');
    }
  } else {
    if (record.delivered !== true || record.reason !== '') {
      throw new E2EError('E2E_INPUT_GATE', 'WRITE-mode keystroke was not delivered cleanly');
    }
    if (record.countAfter !== record.countBefore + 1) {
      throw new E2EError('E2E_INPUT_GATE', 'WRITE-mode keystroke advanced the counter by more than one');
    }
  }
  return { mode, delivered: record.delivered };
}

/**
 * Validate the whole input-gate audit log.
 * @param {unknown} log Candidate log.
 * @returns {{ rows: number }} Log summary.
 */
function validateInputGateLog(log) {
  if (!Array.isArray(log) || log.length === 0) {
    throw new E2EError('E2E_INPUT_GATE', 'input gate log must be a non-empty array');
  }
  const rows = log.map(checkInputGateRow);
  return { rows: rows.length };
}

/**
 * Validate one PTY byte-plane chunk: ASCII base64 within the encoded
 * cap, decoded bytes within the decoded cap, byte_count exact.
 * @param {unknown} chunk Candidate chunk.
 * @returns {{ session: string, seq: number, byteCount: number }} Chunk summary.
 */
function checkPtyChunk(chunk) {
  if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) {
    throw new E2EError('E2E_PTY', 'pty chunk must be an object');
  }
  const record = /** @type {Record<string, unknown>} */ (chunk);
  needClosedKeys(record, ['session', 'seq', 'bytes', 'byteCount'], 'pty chunk', 'E2E_PTY');
  if (typeof record.session !== 'string' || !SESSION_ID_RE.test(record.session)) {
    throw new E2EError('E2E_PTY', 'pty session malformed');
  }
  needPositiveInt(record.seq, 'pty seq', 'E2E_PTY');
  if (typeof record.bytes !== 'string') {
    throw new E2EError('E2E_PTY', 'pty bytes must be a string');
  }
  if (record.bytes.length > B64_MAX_CHARS) {
    throw new E2EError('E2E_PTY', 'pty bytes exceed the encoded cap');
  }
  if (!/^[A-Za-z0-9+/=]*$/.test(record.bytes) || record.bytes.length % 4 !== 0) {
    throw new E2EError('E2E_PTY', 'pty bytes are not base64');
  }
  const decoded = Buffer.from(record.bytes, 'base64');
  if (decoded.length > PTY_MAX_BYTES) {
    throw new E2EError('E2E_PTY', 'pty chunk exceeds the decoded cap');
  }
  needNonNegativeInt(record.byteCount, 'pty byteCount', 'E2E_PTY');
  if (record.byteCount !== decoded.length) {
    throw new E2EError('E2E_PTY', 'pty byteCount disagrees with the decoded bytes');
  }
  return { session: record.session, seq: record.seq, byteCount: record.byteCount };
}

/**
 * Require the staged multislot live entry. Absence is a typed
 * prerequisite failure, never a skip and never a fallback probe.
 * @param {string} root Absolute repository root.
 * @returns {string} Absolute live entry path.
 */
function requireMultislotLiveEntry(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new E2EError('E2E_ARGS', 'root must be a non-empty string');
  }
  const entry = join(root, 'tests', 'e2e', 'live-multislot.cjs');
  try {
    accessSync(entry, constants.R_OK);
  } catch {
    throw new E2EError('E2E_PREREQ', `multislot live entry not staged: ${entry}`);
  }
  return entry;
}

/**
 * Build a valid multislot probe report object.
 * @returns {{ schema: string, phase: string, slots: object[], errors: string[] }}
 * Valid report.
 */
function validMultislotReport() {
  return {
    schema: MULTISLOT_REPORT_SCHEMA,
    phase: MULTISLOT_PHASE,
    slots: [
      {
        capsuleId: 'slot-e2e-a',
        sessionId: 'term-slot-e2e-a:1',
        capsuleAlive: true,
        sessionAlive: true,
        layout: 'docked',
        inputMode: 'read',
        inputCount: 7,
        copiedText: 'slot-e2e-a',
      },
    ],
    errors: [],
  };
}

/**
 * Build a travel log holding one pair across every layout mutation.
 * @returns {Array<{ mutation: string, capsuleId: string, sessionId: string,
 * capsuleAlive: boolean, sessionAlive: boolean }>} Travel log.
 */
function validTravelLog() {
  return LAYOUT_MUTATIONS.map((mutation) => ({
    mutation,
    capsuleId: 'slot-e2e-a',
    sessionId: 'term-slot-e2e-a:1',
    capsuleAlive: true,
    sessionAlive: true,
  }));
}

/**
 * Build a valid provider menu: shell first, then three host providers.
 * @returns {Array<{ id: string, label: string, hint: string, command: string,
 * disabled: boolean }>} Menu rows.
 */
function validProviderMenu() {
  return [
    { id: 'shell', label: 'System shell', hint: 'Interactive login shell', command: 'shell', disabled: false },
    { id: 'claude-code', label: 'Claude Code', hint: 'Host CLI', command: 'provider', disabled: false },
    { id: 'codex', label: 'Codex', hint: 'Host CLI', command: 'provider', disabled: false },
    { id: 'meta', label: 'Meta', hint: 'Host CLI', command: 'provider', disabled: true },
  ];
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

describe('ac06 multislot contract (Layer 1)', () => {
  it('selects tiles by stable id, never by index or text', () => {
    assert.equal(wallTileListSelector(), '[data-capsule-id]');
    assert.equal(tileSelector('slot-e2e-a'), '[data-capsule-id="slot-e2e-a"]');
  });

  it('accepts a valid multislot report', () => {
    const summary = validateMultislotReport(validMultislotReport());
    assert.equal(summary.slots.length, 1);
    assert.equal(summary.slots[0].sessionId, 'term-slot-e2e-a:1');
    assert.deepEqual(summary.errors, []);
  });

  it('negative control: two slots sharing one terminal session are refused', () => {
    const mutant = validMultislotReport();
    mutant.slots.push({ ...mutant.slots[0], capsuleId: 'slot-e2e-b', copiedText: 'slot-e2e-b' });
    rejectsWith(() => validateMultislotReport(mutant), ['E2E_PAIRING']);
  });

  it('negative control: report with an extra key is refused (closed object)', () => {
    const mutant = { ...validMultislotReport(), debug: true };
    rejectsWith(() => validateMultislotReport(mutant), ['E2E_REPORT']);
  });

  it('negative control: wrong schema tag is refused', () => {
    const mutant = validMultislotReport();
    mutant.schema = 'multislot-report/v9';
    rejectsWith(() => validateMultislotReport(mutant), ['E2E_REPORT']);
  });

  it('negative control: malformed report file is refused', () => {
    const scratch = makeScratch('mv0-ac06');
    try {
      const badPath = join(scratch, 'report.json');
      writeFileSync(badPath, '{not json', 'utf8');
      rejectsWith(() => readMultislotReport(badPath), ['E2E_REPORT']);
      rejectsWith(() => readMultislotReport(join(scratch, 'missing.json')), ['E2E_REPORT']);
    } finally {
      removeScratch(scratch);
    }
  });

  it('round-trips a valid multislot report file', () => {
    const scratch = makeScratch('mv0-ac06');
    try {
      const path = join(scratch, 'report.json');
      writeFileSync(path, `${JSON.stringify(validMultislotReport())}\n`, 'utf8');
      const summary = readMultislotReport(path);
      assert.equal(summary.slots.length, 1);
    } finally {
      removeScratch(scratch);
    }
  });

  it('pair travels together across every layout mutation', () => {
    const pair = checkPairingTravel(validTravelLog());
    assert.equal(pair.capsuleId, 'slot-e2e-a');
    assert.equal(pair.sessionId, 'term-slot-e2e-a:1');
    assert.equal(pair.hops, 5);
  });

  it('negative control: session swap mid-travel is refused', () => {
    const mutant = validTravelLog();
    mutant[3].sessionId = 'term-slot-e2e-b:1';
    rejectsWith(() => checkPairingTravel(mutant), ['E2E_PAIRING']);
  });

  it('negative control: capsule swap mid-travel is refused', () => {
    const mutant = validTravelLog();
    mutant[1].capsuleId = 'slot-e2e-b';
    rejectsWith(() => checkPairingTravel(mutant), ['E2E_PAIRING']);
  });

  it('negative control: dead terminal after hide is refused (hide preserves processes)', () => {
    const mutant = validTravelLog();
    mutant[3].sessionAlive = false;
    rejectsWith(() => checkPairingTravel(mutant), ['E2E_PAIRING']);
  });

  it('negative control: unknown mutation is refused', () => {
    const mutant = validTravelLog();
    mutant[0].mutation = 'teleport';
    rejectsWith(() => checkPairingTravel(mutant), ['E2E_PAIRING']);
  });

  it('accepts a shell-first provider menu', () => {
    const summary = validateProviderMenu(validProviderMenu());
    assert.deepEqual(summary.ids, ['shell', 'claude-code', 'codex', 'meta']);
  });

  it('negative control: menu not leading with the system shell is refused', () => {
    const mutant = validProviderMenu();
    const [head, ...rest] = mutant;
    rejectsWith(() => validateProviderMenu([...rest, head]), ['E2E_PROVIDER']);
  });

  it('negative control: more than 32 provider rows are refused', () => {
    const mutant = validProviderMenu();
    for (let index = 0; index < 30; index += 1) {
      mutant.push({
        id: `extra-${index}`,
        label: `Extra ${index}`,
        hint: '',
        command: 'provider',
        disabled: true,
      });
    }
    assert.equal(mutant.length, 34);
    rejectsWith(() => validateProviderMenu(mutant), ['E2E_PROVIDER']);
  });

  it('negative control: malformed, reserved and duplicate ids are refused', () => {
    const malformed = validProviderMenu();
    malformed[1].id = 'has space';
    rejectsWith(() => validateProviderMenu(malformed), ['E2E_PROVIDER']);
    const reserved = validProviderMenu();
    reserved[1].id = 'provider';
    rejectsWith(() => validateProviderMenu(reserved), ['E2E_PROVIDER']);
    const duplicate = validProviderMenu();
    duplicate[2].id = duplicate[1].id;
    rejectsWith(() => validateProviderMenu(duplicate), ['E2E_PROVIDER']);
  });

  it('negative control: renderer-supplied executable key is refused', () => {
    const mutant = validProviderMenu();
    mutant[1] = { ...mutant[1], exe: '/bin/sh' };
    rejectsWith(() => validateProviderMenu(mutant), ['E2E_PROVIDER']);
    const mutantCwd = validProviderMenu();
    mutantCwd[1] = { ...mutantCwd[1], cwd: '/tmp' };
    rejectsWith(() => validateProviderMenu(mutantCwd), ['E2E_PROVIDER']);
  });

  it('accepts a valid custom argv', () => {
    const argv = checkCustomArgv(['my-cli', '--flag', 'value with spaces']);
    assert.deepEqual([...argv], ['my-cli', '--flag', 'value with spaces']);
  });

  it('negative control: custom argv refuses dash head, overflow, NUL and oversize', () => {
    rejectsWith(() => checkCustomArgv(['-dash']), ['E2E_PROVIDER']);
    rejectsWith(() => checkCustomArgv(['  ']), ['E2E_PROVIDER']);
    rejectsWith(() => checkCustomArgv(['exe', 'has\0nul']), ['E2E_PROVIDER']);
    rejectsWith(() => checkCustomArgv(['exe', 'x'.repeat(CUSTOM_MAX_ARG_BYTES + 1)]), ['E2E_PROVIDER']);
    rejectsWith(() => checkCustomArgv(Array.from({ length: CUSTOM_MAX_ARGV + 1 }, () => 'a')), ['E2E_PROVIDER']);
    rejectsWith(() => checkCustomArgv('not-an-array'), ['E2E_PROVIDER']);
  });

  it('copy witness matches the host-issued capsule id', () => {
    const summary = validateCopyWitness({ capsuleId: 'slot-e2e-a', copiedText: 'slot-e2e-a', state: 'copied' });
    assert.equal(summary.state, 'copied');
  });

  it('negative control: clipboard holding a foreign id is refused', () => {
    rejectsWith(
      () => validateCopyWitness({ capsuleId: 'slot-e2e-a', copiedText: 'slot-e2e-b', state: 'copied' }),
      ['E2E_CLIPBOARD'],
    );
  });

  it('negative control: unknown copy state is refused', () => {
    rejectsWith(
      () => validateCopyWitness({ capsuleId: 'slot-e2e-a', copiedText: '', state: 'pasted' }),
      ['E2E_CLIPBOARD'],
    );
  });

  it('WRITE-mode keystroke delivers and advances the counter by one', () => {
    const summary = validateInputGateLog([
      { mode: 'write', delivered: true, reason: '', countBefore: 7, countAfter: 8 },
    ]);
    assert.equal(summary.rows, 1);
  });

  it('READ-mode keystroke drops with the typed refusal and a still counter', () => {
    const summary = validateInputGateLog([
      { mode: 'read', delivered: false, reason: INPUT_GATE_REFUSAL, countBefore: 7, countAfter: 7 },
    ]);
    assert.equal(summary.rows, 1);
  });

  it('negative control: READ-mode keystroke delivered is refused (AC-06 negative)', () => {
    rejectsWith(
      () =>
        validateInputGateLog([
          { mode: 'read', delivered: true, reason: '', countBefore: 7, countAfter: 8 },
        ]),
      ['E2E_INPUT_GATE'],
    );
  });

  it('negative control: READ-mode counter advance without delivery is refused', () => {
    rejectsWith(
      () =>
        validateInputGateLog([
          { mode: 'read', delivered: false, reason: INPUT_GATE_REFUSAL, countBefore: 7, countAfter: 8 },
        ]),
      ['E2E_INPUT_GATE'],
    );
  });

  it('negative control: READ-mode drop without the typed refusal is refused', () => {
    rejectsWith(
      () =>
        validateInputGateLog([
          { mode: 'read', delivered: false, reason: '', countBefore: 7, countAfter: 7 },
        ]),
      ['E2E_INPUT_GATE'],
    );
  });

  it('unknown input mode fails closed to READ', () => {
    const summary = validateInputGateLog([
      { mode: 'turbo', delivered: false, reason: INPUT_GATE_REFUSAL, countBefore: 3, countAfter: 3 },
    ]);
    assert.equal(summary.rows, 1);
    rejectsWith(
      () =>
        validateInputGateLog([
          { mode: 'turbo', delivered: true, reason: '', countBefore: 3, countAfter: 4 },
        ]),
      ['E2E_INPUT_GATE'],
    );
  });

  it('accepts a PTY chunk within both byte caps', () => {
    const bytes = Buffer.from('prompt$ ', 'utf8').toString('base64');
    const summary = checkPtyChunk({ session: 'term-slot-e2e-a:1', seq: 1, bytes, byteCount: 8 });
    assert.equal(summary.byteCount, 8);
  });

  it('negative control: PTY chunk over the decoded cap is refused', () => {
    const bytes = Buffer.alloc(PTY_MAX_BYTES + 1, 0x61).toString('base64');
    rejectsWith(
      () => checkPtyChunk({ session: 'term-slot-e2e-a:1', seq: 2, bytes, byteCount: PTY_MAX_BYTES + 1 }),
      ['E2E_PTY'],
    );
  });

  it('negative control: PTY byteCount disagreeing with the bytes is refused', () => {
    const bytes = Buffer.from('prompt$ ', 'utf8').toString('base64');
    rejectsWith(
      () => checkPtyChunk({ session: 'term-slot-e2e-a:1', seq: 1, bytes, byteCount: 9 }),
      ['E2E_PTY'],
    );
  });

  it('negative control: non-base64 PTY bytes are refused', () => {
    rejectsWith(
      () => checkPtyChunk({ session: 'term-slot-e2e-a:1', seq: 1, bytes: '***', byteCount: 3 }),
      ['E2E_PTY'],
    );
  });

  it('live-entry gate refuses a missing entry and passes a staged one', () => {
    const scratch = makeScratch('mv0-ac06');
    try {
      rejectsWith(() => requireMultislotLiveEntry(scratch), ['E2E_PREREQ']);
      rejectsWith(() => requireMultislotLiveEntry(''), ['E2E_ARGS']);
      const stagedDir = join(scratch, 'tests', 'e2e');
      mkdirSync(stagedDir, { recursive: true });
      const staged = join(stagedDir, 'live-multislot.cjs');
      writeFileSync(staged, "'use strict';\n", 'utf8');
      assert.equal(requireMultislotLiveEntry(scratch), staged);
    } finally {
      removeScratch(scratch);
    }
  });
});

describe('ac06 live multislot journey (Layer 2)', () => {
  it('capsule and terminal travel together with a gated input mode (AC-06)', {
    todo: 'GAP-AC06-LAYOUT-UI: core commits and publishes layout intents; live-multislot entry and renderer placement consumption are not implemented on this base',
  }, () => {
    const dispatch = readFileSync(join(findRepoRoot(__dirname), 'core/src/serve/mod.rs'), 'utf8');
    const uiDispatch = dispatch.slice(dispatch.indexOf('(Component::Ui, Command::UiIntent(request))'));
    assert.equal(/Some\("fold" \| "unfold" \| "move" \| "tab" \| "float" \| "hide" \| "show"\)/.test(uiDispatch.split('let sid =')[0]), true,
      'GAP-AC06-LAYOUT: core has no authoritative layout intent dispatch');
    requireXvfb();
    const root = findRepoRoot(__dirname);
    electronBinary(root);
    requireMultislotLiveEntry(root);
  });
});
