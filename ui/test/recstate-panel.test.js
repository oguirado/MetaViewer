// REC-STATE (FEEDBACK row 6, pillars P3/P4): the Record button shows its
// state. Mounted recording panel: red dot + Stop + live mm:ss, busy phases,
// typed failure reason, honest source-rate note, strict-CSP/token audits and
// source mutants. Live tile rate ~2 fps [MEASURED, operator P8.1 log].
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MV_RECORD_SOURCE_RATE_NOTE } from '../src/recording/recordingClock.js';
import { byId, fakeClock, flush, mount, nodes, sfc, storeWith, textOf, mutantMustFail, UI_ROOT } from './recstate-helpers.mjs';

const CAP = 'cap-01';
const TOGGLE = `mv-recordings-toggle-${CAP}`;
const STATUS = `mv-recordings-capture-status-${CAP}`;
const text = (mounted, id) => textOf(byId(mounted, id)).replace(/\s+/g, ' ').trim();
const elapsedNode = (mounted) => nodes(mounted.root).find((n) => n.props?.class === 'mv4-elapsed');
const hasDot = (mounted) => nodes(mounted.root).some((n) => n.props?.['data-recording-dot'] === 'true' && String(n.props.class).includes('mv4-toggle-dot'));
const hasMarker = (mounted) => nodes(mounted.root).some((n) => n.props?.['data-icon'] === 'marker');

async function checkPanel(Panel) {
  // recording: red dot, Stop, recording class, live timer from the host sample
  {
    const clock = fakeClock();
    const store = storeWith(CAP, { phase: 'recording', recordingId: 'rec-1', elapsedMs: 125_400 });
    const mounted = mount(Panel, { capsuleId: CAP, captureState: store, captureAvailable: true, clock });
    try {
      const toggle = byId(mounted, TOGGLE);
      assert.equal(text(mounted, TOGGLE), 'Stop');
      assert.match(toggle.props.class, /\bmv4-toggle-recording\b/);
      assert.match(toggle.props['aria-label'], /^Stop AI recording/);
      assert.equal(toggle.props.disabled, false);
      assert.ok(hasDot(mounted), 'red recording dot rendered');
      assert.ok(!hasMarker(mounted), 'the idle glyph is replaced by the dot');
      assert.equal(text(mounted, `mv-recordings-phase-${CAP}`) || 'x', 'recording');
      const timer = elapsedNode(mounted);
      assert.equal(textOf(timer).trim(), '02:05');
      assert.equal(timer.props.role, 'timer');
      assert.equal(timer.props['data-recording-elapsed'], 'live');
      // the timer moves with no host event
      clock.advance(3000); await flush();
      assert.equal(textOf(elapsedNode(mounted)).trim(), '02:08');
      clock.advance(1000); await flush();
      assert.equal(textOf(elapsedNode(mounted)).trim(), '02:09');
      // a host event ahead of the local estimate re-anchors
      store.bySurface[CAP].elapsedMs = 140_000; await flush();
      assert.equal(textOf(elapsedNode(mounted)).trim(), '02:20');
      clock.advance(2000); await flush();
      assert.equal(textOf(elapsedNode(mounted)).trim(), '02:22');
      // stop: back to idle; the readout holds the host value and the timer is gone
      store.bySurface[CAP].phase = 'idle'; store.bySurface[CAP].elapsedMs = 0; store.bySurface[CAP].recordingId = null; await flush();
      assert.equal(text(mounted, TOGGLE), 'Record for AI');
      assert.ok(!hasDot(mounted));
      assert.ok(hasMarker(mounted));
      assert.doesNotMatch(byId(mounted, TOGGLE).props.class, /mv4-toggle-recording/);
      assert.equal(clock.active, 0, 'no timer after the stop');
      clock.advance(10_000); await flush();
      assert.equal(textOf(elapsedNode(mounted)).trim(), '00:00');
      assert.equal(elapsedNode(mounted).props['data-recording-elapsed'], undefined);
    } finally { mounted.close(); }
    assert.equal(clock.active, 0, 'unmount clears any timer');
  }
  // unknown elapsed never renders a zero
  for (const bad of [undefined, -1, NaN, null]) {
    const clock = fakeClock();
    const store = storeWith(CAP, { phase: 'recording', recordingId: 'rec-1', elapsedMs: bad });
    const mounted = mount(Panel, { capsuleId: CAP, captureState: store, captureAvailable: true, clock });
    try {
      assert.equal(textOf(elapsedNode(mounted)).trim(), '--:--', String(bad));
      clock.advance(5000); await flush();
      assert.equal(textOf(elapsedNode(mounted)).trim(), '--:--', `${String(bad)} stays unknown while ticking`);
    } finally { mounted.close(); }
  }
  // transitional phases: busy label, disabled, aria-busy, no dot, no timer
  for (const [phase, label] of [['starting', 'Starting'], ['stopping', 'Stopping']]) {
    const clock = fakeClock();
    const store = storeWith(CAP, { phase, recordingId: 'rec-1', elapsedMs: 3000 });
    const mounted = mount(Panel, { capsuleId: CAP, captureState: store, captureAvailable: true, clock });
    try {
      const toggle = byId(mounted, TOGGLE);
      assert.equal(text(mounted, TOGGLE), label);
      assert.equal(toggle.props.disabled, true, `${phase} disables the toggle`);
      assert.equal(toggle.props['aria-busy'], 'true');
      assert.ok(!hasDot(mounted), `${phase} shows no recording dot`);
      assert.equal(clock.active, 0);
    } finally { mounted.close(); }
  }
  // failure: back to a retryable state with the typed reason, no dot
  {
    const store = storeWith(CAP, { phase: 'error', lastCode: 'RECORDING_FAILED' });
    const mounted = mount(Panel, { capsuleId: CAP, captureState: store, captureAvailable: true, clock: fakeClock() });
    try {
      assert.equal(text(mounted, TOGGLE), 'Retry');
      assert.equal(byId(mounted, TOGGLE).props.disabled, false);
      assert.ok(!hasDot(mounted));
      const status = byId(mounted, STATUS);
      assert.match(textOf(status), /recording failed/i);
      assert.equal(status.props['data-error-code'], 'RECORDING_FAILED');
    } finally { mounted.close(); }
  }
  // honest rate copy next to the frame-rate field
  {
    const mounted = mount(Panel, { capsuleId: CAP, captureState: storeWith(CAP), captureAvailable: true, clock: fakeClock() });
    try {
      const all = nodes(mounted.root).map((n) => textOf(n)).join(' ');
      assert.ok(all.includes(MV_RECORD_SOURCE_RATE_NOTE), 'measured source-rate note rendered');
      assert.match(all, /up to the source rate/);
    } finally { mounted.close(); }
  }
}

