import test from 'node:test';
import assert from 'node:assert/strict';
import { createSideTerminalFacade } from '../src/terminal/sideTerminalFacade.js';
function fixture() {
  let listener;
  const sent = [], data = [], exits = [];
  const port = { postMessage: message => sent.push(message), start() {},
    addEventListener: (_, receive) => { listener = receive; }, removeEventListener() { listener = null; } };
  const facade = createSideTerminalFacade({ session: 's', port });
  facade.onData(frame => data.push(frame)); facade.onExit(event => exits.push(event));
  return { facade, sent, data, exits, deliver: value => listener?.({ data: value }) };
}
test('overlay reattaches only the injected session; parser credit and input retain the port protocol', async () => {
  const f = fixture();
  assert.deepEqual(await f.facade.capabilities(), { developerMode: true, commands: [] });
  assert.equal((await f.facade.attach()).sessions[0].session, 's');
  f.deliver({ session: 's', seq: 1, bytes: new Uint8Array([65, 66]) });
  assert.deepEqual(f.data, [{ session: 's', seq: 1, bytes: [65, 66], byteLength: 2 }]);
  assert.deepEqual(f.sent, []);
  assert.throws(() => f.facade.ack({ session: 's', seq: 1, bytes: 3 }), /credit refused/);
  f.facade.ack({ session: 's', seq: 1, bytes: 2 });
  assert.deepEqual(f.sent, [{ session: 's', ack: 1, bytes: 2 }]);
  f.facade.write({ session: 's', bytes: [67] });
  assert.deepEqual(f.sent[1], { session: 's', seq: 1, bytes: new Uint8Array([67]) });
  assert.throws(() => f.facade.write({ session: 'other', bytes: [] }), /refused/);
  f.facade.resize({ session: 's', cols: 80, rows: 24 });
  assert.deepEqual(f.sent[2], { session: 's', cols: 80, rows: 24 });
  f.facade.close({ session: 's' });
  f.deliver({ session: 's', seq: 2, bytes: new Uint8Array([68]) });
  assert.equal(f.data.length, 1);
  assert.equal(f.sent.length, 3, 'view detach never sends a process lifecycle command');
});
test('malformed output disconnects and never reaches the kit parser', async () => {
  const f = fixture(); await f.facade.attach();
  f.deliver({ session: 's', seq: 2, bytes: new Uint8Array([65]) });
  assert.equal(f.data.length, 0); assert.equal(f.exits.length, 1);
  assert.equal(f.sent.length, 0);
});
