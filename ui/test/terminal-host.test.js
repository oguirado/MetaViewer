import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { createTerminalHost } from '../electron/terminalHost.js';
import { createPtySession } from '../electron/ptySession.js';
import { MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, runBroker } from '../electron/ptyBroker.js';
import { installAuthorityWire, SIDE_TERMINAL_CHANNELS, WIRE_CHANNELS } from '../electron/authorityWire.js';
import { createPreloadFacade, installPreload } from '../electron/preload.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';
import { createTerminalClient } from '../src/terminal/terminalClient.js';
import { createProviderMenu } from '../src/terminal/providers.js';

async function createWireHarness(t, { profiles = new Map(), pty = null, clipboard = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mv-termhost-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copied = [];
  const clip = clipboard ?? {
    writeText(text) {
      copied.push(text);
    },
  };
  const spawned = [];
  const fakePty = pty ?? {
    spawn(file, args, opts) {
      const listeners = { data: [], exit: [] };
      const writes = [];
      const resizes = [];
      let killed = false;
      const handle = {
        pid: 40000 + spawned.length,
        file,
        args,
        opts,
        writes,
        resizes,
        get killed() {
          return killed;
        },
        onData(fn) {
          listeners.data.push(fn);
          return { dispose() {} };
        },
        onExit(fn) {
          listeners.exit.push(fn);
          return { dispose() {} };
        },
        write(data) {
          writes.push(data);
          if (String(data).includes('echo ok')) {
            for (const fn of listeners.data) fn('ok\r\n');
          }
        },
        resize(cols, rows) {
          resizes.push([cols, rows]);
        },
        kill() {
          killed = true;
          for (const fn of listeners.exit) fn({ exitCode: 0 });
        },
        pause() {},
        resume() {},
        emitData(chunk) {
          for (const fn of listeners.data) fn(chunk);
        },
        emitExit(exitCode = 0) {
          for (const fn of listeners.exit) fn({ exitCode });
        },
      };
      spawned.push(handle);
      return handle;
    },
  };

  const terminal = createTerminalHost({
    pty: fakePty,
    createMessageChannel: () => new MessageChannel(),
    clipboard: clip,
    env: { ...process.env, HOME: root, PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
    profiles,
  });
  t.after(() => terminal.dispose());

  const handlers = new Map();
  const postMessages = [];
  const subscribers = new Map();
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = {
    id: 11,
    mainFrame: frame,
    isDestroyed: () => false,
    postMessage(channel, value, transfer) {
      postMessages.push({ channel, value, transfer });
      const cbs = subscribers.get(channel) ?? [];
      for (const cb of cbs) cb({}, value, transfer);
    },
  };
  const wire = installAuthorityWire({
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      removeHandler: (channel) => handlers.delete(channel),
    },
    contents,
    core: { request: async () => true },
    env: { XDG_CONFIG_HOME: join(root, 'cfg'), XDG_DATA_HOME: join(root, 'data') },
    argv: [],
    terminal,
  });
  t.after(() => wire.dispose());

  const validEvent = { sender: contents, senderFrame: frame };
  let exposed = null;
  const preload = installPreload({
    contextBridge: {
      exposeInMainWorld(_name, api) {
        exposed = api;
      },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`Missing handler for ${channel}`);
        return handler(validEvent, ...args);
      },
      on: (channel, listener) => {
        const list = subscribers.get(channel) ?? [];
        list.push((event, value, ports) => listener({ ...event, ports }, value));
        subscribers.set(channel, list);
      },
      removeListener: (channel, listener) => {
        const list = subscribers.get(channel) ?? [];
        subscribers.set(channel, list.filter((l) => l !== listener));
      },
    },
  });

  return {
    root,
    terminal,
    wire,
    preload,
    exposed,
    handlers,
    validEvent,
    frame,
    contents,
    copied,
    spawned,
    postMessages,
  };
}

