import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';

import { createTerminalHost } from '../electron/terminalHost.js';
import * as ptyBroker from '../electron/ptyBroker.js';
import { createPreloadFacade, installPreload } from '../electron/preload.js';

function createFakePty({ deferKillExit = false } = {}) {
  const handles = [];
  let nextPid = 41000;
  return {
    handles,
    spawn(file, args, opts) {
      let onData = () => {};
      let onExit = () => {};
      const handle = {
        pid: nextPid++,
        file,
        args,
        opts,
        writes: [],
        resizes: [],
        killed: false,
        onData(fn) {
          onData = fn;
        },
        onExit(fn) {
          onExit = fn;
        },
        write(data) {
          this.writes.push(data);
        },
        resize(cols, rows) {
          this.resizes.push([cols, rows]);
        },
        kill() {
          this.killed = true;
          if (!deferKillExit) {
            onExit({ exitCode: 0 });
          }
        },
        emitData(data) {
          onData(data);
        },
        emitExit(exitCode = 0) {
          onExit({ exitCode });
        },
      };
      handles.push(handle);
      return handle;
    },
  };
}

function nextPortFrame(port) {
  return new Promise((resolve) => {
    port.once('message', (ev) => resolve(ev?.data ?? ev));
  });
}

test('dead shell-string builder buildProviderExecCommand is removed from ptyBroker', () => {
  assert.equal('buildProviderExecCommand' in ptyBroker, false);
});

test('B1: attached session port accepts valid {session,cols,rows} resize frames and refuses malformed resize without killing session', async () => {
  const pty = createFakePty();
  const host = createTerminalHost({
    pty,
    createMessageChannel: () => new MessageChannel(),
    env: { PATH: '/usr/bin', HOME: '/tmp' },
  });
  let port = null;
  try {
    await host.setEnabled(true);
    const { session } = await host.open({ command: 'shell', cols: 80, rows: 24 });
    ({ port } = await host.attach({ session }));
    port.start?.();

    // Valid port resize within [2..500] x [2..300] is forwarded to the PTY without closing.
    port.postMessage({ session, cols: 132, rows: 43 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pty.handles[0].killed, false);
    assert.deepEqual(pty.handles[0].resizes, [[132, 43]]);

    // Malformed port resize (out-of-range dims or extra property) emits TERMINAL_IO_REFUSED without killing the session.
    const errFramePromise = nextPortFrame(port);
    port.postMessage({ session, cols: 1, rows: 43 });
    const errFrame = await errFramePromise;
    assert.deepEqual(errFrame, { session, error: 'TERMINAL_IO_REFUSED' });
    assert.equal(pty.handles[0].killed, false);

    const errExtraPromise = nextPortFrame(port);
    port.postMessage({ session, cols: 100, rows: 30, extra: true });
    const errExtra = await errExtraPromise;
    assert.deepEqual(errExtra, { session, error: 'TERMINAL_IO_REFUSED' });
    assert.equal(pty.handles[0].killed, false);

    // Session remains alive and accepts subsequent port resize and write frames.
    port.postMessage({ session, cols: 120, rows: 40 });
    port.postMessage({ session, seq: 1, bytes: new TextEncoder().encode('ok\n') });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pty.handles[0].killed, false);
    assert.deepEqual(pty.handles[0].resizes, [
      [132, 43],
      [120, 40],
    ]);
    assert.deepEqual(pty.handles[0].writes, ['ok\n']);
  } finally {
    port?.close?.();
    await host.dispose();
  }
});

