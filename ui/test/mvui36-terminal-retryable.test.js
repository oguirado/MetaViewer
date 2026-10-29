import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTerminalClient } from '../src/terminal/terminalClient.js';

test('TERM-FIX-3: client survives retryable refusal (MUT_FATAL_ON_RETRYABLE)', () => {
  let receive;
  const sent = [], statuses = [];
  const port = {
    addEventListener(_name, fn) { receive = fn; },
    removeEventListener() {}, start() {}, postMessage(frame) { sent.push(frame); },
  };
  const client = createTerminalClient({ session: 's', port, write() {},
    onStatus: status => statuses.push(status) });
  try {
    receive({ data: { session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 1 } });
    client.input(new Uint8Array([65]));
    assert.deepEqual(sent, [{ session: 's', seq: 1, bytes: new Uint8Array([65]) }]);
    assert.deepEqual(statuses, []);
    receive({ data: { session: 's', error: 'TERMINAL_IO_REFUSED' } });
    client.input(new Uint8Array([66]));
    assert.equal(sent.length, 1);
    assert.deepEqual(statuses, ['TERMINAL_IO_REFUSED']);
  } finally {
    client.dispose();
  }
});

function fixture() {
  let receive;
  const sent = [], writes = [], statuses = [];
  const port = {
    addEventListener(_name, fn) { receive = fn; },
    removeEventListener() { receive = null; }, start() {}, postMessage(frame) { sent.push(frame); },
  };
  const client = createTerminalClient({ session: 's', port,
    write: (bytes, done) => writes.push({ bytes, done }),
    onStatus: status => statuses.push(status) });
  return { client, sent, writes, statuses, deliver: m => receive?.({ data: m }) };
}

test('TERM-FIX-3: malformed retryable frames stay fatal', () => {
  const variants = [
    ['extra key', { session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 1, extra: 0 }],
    ['retryable string', { session: 's', error: 'TERMINAL_IO_REFUSED', retryable: 'true', expectedSeq: 1 }],
    ['expectedSeq 0', { session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 0 }],
    ['expectedSeq -1', { session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: -1 }],
    ['expectedSeq 1.5', { session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 1.5 }],
    ['expectedSeq missing', { session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true }],
    ['other error code', { session: 's', error: 'TERMINAL_UNKNOWN_SESSION', retryable: true, expectedSeq: 1 }],
  ];
  for (const [label, frame] of variants) {
    const f = fixture();
    try {
      f.deliver(frame);
      f.client.input(new Uint8Array([65]));
      assert.equal(f.sent.length, 0, `${label}: no input after fatal refusal`);
      assert.deepEqual(f.statuses, [frame.error], `${label}: fatal status text`);
    } finally {
      f.client.dispose();
    }
  }
});

test('TERM-FIX-3: retryable refusal for another session is a binding refusal', () => {
  const f = fixture();
  try {
    f.deliver({ session: 'other', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 1 });
    f.client.input(new Uint8Array([65]));
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.statuses, ['Terminal binding refused']);
  } finally {
    f.client.dispose();
  }
});

test('TERM-FIX-3: two successive retryable refusals, last expectedSeq wins', () => {
  const f = fixture();
  try {
    f.deliver({ session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 3 });
    f.deliver({ session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 7 });
    f.client.input(new Uint8Array([65]));
    assert.deepEqual(f.sent, [{ session: 's', seq: 7, bytes: new Uint8Array([65]) }]);
    assert.deepEqual(f.statuses, []);
  } finally {
    f.client.dispose();
  }
});

test('TERM-FIX-3: input seq keeps incrementing from expectedSeq', () => {
  const f = fixture();
  try {
    f.client.input(new Uint8Array([64]));
    f.deliver({ session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 5 });
    f.client.input(new Uint8Array([65]));
    f.client.input(new Uint8Array([66]));
    assert.deepEqual(f.sent.map(frame => frame.seq), [1, 5, 6]);
    assert.deepEqual(f.statuses, []);
  } finally {
    f.client.dispose();
  }
});

test('TERM-FIX-3: output stream still works after a retryable refusal', () => {
  const f = fixture();
  try {
    f.deliver({ session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 1 });
    f.deliver({ session: 's', seq: 1, bytes: new Uint8Array([1, 2]) });
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].bytes, new Uint8Array([1, 2]));
    f.writes[0].done();
    assert.deepEqual(f.sent, [{ session: 's', ack: 1, bytes: 2 }]);
    assert.deepEqual(f.statuses, []);
  } finally {
    f.client.dispose();
  }
});

test('TERM-FIX-3: MUT_FATAL_ON_RETRYABLE mutant fails the retryable scenario', async () => {
  const source = readFileSync(new URL('../src/terminal/terminalClient.js', import.meta.url), 'utf8');
  const anchor = 'inputSeq=m.expectedSeq-1;return;';
  assert.ok(source.includes(anchor), 'retryable-resync anchor must exist in the fixed source');
  const mutantSource = source.replace(
    anchor,
    '/* MUT_FATAL_ON_RETRYABLE */active=false;onStatus(m.error);return;',
  );
  assert.notEqual(mutantSource, source, 'negative control must change the source');
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}#mut-fatal-on-retryable`);
  let receive;
  const sent = [], statuses = [];
  const port = {
    addEventListener(_name, fn) { receive = fn; },
    removeEventListener() {}, start() {}, postMessage(frame) { sent.push(frame); },
  };
  const client = mutant.createTerminalClient({ session: 's', port, write() {},
    onStatus: status => statuses.push(status) });
  try {
    receive({ data: { session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 1 } });
    client.input(new Uint8Array([65]));
    assert.equal(sent.length, 0, 'mutant must not send after a retryable refusal');
    assert.deepEqual(statuses, ['TERMINAL_IO_REFUSED'], 'mutant must go fatal on a retryable refusal');
  } finally {
    client.dispose();
  }
  assert.throws(() => {
    let r2;
    const sent2 = [], statuses2 = [];
    const port2 = {
      addEventListener(_name, fn) { r2 = fn; },
      removeEventListener() {}, start() {}, postMessage(frame) { sent2.push(frame); },
    };
    const client2 = mutant.createTerminalClient({ session: 's', port: port2, write() {},
      onStatus: status => statuses2.push(status) });
    try {
      r2({ data: { session: 's', error: 'TERMINAL_IO_REFUSED', retryable: true, expectedSeq: 1 } });
      client2.input(new Uint8Array([65]));
      assert.deepEqual(sent2, [{ session: 's', seq: 1, bytes: new Uint8Array([65]) }]);
      assert.deepEqual(statuses2, []);
    } finally {
      client2.dispose();
    }
  }, assert.AssertionError, 'MUT_FATAL_ON_RETRYABLE must fail the retryable scenario');
});