test('G1+G2+G7: preload exposes exact sideTerminal functions via contextBridge and enforces shell/provider profile allowlist', async (t) => {
  const profiles = new Map([
    ['agent-luna', { executable: '/bin/echo', argv: ['/bin/echo', '--agent'], label: 'Luna Agent', hint: 'Bounded helper' }],
  ]);
  const h = await createWireHarness(t, { profiles });

  assert.deepEqual(
    Object.keys(h.exposed.sideTerminal).sort(),
    ['attach', 'close', 'copyText', 'listProviders', 'open', 'resize', 'setEnabled'],
  );
  assert.equal(Object.isFrozen(h.exposed.sideTerminal), true);

  // Disabled by default -> open refuses with TERMINAL_DISABLED.
  await assert.rejects(
    h.exposed.sideTerminal.open({ command: 'shell', cols: 80, rows: 24 }),
    /TERMINAL_DISABLED/,
  );

  // Enable side terminal.
  assert.equal(await h.exposed.sideTerminal.setEnabled(true), true);

  // Open 'shell' without args -> resolves userInfo().shell || '/bin/sh' with args [].
  const expectedShell = userInfo().shell || '/bin/sh';
  const openedShell = await h.exposed.sideTerminal.open({ command: 'shell', cols: 80, rows: 24 });
  assert.match(openedShell.session, /^[A-Za-z0-9._-]{1,128}$/);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].file, expectedShell);
  assert.deepEqual(h.spawned[0].args, []);

  // Open owned provider by reference (no argv/env from renderer).
  const openedProvider = await h.exposed.sideTerminal.open({ command: 'agent-luna', args: [], cols: 100, rows: 30 });
  assert.match(openedProvider.session, /^[A-Za-z0-9._-]{1,128}$/);
  assert.equal(h.spawned.length, 2);

  // Negative controls: argv injection via command or args, unknown providers, and env injection are all refused.
  for (const badCmd of [
    '/bin/sh',
    '/bin/bash -c id',
    'shell; id',
    '-i',
    '--login',
    'unknown-provider',
    '',
  ]) {
    await assert.rejects(
      h.exposed.sideTerminal.open({ command: badCmd, cols: 80, rows: 24 }),
      /COMMAND_NOT_ALLOWED/,
    );
  }
  await assert.rejects(
    h.exposed.sideTerminal.open({ command: 'shell', args: ['-c', 'id'], cols: 80, rows: 24 }),
    /COMMAND_NOT_ALLOWED/,
  );
  await assert.rejects(
    h.exposed.sideTerminal.open({ command: 'agent-luna', args: ['--injected'], cols: 80, rows: 24 }),
    /COMMAND_NOT_ALLOWED/,
  );
  await assert.rejects(
    h.exposed.sideTerminal.open({ command: 'shell', cols: 80, rows: 24, env: { LD_PRELOAD: '/tmp/evil.so' } }),
    /PAYLOAD/,
  );
});

