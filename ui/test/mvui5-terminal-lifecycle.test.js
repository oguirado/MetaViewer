/**
 * Lane M: typed terminal-session lifecycle (pending -> attached -> exited/failed).
 *
 * Covers the pure lifecycle helpers in `terminal/sideTerminalFacade` plus the
 * static contracts of the multislot host and broker launch controls: typed outcome rows carry
 * designed messages only (codes in data attributes, never raw host text),
 * session records keep the broker id verbatim for stable kit tabs, every new
 * row is anchored, and the lane stays CSP-clean with kit tokens only.
 * Mounted behaviour lives in mvui5-terminal-panels.test.js.
 *
 * @module mvui5-terminal-lifecycle.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TERMINAL_SESSION_ID_RE,
  TERMINAL_SESSION_OUTCOMES,
  normalizeTerminalOutcome,
  terminalLifecycleRefs,
  toPaneSession,
} from '../src/terminal/sideTerminalFacade.js';

const HOST_URL = new URL('../src/multislot/MultislotHost.vue', import.meta.url);
const CONTROLS_URL = new URL('../src/terminal/BrokerLaunchControls.vue', import.meta.url);
const MULTI_CSS_URL = new URL('../src/multislot/multislot.css', import.meta.url);
const TERM_CSS_URL = new URL('../src/terminal/terminal.css', import.meta.url);
const FACADE_URL = new URL('../src/terminal/sideTerminalFacade.js', import.meta.url);
const host = readFileSync(HOST_URL, 'utf8');
const controls = readFileSync(CONTROLS_URL, 'utf8');
const multiCss = readFileSync(MULTI_CSS_URL, 'utf8');
const termCss = readFileSync(TERM_CSS_URL, 'utf8');
const facadeSrc = readFileSync(FACADE_URL, 'utf8');
const hostTemplate = host.slice(host.indexOf('<template>'));
const controlsTemplate = controls.slice(controls.indexOf('<template>'));

test('exited sessions normalize to a typed info row with a designed message', () => {
  const outcome = normalizeTerminalOutcome({ type: 'exited', sessionId: 'sess-9' });
  assert.equal(outcome.type, 'exited');
  assert.equal(outcome.sessionId, 'sess-9');
  assert.equal(outcome.code, TERMINAL_SESSION_OUTCOMES.EXITED);
  assert.equal(outcome.code, 'TERMINAL_SESSION_EXITED');
  assert.equal(outcome.message, 'Session ended.');
  assert.equal(outcome.tone, 'info');
  assert.doesNotMatch(outcome.message, /TERMINAL_|ERR_|sess-9/);
});

test('failed and unknown outcomes fail closed to a typed error row, never raw text', () => {
  const raw = 'RAW-HOST-SECRET <b>boom</b> exit=137';
  for (const input of [
    { type: 'failed', sessionId: 's1' },
    { session: 's1', error: raw },
    { type: 'FAILED', sessionId: 's1' },
    null,
    undefined,
    raw,
  ]) {
    const outcome = normalizeTerminalOutcome(input);
    assert.equal(outcome.code, TERMINAL_SESSION_OUTCOMES.FAILED);
    assert.equal(outcome.message, 'Session ended unexpectedly.');
    assert.equal(outcome.tone, 'error');
    assert.ok(!outcome.message.includes('RAW-HOST-SECRET'), 'host text never reaches the row');
    assert.ok(!outcome.message.includes('<b>'), 'markup never reaches the row');
  }
  const exitedWithRawFields = normalizeTerminalOutcome({ type: 'exited', sessionId: 's1', error: raw, exitCode: 137 });
  assert.equal(exitedWithRawFields.code, TERMINAL_SESSION_OUTCOMES.EXITED);
  assert.equal(exitedWithRawFields.message, 'Session ended.');
  // Negative control: a naive String(error) projection WOULD leak the raw text,
  // so the detector below must flag it while the typed row stays clean.
  assert.ok(String(raw).includes('RAW-HOST-SECRET'));
});

test('pane session records carry the broker id verbatim for stable kit tabs', () => {
  assert.deepEqual(toPaneSession('sess-9', { title: 'Shell', kind: 'shell' }), {
    sessionId: 'sess-9', title: 'Shell', kind: 'shell', activity: 'unknown',
  });
  assert.deepEqual(toPaneSession('sess-9', {}), {
    sessionId: 'sess-9', title: 'sess-9', kind: '', activity: 'unknown',
  });
  assert.deepEqual(toPaneSession('sess-9', null), {
    sessionId: 'sess-9', title: 'sess-9', kind: '', activity: 'unknown',
  });
  assert.ok(TERMINAL_SESSION_ID_RE.test('sess-9'));
  assert.equal(TERMINAL_SESSION_ID_RE.test(''), false);
  assert.equal(TERMINAL_SESSION_ID_RE.test('has space'), false);
});

test('lifecycle refs are deterministic capsule derivations, unique per capsule', () => {
  const first = terminalLifecycleRefs('cap-01');
  const second = terminalLifecycleRefs('cap-01');
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    pending: 'mv-multislot-cap-01-launch-pending',
    pendingAnchor: 'capsule/cap-01/launch-pending',
    notice: 'mv-multislot-cap-01-session-notice',
    noticeAnchor: 'capsule/cap-01/session-notice',
    noticeDismiss: 'mv-multislot-cap-01-session-notice-dismiss',
    noticeDismissAnchor: 'capsule/cap-01/session-notice-dismiss',
  });
  const other = terminalLifecycleRefs('cap-02');
  assert.ok(!Object.values(other).some((value) => Object.values(first).includes(value)));
});

test('multislot host renders pending and typed notice rows, keeps removal semantics', () => {
  assert.ok(host.includes("from '../terminal/sideTerminalFacade.js'"));
  assert.ok(host.includes('normalizeTerminalOutcome'));
  assert.ok(host.includes('toPaneSession'));
  assert.ok(hostTemplate.includes('lifecycleRefs.pending'));
  assert.ok(hostTemplate.includes('lifecycleRefs.notice'));
  assert.ok(hostTemplate.includes('Starting session…'));
  assert.ok(hostTemplate.includes(':data-outcome-code="sessionNotice.code"'));
  assert.ok(hostTemplate.includes('{{ sessionNotice.message }}'));
  assert.ok(hostTemplate.includes('Dismiss session notice'));
  assert.ok(host.includes('onPumpEvent'));
  assert.ok(
    host.includes("sessions.value = sessions.value.filter((item) => item.sessionId !== event.sessionId);"),
    'existing removal semantics are preserved',
  );
  assert.doesNotMatch(hostTemplate, /\{\{\s*(payload|error|err)\b/);
});

test('broker controls show a pending row while a launch is in flight', () => {
  assert.ok(controlsTemplate.includes('v-if="launching"'));
  assert.ok(controlsTemplate.includes('`${idPrefix}-pending`'));
  assert.ok(controlsTemplate.includes('`${anchorPrefix}/pending`'));
  assert.ok(controlsTemplate.includes('role="status"'));
  assert.ok(controlsTemplate.includes('Starting session…'));
  assert.ok(controls.includes('TERMINAL_LAUNCH_REFUSED'));
  assert.ok(controlsTemplate.includes('data-outcome-code'));
});

/**
 * @param {string} template Vue template source.
 * @returns {string[]} Interactive elements missing id, anchor or a name.
 */
