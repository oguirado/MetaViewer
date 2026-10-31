// Lane R: live-replay script, fake authority port contract, and the
// deterministic replay through the REAL authority runtime (never fixture
// rows). Every behaviour ships with a negative control.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LIVE_REPLAY_FIXTURE,
  LIVE_REPLAY_KEY,
  LIVE_REPLAY_SCRIPT,
  LIVE_REPLAY_SURFACE_ID,
  createLiveReplayHarness,
  createLiveReplayMount,
  parseStepQuery,
} from '../src/fixtures/liveReplay.js';
import { createAuthorityAdapter, createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { auditAnchors } from '../src/agent/agentLane.js';
import { FIXTURE_KEYS, FIXTURES } from '../src/fixtures/states.js';
import { isFixtureKey } from '../src/fixtures/resolveState.js';

/** @param {unknown} value */
function assertDeepFrozen(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (entry && typeof entry === 'object') assertDeepFrozen(entry);
    }
  }
}

const FRAME_REF_KEYS = 'capture_us,format,generation,height,schema,sha256,surface_id,tick,ts_ns,width';
const SURFACE_KEYS = 'control,display,geometry,kind,profile_id,schema,state,surface_id,visibility';

describe('script', () => {
  test('eight frozen entries in phase order with fixed generations', () => {
    assert.equal(LIVE_REPLAY_KEY, 'live-replay');
    assert.equal(LIVE_REPLAY_SURFACE_ID, 'cap-01');
    assert.equal(LIVE_REPLAY_SCRIPT.length, 8);
    assert.deepEqual(LIVE_REPLAY_SCRIPT.map((entry) => entry.phase), [
      'live', 'live', 'live', 'human-control', 'agent-acting', 'stale-resend', 'lost', 'recovered',
    ]);
    assert.deepEqual(LIVE_REPLAY_SCRIPT.map((entry) => entry.generation), [1, 2, 3, 4, 5, 3, 6, 7]);
    assert.deepEqual(LIVE_REPLAY_SCRIPT.map((entry) => entry.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assertDeepFrozen(LIVE_REPLAY_SCRIPT);
  });

  test('every notice carries closed frame_ref/v0.2 + surface/v0.2 key sets', () => {
    const digests = new Set();
    for (const entry of LIVE_REPLAY_SCRIPT) {
      const notice = entry.notice;
      assert.deepEqual(Object.keys(notice).sort(), ['frame_ref', 'surface']);
      const frame = notice.frame_ref;
      assert.deepEqual(Object.keys(frame).sort().join(','), FRAME_REF_KEYS);
      assert.equal(frame.schema, 'frame_ref/v0.2');
      assert.equal(frame.surface_id, 'cap-01');
      assert.equal(frame.format, 'rgb24');
      assert.match(/** @type {string} */ (frame.sha256), /^[a-f0-9]{64}$/);
      digests.add(frame.sha256);
      for (const key of ['generation', 'width', 'height']) {
        assert.ok(Number.isSafeInteger(frame[key]) && /** @type {number} */ (frame[key]) > 0, key);
      }
      for (const key of ['tick', 'ts_ns', 'capture_us']) {
        assert.ok(Number.isSafeInteger(frame[key]) && /** @type {number} */ (frame[key]) >= 0, key);
      }
      const surface = notice.surface;
      assert.deepEqual(Object.keys(surface).sort().join(','), SURFACE_KEYS);
      assert.equal(surface.schema, 'surface/v0.2');
      assert.equal(surface.surface_id, 'cap-01');
      assert.equal(frame.generation, entry.generation);
      assert.equal(surface.control, entry.control);
      assert.equal(surface.state, entry.state);
      const geometry = /** @type {Record<string, unknown>} */ (surface.geometry);
      assert.deepEqual(Object.keys(geometry).sort(), ['h', 'w']);
    }
    assert.equal(digests.size, 8, 'distinct fixed digests per entry');
  });

  test('control and lifecycle axes follow the phase order', () => {
    assert.deepEqual(LIVE_REPLAY_SCRIPT.map((entry) => entry.control),
      ['shared', 'shared', 'shared', 'human', 'agent', 'shared', 'agent', 'shared']);
    assert.deepEqual(LIVE_REPLAY_SCRIPT.map((entry) => entry.state),
      ['active', 'active', 'active', 'active', 'active', 'active', 'lost', 'active']);
  });

  test('the script is deterministic across repeated builds', () => {
    const first = JSON.stringify(LIVE_REPLAY_SCRIPT);
    const second = JSON.stringify(createLiveReplayHarness().script);
    assert.equal(first, second);
    assert.deepEqual(JSON.parse(first), JSON.parse(second));
  });

  test('replay stays out of the room fixture key set by design', () => {
    assert.equal(FIXTURE_KEYS.includes(LIVE_REPLAY_KEY), false);
    assert.equal(Object.hasOwn(FIXTURES, LIVE_REPLAY_KEY), false);
    assert.equal(isFixtureKey(LIVE_REPLAY_KEY), false);
    assert.equal(isFixtureKey('live-replay '), false);
  });
});

describe('fake authority port contract', () => {
  test('the port exposes exactly the authority methods', () => {
    const { port } = createLiveReplayHarness();
    assert.deepEqual(Object.keys(port).sort(), ['intent', 'propose', 'subscribeFrames']);
  });

  test('every method enforces exact positional arity', () => {
    const { port } = createLiveReplayHarness();
    assert.throws(() => /** @type {any} */ (port.propose)(), /wrong arity/);
    assert.throws(() => /** @type {any} */ (port.propose)('{}', '{}'), /wrong arity/);
    assert.throws(() => /** @type {any} */ (port.intent)(), /wrong arity/);
    assert.throws(() => /** @type {any} */ (port.intent)('{}', '{}'), /wrong arity/);
    assert.throws(() => /** @type {any} */ (port.subscribeFrames)(), /wrong arity/);
    assert.throws(() => /** @type {any} */ (port.subscribeFrames)(() => {}, () => {}), /wrong arity/);
    const stop = /** @type {any} */ (port.subscribeFrames)(() => {});
    assert.throws(() => stop('extra'), /wrong arity/);
    stop();
  });

  test('detached receivers are refused', () => {
    const { port } = createLiveReplayHarness();
    const propose = /** @type {any} */ (port.propose);
    const intent = /** @type {any} */ (port.intent);
    const subscribe = /** @type {any} */ (port.subscribeFrames);
    assert.throws(() => propose('{}'), /invalid receiver/);
    assert.throws(() => intent('{}'), /invalid receiver/);
    assert.throws(() => subscribe(() => {}), /invalid receiver/);
  });

  test('intent acknowledges valid ui_intent bodies with literal true', async () => {
    const { port, calls } = createLiveReplayHarness();
    const reply = await /** @type {any} */ (port.intent)(
      JSON.stringify({ schema: 'ui_intent/v0.2', request_id: 'r', op: 'take_control', params: { surface_id: 'cap-01' } }),
    );
    assert.equal(reply, true);
    assert.equal(reply === true, true, 'literal true, never truthy');
    assert.equal(calls.length, 1);
    assert.ok(Object.isFrozen(calls[0]));
    assert.equal(calls[0].method, 'intent');
  });

  test('intent refuses non-JSON and non-ui_intent bodies', async () => {
    const { port } = createLiveReplayHarness();
    const target = /** @type {any} */ (port);
    const invoke = (/** @type {unknown} */ body) => target.intent(body);
    assert.throws(() => invoke({ op: 'take_control' }), /JSON text/);
    assert.throws(() => invoke('{nope'), /JSON text/);
    assert.throws(() => invoke('[]'), /JSON text/);
    assert.throws(() => invoke('"str"'), /JSON text/);
    assert.throws(() => invoke(JSON.stringify({ op: 'take_control' })), /invalid intent payload/);
    assert.throws(() => invoke(JSON.stringify({ schema: 'ui_intent/v0.1', op: 'take_control' })), /invalid intent payload/);
    assert.throws(() => invoke(JSON.stringify({ schema: 'ui_intent/v0.2' })), /invalid intent payload/);
  });

  test('propose answers admitted, or a typed refusal on refuse:true', async () => {
    const { port } = createLiveReplayHarness();
    const target = /** @type {any} */ (port);
    const invoke = (/** @type {unknown} */ body) => target.propose(body);
    assert.deepEqual(await invoke('{}'), {
      schema: 'action_verdict/v0.2', proposal_id: 'replay-proposal-1', core_seq: 1, decision: 'admitted',
    });
    assert.deepEqual(await invoke(JSON.stringify({ refuse: true })), {
      schema: 'action_verdict/v0.2', proposal_id: 'replay-proposal-1', core_seq: 1, decision: 'refused', reason_code: 'POLICY',
    });
    // Refusal is exact: truthy non-true never flips the verdict.
    assert.equal((await invoke(JSON.stringify({ refuse: 1 }))).decision, 'admitted');
    assert.throws(() => invoke('['), /JSON text/);
    assert.throws(() => invoke(42), /JSON text/);
  });

  test('subscribe delivers in order and honours unsubscribe', () => {
    const harness = createLiveReplayHarness();
    const seen = [];
    const stop = /** @type {any} */ (harness.port.subscribeFrames)((notice) => seen.push(notice));
    assert.throws(() => /** @type {any} */ (harness.port.subscribeFrames)('nope'), /callback required/);
    assert.equal(harness.emitUpTo(3), 3);
    assert.deepEqual(seen, LIVE_REPLAY_SCRIPT.slice(0, 3).map((entry) => entry.notice));
    stop();
    stop();
    assert.equal(harness.emitUpTo(5), 5);
    assert.equal(seen.length, 3, 'unsubscribed listener hears nothing more');
    assert.throws(() => harness.emitUpTo(9), /unknown step/);
    assert.throws(() => harness.emitUpTo(-1), /unknown step/);
  });

  test('answers are promises and calls stay frozen', async () => {
    const { port, calls } = createLiveReplayHarness();
    assert.ok(/** @type {any} */ (port.intent)(
      JSON.stringify({ schema: 'ui_intent/v0.2', op: 'release_control', params: { surface_id: 'cap-01' } }),
    ) instanceof Promise);
    assert.ok(/** @type {any} */ (port.propose)('{}') instanceof Promise);
    assert.deepEqual(calls.map((call) => call.method), ['intent', 'propose']);
    for (const call of calls) assert.ok(Object.isFrozen(call));
  });
});

describe('replay through the real authority runtime', () => {
  /**
   * @param {number} step
   */
  function mountAt(step) {
    const created = createLiveReplayMount(`?state=live-replay&step=${step}`);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('replay mount refused');
    return created.mount;
  }

  test('step 0 is connecting: no rows, no envelope', () => {
    const mount = mountAt(0);
    const snapshot = mount.runtime.projectionView.getSnapshot();
    assert.equal(snapshot.status, 'unavailable');
    assert.equal(snapshot.envelope, null);
    assert.deepEqual(mount.runtime.projectionView.getProjection(), null);
  });

  test('steps 1..3 go live with rising generations', () => {
    for (const step of [1, 2, 3]) {
      const mount = mountAt(step);
      const snapshot = mount.runtime.projectionView.getSnapshot();
      assert.equal(snapshot.status, 'live', `step ${step}`);
      assert.equal(snapshot.stale, false, `step ${step}`);
      assert.equal(snapshot.error, null, `step ${step}`);
      const rows = mount.runtime.projectionView.getProjection()?.rows ?? [];
      assert.equal(rows.length, 1, `step ${step}`);
      assert.equal(rows[0].id, 'cap-01');
      assert.equal(rows[0].surfaceId, 'cap-01');
      assert.equal(rows[0].generation, step);
      assert.equal(rows[0].control, 'shared');
      assert.equal(rows[0].controlOwner, 'none');
      assert.equal(rows[0].backendLifecycle, 'active');
      assert.equal(snapshot.envelope?.revision, step);
    }
  });

  test('step 4 takes human control, step 5 shows the agent acting', () => {
    const human = mountAt(4).runtime.projectionView.getProjection()?.rows ?? [];
    assert.equal(human[0].generation, 4);
    assert.equal(human[0].control, 'human');
    assert.equal(human[0].controlOwner, 'human');
    const agent = mountAt(5).runtime.projectionView.getProjection()?.rows ?? [];
    assert.equal(agent[0].generation, 5);
    assert.equal(agent[0].control, 'agent');
    assert.equal(agent[0].controlOwner, 'agent');
    assert.equal(agent[0].backendLifecycle, 'active');
  });

  test('step 6 absorbs the older generation without applying it', () => {
    const mount = mountAt(6);
    const snapshot = mount.runtime.projectionView.getSnapshot();
    assert.equal(snapshot.status, 'live');
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.error, null);
    const rows = mount.runtime.projectionView.getProjection()?.rows ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].generation, 5, 'older generation never overwrites last-good');
    assert.equal(snapshot.envelope?.revision, 6, 'duplicate advances the revision without touching rows');
  });

  test('step 7 reports lost, step 8 recovers live', () => {
    const lost = mountAt(7);
    const lostSnapshot = lost.runtime.projectionView.getSnapshot();
    assert.equal(lostSnapshot.status, 'live');
    assert.equal(lostSnapshot.stale, false);
    assert.equal(lostSnapshot.error, null);
    const lostRows = lost.runtime.projectionView.getProjection()?.rows ?? [];
    assert.equal(lostRows[0].generation, 6);
    assert.equal(lostRows[0].backendLifecycle, 'lost');
    assert.equal(lostSnapshot.envelope?.revision, 7);
    const recovered = mountAt(8);
    const recoveredRows = recovered.runtime.projectionView.getProjection()?.rows ?? [];
    assert.equal(recoveredRows[0].generation, 7);
    assert.equal(recoveredRows[0].backendLifecycle, 'active');
    assert.equal(recoveredRows[0].control, 'shared');
    assert.equal(recovered.runtime.projectionView.getSnapshot().envelope?.revision, 8);
  });

  test('absent step replays the full script', () => {
    for (const search of ['?state=live-replay', '?state=live-replay&other=1', '']) {
      const created = createLiveReplayMount(search);
      assert.equal(created.ok, true, search);
      if (!created.ok) continue;
      const rows = created.mount.runtime.projectionView.getProjection()?.rows ?? [];
      assert.equal(rows[0]?.generation, 7, search);
      assert.equal(rows[0]?.backendLifecycle, 'active', search);
    }
  });

  test('mounts stay deterministic across repeated builds', () => {
    const first = mountAt(5);
    const second = mountAt(5);
    assert.deepEqual(first.runtime.projectionView.getSnapshot(), second.runtime.projectionView.getSnapshot());
    assert.deepEqual(first.runtime.projectionView.getProjection(), second.runtime.projectionView.getProjection());
    assert.equal(first.fixture, LIVE_REPLAY_FIXTURE);
    assert.equal(second.calls.length, 0);
  });

  test('the mount carries the real runtime surface, never fixture rows', () => {
    const mount = mountAt(5);
    assert.deepEqual(Object.keys(mount).sort(), ['authorityPort', 'calls', 'fixture', 'runtime', 'terminal']);
    assert.equal(mount.terminal, null);
    assert.deepEqual(Object.keys(mount.runtime).sort(),
      ['controlRegistry', 'dispose', 'intentBuilders', 'projectionView', 'scheduler']);
    assert.equal(typeof mount.runtime.dispose, 'function');
    assert.deepEqual(mount.runtime.projectionView.getAllowedSchemas(), ['metaviewer.frame-wall/v1']);
    const body = mount.runtime.intentBuilders.control({ capsuleId: 'cap-01', verb: 'take_control' });
    assert.equal(/** @type {any} */ (body).schema, 'ui_intent/v0.2');
    assert.equal(/** @type {any} */ (body).op, 'take_control');
    assert.deepEqual(/** @type {any} */ (body).params, { surface_id: 'cap-01' });
    assert.equal(typeof /** @type {any} */ (body).request_id, 'string');
    assert.equal('fixture' in /** @type {object} */ (body), false, 'fixture stubs never leak into the replay');
  });

  test('real builder plus real adapter round-trips a true ack on the replay port', async () => {
    const mount = mountAt(5);
    const adapter = createAuthorityAdapter(mount.authorityPort);
    const request = mount.runtime.intentBuilders.control({ capsuleId: 'cap-01', verb: 'release_control' });
    assert.equal(await adapter.intent?.(request), true);
    const admitted = await adapter.propose?.({ schema:'action_proposal/v0.2',proposal_id:'p',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'} });
    assert.equal(admitted?.code, 'ACTION_ADMITTED');
    assert.equal(admitted?.tone, 'success');
    const refused = await adapter.propose?.({ schema:'action_proposal/v0.2',proposal_id:'p',surface_id:'cap-01',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0},action:{type:'click',x:1,y:1,button:'left'},expectation:{type:'state_sha256_change'}, refuse: true });
    assert.equal(refused?.code, 'POLICY');
    assert.equal(refused?.tone, 'refusal');
    assert.doesNotMatch(refused?.message ?? '', /POLICY|ERR_/);
  });

  test('mutated notices are refused by the real runtime', () => {
    /** @type {(notice: unknown) => void} */
    let deliver = () => {};
    const runtime = createAuthorityRuntime({
      subscribeFrames: (callback) => { deliver = callback; return () => {}; },
    });
    assert.ok(runtime);
    if (!runtime) return;
    const clean = LIVE_REPLAY_SCRIPT[0].notice;
    const withPath = {
      frame_ref: { ...clean.frame_ref, ramws_path: '/private/frames/0' },
      surface: clean.surface,
    };
    deliver(withPath);
    assert.equal(runtime.projectionView.getSnapshot().error?.code, 'ERR_FRAME_NOTICE');
    assert.equal(runtime.projectionView.getProjection(), null);
    const v01 = {
      frame_ref: { ...clean.frame_ref, schema: 'frame_ref/v0.1' },
      surface: clean.surface,
    };
    deliver(v01);
    assert.equal(runtime.projectionView.getSnapshot().error?.code, 'ERR_FRAME_NOTICE');
    assert.equal(runtime.projectionView.getProjection(), null);
    deliver(clean);
    assert.equal(runtime.projectionView.getSnapshot().status, 'live');
    assert.equal(runtime.projectionView.getProjection()?.rows[0]?.generation, 1);
    runtime.dispose();
  });

  test('unknown and malformed steps refuse with typed errors', () => {
    for (const search of ['?state=live-replay&step=9', '?state=live-replay&step=100']) {
      const created = createLiveReplayMount(search);
      assert.equal(created.ok, false, search);
      if (!created.ok) {
        assert.equal(created.error.code, 'ERR_UNKNOWN_STEP');
        assert.ok(Object.isFrozen(created.error));
      }
    }
    for (const search of ['?state=live-replay&step=', '?state=live-replay&step=x', '?state=live-replay&step=1&step=2']) {
      const created = createLiveReplayMount(search);
      assert.equal(created.ok, false, search);
      if (!created.ok) assert.equal(created.error.code, 'ERR_INVALID_STEP_QUERY');
      else assert.fail(`${search} must refuse`);
    }
  });
});

