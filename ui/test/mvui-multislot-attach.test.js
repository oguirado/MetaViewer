import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MULTISLOT_ATTACH_EPOCH,
  MULTISLOT_ATTACH_GENERATION,
  createMultislotPump,
} from '../src/multislot/multislotAttach.js';

function doubles({ mode = 'read' } = {}) {
  const calls = { createSession: [], beginAttach: [], restore: [], chunks: [], leases: [], disposed: [], forgotten: [], closed: [] };
  const listeners = { data: new Set(), exit: new Set() };
  const registry = {
    createSession: (config) => { calls.createSession.push(config); },
    beginAttach: (params) => { calls.beginAttach.push(params); },
    applyRestoreSnapshot: (params) => { calls.restore.push(params); },
    writeOutputChunk: (params) => { calls.chunks.push(params); },
    setControlLease: (params) => { calls.leases.push(params); },
    disposeSession: (id) => { calls.disposed.push(id); },
    forgetSession: (id) => { calls.forgotten.push(id); },
  };
  const facade = {
    onData: (receive) => { listeners.data.add(receive); return () => listeners.data.delete(receive); },
    onExit: (receive) => { listeners.exit.add(receive); return () => listeners.exit.delete(receive); },
    close: (request) => { calls.closed.push(request); },
  };
  let liveMode = mode;
  const events = [];
  const pump = createMultislotPump({
    facade,
    registry,
    capsuleId: 'cap-01',
    getInputMode: () => liveMode,
    onEvent: (event) => events.push(event),
  });
  return {
    calls, listeners, events, pump,
    setMode: (next) => { liveMode = next; },
    deliver: (frame) => { for (const receive of [...listeners.data]) receive(frame); },
    exit: (event) => { for (const receive of [...listeners.exit]) receive(event); },
  };
}

const ATTACHMENT = Object.freeze({
  session: 'sess-01', command: 'session', seq: 0, ackedSeq: 0, bytes: 0, replay: [], title: 't', kind: 'k',
});

test('attach runs the kit sequence: createSession, beginAttach, restore snapshot', () => {
  const f = doubles({ mode: 'write' });
  assert.equal(MULTISLOT_ATTACH_EPOCH, 1);
  assert.equal(MULTISLOT_ATTACH_GENERATION, 1);
  assert.equal(f.pump.attachSession({ ...ATTACHMENT }), 'sess-01');
  assert.deepEqual(f.calls.createSession, [{
    sessionId: 'sess-01', capsuleId: 'cap-01', epoch: 1, generation: 1, mode: 'pty', hasControlLease: true,
  }]);
  assert.deepEqual(f.calls.beginAttach, [{ sessionId: 'sess-01', epoch: 1, attachmentId: 'sess-01' }]);
  assert.equal(f.calls.restore.length, 1);
  assert.deepEqual({ ...f.calls.restore[0], snapshotData: [...f.calls.restore[0].snapshotData] }, {
    sessionId: 'sess-01', epoch: 1, attachmentId: 'sess-01', snapshotCursorSeq: 0, snapshotData: [],
  });
  assert.deepEqual(f.pump.sessionIds(), ['sess-01']);
});

test('attach starts lease-off in READ mode and lease-on in WRITE mode', () => {
  const read = doubles({ mode: 'read' });
  read.pump.attachSession({ ...ATTACHMENT });
  assert.equal(read.calls.createSession[0].hasControlLease, false);
  const write = doubles({ mode: 'write' });
  write.pump.attachSession({ ...ATTACHMENT });
  assert.equal(write.calls.createSession[0].hasControlLease, true);
});

test('malformed attachments throw and attach nothing (negative controls)', () => {
  for (const bad of [
    { ...ATTACHMENT, session: '' },
    { ...ATTACHMENT, command: '' },
    { ...ATTACHMENT, seq: -1 },
    { ...ATTACHMENT, bytes: -2 },
    { ...ATTACHMENT, replay: [256] },
    { ...ATTACHMENT, replay: new Array(131073).fill(0) },
    null,
  ]) {
    const f = doubles();
    assert.throws(() => f.pump.attachSession(bad), /Invalid terminal attachment/);
    assert.equal(f.calls.createSession.length, 0);
  }
  const dup = doubles();
  dup.pump.attachSession({ ...ATTACHMENT });
  assert.throws(() => dup.pump.attachSession({ ...ATTACHMENT }), /Invalid terminal attachment/);
  assert.throws(
    () => createMultislotPump({ facade: {}, registry: {}, capsuleId: 'cap-01', getInputMode: () => 'read' }),
    TypeError,
  );
});