test('B2: unattached sessions expire at attach deadline, pre-attach queue cap faults on excess, and dispose settles in-flight close()', async () => {
  // 1. Attach deadline expires unattached sessions and frees all 8 broker slots.
  const ptyDeadline = createFakePty();
  const hostDeadline = createTerminalHost({
    pty: ptyDeadline,
    createMessageChannel: () => new MessageChannel(),
    env: { PATH: '/usr/bin', HOME: '/tmp' },
    attachDeadlineMs: 40,
  });
  try {
    await hostDeadline.setEnabled(true);
    const unattached = [];
    for (let i = 0; i < 8; i += 1) {
      unattached.push(await hostDeadline.open({ command: 'shell', cols: 80, rows: 24 }));
    }
    assert.equal(ptyDeadline.handles.length, 8);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(
      ptyDeadline.handles.every((h) => h.killed),
      true,
      'all 8 unattached PTY handles must be killed after attach deadline',
    );
    // Broker slot is freed so a 9th open succeeds.
    const ninth = await hostDeadline.open({ command: 'shell', cols: 80, rows: 24 });
    assert.match(ninth.session, /^[0-9a-f-]{36}$/);
  } finally {
    await hostDeadline.dispose();
  }

  // 2. Pre-attach queue cap faults and closes session when unattached output exceeds cap.
  const ptyQueueCap = createFakePty();
  const hostQueueCap = createTerminalHost({
    pty: ptyQueueCap,
    createMessageChannel: () => new MessageChannel(),
    env: { PATH: '/usr/bin', HOME: '/tmp' },
    attachDeadlineMs: 5000,
    maxPreAttachFrames: 3,
    maxPreAttachBytes: 128,
  });
  try {
    await hostQueueCap.setEnabled(true);
    const { session: cappedSession } = await hostQueueCap.open({ command: 'shell', cols: 80, rows: 24 });
    ptyQueueCap.handles[0].emitData('x'.repeat(200));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ptyQueueCap.handles[0].killed, true);
    await assert.rejects(() => hostQueueCap.attach({ session: cappedSession }), /TERMINAL_UNKNOWN_SESSION/);
  } finally {
    await hostQueueCap.dispose();
  }

  // 3. dispose() settles an in-flight close() when broker dispose races with close().
  /** @type {Promise<any> | null} */
  let closePromise = null;
  /** @type {any} */
  let hostDispose = null;
  let closingSession = '';
  const ptyDispose = {
    spawn(file, args, opts) {
      return {
        pid: 49999,
        file,
        args,
        opts,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {
          if (!closePromise && hostDispose && closingSession) {
            closePromise = hostDispose.close({ session: closingSession });
          }
        },
      };
    },
  };
  hostDispose = createTerminalHost({
    pty: ptyDispose,
    createMessageChannel: () => new MessageChannel(),
    env: { PATH: '/usr/bin', HOME: '/tmp' },
  });
  try {
    await hostDispose.setEnabled(true);
    ({ session: closingSession } = await hostDispose.open({ command: 'shell', cols: 80, rows: 24 }));
    await hostDispose.dispose();
    assert.ok(closePromise, 'close() must be invoked during dispose()');
    const closeOutcome = await Promise.race([
      closePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('close() hung across dispose()')), 200)),
    ]);
    assert.equal(closeOutcome, true);
  } finally {
    await hostDispose.dispose();
  }
});