test('G3+G5+G7: attach, terminalClient wire framing, ack flow, resize, close, and unknown/malformed IO refusals', async (t) => {
  const h = await createWireHarness(t);
  await h.exposed.sideTerminal.setEnabled(true);
  const { session } = await h.exposed.sideTerminal.open({ command: 'shell', cols: 80, rows: 24 });

  // Attach returns { port } speaking the terminalClient wire.
  const attached = await h.exposed.sideTerminal.attach({ session });
  t.after(() => attached.port.close?.());
  assert.ok(attached && typeof attached.port === 'object');

  // Second attach on same session is refused TERMINAL_IO_REFUSED.
  await assert.rejects(
    h.exposed.sideTerminal.attach({ session }),
    /TERMINAL_IO_REFUSED/,
  );

  // Connect renderer terminalClient to the attached port.
  const receivedChunks = [];
  const statuses = [];
  const client = createTerminalClient({
    session,
    port: attached.port,
    write: (bytes, done) => {
      receivedChunks.push(Buffer.from(bytes).toString('utf8'));
      done();
    },
    onStatus: (status) => statuses.push(status),
  });

  client.input(new TextEncoder().encode('echo ok\n'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(receivedChunks.join(''), 'ok\r\n');
  assert.deepEqual(statuses, []);

  // Resize valid & invalid bounds.
  assert.equal(await h.exposed.sideTerminal.resize({ session, cols: 120, rows: 40 }), true);
  assert.deepEqual(h.spawned[0].resizes, [[120, 40]]);
  await assert.rejects(
    h.exposed.sideTerminal.resize({ session, cols: 1, rows: 40 }),
    /TERMINAL_IO_REFUSED/,
  );
  await assert.rejects(
    h.handlers.get(SIDE_TERMINAL_CHANNELS.terminalResize)(h.validEvent, { session, cols: 501, rows: 40 }),
    /TERMINAL_IO_REFUSED/,
  );

  // Unknown session negative controls for attach, resize, close, and port write.
  await assert.rejects(
    h.exposed.sideTerminal.attach({ session: 'unknown-session-id' }),
    /TERMINAL_UNKNOWN_SESSION/,
  );
  await assert.rejects(
    h.exposed.sideTerminal.resize({ session: 'unknown-session-id', cols: 80, rows: 24 }),
    /TERMINAL_UNKNOWN_SESSION/,
  );
  await assert.rejects(
    h.exposed.sideTerminal.close({ session: 'unknown-session-id' }),
    /TERMINAL_UNKNOWN_SESSION/,
  );

  // Close session -> true, and subsequent close/resize refuses with TERMINAL_UNKNOWN_SESSION.
  assert.equal(await h.exposed.sideTerminal.close({ session }), true);
  client.dispose();
  attached.port.close?.();
  await assert.rejects(
    h.exposed.sideTerminal.close({ session }),
    /TERMINAL_UNKNOWN_SESSION/,
  );
  await assert.rejects(
    h.exposed.sideTerminal.resize({ session, cols: 80, rows: 24 }),
    /TERMINAL_UNKNOWN_SESSION/,
  );

  // Malformed IO on port (wrong session / out-of-order seq) emits TERMINAL_IO_REFUSED and closes session.
  const { session: session2 } = await h.exposed.sideTerminal.open({ command: 'shell', cols: 80, rows: 24 });
  const { port: port2 } = await h.exposed.sideTerminal.attach({ session: session2 });
  t.after(() => port2.close?.());
  const port2Errors = [];
  port2.on('message', (ev) => {
    const m = ev?.data ?? ev;
    if (m?.error) port2Errors.push(m.error);
  });
  port2.start?.();
  // Send write with wrong session id / bad sequence.
  port2.postMessage({ session: 'wrong-session', seq: 99, bytes: new Uint8Array([65]) });
  await new Promise((r) => setTimeout(r, 30));
  port2.close?.();
  assert.deepEqual(port2Errors, ['TERMINAL_IO_REFUSED']);
  await assert.rejects(
    h.exposed.sideTerminal.resize({ session: session2, cols: 80, rows: 24 }),
    /TERMINAL_UNKNOWN_SESSION/,
  );
});

test('G4: listProviders returns entries and capabilities compatible with providers.js with shell always present', async (t) => {
  const profiles = new Map([
    ['argon', { executable: '/bin/echo', argv: ['/bin/echo'], label: 'Argon CLI', hint: 'Compiler' }],
  ]);
  const h = await createWireHarness(t, { profiles });
  const raw = await h.exposed.sideTerminal.listProviders();
  assert.ok(Array.isArray(raw.entries));
  assert.ok(Array.isArray(raw.capabilities));
  assert.ok(raw.entries.some((e) => e.id === 'shell'));
  assert.ok(raw.entries.some((e) => e.id === 'argon' && e.label === 'Argon CLI'));

  // Validate against renderer createProviderMenu (which prepends shell and checks non-shell entries + capabilities).
  const nonShellEntries = raw.entries.filter((e) => e.id !== 'shell');
  const menu = createProviderMenu(nonShellEntries, raw.capabilities);
  assert.equal(menu[0].id, 'shell');
  assert.equal(menu[0].disabled, false);
  assert.ok(menu.some((item) => item.id === 'argon' && item.disabled === false));
});

test('G6: copyText writes valid capsule IDs to main clipboard and refuses oversized or non-capsule-id text with ERR_CLIPBOARD_INVALID', async (t) => {
  const h = await createWireHarness(t);

  assert.equal(await h.exposed.sideTerminal.copyText({ text: 'capsule-01.main:slot_2' }), true);
  assert.deepEqual(h.copied, ['capsule-01.main:slot_2']);

  // Max length 128 chars is admitted.
  const maxId = 'c' + 'a'.repeat(127);
  assert.equal(await h.exposed.sideTerminal.copyText({ text: maxId }), true);
  assert.equal(h.copied.at(-1), maxId);

  // Oversized (>128 chars) is refused ERR_CLIPBOARD_INVALID.
  const oversized = 'c' + 'a'.repeat(128);
  await assert.rejects(h.exposed.sideTerminal.copyText({ text: oversized }), /ERR_CLIPBOARD_INVALID/);
  await assert.rejects(
    h.handlers.get(SIDE_TERMINAL_CHANNELS.terminalCopy)(h.validEvent, { text: oversized }),
    /ERR_CLIPBOARD_INVALID/,
  );

  // Non-capsule-id strings and closed-key violations are refused ERR_CLIPBOARD_INVALID.
  for (const invalid of [
    '',
    '-leading-dash',
    '.leading-dot',
    'has space',
    'slash/path',
    'semi;colon',
    'line\nbreak',
    'null\0byte',
  ]) {
    await assert.rejects(h.exposed.sideTerminal.copyText({ text: invalid }), /ERR_CLIPBOARD_INVALID/);
    await assert.rejects(
      h.handlers.get(SIDE_TERMINAL_CHANNELS.terminalCopy)(h.validEvent, { text: invalid }),
      /ERR_CLIPBOARD_INVALID/,
    );
  }
  await assert.rejects(
    h.handlers.get(SIDE_TERMINAL_CHANNELS.terminalCopy)(h.validEvent, { text: 'valid-id', extra: 1 }),
    /ERR_CLIPBOARD_INVALID/,
  );
  assert.equal(h.copied.length, 2);
});

test('G7: IPC channels fail closed on non-app sender frames, foreign webContents, and bad arity', async (t) => {
  const h = await createWireHarness(t);
  const foreignEvents = [
    { sender: { id: 999, mainFrame: h.frame, isDestroyed: () => false }, senderFrame: h.frame },
    { sender: h.contents, senderFrame: { url: 'https://evil.example/index.html', parent: null } },
    { sender: h.contents, senderFrame: { url: `${PRIVILEGED_ORIGIN}/index.html`, parent: {} } },
  ];
  const channelCalls = [
    [WIRE_CHANNELS.terminalEnabled, [true]],
    [WIRE_CHANNELS.terminalOpen, [{ command: 'shell', cols: 80, rows: 24 }]],
    [SIDE_TERMINAL_CHANNELS.terminalAttach, [{ session: 's1' }]],
    [SIDE_TERMINAL_CHANNELS.terminalResize, [{ session: 's1', cols: 80, rows: 24 }]],
    [SIDE_TERMINAL_CHANNELS.terminalClose, [{ session: 's1' }]],
    [SIDE_TERMINAL_CHANNELS.terminalProviders, []],
    [SIDE_TERMINAL_CHANNELS.terminalCopy, [{ text: 'capsule-1' }]],
  ];

  for (const [channel, args] of channelCalls) {
    const handler = h.handlers.get(channel);
    assert.equal(typeof handler, 'function', `handler registered for ${channel}`);
    for (const badEvent of foreignEvents) {
      await assert.rejects(() => handler(badEvent, ...args), { message: 'SENDER' });
    }
    await assert.rejects(() => handler(h.validEvent, ...args, 'surplus'), { message: 'ARGS' });
  }
});

test('G8: real node-pty shell open + attach + write "echo ok" + read + close round-trip and process tree reaping', async (t) => {
  let ptyMod;
  try {
    ptyMod = await import('node-pty');
    const probe = ptyMod.spawn('/bin/sh', [], { cols: 80, rows: 24, cwd: '/tmp', env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' } });
    probe.kill('SIGKILL');
  } catch (err) {
    t.skip(`node-pty cannot load or spawn on this runner: ${err?.message ?? err}`);
    return;
  }

  let lastPid = null;
  const wrappedPty = {
    spawn(file, args, opts) {
      const handle = ptyMod.spawn(file, args, opts);
      lastPid = handle.pid;
      return handle;
    },
  };

  const h = await createWireHarness(t, { pty: wrappedPty });
  await h.exposed.sideTerminal.setEnabled(true);

  const { session } = await h.exposed.sideTerminal.open({ command: 'shell', cols: 80, rows: 24 });
  assert.ok(Number.isSafeInteger(lastPid) && lastPid > 1);
  const shellPid = lastPid;

  const { port } = await h.exposed.sideTerminal.attach({ session });
  let output = '';
  let resolveMarker;
  const markerSeen = new Promise((r) => {
    resolveMarker = r;
  });

  const client = createTerminalClient({
    session,
    port,
    write: (bytes, done) => {
      output += Buffer.from(bytes).toString('utf8');
      done();
      if (output.includes('ok')) resolveMarker();
    },
    onStatus: () => {},
  });

  client.input(new TextEncoder().encode('echo ok\n'));
  await Promise.race([
    markerSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for 'ok', got: ${JSON.stringify(output)}`)), 5000)),
  ]);
  assert.match(output, /ok/);

  assert.equal(await h.exposed.sideTerminal.close({ session }), true);
  client.dispose();
  port.close?.();

  // Verify the PTY leader process is reaped after close.
  let alive = true;
  for (let i = 0; i < 20; i += 1) {
    try {
      process.kill(shellPid, 0);
      await new Promise((r) => setTimeout(r, 25));
    } catch (err) {
      if (err?.code === 'ESRCH') {
        alive = false;
        break;
      }
    }
  }
  assert.equal(alive, false, `Expected PTY pid ${shellPid} to be reaped after close`);
});

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rparen = stat.lastIndexOf(')');
    if (rparen >= 0) {
      const state = stat.slice(rparen + 2).trim().split(/\s+/)[0];
      if (state === 'Z') return false;
    }
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ESRCH') return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

async function waitForCondition(predicate, timeoutMs = 4000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

test('R3-ELECTRON-3 (tg6_electron#3): transitive 3-level process-tree reaping without node-pty and live sibling negative control', async (t) => {
  const trackedPids = new Set();
  const track = (pid) => {
    if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
      trackedPids.add(pid);
    }
  };
  t.after(() => {
    for (const pid of trackedPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });

  // Spawn a live sibling process outside the target session tree (negative control).
  const sibling = spawn('/bin/sh', ['-c', 'exec sleep 60'], {
    detached: true,
    stdio: 'ignore',
  });
  sibling.unref();
  track(sibling.pid);
  assert.equal(
    await waitForCondition(() => isPidAlive(sibling.pid), 4000),
    true,
    'sibling negative-control process must be alive before session open',
  );

  /** @type {{ leaderPid: number | null, childPid: number | null, grandchildPid: number | null }} */
  const treePids = { leaderPid: null, childPid: null, grandchildPid: null };
  let treeReadyResolve;
  const treeReady = new Promise((r) => {
    treeReadyResolve = r;
  });

  const childPtyAdapter = {
    spawn() {
      const dataListeners = [];
      const exitListeners = [];
      // Leader runs in its own session/pgrp; child and grandchild each detach into
      // fresh sessions via node detached spawn so pgrp/sid !== leaderPid and ppid !== leaderPid for grandchild.
      const treeScript = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, [
          '-e',
          "const { spawn } = require('node:child_process'); const gc = spawn('/bin/sh', ['-c', 'exec sleep 60'], { detached: true, stdio: 'ignore' }); console.log('GC:' + gc.pid); setInterval(() => {}, 1000);"
        ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.on('data', (chunk) => {
          const m = String(chunk).match(/GC:(\\d+)/);
          if (m) {
            child.stdout.destroy();
            console.log(JSON.stringify({ leader: process.pid, child: child.pid, grandchild: Number(m[1]) }));
          }
        });
        setInterval(() => {}, 1000);
      `;
      const leader = spawn(process.execPath, ['-e', treeScript], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      leader.unref();
      track(leader.pid);
      treePids.leaderPid = leader.pid;

      let stdoutBuf = '';
      leader.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (Number.isSafeInteger(parsed.child) && Number.isSafeInteger(parsed.grandchild)) {
              treePids.childPid = parsed.child;
              treePids.grandchildPid = parsed.grandchild;
              track(parsed.child);
              track(parsed.grandchild);
              leader.stdout.destroy();
              treeReadyResolve();
            }
          } catch {}
        }
        for (const fn of dataListeners) fn(chunk);
      });

      leader.on('exit', (code) => {
        for (const fn of exitListeners) fn({ exitCode: code ?? 0 });
      });

      return {
        pid: leader.pid,
        onData(fn) {
          dataListeners.push(fn);
          return { dispose() {} };
        },
        onExit(fn) {
          exitListeners.push(fn);
          return { dispose() {} };
        },
        write() {},
        resize() {},
        kill(signal) {
          // Deliberately no-op here so terminalHost's reapOwnedPid is the sole reaper of the tree.
          void signal;
        },
        pause() {},
        resume() {},
      };
    },
  };

  const h = await createWireHarness(t, { pty: childPtyAdapter });
  await h.exposed.sideTerminal.setEnabled(true);
  const { session } = await h.exposed.sideTerminal.open({ command: 'shell', cols: 80, rows: 24 });

  await new Promise((r, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for 3-level process tree spawn')), 4000);
    treeReady.then(() => {
      clearTimeout(timer);
      r();
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const { leaderPid, childPid, grandchildPid } = treePids;
  assert.ok(Number.isSafeInteger(leaderPid) && leaderPid > 1);
  assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 1);
  assert.notEqual(leaderPid, childPid);
  assert.notEqual(childPid, grandchildPid);
  assert.notEqual(leaderPid, sibling.pid);

  // Verify all 3 tree processes and the sibling are alive before close.
  assert.equal(isPidAlive(leaderPid), true, 'leader must be alive before close');
  assert.equal(isPidAlive(childPid), true, 'child must be alive before close');
  assert.equal(isPidAlive(grandchildPid), true, 'grandchild must be alive before close');
  assert.equal(isPidAlive(sibling.pid), true, 'sibling must be alive before close');

  // Verify grandchild has ppid === childPid and pgrp !== leaderPid && sid !== leaderPid
  // so only transitive `tree.has(ppid)` discovery can reap it.
  if (existsSync(`/proc/${grandchildPid}/stat`)) {
    const stat = readFileSync(`/proc/${grandchildPid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    assert.equal(Number(fields[1]), childPid, 'grandchild ppid must be childPid');
    assert.notEqual(Number(fields[2]), leaderPid, 'grandchild pgrp must not be leaderPid');
    assert.notEqual(Number(fields[3]), leaderPid, 'grandchild sid must not be leaderPid');
  }

  assert.equal(await h.exposed.sideTerminal.close({ session }), true);

  const allReaped = await waitForCondition(
    () => !isPidAlive(leaderPid) && !isPidAlive(childPid) && !isPidAlive(grandchildPid),
    4000,
  );
  assert.equal(allReaped, true, `Expected leader (${leaderPid}), child (${childPid}), and grandchild (${grandchildPid}) to be reaped`);
  assert.equal(isPidAlive(leaderPid), false, 'leader must be reaped after close');
  assert.equal(isPidAlive(childPid), false, 'child must be reaped after close');
  assert.equal(isPidAlive(grandchildPid), false, 'grandchild must be reaped after close');

  // Negative control: unrelated sibling process outside the tree remains alive after close.
  assert.equal(isPidAlive(sibling.pid), true, 'sibling outside the session tree must remain alive after close');
});

test('R3-ELECTRON-3 (tg6_electron#6): ptyBroker and ptySession resize bounds align at 500x300 and ptySession enforces exact boundary controls and refusals', async () => {
  // 1. Verify ptyBroker constants are aligned with ptySession and terminalHost (500x300).
  assert.equal(MIN_COLS, 2);
  assert.equal(MAX_COLS, 500);
  assert.equal(MIN_ROWS, 2);
  assert.equal(MAX_ROWS, 300);

  // 2. Drive valid boundary resizes (control) and out-of-range resizes (refusal) directly through createPtySession.
  const spec = {
    file: '/bin/sh',
    args: [],
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  };
  const resized = [];
  const ptySession = createPtySession({
    session: 'resize-bound-session',
    spec,
    spawn() {
      return {
        onData() {
          return { dispose() {} };
        },
        onExit() {
          return { dispose() {} };
        },
        write() {},
        resize(cols, rows) {
          resized.push([cols, rows]);
        },
        pause() {},
        resume() {},
        kill() {},
      };
    },
    send() {},
  });

  // Valid boundary controls: minimum (1x1 and 2x2) and maximum (500x300).
  ptySession.receive({ session: 'resize-bound-session', cols: 1, rows: 1 });
  ptySession.receive({ session: 'resize-bound-session', cols: MIN_COLS, rows: MIN_ROWS });
  ptySession.receive({ session: 'resize-bound-session', cols: MAX_COLS, rows: MAX_ROWS });
  assert.deepEqual(resized, [
    [1, 1],
    [2, 2],
    [500, 300],
  ]);

  // Out-of-range refusals directly on ptySession (including 501, 301, 1000, 5000, 3000, 0, negative, non-int).
  for (const [cols, rows] of [
    [501, 24],
    [80, 301],
    [501, 301],
    [1000, 1000],
    [5000, 300],
    [500, 3000],
    [0, 24],
    [80, 0],
    [-1, 24],
    [80, -1],
    [80.5, 24],
    [80, 24.5],
  ]) {
    assert.throws(
      () => ptySession.receive({ session: 'resize-bound-session', cols, rows }),
      /INVALID_MESSAGE/,
      `Expected ptySession.receive to reject cols=${cols}, rows=${rows} with INVALID_MESSAGE`,
    );
  }
  assert.equal(resized.length, 3, 'refused resizes must not reach underlying pty.resize');
  ptySession.close();

  // 3. Verify runBroker aligns with ptySession: admits 500x300 and refuses 501/301 with DIMS_RANGE.
  let brokerReceive;
  const brokerEvents = [];
  const brokerResizes = [];
  const profile = {
    command: 'shell',
    executable: '/bin/sh',
    argv: [],
    cwd: '/tmp',
    loginShell: '/bin/sh',
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  };
  const broker = runBroker({
    profiles: new Map([['shell', profile]]),
    processes: { record() {}, async reapOwned() {} },
    transport: {
      send: (msg) => brokerEvents.push(msg),
      onMessage(fn) {
        brokerReceive = fn;
        return () => {};
      },
    },
    pty: {
      spawn() {
        return {
          pid: 43210,
          onData() {
            return { dispose() {} };
          },
          onExit() {
            return { dispose() {} };
          },
          write() {},
          resize(cols, rows) {
            brokerResizes.push([cols, rows]);
          },
          kill() {},
          pause() {},
          resume() {},
        };
      },
    },
  });
  try {
    brokerReceive({ version: 1, generation: 1, op: 'open', id: 'b-sess', provider: 'shell', command: 'shell', cols: 500, rows: 300 });
    await new Promise((r) => setImmediate(r));
    assert.equal(brokerEvents.at(-1)?.ev, 'open');

    brokerReceive({ version: 1, generation: 1, op: 'resize', id: 'b-sess', cols: 500, rows: 300 });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(brokerResizes, [[500, 300]]);

    for (const [cols, rows] of [
      [501, 300],
      [500, 301],
      [1000, 1000],
    ]) {
      const before = brokerEvents.length;
      brokerReceive({ version: 1, generation: 1, op: 'resize', id: 'b-sess', cols, rows });
      await new Promise((r) => setImmediate(r));
      assert.equal(brokerEvents.length, before + 1);
      assert.equal(brokerEvents.at(-1)?.ev, 'error');
      assert.equal(brokerEvents.at(-1)?.code, 'DIMS_RANGE');
    }
    assert.equal(brokerResizes.length, 1);
  } finally {
    await broker.dispose();
  }
});