test('recording panel: dot + Stop + live mm:ss, busy phases, typed failure, honest rate', async () => checkPanel(await sfc('src/recording/MvRecordingPanel.vue', [], { specifiers: { './useRecordingElapsed.js': new URL('src/recording/useRecordingElapsed.js', UI_ROOT).href } })));

test('recording panel: legacy unbound mount keeps its props readout and shows no dot', async () => {
  const Panel = await sfc('src/recording/MvRecordingPanel.vue');
  const mounted = mount(Panel, { capsuleId: CAP, phase: 'recording', elapsedSeconds: 61 });
  try {
    assert.equal(textOf(elapsedNode(mounted)).trim(), '01:01');
    assert.equal(text(mounted, TOGGLE), 'Stop');
    const unknown = mount(Panel, { capsuleId: CAP, phase: 'recording' });
    try { assert.equal(textOf(elapsedNode(unknown)).trim(), '--:--'); } finally { unknown.close(); }
  } finally { mounted.close(); }
});

const MUTANTS = [
  ['drop the recording dot', [['<span v-if="recordingNow" class="mv4-toggle-dot"', '<span v-if="false" class="mv4-toggle-dot"']]],
  ['drop the recording class', [["(phaseN === 'recording' ? ' mv4-toggle-recording' : '')", "''"]]],
  ['label the toggle Record while recording', [['const toggleLabel = computed(() => mvRecordToggleLabel(phaseEff.value));', "const toggleLabel = computed(() => 'Record for AI');"]]],
  ['hard-code a zero readout', [['return ms === null ? null : Math.floor(ms / 1000);', 'return 0;']]],
  ['render store events only, no local tick', [['const ms = liveElapsedMs.value;', 'const ms = captureEntry.value?.elapsedMs ?? null;']]],
  ['derive elapsed from the wall clock', [['return ms === null ? null : Math.floor(ms / 1000);', 'return Math.floor(Date.now() / 1000) % 3600;']]],
  ['clear busy/disabled handling', [[':disabled="toggleDisabled"', ':disabled="false"']]],
  ['hide the dot on a failed phase check (always dot)', [['<span v-if="recordingNow" class="mv4-toggle-dot"', '<span v-if="true" class="mv4-toggle-dot"']]],
  ['drop the timer role', [['role="timer"', '']]],
  ['drop the measured rate note', [['<span class="mv4-fps-hint mv4-fps-rate" :title="MV_RECORD_SOURCE_RATE_NOTE">{{ MV_RECORD_SOURCE_RATE_NOTE }}</span>', '']]],
];
for (const [label, edits] of MUTANTS) {
  test(`panel mutant must fail: ${label}`, async () => {
    const Panel = await sfc('src/recording/MvRecordingPanel.vue', edits);
    await mutantMustFail(() => checkPanel(Panel), label);
  });
}

test('panel CSS/markup audit: class-based, kit tokens only, dot and live classes styled', () => {
  const css = readFileSync(fileURLToPath(new URL('src/recording/recording.css', UI_ROOT)), 'utf8');
  assert.match(css, /\.mv4-toggle-dot\s*\{/);
  assert.match(css, /\.mv4-toggle-recording \.mv4-toggle-dot\s*\{[^}]*background:\s*currentColor/);
  assert.match(css, /\.mv4-elapsed\[data-recording-elapsed="live"\]\s*\{/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'no colour literals');
  for (const file of ['MvRecordingPanel.vue', 'RecordingBadge.vue']) {
    const source = readFileSync(fileURLToPath(new URL(`src/recording/${file}`, UI_ROOT)), 'utf8');
    assert.doesNotMatch(source, /\sstyle=|:style=|v-html|<style(?![^>]*\ssrc=)/, `${file}: strict CSP, class-based (external stylesheet only)`);
  }
});