test('B3: per-session token bucket throttles resize and write bursts without killing the session', async () => {
  let clockMs = 1_000_000;
  const pty = createFakePty();
  const host = createTerminalHost({
    pty,
    createMessageChannel: () => new MessageChannel(),
    env: { PATH: '/usr/bin', HOME: '/tmp' },
    now: () => clockMs,
    resizeBurst: 3,
    resizePerSec: 3,
    writeBytesBurst: 65536,
    writeBytesPerSec: 65536,
    writeOpsBurst: 3,
    writeOpsPerSec: 3,
  });
  let port = null;
  try {
    await host.setEnabled(true);
    const { session } = await host.open({ command: 'shell', cols: 80, rows: 24 });
    ({ port } = await host.attach({ session }));
    port.start?.();

    // Burst 3 IPC resizes (within burst=3) -> admitted; 4th IPC resize in same window -> refused without killing session.
    await host.resize({ session, cols: 90, rows: 25 });
    await host.resize({ session, cols: 91, rows: 25 });
    await host.resize({ session, cols: 92, rows: 25 });
    await assert.rejects(() => host.resize({ session, cols: 93, rows: 25 }), /TERMINAL_IO_REFUSED/);
    assert.equal(pty.handles[0].killed, false);

    // Port resize when bucket is empty emits TERMINAL_IO_REFUSED on port without killing session.
    const resizeRateErrP = nextPortFrame(port);
    port.postMessage({ session, cols: 94, rows: 25 });
    assert.deepEqual(await resizeRateErrP, { session, error: 'TERMINAL_IO_REFUSED' });
    assert.equal(pty.handles[0].killed, false);

    // Burst 64 KiB port write consumes the 65536-byte bucket; immediate second 64 KiB write is throttled without killing session.
    const chunk64k = new Uint8Array(65536).fill(65);
    port.postMessage({ session, seq: 1, bytes: chunk64k });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(pty.handles[0].writes.length, 1);
    assert.equal(pty.handles[0].killed, false);

    const writeRateErrP = nextPortFrame(port);
    port.postMessage({ session, seq: 2, bytes: chunk64k });
    assert.deepEqual(await writeRateErrP, { session, error: 'TERMINAL_IO_REFUSED' });
    assert.equal(pty.handles[0].writes.length, 1);
    assert.equal(pty.handles[0].killed, false);

    // Advance clock by 1 second: buckets refill and session accepts both resize and write again.
    clockMs += 1000;
    await host.resize({ session, cols: 100, rows: 30 });
    port.postMessage({ session, seq: 3, bytes: new TextEncoder().encode('alive') });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(pty.handles[0].killed, false);
    assert.deepEqual(pty.handles[0].resizes.at(-1), [100, 30]);
    assert.equal(pty.handles[0].writes.at(-1), 'alive');
  } finally {
    port?.close?.();
    await host.dispose();
  }
});

test('B4: terminal sessions bind to opener sender identity and refuse cross-sender attach/resize/close', async () => {
  // 1. terminalHost sender binding
  const pty = createFakePty();
  const host = createTerminalHost({
    pty,
    createMessageChannel: () => new MessageChannel(),
    env: { PATH: '/usr/bin', HOME: '/tmp' },
  });
  let port = null;
  try {
    await host.setEnabled(true);
    const senderA = { id: 101 };
    const senderB = { id: 202 };
    const { session } = await host.open({ command: 'shell', cols: 80, rows: 24 }, senderA);

    await assert.rejects(() => host.attach({ session }, senderB), /TERMINAL_IO_REFUSED/);
    await assert.rejects(() => host.resize({ session, cols: 100, rows: 30 }, senderB), /TERMINAL_IO_REFUSED/);
    await assert.rejects(() => host.close({ session }, senderB), /TERMINAL_IO_REFUSED/);
    assert.equal(pty.handles[0].killed, false);

    // Opener sender A succeeds on attach, resize, and close.
    ({ port } = await host.attach({ session }, senderA));
    await host.resize({ session, cols: 100, rows: 30 }, senderA);
    assert.deepEqual(pty.handles[0].resizes, [[100, 30]]);
    await host.close({ session }, senderA);
    assert.equal(pty.handles[0].killed, true);
  } finally {
    port?.close?.();
    await host.dispose();
  }

  // 2. preload facade sender binding across two facade instances sharing a session id
  const invokeHandler = async (channel) => {
    if (channel === 'metaviewer:side-terminal.open') return { session: 'sess-bound-1' };
    if (channel === 'metaviewer:side-terminal.attach') return { port: { postMessage() {}, close() {} } };
    return true;
  };
  let facadeA;
  let facadeB;
  createPreloadFacade({
    transport: { invoke: invokeHandler, subscribe: () => () => {} },
    bridge: { exposeInMainWorld: (_n, api) => { facadeA = api; } },
  });
  createPreloadFacade({
    transport: { invoke: invokeHandler, subscribe: () => () => {} },
    bridge: { exposeInMainWorld: (_n, api) => { facadeB = api; } },
  });
  const opened = await facadeA.sideTerminal.open({ command: 'shell', cols: 80, rows: 24 });
  assert.equal(opened.session, 'sess-bound-1');
  await assert.rejects(() => facadeB.sideTerminal.resize({ session: 'sess-bound-1', cols: 90, rows: 24 }), /TERMINAL_IO_REFUSED/);
  await assert.rejects(() => facadeB.sideTerminal.close({ session: 'sess-bound-1' }), /TERMINAL_IO_REFUSED/);
  await assert.doesNotReject(() => facadeA.sideTerminal.resize({ session: 'sess-bound-1', cols: 90, rows: 24 }));
  await assert.doesNotReject(() => facadeA.sideTerminal.close({ session: 'sess-bound-1' }));
});