function interactiveWithoutContract(template) {
  const missing = [];
  const tagPattern = /<(button|input|select|textarea|a)\b[^>]*>/g;
  let match = tagPattern.exec(template);
  while (match !== null) {
    const tag = match[0];
    const hasId = /(^|\s):?id=/.test(tag);
    const hasAnchor = /(^|\s):?data-semantic-anchor=/.test(tag);
    const labelled = /aria-label=|aria-labelledby=/.test(tag);
    const nameFromText = match[1] === 'button' || match[1] === 'a';
    if (!hasId || !hasAnchor || (!labelled && !nameFromText)) missing.push(tag);
    match = tagPattern.exec(template);
  }
  return missing;
}

test('every new control carries id, anchor and an accessible name', () => {
  assert.deepEqual(interactiveWithoutContract(hostTemplate), []);
  assert.deepEqual(interactiveWithoutContract(controlsTemplate), []);
  assert.ok(hostTemplate.includes('capsule/'));
  assert.ok(controlsTemplate.includes('anchorPrefix'));
});

test('anchor check fails on a planted control without id or anchor (negative control)', () => {
  assert.deepEqual(interactiveWithoutContract('<button class="x">No contract</button>'), [
    '<button class="x">',
  ]);
  assert.deepEqual(
    interactiveWithoutContract(
      '<button id="a" data-semantic-anchor="b">Ok</button>',
    ),
    [],
  );
});

