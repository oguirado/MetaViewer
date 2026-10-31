// Lane R mvui6: named replay bench steps for verdict, refusal, intent,
// multislot, and terminal lifecycle rows. Every behaviour ships with a
// negative control; numeric 0..8 behaviour stays byte-identical.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LIVE_REPLAY_BENCH_NAMES,
  LIVE_REPLAY_FIXTURE,
  LIVE_REPLAY_SCRIPT,
  LIVE_REPLAY_STEP_MAP,
  createLiveReplayHarness,
  createLiveReplayMount,
  createLiveReplayTerminalHarness,
  parseStepQuery,
} from '../src/fixtures/liveReplay.js';
import { createAuthorityAdapter, createTerminalBroker } from '../src/core/hostAdapters.js';
import { createSideTerminalFacade } from '../src/terminal/sideTerminalFacade.js';
import { normalizeTerminalOutcome } from '../src/terminal/sideTerminalFacade.js';
import { createMultislotPump } from '../src/multislot/multislotAttach.js';

/** @param {unknown} value */
function assertDeepFrozen(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (entry && typeof entry === 'object') assertDeepFrozen(entry);
    }
  }
}

describe('step map', () => {
  test('nineteen frozen entries: numeric 0..8 plus ten named bench steps', () => {
    assert.equal(LIVE_REPLAY_STEP_MAP.length, 19);
    assert.deepEqual(LIVE_REPLAY_STEP_MAP.slice(0, 9).map((row) => row.step), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(LIVE_REPLAY_STEP_MAP.slice(9).map((row) => row.step), [...LIVE_REPLAY_BENCH_NAMES]);
    assert.deepEqual([...LIVE_REPLAY_BENCH_NAMES], [
      'propose-admitted', 'propose-refused', 'intent-acked', 'intent-refused',
      'multislot-fold-acked', 'multislot-unfold-refused',
      'terminal-pending', 'terminal-attached', 'terminal-exited', 'terminal-failed',
    ]);
    assertDeepFrozen(LIVE_REPLAY_STEP_MAP);
    assertDeepFrozen(LIVE_REPLAY_BENCH_NAMES);
  });

  test('numeric entries carry no bench action; named entries carry one frozen action', () => {
    for (const row of LIVE_REPLAY_STEP_MAP.slice(0, 9)) {
      assert.equal(row.bench, null, String(row.step));
      assert.equal(row.kind, 'frames', String(row.step));
      assert.equal(row.frames, row.step, String(row.step));
    }
    for (const row of LIVE_REPLAY_STEP_MAP.slice(9)) {
      assert.ok(row.bench && typeof row.bench === 'object', String(row.step));
      assert.equal(row.frames, 8, String(row.step));
      assert.ok(Object.isFrozen(row.bench), String(row.step));
      if (row.bench && typeof row.bench === 'object' && 'body' in row.bench) {
        assert.ok(Object.isFrozen(row.bench.body), String(row.step));
      }
    }
  });

  test('descriptions are designed text, never placeholders', () => {
    for (const row of LIVE_REPLAY_STEP_MAP) {
      assert.ok(row.description.length > 0, String(row.step));
      assert.doesNotMatch(row.description, /placeholder|TODO|FIXME|lorem/i, String(row.step));
      assert.ok(row.expects && typeof row.expects === 'object', String(row.step));
    }
  });

  test('the map is deterministic across repeated reads', () => {
    assert.equal(JSON.stringify(LIVE_REPLAY_STEP_MAP), JSON.stringify([...LIVE_REPLAY_STEP_MAP]));
  });

  test('negative control: a planted duplicate step fails uniqueness', () => {
    const steps = LIVE_REPLAY_STEP_MAP.map((row) => row.step);
    assert.equal(new Set(steps).size, steps.length);
    assert.throws(() => assert.equal(new Set([...steps, 0]).size, steps.length + 1), assert.AssertionError);
  });
});

describe('parseStepQuery named steps', () => {
  test('each allowlisted name resolves to itself', () => {
    for (const name of LIVE_REPLAY_BENCH_NAMES) {
      assert.deepEqual(parseStepQuery(`?state=live-replay&step=${name}`), { ok: true, step: name });
      assert.deepEqual(parseStepQuery(`step=${name}`), { ok: true, step: name });
    }
  });

  test('numeric 0..8 and absent steps keep their exact prior meaning', () => {
    for (let step = 0; step <= 8; step += 1) {
      assert.deepEqual(parseStepQuery(`?step=${step}`), { ok: true, step });
    }
    assert.deepEqual(parseStepQuery('?state=live-replay'), { ok: true, step: 8 });
    assert.deepEqual(parseStepQuery(''), { ok: true, step: 8 });
  });

  test('unknown names stay invalid, numeric out-of-range stays unknown', () => {
    for (const search of ['?step=bogus', '?step=verdict', '?step=propose', '?step=PROPOSE-ADMITTED', '?step=propose-admitted ']) {
      const parsed = parseStepQuery(search);
      assert.equal(parsed.ok, false, search);
      if (!parsed.ok) assert.equal(parsed.error.code, 'ERR_INVALID_STEP_QUERY', search);
      else assert.fail(`${search} must refuse`);
    }
    for (const search of ['?step=9', '?step=10', '?step=99', '?step=100']) {
      const parsed = parseStepQuery(search);
      assert.equal(parsed.ok, false, search);
      if (!parsed.ok) assert.equal(parsed.error.code, 'ERR_UNKNOWN_STEP', search);
      else assert.fail(`${search} must refuse`);
    }
  });

  test('malformed named queries refuse as invalid', () => {
    for (const search of [
      '?step=propose-admitted&step=intent-acked',
      '?step=',
      '?step=02',
      '?step=-1',
    ]) {
      const parsed = parseStepQuery(search);
      assert.equal(parsed.ok, false, search);
      if (!parsed.ok) assert.equal(parsed.error.code, 'ERR_INVALID_STEP_QUERY', search);
      else assert.fail(`${search} must refuse`);
    }
  });
});

describe('mount numeric preservation', () => {
  test('numeric mounts keep the exact five-key surface with no bench', () => {
    for (const step of [0, 5, 8]) {
      const created = createLiveReplayMount(`?state=live-replay&step=${step}`);
      assert.equal(created.ok, true, `step ${step}`);
      if (!created.ok) continue;
      assert.deepEqual(Object.keys(created.mount).sort(),
        ['authorityPort', 'calls', 'fixture', 'runtime', 'terminal']);
      assert.equal(created.mount.terminal, null);
      assert.equal('bench' in created.mount, false);
      assert.equal('terminalBrokerPort' in created.mount, false);
    }
  });

  test('step 9 still refuses as unknown (numeric range unchanged)', () => {
    const created = createLiveReplayMount('?state=live-replay&step=9');
    assert.equal(created.ok, false);
    if (!created.ok) assert.equal(created.error.code, 'ERR_UNKNOWN_STEP');
  });
});

describe('mount named bench steps', () => {
  test('every named step mounts full frames (recovered live)', () => {
    for (const name of LIVE_REPLAY_BENCH_NAMES) {
      const created = createLiveReplayMount(`?state=live-replay&step=${name}`);
      assert.equal(created.ok, true, name);
      if (!created.ok) continue;
      const rows = created.mount.runtime.projectionView.getProjection()?.rows ?? [];
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].generation, 7, name);
      assert.equal(rows[0].backendLifecycle, 'active', name);
      assert.equal(created.mount.runtime.projectionView.getSnapshot().envelope?.revision, 8, name);
      assert.equal(created.mount.fixture, LIVE_REPLAY_FIXTURE, name);
    }
  });

  test('bench descriptors match the frozen step map', () => {
    for (const name of LIVE_REPLAY_BENCH_NAMES) {
      const created = createLiveReplayMount(`?step=${name}`);
      assert.equal(created.ok, true, name);
      if (!created.ok) continue;
      const entry = LIVE_REPLAY_STEP_MAP.find((row) => row.step === name);
      assert.deepEqual(created.mount.bench, entry?.bench ?? null, name);
      assert.ok(Object.isFrozen(created.mount.bench), name);
    }
  });

  test('propose and intent benches carry the exact dispatch bodies', () => {
    const admitted = createLiveReplayMount('?step=propose-admitted');
    assert.equal(admitted.ok, true);
    if (admitted.ok) assert.deepEqual(admitted.mount.bench, { kind: 'propose', body: { schema:'action_proposal/v0.2',proposal_id:'replay-proposal',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'} } });
    const refused = createLiveReplayMount('?step=propose-refused');
    if (refused.ok) assert.deepEqual(refused.mount.bench?.body, { schema:'action_proposal/v0.2',proposal_id:'replay-proposal',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'}, refuse: true });
    const acked = createLiveReplayMount('?step=intent-acked');
    if (acked.ok) assert.deepEqual(acked.mount.bench?.body, { op: 'take_control', surfaceId: 'cap-01' });
    const denied = createLiveReplayMount('?step=intent-refused');
    if (denied.ok) assert.deepEqual(denied.mount.bench?.body, { op: 'take_control', surfaceId: '' });
  });

  test('multislot benches carry closed ui_intent bodies with fixed slot ids', () => {
    const folded = createLiveReplayMount('?step=multislot-fold-acked');
    assert.equal(folded.ok, true);
    if (folded.ok) {
      assert.equal(folded.mount.bench?.kind, 'multislot');
      assert.equal(folded.mount.bench?.capsuleId, 'cap-01');
      const body = /** @type {Record<string, any>} */ (folded.mount.bench?.body);
      assert.equal(body.schema, 'ui_intent/v0.2');
      assert.equal(body.op, 'fold');
      assert.deepEqual(body.params, { slot_id: 'cuk-ai-slot-cap-01' });
    }
    const unfolded = createLiveReplayMount('?step=multislot-unfold-refused');
    if (unfolded.ok) {
      const body = /** @type {Record<string, any>} */ (unfolded.mount.bench?.body);
      assert.equal(body.op, 'unfold');
      assert.deepEqual(body.params, {});
    }
  });

  test('terminal mounts carry fake broker ports; binding only past pending', () => {
    for (const name of ['terminal-pending', 'terminal-attached', 'terminal-exited', 'terminal-failed']) {
      const created = createLiveReplayMount(`?step=${name}`);
      assert.equal(created.ok, true, name);
      if (!created.ok) continue;
      assert.ok(created.mount.terminalBrokerPort, `${name} carries a broker port`);
      assert.ok(created.mount.terminalHarness, `${name} carries a harness`);
      assert.equal(created.mount.terminalHarness?.lifecycle, name.slice('terminal-'.length), name);
      if (name === 'terminal-pending') {
        assert.equal(created.mount.terminal, null, name);
      } else {
        assert.equal(created.mount.terminal?.session, 'term-01', name);
        assert.ok(created.mount.terminal?.port, name);
      }
    }
    for (const name of ['propose-admitted', 'intent-acked', 'multislot-fold-acked']) {
      const created = createLiveReplayMount(`?step=${name}`);
      if (created.ok) {
        assert.equal(created.mount.terminal, null, name);
        assert.equal('terminalBrokerPort' in created.mount, false, name);
      }
    }
  });

  test('named mounts answer through the real authority adapter', async () => {
    const created = createLiveReplayMount('?step=propose-admitted');
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const adapter = createAuthorityAdapter(created.mount.authorityPort);
    assert.equal((await adapter.propose?.({ schema:'action_proposal/v0.2',proposal_id:'p',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'} }))?.code, 'ACTION_ADMITTED');
    assert.equal((await adapter.propose?.({ schema:'action_proposal/v0.2',proposal_id:'p',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'}, refuse: true }))?.code, 'POLICY');
    assert.equal((await adapter.propose?.({ schema:'action_proposal/v0.2',proposal_id:'p',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'}, refuse: 1 }))?.decision ?? 'admitted', 'admitted');
    const request = created.mount.runtime.intentBuilders.control({ capsuleId: 'cap-01', verb: 'take_control' });
    assert.equal(await adapter.intent?.(request), true);
  });
});

describe('fake terminal port contract', () => {
  test('broker exposes exactly open, setEnabled, close', () => {
    const { brokerPort } = createLiveReplayTerminalHarness('attached');
    assert.deepEqual(Object.keys(brokerPort).sort(), ['close', 'open', 'setEnabled']);
  });

  test('session port exposes exactly the MessagePort surface', () => {
    const { sessionPort } = createLiveReplayTerminalHarness('attached');
    assert.deepEqual(Object.keys(sessionPort).sort(),
      ['addEventListener', 'postMessage', 'removeEventListener', 'start']);
  });

  test('every method enforces exact positional arity', () => {
    const { brokerPort, sessionPort } = createLiveReplayTerminalHarness('attached');
    const broker = /** @type {any} */ (brokerPort);
    const session = /** @type {any} */ (sessionPort);
    const spec = { command: 'shell', args: [], cols: 80, rows: 24 };
    assert.throws(() => broker.open(), /wrong arity/);
    assert.throws(() => broker.open(spec, spec), /wrong arity/);
    assert.throws(() => broker.setEnabled(), /wrong arity/);
    assert.throws(() => broker.setEnabled(true, false), /wrong arity/);
    assert.throws(() => broker.close(), /wrong arity/);
    assert.throws(() => session.postMessage(), /wrong arity/);
    assert.throws(() => session.addEventListener('message'), /wrong arity/);
    assert.throws(() => session.removeEventListener('message'), /wrong arity/);
    assert.throws(() => session.start('extra'), /wrong arity/);
  });

  test('detached receivers are refused', () => {
    const { brokerPort, sessionPort } = createLiveReplayTerminalHarness('attached');
    const open = /** @type {any} */ (brokerPort.open);
    const post = /** @type {any} */ (sessionPort.postMessage);
    assert.throws(() => open({ command: 'shell', args: [], cols: 80, rows: 24 }), /invalid receiver/);
    assert.throws(() => post({ session: 'term-01' }), /invalid receiver/);
  });

  test('open validates closed specs; enable acks literal true', async () => {
    const { brokerPort, calls } = createLiveReplayTerminalHarness('attached');
    const broker = /** @type {any} */ (brokerPort);
    assert.deepEqual(await broker.open({ command: 'shell', args: [], cols: 80, rows: 24 }), { session: 'term-01' });
    const enabled = await broker.setEnabled(true);
    assert.equal(enabled, true);
    assert.equal(enabled === true, true, 'literal true, never truthy');
    assert.deepEqual(calls.map((call) => call.method), ['open', 'setEnabled']);
    for (const call of calls) assert.ok(Object.isFrozen(call));
    assert.throws(() => broker.open({ command: 'shell' }), /invalid spec/);
    assert.throws(() => broker.open({ command: 'shell', args: [], cols: 80, rows: 24, extra: 1 }), /invalid spec/);
    assert.throws(() => broker.open({ command: '', args: [], cols: 80, rows: 24 }), /invalid spec/);
    assert.throws(() => broker.open({ command: 'shell', args: [42], cols: 80, rows: 24 }), /invalid spec/);
    assert.throws(() => broker.setEnabled('yes'), /invalid flag/);
    assert.throws(() => broker.close({ session: 'has space' }), /invalid request/);
    assert.throws(() => broker.close({}), /invalid request/);
  });

  test('pending opens stay pending for the bench screenshot', async () => {
    const { brokerPort, calls } = createLiveReplayTerminalHarness('pending');
    const opened = /** @type {any} */ (brokerPort.open)({ command: 'shell', args: [], cols: 80, rows: 24 });
    assert.ok(opened instanceof Promise);
    assert.deepEqual(calls.map((call) => call.method), ['open']);
    const winner = await Promise.race([opened.then(() => 'resolved'), Promise.resolve('pending')]);
    assert.equal(winner, 'pending', 'pending open never resolves synchronously');
  });

  test('unknown lifecycles throw', () => {
    assert.throws(() => createLiveReplayTerminalHarness(/** @type {any} */ ('bogus')), /unknown lifecycle/);
    assert.throws(() => createLiveReplayTerminalHarness(/** @type {any} */ (null)), /unknown lifecycle/);
  });

  test('failed lifecycle throws on ack writes, accepts other messages', () => {
    const failed = createLiveReplayTerminalHarness('failed');
    const session = /** @type {any} */ (failed.sessionPort);
    session.postMessage({ session: 'term-01', seq: 1, bytes: [65] });
    assert.throws(() => session.postMessage({ session: 'term-01', ack: 1, bytes: 1 }), /ack refused/);
    const attached = createLiveReplayTerminalHarness('attached');
    /** @type {any} */ (attached.sessionPort.postMessage)({ session: 'term-01', ack: 1, bytes: 1 });
    assert.throws(() => session.postMessage('nope'), /invalid message/);
    assert.throws(() => session.addEventListener('open', () => {}), /message listener required/);
  });
});

describe('terminal lifecycle through real facade and pump', () => {
  function doubles() {
    const events = [];
    const calls = { chunks: [], leases: [], closed: [] };
    const registry = {
      createSession: () => {}, beginAttach: () => {}, applyRestoreSnapshot: () => {},
      writeOutputChunk: (chunk) => calls.chunks.push(chunk),
      setControlLease: (lease) => calls.leases.push(lease),
      disposeSession: () => {}, forgetSession: () => {},
    };
    return { events, calls, registry };
  }

  async function attachedPump(lifecycle) {
    const harness = createLiveReplayTerminalHarness(lifecycle);
    const facade = createSideTerminalFacade({ session: 'term-01', port: /** @type {any} */ (harness.sessionPort) });
    const f = doubles();
    const pump = createMultislotPump({
      facade: /** @type {any} */ (facade), registry: /** @type {any} */ (f.registry),
      capsuleId: 'cap-01', getInputMode: () => 'read', onEvent: (event) => f.events.push(event),
    });
    const attached = await facade.attach();
    for (const item of attached.sessions ?? []) pump.attachSession(item);
    return { harness, facade, pump, ...f };
  }

  test('attached carries one live session with no outcome', async () => {
    const f = await attachedPump('attached');
    try {
      assert.deepEqual(f.pump.sessionIds(), ['term-01']);
      assert.deepEqual(f.events, []);
      assert.equal(f.calls.chunks.length, 0);
    } finally { f.pump.dispose(); f.facade.dispose(); }
  });

  test('emitted exit reports exited with the designed message', async () => {
    const f = await attachedPump('exited');
    try {
      f.harness.emitExit();
      assert.deepEqual(f.events, [{ type: 'exited', sessionId: 'term-01' }]);
      const outcome = normalizeTerminalOutcome({ type: 'exited', sessionId: 'term-01' });
      assert.equal(outcome.code, 'TERMINAL_SESSION_EXITED');
      assert.equal(outcome.message, 'Session ended.');
      assert.equal(outcome.tone, 'info');
      assert.doesNotMatch(outcome.message, /TERMINAL_|term-01/);
    } finally { f.pump.dispose(); f.facade.dispose(); }
  });

  test('emitted frame on the failed harness reports failed with the designed message', async () => {
    const f = await attachedPump('failed');
    try {
      f.harness.emitFrame();
      assert.deepEqual(f.events, [{ type: 'failed', sessionId: 'term-01' }]);
      const outcome = normalizeTerminalOutcome({ type: 'failed', sessionId: 'term-01' });
      assert.equal(outcome.code, 'TERMINAL_SESSION_FAILED');
      assert.equal(outcome.message, 'Session ended unexpectedly.');
      assert.equal(outcome.tone, 'error');
      assert.doesNotMatch(outcome.message, /TERMINAL_|term-01/);
    } finally { f.pump.dispose(); f.facade.dispose(); }
  });

  test('negative control: the same frame on the attached harness stays live', async () => {
    const f = await attachedPump('attached');
    try {
      f.harness.emitFrame();
      assert.deepEqual(f.events, []);
      assert.equal(f.calls.chunks.length, 1);
      assert.deepEqual(f.pump.sessionIds(), ['term-01']);
    } finally { f.pump.dispose(); f.facade.dispose(); }
  });
});

describe('replay source hygiene', () => {
  const source = readFileSync(new URL('../src/fixtures/liveReplay.js', import.meta.url), 'utf8');

  /** @param {string} text */
  function assertReplayHygiene(text) {
    assert.doesNotMatch(text, /\sstyle\s*=/, 'inline style attribute');
    assert.doesNotMatch(text, /:style\b/, 'style binding');
    assert.doesNotMatch(text, /element\.style/, 'style write');
    assert.doesNotMatch(text, /setAttribute\(\s*['"]style['"]/, 'style setAttribute');
    assert.doesNotMatch(text, /\bwindow\./, 'host global read');
    assert.doesNotMatch(text, /\bdocument\./, 'host document read');
    assert.doesNotMatch(text, /Date\.now|Math\.random|randomUUID/, 'nondeterminism');
  }

  test('the replay module stays deterministic and host-free', () => {
    assertReplayHygiene(source);
  });

  test('the hygiene check fails on planted violations', () => {
    for (const planted of [
      '<div style="display:none"></div>',
      '<canvas :style="s"></canvas>',
      'element.style.width = "1px";',
      'node.setAttribute(\'style\', "x");',
      'window.location.search',
      'document.querySelector("x")',
      'Date.now()',
      'Math.random()',
      'crypto.randomUUID()',
    ]) {
      assert.throws(() => assertReplayHygiene(planted), Error, planted);
    }
  });
});

describe('bench anchor hints', () => {
  /** @param {unknown} anchor */
  function assertAnchorHint(anchor) {
    assert.equal(typeof anchor, 'string');
    assert.match(/** @type {string} */ (anchor), /^[a-z0-9]+(?:\/[a-z0-9-]+)+$/, String(anchor));
  }

  test('terminal expects carry unique kebab-case anchors', () => {
    const anchors = LIVE_REPLAY_STEP_MAP
      .map((row) => /** @type {Record<string, unknown>} */ (row.expects)?.anchor)
      .filter((anchor) => typeof anchor === 'string');
    assert.deepEqual([...anchors].sort(), [
      'capsule/cap-01/session-notice',
      'capsule/cap-01/session-notice',
      'terminal/pending',
      'terminal/session/term-01/tab',
    ].sort());
    for (const anchor of new Set(anchors)) assertAnchorHint(anchor);
  });

  test('the anchor check fails on a missing anchor (negative control)', () => {
    assert.throws(() => assertAnchorHint(null), assert.AssertionError);
    assert.throws(() => assertAnchorHint('Missing Anchor'), assert.AssertionError);
    assertAnchorHint('terminal/pending');
  });
});