describe('parseStepQuery', () => {
  test('canonical steps resolve, absent steps mean the full replay', () => {
    assert.deepEqual(parseStepQuery('?state=live-replay&step=0'), { ok: true, step: 0 });
    assert.deepEqual(parseStepQuery('?step=8'), { ok: true, step: 8 });
    assert.deepEqual(parseStepQuery('step=3'), { ok: true, step: 3 });
    assert.deepEqual(parseStepQuery('?x=1&step=5&y=2'), { ok: true, step: 5 });
    assert.deepEqual(parseStepQuery('?state=live-replay'), { ok: true, step: 8 });
    assert.deepEqual(parseStepQuery(''), { ok: true, step: 8 });
  });

  test('malformed steps are typed refusals', () => {
    for (const search of [null, 42, {}, [], '?step=', '?step=3&step=4', '?step=-1', '?step=02',
      '?step=3.0', '?step=x', '?step=%203', '?step=3%20', '?step=99999999999999999999999']) {
      const parsed = parseStepQuery(/** @type {any} */ (search));
      assert.equal(parsed.ok, false, String(search));
      if (!parsed.ok) {
        assert.equal(parsed.error.code, 'ERR_INVALID_STEP_QUERY', String(search));
        assert.ok(Object.isFrozen(parsed.error));
      } else {
        assert.fail(`${String(search)} must refuse`);
      }
    }
  });

  test('out-of-range steps are unknown steps', () => {
    for (const search of ['?step=9', '?step=10', '?step=100']) {
      const parsed = parseStepQuery(search);
      assert.equal(parsed.ok, false, search);
      if (!parsed.ok) assert.equal(parsed.error.code, 'ERR_UNKNOWN_STEP', search);
      else assert.fail(`${search} must refuse`);
    }
  });
});