test('lifecycle files honor strict CSP: no inline styles, bindings or v-show', () => {
  const files = [
    ['MultislotHost.vue', host],
    ['BrokerLaunchControls.vue', controls],
    ['multislot.css', multiCss],
    ['terminal.css', termCss],
    ['sideTerminalFacade.js', facadeSrc],
  ];
  for (const [name, text] of files) {
    assert.doesNotMatch(text, /(^|[^a-zA-Z-])style\s*=/, `${name} carries a style attribute`);
    assert.ok(!text.includes(':style'), `${name} carries a style binding`);
    assert.ok(!text.includes('v-bind:style'), `${name} carries a style binding`);
    assert.ok(!text.includes('v-show'), `${name} mutates element.style through v-show`);
    assert.ok(!text.includes("setAttribute('style'"), `${name} writes a style attribute`);
    assert.ok(!text.includes('.style.'), `${name} writes element.style`);
  }
});

test('CSP check fails on planted style vectors (negative control)', () => {
  assert.match('<p style="margin:0">x</p>', /(^|[^a-zA-Z-])style\s*=/);
  assert.ok('<div :style="s">x</div>'.includes(':style'));
  assert.ok('<div v-show="open">x</div>'.includes('v-show'));
});

test('lifecycle styles use kit tokens only: no colour literals, no new fonts', () => {
  for (const [name, css] of [['multislot.css', multiCss], ['terminal.css', termCss]]) {
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${name} carries a colour literal`);
    assert.doesNotMatch(css, /\brgba?\(/, `${name} carries a colour function`);
    assert.doesNotMatch(css, /\bhsla?\(/, `${name} carries a colour function`);
    assert.doesNotMatch(css, /@font-face|font-family\s*:/, `${name} adds a font`);
  }
  assert.ok(multiCss.includes('var(--cuk-semantic-'));
  assert.ok(termCss.includes('var(--cuk-semantic-'));
  assert.ok(multiCss.includes('.mv-multislot__notice'));
  assert.ok(multiCss.includes('.mv-multislot__pending'));
  assert.ok(termCss.includes('.mv-broker-launch__pending'));
});

test('colour-literal check fails on a planted hex code (negative control)', () => {
  assert.match('.x{color:#ff0000}', /#[0-9a-fA-F]{3,8}\b/);
});

test('lane sources name no third-party products and invent no random ids', () => {
  const sources = [host, controls, multiCss, termCss, facadeSrc].join('\n');
  assert.doesNotMatch(sources, /claude code|codex|openai|anthropic/i);
  assert.ok(!sources.includes('Math.random'), 'ids stay deterministic');
  assert.ok(!sources.includes('Date.now'), 'ids stay deterministic');
  assert.ok(!sources.includes('randomUUID'), 'ids stay deterministic');
  // Negative controls: the detectors above must flag planted violations.
  assert.match('claude code', /claude code|codex|openai|anthropic/i);
  assert.ok('Math.random()'.includes('Math.random'));
});

test('multislot host stays kit-first: kit shell, control bar and stream registry', () => {
  assert.ok(host.includes('multislot/AiMultiSlot.vue'));
  assert.ok(host.includes('multislot/AiSlotControlBar.vue'));
  assert.ok(host.includes("from 'capsule-ui-kit/TerminalView'"));
  assert.ok(host.includes(':has-control-lease="hasLease"'));
  assert.ok(host.includes('createGatedTerminalWriter'));
});