test('B5: nested display explicitly refuses all side-terminal channels with DISPLAY_ONLY', async () => {
  // 1. Preload facade in nested mode refuses all 7 side-terminal methods with DISPLAY_ONLY.
  let invoked = false;
  let nestedFacade;
  createPreloadFacade({
    transport: {
      nested: true,
      invoke: async () => {
        invoked = true;
        return { ok: true };
      },
      subscribe: () => () => {},
    },
    bridge: {
      exposeInMainWorld: (_name, api) => {
        nestedFacade = api;
      },
    },
  });

  const preloadCalls = [
    () => nestedFacade.sideTerminal.open({ command: 'shell', cols: 80, rows: 24 }),
    () => nestedFacade.sideTerminal.setEnabled(true),
    () => nestedFacade.sideTerminal.attach({ session: 'sess-1' }),
    () => nestedFacade.sideTerminal.resize({ session: 'sess-1', cols: 80, rows: 24 }),
    () => nestedFacade.sideTerminal.close({ session: 'sess-1' }),
    () => nestedFacade.sideTerminal.listProviders(),
    () => nestedFacade.sideTerminal.copyText({ text: 'capsule-1' }),
  ];
  for (const call of preloadCalls) {
    await assert.rejects(
      call,
      (err) => err && (err.code === 'DISPLAY_ONLY' || /DISPLAY_ONLY/.test(String(err.message))),
    );
  }
  assert.equal(invoked, false);

  // 2. terminalHost in nested mode refuses all 7 side-terminal methods with DISPLAY_ONLY.
  const nestedHost = createTerminalHost({
    pty: createFakePty(),
    createMessageChannel: () => new MessageChannel(),
    env: { PATH: '/usr/bin', HOME: '/tmp' },
    nested: true,
  });
  const hostCalls = [
    () => nestedHost.open({ command: 'shell', cols: 80, rows: 24 }),
    () => nestedHost.setEnabled(true),
    () => nestedHost.attach({ session: 'sess-1' }),
    () => nestedHost.resize({ session: 'sess-1', cols: 80, rows: 24 }),
    () => nestedHost.close({ session: 'sess-1' }),
    () => nestedHost.listProviders(),
    () => nestedHost.copyText({ text: 'capsule-1' }),
  ];
  for (const call of hostCalls) {
    await assert.rejects(
      call,
      (err) => err && (err.code === 'DISPLAY_ONLY' || /DISPLAY_ONLY/.test(String(err.message))),
    );
  }
  await nestedHost.dispose();

  // 3. installPreload with --nested-depth=1 in navigator.userAgent refuses side-terminal channels with DISPLAY_ONLY.
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Electron --nested-depth=1' },
    configurable: true,
  });
  try {
    const installed = installPreload({
      contextBridge: { exposeInMainWorld() {} },
      ipcRenderer: {
        invoke: async () => ({ ok: true }),
        on() {},
        removeListener() {},
      },
    });
    await assert.rejects(
      () => installed.sideTerminal.attach({ session: 'sess-1' }),
      (err) => err && err.code === 'DISPLAY_ONLY',
    );
  } finally {
    if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav);
    else delete globalThis.navigator;
  }
});
