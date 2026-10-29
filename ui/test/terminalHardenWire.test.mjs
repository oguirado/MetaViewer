import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { installAuthorityWire } from '../electron/authorityWire.js';
import { createTerminalHost } from '../electron/terminalHost.js';
import { installReadOnlyLayout } from '../electron/nesting.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';

function sender(id) {
  return {
    id,
    mainFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` },
    isDestroyed: () => false,
    postMessage() {},
  };
}

function wireFor(t, contents, terminal) {
  const handlers = new Map();
  const wire = installAuthorityWire({
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      removeHandler: (channel) => handlers.delete(channel),
    },
    contents, terminal, core: { request: async () => true }, env: {}, argv: [],
  });
  t.after(() => wire.dispose());
  return (method, value) => handlers.get(`metaviewer:side-terminal.${method}`)(
    { sender: contents, senderFrame: contents.mainFrame }, value,
  );
}

test('authority wire binds terminal sessions to the opening sender across admitted windows', async (t) => {
  const handles = [];
  const terminal = createTerminalHost({
    pty: {
      spawn() {
        let onExit = () => {};
        const handle = {
          pid: 41000 + handles.length, resizes: [], killed: false,
          onData() {}, onExit(fn) { onExit = fn; }, write() {},
          resize(cols, rows) { this.resizes.push([cols, rows]); },
          kill() { this.killed = true; onExit({ exitCode: 0 }); },
        };
        handles.push(handle);
        return handle;
      },
    },
    createMessageChannel: () => new MessageChannel(),
    env: process.env,
  });
  t.after(() => terminal.dispose());
  const a = wireFor(t, sender(101), terminal);
  const b = wireFor(t, sender(102), terminal);
  await a('enabled', true);
  const { session } = await a('open', { command: 'shell', cols: 80, rows: 24 });

  await assert.rejects(b('attach', { session }), /TERMINAL_IO_REFUSED: SENDER/);
  await assert.rejects(b('resize', { session, cols: 100, rows: 30 }), /TERMINAL_IO_REFUSED: SENDER/);
  await assert.rejects(b('close', { session }), /TERMINAL_IO_REFUSED: SENDER/);
  assert.deepEqual(handles[0].resizes, []);
  assert.equal(handles[0].killed, false);

  const { port } = await a('attach', { session });
  t.after(() => port.close());
  assert.equal(await a('resize', { session, cols: 120, rows: 40 }), true);
  assert.deepEqual(handles[0].resizes, [[120, 40]]);
  assert.equal(await a('close', { session }), true);
  assert.equal(handles[0].killed, true);
});

test('nested read-only layout explicitly refuses every side-terminal channel', async () => {
  const contents = sender(103);
  const handlers = new Map();
  const registered = installReadOnlyLayout({ handle: (channel, fn) => handlers.set(channel, fn) }, contents);
  // Keep the contract list independent of the production refusal list.
  for (const method of ['open', 'enabled', 'attach', 'resize', 'close', 'providers', 'copy']) {
    const channel = `metaviewer:side-terminal.${method}`;
    assert.ok(registered.includes(channel), `${channel} must be registered`);
    const handler = handlers.get(channel);
    await assert.rejects(async () => handler(
      { sender: contents, senderFrame: contents.mainFrame },
      { session: 'test-session', cols: 80, rows: 24, text: 'test' },
    ), /DISPLAY_ONLY/, channel);
  }
});