describe('replay fixture record', () => {
  test('closed fixture shape with frozen pure data', () => {
    assert.deepEqual(Object.keys(LIVE_REPLAY_FIXTURE).sort(), [
      'capsules', 'density', 'epoch', 'expectedAnchors', 'key', 'revision', 'scheme', 'screen', 'ui',
    ]);
    assert.equal(LIVE_REPLAY_FIXTURE.key, 'live-replay');
    assert.equal(LIVE_REPLAY_FIXTURE.screen, 'wall');
    assert.equal(LIVE_REPLAY_FIXTURE.scheme, 'mv-light');
    assert.equal(LIVE_REPLAY_FIXTURE.density, 'compact');
    assertDeepFrozen(LIVE_REPLAY_FIXTURE);
    assert.deepEqual(JSON.parse(JSON.stringify(LIVE_REPLAY_FIXTURE)).key, 'live-replay');
  });

  test('single replay capsule with immutable identity', () => {
    assert.equal(LIVE_REPLAY_FIXTURE.capsules.length, 1);
    const row = LIVE_REPLAY_FIXTURE.capsules[0];
    assert.equal(row.id, 'cap-01');
    assert.equal(row.surfaceId, 'cap-01');
    assert.ok(row.title.length > 0);
    assert.deepEqual(LIVE_REPLAY_FIXTURE.ui, { liveReplay: true });
  });

  test('expected anchors are unique and kit-admitted', () => {
    const anchors = LIVE_REPLAY_FIXTURE.expectedAnchors.map((row) => row.anchor);
    assert.equal(new Set(anchors).size, anchors.length);
    assert.ok(anchors.includes('capsule/cap-01/panel'));
    // Chrome anchors are room-owned shell; only capsule-scoped families audit
    // against the kit inventory, mirroring the room fixture contract.
    const scoped = auditAnchors(LIVE_REPLAY_FIXTURE.expectedAnchors)
      .filter((row) => row.anchor.startsWith('capsule/'));
    assert.ok(scoped.length > 0);
    for (const row of scoped) {
      assert.equal(row.admitted, true, row.anchor);
      assert.equal(row.roleAdmitted, true, row.anchor);
    }
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