test('invalid pump capsule id refuses the pump', () => {
  const f = doubles();
  assert.throws(
    () => createMultislotPump({
      facade: { onData: () => () => {}, onExit: () => () => {}, close: () => {} },
      registry: { createSession: () => {}, writeOutputChunk: () => {} },
      capsuleId: 'not an id',
      getInputMode: () => 'read',
    }),
    /Invalid terminal attachment/,
  );
  assert.deepEqual(f.pump.sessionIds(), []);
});

test('contiguous frames reach the registry; unknown sessions are silently ignored', () => {
  const f = doubles();
  f.pump.attachSession({ ...ATTACHMENT });
  f.deliver({ session: 'sess-01', seq: 1, bytes: [65, 66], byteLength: 2 });
  assert.equal(f.calls.chunks.length, 1);
  assert.deepEqual({ ...f.calls.chunks[0], data: [...f.calls.chunks[0].data] }, {
    sessionId: 'sess-01', epoch: 1, attachmentId: 'sess-01', startSeq: 0, endSeq: 1, data: [65, 66],
  });
  f.deliver({ session: 'ghost', seq: 1, bytes: [65], byteLength: 1 });
  assert.equal(f.calls.chunks.length, 1);
  assert.deepEqual(f.events, []);
});

test('sequence gap or malformed frame fails the session: lease off, view detached, typed event', () => {
  const gap = doubles();
  gap.pump.attachSession({ ...ATTACHMENT });
  gap.deliver({ session: 'sess-01', seq: 2, bytes: [65], byteLength: 1 });
  assert.deepEqual(gap.events, [{ type: 'failed', sessionId: 'sess-01' }]);
  assert.deepEqual(gap.calls.leases, [{ sessionId: 'sess-01', epoch: 1, hasControlLease: false }]);
  assert.deepEqual(gap.calls.closed, [{ session: 'sess-01' }]);
  assert.equal(gap.calls.chunks.length, 0);

  const mismatch = doubles();
  mismatch.pump.attachSession({ ...ATTACHMENT });
  mismatch.deliver({ session: 'sess-01', seq: 1, bytes: [65], byteLength: 2 });
  assert.deepEqual(mismatch.events, [{ type: 'failed', sessionId: 'sess-01' }]);

  const failed = doubles();
  failed.pump.attachSession({ ...ATTACHMENT });
  failed.deliver({ session: 'sess-01', seq: 2, bytes: [65], byteLength: 1 });
  failed.deliver({ session: 'sess-01', seq: 3, bytes: [66], byteLength: 1 });
  assert.equal(failed.calls.chunks.length, 0, 'failed sessions accept no further frames');
});

test('broker exit reports exited and leases off without detaching twice', () => {
  const f = doubles();
  f.pump.attachSession({ ...ATTACHMENT });
  f.exit({ session: 'sess-01', reason: 'done' });
  assert.deepEqual(f.events, [{ type: 'exited', sessionId: 'sess-01' }]);
  assert.deepEqual(f.calls.leases, [{ sessionId: 'sess-01', epoch: 1, hasControlLease: false }]);
  assert.deepEqual(f.calls.closed, []);
});

test('syncLease reprograms the live mode; closeSession removes exactly one session', () => {
  const f = doubles({ mode: 'read' });
  f.pump.attachSession({ ...ATTACHMENT });
  f.pump.attachSession({ ...ATTACHMENT, session: 'sess-02', command: 'session' });
  f.setMode('write');
  f.pump.syncLease();
  assert.deepEqual(f.calls.leases, [
    { sessionId: 'sess-01', epoch: 1, hasControlLease: true },
    { sessionId: 'sess-02', epoch: 1, hasControlLease: true },
  ]);
  assert.equal(f.pump.closeSession('sess-01'), true);
  assert.equal(f.pump.closeSession('sess-01'), false);
  assert.deepEqual(f.pump.sessionIds(), ['sess-02']);
  assert.deepEqual(f.calls.closed, [{ session: 'sess-01' }]);
  assert.deepEqual(f.calls.disposed, ['sess-01']);
  assert.deepEqual(f.calls.forgotten, ['sess-01']);
});

test('dispose unsubscribes, leases off and detaches every session exactly once', () => {
  const f = doubles();
  f.pump.attachSession({ ...ATTACHMENT });
  assert.equal(f.listeners.data.size, 1);
  assert.equal(f.listeners.exit.size, 1);
  f.pump.dispose();
  assert.equal(f.listeners.data.size, 0);
  assert.equal(f.listeners.exit.size, 0);
  assert.deepEqual(f.calls.closed, [{ session: 'sess-01' }]);
  assert.deepEqual(f.pump.sessionIds(), []);
  assert.throws(() => f.pump.attachSession({ ...ATTACHMENT }), /Invalid terminal attachment/);
  f.pump.dispose();
  assert.equal(f.calls.closed.length, 1, 'second dispose detaches nothing more');
});
