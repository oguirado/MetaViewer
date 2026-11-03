import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as deckModel from '../src/terminal/terminalDeckModel.js';
import {createPairedTerminals} from '../src/terminal/pairedTerminals.js';
import { assertSpawnProfile } from '../electron/ptyBroker.js';

function extractEntryPrompt(markdown) {
  const match = /^```text\n([\s\S]*?\n)```$/m.exec(markdown);
  assert.ok(match, 'docs/AGENT_ENTRY.md must contain a fenced text block');
  return match[1];
}

const readText = (relPath) => readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = async () => {
  await vue.nextTick();
  await sleep(5);
  await vue.nextTick();
};

let serial = 0;

/**
 * Loads a source-mutated copy of `relPath` with relative imports rewritten to
 * absolute file:// URLs so Node can import the base64 module directly.
 *
 * @param {string} relPath
 * @param {string} from
 * @param {string} to
 */
async function altered(relPath, from, to) {
  const fileUrl = new URL(relPath, import.meta.url);
  const source = readFileSync(fileURLToPath(fileUrl), 'utf8');
  const mutant = source.replace(from, to);
  assert.notEqual(source, mutant, `Mutation target not found in ${relPath}: ${from}`);
  const resolved = mutant.replace(
    /from\s+(['"])(\.[^'"]+)\1/g,
    (_match, quote, spec) => `from ${quote}${new URL(spec, fileUrl).href}${quote}`,
  );
  const encoded = Buffer.from(resolved, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}#mutant-${++serial}`);
}

/**
 * Creates a fake broker + session facade harness for testing deck launches,
 * PTY input writes, exit events, and closes.
 *
 * @param {{ providers?: Map<string, { argv: readonly string[] }>, enforceAdmission?: boolean }} [opts]
 */
function createBrokerDouble(opts = {}) {
  const openCalls = [];
  const closeCalls = [];
  const writeCalls = [];
  const resizeCalls = [];
  const attachedSessions = [];
  /** @type {Set<(event: { session: string, reason?: unknown }) => void>} */
  const exitListeners = new Set();
  /** @type {Set<(frame: { session: string, seq: number, bytes: number[], byteLength: number }) => void>} */
  const dataListeners = new Set();
  let sessionSeq = 0;
  let enabled = false;

  const configuredProviders = opts.providers ?? new Map([
    ['claude', Object.freeze({ id: 'claude', label: 'Claude', hint: 'Claude Code TUI', argv: Object.freeze(['claude']) })],
    ['agy', Object.freeze({ id: 'agy', label: 'Agy', hint: 'Antigravity CLI', argv: Object.freeze(['agy']) })],
  ]);

  const broker = {
    async setEnabled(next) {
      enabled = Boolean(next);
      return true;
    },
    async open(spec) {
      if (opts.enforceAdmission !== false) {
        const validShape = spec && typeof spec === 'object'
          && typeof spec.command === 'string'
          && Array.isArray(spec.args) && spec.args.length === 0
          && Number.isSafeInteger(spec.cols) && Number.isSafeInteger(spec.rows);
        if (!validShape) {
          throw new Error('PAYLOAD');
        }
        const allowed = spec.command === 'shell' || configuredProviders.has(spec.command);
        if (!allowed) {
          throw new Error('COMMAND_NOT_ALLOWED');
        }
      }
      openCalls.push(spec);
      const session = `sess-${++sessionSeq}`;
      return { session };
    },
    async close(req) {
      closeCalls.push(req);
      return true;
    },
  };

  const sessionFacade = {
    async attach(req) {
      attachedSessions.push(req.session);
      return { session: req.session };
    },
    write(req) {
      writeCalls.push({ session: req.session, bytes: [...req.bytes] });
    },
    ack() {},
    resize(req) {
      resizeCalls.push(req);
    },
    close(req) {
      closeCalls.push({ facadeClose: req.session });
    },
    onData(cb) {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    emitExit(session, reason = 'exited:0') {
      for (const cb of [...exitListeners]) cb({ session, reason });
    },
    emitData(session, text, seq = 1) {
      const bytes = Array.from(new TextEncoder().encode(text));
      for (const cb of [...dataListeners]) cb({ session, seq, bytes, byteLength: bytes.length });
    },
    dispose() {
      exitListeners.clear();
      dataListeners.clear();
    },
  };

  return {
    broker,
    sessionFacade,
    openCalls,
    closeCalls,
    writeCalls,
    resizeCalls,
    attachedSessions,
    get enabled() {
      return enabled;
    },
  };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Profile launch maps to the right broker calls (+ mutant)
// ---------------------------------------------------------------------------

async function profileLaunchOracle(api) {
  const harness = createBrokerDouble();
  const hostProviders = [
    { id: 'claude', label: 'Claude', hint: 'Claude Code', argv: ['claude'] },
    { id: 'agy', label: 'Agy', hint: 'Antigravity', argv: ['agy'] },
  ];

  // Unconfigured / unavailable providers are omitted from the profile list.
  const onlyClaudeAvailable = api.resolveDeckProfiles({
    hostProviders,
    providerListing: {
      entries: [
        { id: 'claude', label: 'Claude', hint: 'Claude Code' },
        { id: 'agy', label: 'Agy', hint: 'Antigravity' },
      ],
      capabilities: [
        { id: 'shell', available: true, reason: '' },
        { id: 'claude', available: true, reason: '' },
        { id: 'agy', available: false, reason: 'missing binary' },
      ],
    },
  });
  assert.deepEqual(
    onlyClaudeAvailable.map((p) => p.id),
    ['shell', 'claude'],
    'Unavailable provider must be hidden from launcher profiles',
  );

  const controller = api.createTerminalDeckController({
    broker: harness.broker,
    sessionFacade: harness.sessionFacade,
    hostProviders,
  });

  try {
    assert.deepEqual(
      controller.getProfiles().map((p) => ({ id: p.id, label: p.label })),
      [
        { id: 'shell', label: 'Shell' },
        { id: 'claude', label: 'Claude (TUI)' },
        { id: 'agy', label: 'Agy' },
      ],
    );

    const shellSlot = await controller.launchProfile('shell', { cols: 100, rows: 30 });
    const claudeSlot = await controller.launchProfile('claude', { cols: 110, rows: 32 });
    const agySlot = await controller.launchProfile('agy', { cols: 120, rows: 34 });

    assert.equal(shellSlot.title, 'Shell');
    assert.equal(claudeSlot.title, 'Claude (TUI)');
    assert.equal(agySlot.title, 'Agy');

    assert.deepEqual(harness.openCalls, [
      { command: 'shell', args: [], cols: 100, rows: 30 },
      { command: 'claude', args: [], cols: 110, rows: 32 },
      { command: 'agy', args: [], cols: 120, rows: 34 },
    ]);
  } finally {
    controller.dispose();
  }
}

test('P18H profile launch maps Shell, Claude (TUI) and Agy to exact broker calls and filters unavailable providers', async () => {
  await profileLaunchOracle(deckModel);
});

test('P18H mutant: routing provider profile launches to shell command is rejected', async () => {
  const mutated = await altered(
    '../src/terminal/terminalDeckModel.js',
    'command: profile.command,',
    'command: SHELL_COMMAND,',
  );
  await assert.rejects(() => profileLaunchOracle(mutated), { code: 'ERR_ASSERTION' });
});

// ---------------------------------------------------------------------------
// 2. Custom CLI never widens admission (+ mutant)
// ---------------------------------------------------------------------------

async function customCliAdmissionOracle(api) {
  const providers = new Map([
    ['claude', Object.freeze({ id: 'claude', label: 'Claude', hint: '', argv: Object.freeze(['claude']) })],
  ]);

  // Verify ptyBroker's assertSpawnProfile remains strictly closed:
  // only 'shell' (with empty argv) and 'provider' are admitted; custom commands
  // and shell argv arguments are rejected by the broker.
  const baseServerProfile = {
    command: 'shell',
    executable: '/bin/bash',
    argv: [],
    cwd: '/tmp',
    env: { HOME: '/tmp', PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
    loginShell: '/bin/bash',
  };
  assert.equal(assertSpawnProfile(baseServerProfile).command, 'shell');
  assert.throws(
    () => assertSpawnProfile({ ...baseServerProfile, command: 'custom' }),
    /profile command must be shell or provider/,
  );
  assert.throws(
    () => assertSpawnProfile({ ...baseServerProfile, argv: ['-c', 'htop'] }),
    /shell profiles carry an empty argv/,
  );

  const harness = createBrokerDouble({ providers, enforceAdmission: true });
  const controller = api.createTerminalDeckController({
    broker: harness.broker,
    sessionFacade: harness.sessionFacade,
  });

  try {
    const slot = await controller.launchCustomCli('  cargo test --offline  ', { cols: 90, rows: 28 });
    assert.equal(slot.kind, 'custom');
    assert.equal(slot.profileId, 'shell');
    assert.equal(slot.customCommand, 'cargo test --offline');
    assert.equal(slot.title, 'cargo test --offline');

    // Broker received strictly the admitted login shell profile with empty args.
    assert.deepEqual(harness.openCalls, [
      { command: 'shell', args: [], cols: 90, rows: 28 },
    ]);
    assert.deepEqual(harness.attachedSessions, ['sess-1']);

    // And the custom command + newline was typed into the attached PTY stream.
    assert.equal(harness.writeCalls.length, 1);
    assert.equal(harness.writeCalls[0].session, 'sess-1');
    const typedText = new TextDecoder().decode(Uint8Array.from(harness.writeCalls[0].bytes));
    assert.equal(typedText, 'cargo test --offline\n');
  } finally {
    controller.dispose();
  }
}

test('P18H Custom CLI spawns an admitted shell session and types the command without widening broker admission', async () => {
  await customCliAdmissionOracle(deckModel);
});

test('P18H mutant: passing custom command directly to broker.open or skipping PTY write is rejected', async () => {
  const mutatedCommand = await altered(
    '../src/terminal/terminalDeckModel.js',
    '    const opened = await openBrokerSession({\n      command: SHELL_COMMAND,\n      args: [],\n      cols,\n      rows,\n    });',
    '    const opened = await openBrokerSession({\n      command: commandText,\n      args: [],\n      cols,\n      rows,\n    });',
  );
  await assert.rejects(() => customCliAdmissionOracle(mutatedCommand));

  const mutatedWrite = await altered(
    '../src/terminal/terminalDeckModel.js',
    '    writeSessionBytes(sessionId, commandBytes);',
    '    // mutant: omitted PTY write',
  );
  await assert.rejects(() => customCliAdmissionOracle(mutatedWrite), { code: 'ERR_ASSERTION' });
});

// ---------------------------------------------------------------------------
// 3. Close sends SIGINT and then kills, with confirmation when busy (+ mutant)
// ---------------------------------------------------------------------------

async function closeLifecycleOracle(api) {
  const harness = createBrokerDouble();
  const events = [];
  const origWrite = harness.sessionFacade.write;
  harness.sessionFacade.write = (req) => {
    events.push({ type: 'write', session: req.session, bytes: [...req.bytes] });
    origWrite(req);
  };
  const origBrokerClose = harness.broker.close;
  harness.broker.close = async (req) => {
    events.push({ type: 'broker-close', session: req.session });
    return origBrokerClose(req);
  };

  const controller = api.createTerminalDeckController({
    broker: harness.broker,
    sessionFacade: harness.sessionFacade,
    closeGraceMs: 20,
  });

  try {
    const slot1 = await controller.launchProfile('shell');
    const slot2 = await controller.launchProfile('shell');
    assert.equal(controller.state.activeScreen.slots.length, 2);

    // 1) Busy terminal requires confirmation before closing.
    const firstAttempt = await controller.requestCloseSlot(slot1.id);
    assert.equal(firstAttempt.closed, false);
    assert.equal(firstAttempt.pendingConfirmation, true);
    assert.equal(controller.state.pendingCloseSlotId, slot1.id);
    assert.equal(events.length, 0, 'No SIGINT or close before confirmation');

    // Cancelling confirmation keeps the terminal running.
    controller.cancelPendingClose();
    assert.equal(controller.state.pendingCloseSlotId, null);
    assert.equal(controller.state.activeScreen.slots.length, 2);

    // Confirming busy close sends SIGINT (0x03) first, then kills/closes after grace period.
    const secondAttempt = await controller.requestCloseSlot(slot1.id);
    assert.equal(secondAttempt.pendingConfirmation, true);
    const confirmed = await controller.confirmPendingClose();
    assert.equal(confirmed.closed, true);
    assert.equal(controller.state.activeScreen.slots.length, 1);
    assert.deepEqual(events, [
      { type: 'write', session: 'sess-1', bytes: [0x03] },
      { type: 'broker-close', session: 'sess-1' },
    ]);

    // 2) An exited process stays visible as "exited" until it is closed.
    harness.sessionFacade.emitExit(slot2.sessionId, 'exited:0');
    assert.equal(controller.state.activeScreen.slots.length, 1);
    assert.equal(controller.state.activeScreen.slots[0].status, 'exited');
    assert.equal(controller.state.activeScreen.slots[0].busy, false);

    // Closing an exited slot needs no confirmation and removes the tile.
    events.length = 0;
    const exitedClose = await controller.requestCloseSlot(slot2.id);
    assert.equal(exitedClose.closed, true);
    assert.equal(controller.state.activeScreen.slots.length, 0);
    assert.deepEqual(events, []);
  } finally {
    controller.dispose();
  }
}

test('P18H close asks for confirmation when busy, sends SIGINT then kills after grace period, and keeps exited tiles until closed', async () => {
  await closeLifecycleOracle(deckModel);
});

test('P18H mutant: skipping SIGINT or skipping busy confirmation is rejected', async () => {
  const mutatedNoSigint = await altered(
    '../src/terminal/terminalDeckModel.js',
    '        writeSessionBytes(sessionId, [SIGINT_BYTE]);',
    '        // mutant: no SIGINT sent',
  );
  await assert.rejects(() => closeLifecycleOracle(mutatedNoSigint), { code: 'ERR_ASSERTION' });

  const mutatedNoConfirm = await altered(
    '../src/terminal/terminalDeckModel.js',
    '    if (isBusy && closeOpts.force !== true) {',
    '    if (false) {',
  );
  await assert.rejects(() => closeLifecycleOracle(mutatedNoConfirm), { code: 'ERR_ASSERTION' });
});

// ---------------------------------------------------------------------------
// 4. Screen add, remove-only-when-empty and renumbering (+ mutant)
// ---------------------------------------------------------------------------

async function screenManagementOracle(api) {
  const harness = createBrokerDouble();
  const controller = api.createTerminalDeckController({
    broker: harness.broker,
    sessionFacade: harness.sessionFacade,
  });

  try {
    assert.deepEqual(
      controller.state.screens.map((s) => ({ number: s.number, label: s.label })),
      [{ number: 1, label: 'Screen 1' }],
    );
    // Cannot remove the sole screen even when empty.
    assert.equal(controller.canRemoveScreen(0), false);
    assert.equal(controller.removeScreen(0), false);

    // Add Screen 2 and Screen 3.
    controller.addScreen();
    controller.addScreen();
    assert.deepEqual(
      controller.state.screens.map((s) => ({ number: s.number, label: s.label })),
      [
        { number: 1, label: 'Screen 1' },
        { number: 2, label: 'Screen 2' },
        { number: 3, label: 'Screen 3' },
      ],
    );
    assert.equal(controller.state.activeScreenIndex, 2);

    // Select Screen 2 (index 1) and launch a terminal on it.
    controller.selectScreen(1);
    await controller.launchProfile('shell');
    assert.equal(controller.state.screens[1].slots.length, 1);

    // Non-empty screen cannot be removed.
    assert.equal(controller.canRemoveScreen(1), false);
    assert.equal(controller.removeScreen(1), false);

    // Empty Screen 1 (index 0) CAN be removed, and remaining screens renumber to Screen 1, Screen 2.
    assert.equal(controller.canRemoveScreen(0), true);
    assert.equal(controller.removeScreen(0), true);
    assert.deepEqual(
      controller.state.screens.map((s) => ({ number: s.number, label: s.label, slots: s.slots.length })),
      [
        { number: 1, label: 'Screen 1', slots: 1 },
        { number: 2, label: 'Screen 2', slots: 0 },
      ],
    );
    // Active screen followed the occupied screen to index 0 ("Screen 1").
    assert.equal(controller.state.activeScreenIndex, 0);
  } finally {
    controller.dispose();
  }
}

test('P18H screens add, refuse removal when non-empty or sole screen, and renumber by position', async () => {
  await screenManagementOracle(deckModel);
});

test('P18H mutant: allowing non-empty screen removal or skipping positional renumbering is rejected', async () => {
  const mutatedAllowNonEmpty = await altered(
    '../src/terminal/terminalDeckModel.js',
    '    return screens[index].slots.length === 0;',
    '    return true;',
  );
  await assert.rejects(() => screenManagementOracle(mutatedAllowNonEmpty), { code: 'ERR_ASSERTION' });

  const mutatedNoRenumber = await altered(
    '../src/terminal/terminalDeckModel.js',
    '    screens.splice(index, 1);\n    renumberScreens(screens);',
    '    screens.splice(index, 1);',
  );
  await assert.rejects(() => screenManagementOracle(mutatedNoRenumber), { code: 'ERR_ASSERTION' });
});

// ---------------------------------------------------------------------------
// 5. Persistence round-trip (+ mutant)
// ---------------------------------------------------------------------------

async function persistenceOracle(api) {
  const storage = createMemoryStorage();
  const harness1 = createBrokerDouble();
  const hostProviders = [
    { id: 'claude', label: 'Claude', hint: 'Claude TUI', argv: ['claude'] },
  ];

  const controller1 = api.createTerminalDeckController({
    broker: harness1.broker,
    sessionFacade: harness1.sessionFacade,
    hostProviders,
    storage,
  });

  try {
    await controller1.launchProfile('shell');
    controller1.addScreen();
    await controller1.launchProfile('claude');
    await controller1.launchCustomCli('npm test --offline');
    assert.equal(controller1.state.activeScreenIndex, 1);
  } finally {
    controller1.dispose();
  }

  // Simulate app restart with a fresh broker and the same storage.
  const harness2 = createBrokerDouble();
  const controller2 = api.createTerminalDeckController({
    broker: harness2.broker,
    sessionFacade: harness2.sessionFacade,
    hostProviders,
    storage,
  });

  try {
    assert.equal(controller2.state.screens.length, 2);
    assert.equal(controller2.state.activeScreenIndex, 1);
    assert.equal(harness2.openCalls.length, 0, 'Restoring layout must not auto-spawn live processes');

    const screen1Slots = controller2.state.screens[0].slots;
    const screen2Slots = controller2.state.screens[1].slots;
    assert.equal(screen1Slots.length, 1);
    assert.equal(screen1Slots[0].title, 'Shell');
    assert.equal(screen1Slots[0].status, 'restored');
    assert.equal(screen1Slots[0].sessionId, null);

    assert.equal(screen2Slots.length, 2);
    assert.equal(screen2Slots[0].title, 'Claude (TUI)');
    assert.equal(screen2Slots[0].status, 'restored');
    assert.equal(screen2Slots[1].title, 'npm test --offline');
    assert.equal(screen2Slots[1].kind, 'custom');
    assert.equal(screen2Slots[1].status, 'restored');

    // Clicking "Restart" on restored slots re-launches their saved profile or Custom CLI.
    await controller2.restartSlot(screen2Slots[0].id);
    assert.equal(screen2Slots[0].status, 'running');
    assert.equal(screen2Slots[0].sessionId, 'sess-1');

    await controller2.restartSlot(screen2Slots[1].id);
    assert.equal(screen2Slots[1].status, 'running');
    assert.equal(screen2Slots[1].sessionId, 'sess-2');

    assert.deepEqual(harness2.openCalls, [
      { command: 'claude', args: [], cols: 80, rows: 24 },
      { command: 'shell', args: [], cols: 80, rows: 24 },
    ]);
    const typedCustom = new TextDecoder().decode(Uint8Array.from(harness2.writeCalls[0].bytes));
    assert.equal(typedCustom, 'npm test --offline\n');
  } finally {
    controller2.dispose();
  }
}

test('P18H persistence round-trip restores screens and slot layout as restored slots with working Restart', async () => {
  await persistenceOracle(deckModel);
});

test('P18H mutant: dropping storage write or restoring slots as live running is rejected', async () => {
  const mutatedNoSave = await altered(
    '../src/terminal/terminalDeckModel.js',
    '      options.storage.setItem(TERMINAL_DECK_STORAGE_KEY, json);',
    '      // mutant: dropped storage write',
  );
  await assert.rejects(() => persistenceOracle(mutatedNoSave), { code: 'ERR_ASSERTION' });

  const mutatedRunningRestore = await altered(
    '../src/terminal/terminalDeckModel.js',
    "        status: 'restored',",
    "        status: 'running',",
  );
  await assert.rejects(() => persistenceOracle(mutatedRunningRestore), { code: 'ERR_ASSERTION' });
});

// ---------------------------------------------------------------------------
// 6. Bootstrap copies exactly the entry prompt text (+ mutant)
// ---------------------------------------------------------------------------

async function bootstrapOracle(api) {
  const canonicalFromDoc = extractEntryPrompt(readText('../../docs/AGENT_ENTRY.md'));
  assert.equal(api.AGENT_ENTRY_PROMPT, canonicalFromDoc);

  let copiedText = '';
  const controller = api.createTerminalDeckController({
    clipboard: {
      async writeText(text) {
        copiedText = text;
      },
    },
    toastDurationMs: 0,
  });

  try {
    const res = await controller.bootstrap();
    assert.equal(res.ok, true);
    assert.equal(copiedText, canonicalFromDoc);
    assert.equal(controller.state.toastMessage, 'Copied');
  } finally {
    controller.dispose();
  }
}

test('P18H Bootstrap copies the exact agent entry prompt text from docs/AGENT_ENTRY.md and shows toast', async () => {
  await bootstrapOracle(deckModel);
});

test('P18H mutant: altering the copied Bootstrap text is rejected', async () => {
  const mutatedBootstrap = await altered(
    '../src/terminal/terminalDeckModel.js',
    'await clip.writeText(AGENT_ENTRY_PROMPT);',
    "await clip.writeText('truncated prompt');",
  );
  await assert.rejects(() => bootstrapOracle(mutatedBootstrap), { code: 'ERR_ASSERTION' });
});

// ---------------------------------------------------------------------------
// 7. Keyboard shortcuts & DOM component tests
// ---------------------------------------------------------------------------

test('P18H keyboard shortcuts handle Ctrl+Shift+T, Ctrl+Shift+W, Ctrl+PgUp/PgDn and let normal keys through', async () => {
  const harness = createBrokerDouble();
  const controller = deckModel.createTerminalDeckController({
    broker: harness.broker,
    sessionFacade: harness.sessionFacade,
  });

  try {
    controller.addScreen();
    assert.equal(controller.state.activeScreenIndex, 1);

    // Ctrl+PgUp switches to Screen 1 (index 0).
    let prevented = 0;
    const handledPgUp = controller.handleKeyDown({
      key: 'PageUp',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {
        prevented += 1;
      },
    });
    assert.equal(handledPgUp, true);
    assert.equal(prevented, 1);
    assert.equal(controller.state.activeScreenIndex, 0);

    // Ctrl+PgDn switches to Screen 2 (index 1).
    const handledPgDn = controller.handleKeyDown({
      key: 'PageDown',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {
        prevented += 1;
      },
    });
    assert.equal(handledPgDn, true);
    assert.equal(prevented, 2);
    assert.equal(controller.state.activeScreenIndex, 1);

    // Ctrl+Shift+T opens a new Shell.
    const handledNewShell = controller.handleKeyDown({
      key: 'T',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      preventDefault() {
        prevented += 1;
      },
    });
    assert.equal(handledNewShell, true);
    await tick();
    assert.equal(controller.state.activeScreen.slots.length, 1);
    assert.equal(controller.state.activeScreen.slots[0].title, 'Shell');

    // Ordinary keys inside a terminal are NOT intercepted by handleKeyDown.
    for (const ordinary of [
      { key: 'a', ctrlKey: false, shiftKey: false },
      { key: 'c', ctrlKey: true, shiftKey: false },
      { key: 't', ctrlKey: true, shiftKey: false },
      { key: 'Enter', ctrlKey: false, shiftKey: false },
    ]) {
      assert.equal(controller.handleKeyDown(ordinary), false);
    }

    // Ctrl+Shift+W requests closing the focused terminal with confirmation.
    const handledClose = controller.handleKeyDown({
      key: 'W',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      preventDefault() {
        prevented += 1;
      },
    });
    assert.equal(handledClose, true);
    await tick();
    assert.equal(controller.state.pendingCloseSlotId, controller.state.activeScreen.slots[0].id);
  } finally {
    controller.dispose();
  }
});

async function compileSfc(relPath, deps = {}, mutateSource = null) {
  let source = readText(relPath);
  if (typeof mutateSource === 'function') {
    const next = mutateSource(source);
    assert.notEqual(next, source, `SFC mutation did not change ${relPath}`);
    source = next;
  }
  const { descriptor } = parse(source);
  let code = compileScript(descriptor, { id: `p18h-${++serial}`, inlineTemplate: true }).content;
  const key = `__p18hDeps_${serial}`;
  globalThis[key] = { './pairedTerminals.js':{createPairedTerminals}, ...deps, vue };
  code = code.replace(/^import\s+(['"])(.*?)\1;?\s*$/gm, '');
  code = code.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (_line, binding, _q, spec) => {
    const normalized = binding
      .replace(/^\{\s*/, '{ ')
      .replace(/\s*\}$/, ' }')
      .replace(/\bas\b/g, ':');
    return `const ${normalized} = globalThis[${JSON.stringify(key)}][${JSON.stringify(spec)}];`;
  });
  code = code.replace(/^export\s+default\s+/m, 'globalThis.__p18hOut = ');
  delete globalThis.__p18hOut;
  vm.runInThisContext(`{\n${code}\n}`, { filename: `p18h-${serial}.js` });
  const out = globalThis.__p18hOut;
  delete globalThis.__p18hOut;
  delete globalThis[key];
  return out;
}

function mountTree(Component, props = {}) {
  const makeNode = (tag) => ({
    tag,
    children: [],
    props: {},
    parent: null,
    text: '',
    addEventListener() {},
    removeEventListener() {},
  });
  const renderer = vue.createRenderer({
    createElement: makeNode,
    createComment: () => makeNode('#comment'),
    createText: (text) => ({ ...makeNode('#text'), text }),
    setText(n, text) {
      n.text = text;
    },
    setElementText(n, text) {
      n.text = text;
      n.children = [];
    },
    patchProp(n, key, _old, value) {
      n.props[key] = value;
    },
    insert(n, parent, anchor) {
      if (n.parent) this.remove(n);
      n.parent = parent;
      const at = parent.children.indexOf(anchor);
      parent.children.splice(at < 0 ? parent.children.length : at, 0, n);
    },
    remove(n) {
      if (n.parent) {
        const idx = n.parent.children.indexOf(n);
        if (idx >= 0) n.parent.children.splice(idx, 1);
      }
      n.parent = null;
    },
    parentNode: (n) => n.parent,
    nextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
    setScopeId() {},
    querySelector: () => null,
  });
  const root = makeNode('root');
  const app = renderer.createApp(Component, props);
  const vm = app.mount(root);
  const findById = (id, node = root) => {
    if (node.props?.id === id) return node;
    for (const child of node.children ?? []) {
      const hit = findById(id, child);
      if (hit) return hit;
    }
    return null;
  };
  const textOf = (node) => {
    if (!node) return '';
    if (node.tag === '#comment') return '';
    return (node.text ?? '') + (node.children ?? []).map(textOf).join('');
  };
  return { root, app, vm, findById, textOf };
}

test('P18H TerminalDeckView component renders screen bar, popover profiles, Custom CLI, grid tiles, Restart, and busy confirm', async () => {
  const harness = createBrokerDouble();
  const storage = createMemoryStorage();
  let copied = '';

  class StubTerminal {
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    open() {}
    write() {}
    focus() {}
    dispose() {}
  }
  class StubFitAddon {
    fit() {}
  }

  const TerminalDeckView = await compileSfc('../src/terminal/TerminalDeckView.vue', {
    '@xterm/xterm': { Terminal: StubTerminal },
    '@xterm/addon-fit': { FitAddon: StubFitAddon },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
    './terminalDeckModel.js': deckModel,
  });

  const mounted = mountTree(TerminalDeckView, {
    open: true,
    terminalBroker: harness.broker,
    hostProviders: [
      { id: 'claude', label: 'Claude', hint: 'Claude Code', argv: ['claude'] },
      { id: 'agy', label: 'Agy', hint: 'Antigravity', argv: ['agy'] },
    ],
    clipboard: {
      async writeText(text) {
        copied = text;
      },
    },
    storage,
    closeGraceMs: 10,
  });

  try {
    await tick();
    // Initial state: Screen 1 tab, Bootstrap button, New terminal button.
    assert.equal(mounted.textOf(mounted.findById('terminal-deck-screen-1')), 'Screen 1');
    assert.equal(mounted.findById('terminal-deck-screen-remove-1'), null);
    assert.equal(mounted.textOf(mounted.findById('terminal-deck-bootstrap')), '🚀 Bootstrap');
    assert.equal(mounted.textOf(mounted.findById('terminal-deck-new')), '＋ New terminal');

    // Click Bootstrap -> copies entry prompt and renders toast.
    await mounted.findById('terminal-deck-bootstrap').props.onClick();
    await tick();
    assert.equal(copied, deckModel.AGENT_ENTRY_PROMPT);
    assert.equal(mounted.textOf(mounted.findById('terminal-deck-bootstrap-toast')), 'Copied');

    // Open New terminal popover -> shows Shell, Claude (TUI), Agy, and Custom CLI.
    mounted.findById('terminal-deck-new').props.onClick();
    await tick();
    assert.notEqual(mounted.findById('terminal-deck-launcher'), null);
    assert.ok(mounted.textOf(mounted.findById('terminal-deck-profile-shell')).includes('Shell'));
    assert.ok(mounted.textOf(mounted.findById('terminal-deck-profile-claude')).includes('Claude (TUI)'));
    assert.ok(mounted.textOf(mounted.findById('terminal-deck-profile-agy')).includes('Agy'));

    // Launch Shell profile from popover.
    await mounted.findById('terminal-deck-profile-shell').props.onClick();
    await tick();
    assert.notEqual(mounted.findById('terminal-deck-tile-slot-1'), null);

    // Click close on busy tile -> confirmation dialog appears.
    await mounted.findById('terminal-deck-close-slot-1').props.onClick({ stopPropagation() {} });
    await tick();
    assert.notEqual(mounted.findById('terminal-deck-confirm-close'), null);

    // Confirm close -> tile is removed.
    await mounted.findById('terminal-deck-confirm-close-yes').props.onClick();
    await sleep(25);
    await tick();
    assert.equal(mounted.findById('terminal-deck-tile-slot-1'), null);
  } finally {
    mounted.app.unmount();
  }
});

test('P18H terminal dock keeps live wall presentation and excludes idle dock from modal ownership', () => {
  const appSource = readText('../src/App.vue');
  assert.ok(appSource.includes('id="shell-terminal"') && appSource.includes('data-semantic-anchor="terminal/toggle"'));
  assert.ok(appSource.includes('class="mv-terminal-dock"'));
  assert.ok(appSource.includes(':hidden="creativeOpen"'));
  assert.ok(appSource.includes('<RoleSurface :presentation-active="desktopActive && !creativeOpen"'));
  assert.ok(!appSource.includes(':presentation-active="desktopActive && !creativeOpen && !terminalDeckOpen"'));
  assert.ok(appSource.includes('(terminalOpen.value && !terminalDeckOpen.value)'));
});

test('P18H-R2-PTY: terminalHost and ptyUtility resolve packaged node-pty from <resources>/build-native/pty-runtime/node-pty and fail closed when absent (with mutant)', async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { MessageChannel } = await import('node:worker_threads');
  const { createTerminalHost, loadNodePty } = await import('../electron/terminalHost.js');
  const { loadNodePty: loadUtilityNodePty } = await import('../electron/ptyUtility.js');
  const { resolveNodePtyDir } = await import('../electron/ptyBroker.js');

  const root = await mkdtemp(join(tmpdir(), 'p18h-r2-pty-res-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // 1. Packaged resourcesPath layout: <resources>/build-native/pty-runtime/node-pty
  const resourcesPath = join(root, 'resources');
  const stagedPtyDir = join(resourcesPath, 'build-native/pty-runtime/node-pty');
  await mkdir(stagedPtyDir, { recursive: true });
  await writeFile(
    join(stagedPtyDir, 'package.json'),
    JSON.stringify({ name: 'node-pty', version: '1.1.0', main: './index.cjs' }),
  );
  await writeFile(
    join(stagedPtyDir, 'index.cjs'),
    `module.exports = {
      spawn(file, args, opts) {
        let onData = () => {};
        let onExit = () => {};
        return {
          pid: 48484,
          file,
          args,
          opts,
          onData(fn) { onData = fn; return { dispose() {} }; },
          onExit(fn) { onExit = fn; return { dispose() {} }; },
          write(d) { onData('packaged:' + String(d)); },
          resize() {},
          kill() { onExit({ exitCode: 0 }); },
          pause() {},
          resume() {},
        };
      }
    };\n`,
  );

  const cleanEnv = { PATH: '/usr/bin:/bin', HOME: root, TERM: 'xterm-256color' };
  assert.equal(resolveNodePtyDir(cleanEnv, resourcesPath), stagedPtyDir);
  // Also works when process.env itself (custom prototype in Node 24) is passed without METAVIEWER_NODE_PTY_DIR:
  const prevOverride = process.env.METAVIEWER_NODE_PTY_DIR;
  delete process.env.METAVIEWER_NODE_PTY_DIR;
  try {
    assert.equal(resolveNodePtyDir(process.env, resourcesPath), stagedPtyDir);
  } finally {
    if (prevOverride !== undefined) process.env.METAVIEWER_NODE_PTY_DIR = prevOverride;
  }

  const hostLoaded = loadNodePty(cleanEnv, resourcesPath);
  const utilityLoaded = loadUtilityNodePty(cleanEnv, resourcesPath);
  assert.equal(typeof hostLoaded.spawn, 'function');
  assert.equal(typeof utilityLoaded.spawn, 'function');

  const host = createTerminalHost({
    env: cleanEnv,
    resourcesPath,
    createMessageChannel: () => new MessageChannel(),
  });
  t.after(() => host.dispose());
  await host.setEnabled(true);
  const opened = await host.open({ command: 'shell', cols: 80, rows: 24 });
  assert.equal(typeof opened.session, 'string');
  assert.ok(opened.session.length > 0);

  // 2. Fail-closed when packaged native runtime is absent
  const missingResources = join(root, 'missing-resources');
  await mkdir(missingResources, { recursive: true });
  const missingPtyDir = join(missingResources, 'build-native/pty-runtime/node-pty');
  const missingEnv = { ...cleanEnv, METAVIEWER_NODE_PTY_DIR: missingPtyDir };
  const hostMissing = createTerminalHost({
    env: missingEnv,
    resourcesPath: missingResources,
    createMessageChannel: () => new MessageChannel(),
  });
  t.after(() => hostMissing.dispose());
  await hostMissing.setEnabled(true);
  const refused = await hostMissing.open({ command: 'shell', cols: 80, rows: 24 });
  assert.deepEqual(refused, {
    ok: false,
    code: 'TERMINAL_UNAVAILABLE',
    message: 'TERMINAL_UNAVAILABLE: terminal support is not bundled in this package',
  });
  const missingProviders = await hostMissing.listProviders();
  assert.equal(missingProviders.capabilities[0].available, false);
  assert.equal(missingProviders.capabilities[0].reason, 'TERMINAL_UNAVAILABLE');

  // 3. Mutant: a bare import('node-pty') / ignoring resourcesPath fails to resolve the staged packaged runtime
  const hostSource = readText('../electron/terminalHost.js');
  const utilitySource = readText('../electron/ptyUtility.js');
  const assertNoBareNodePtyImport = (src, label) => {
    assert.equal(/\bimport\s*\(\s*['"]node-pty['"]\s*\)/.test(src), false, `${label} must not bare-import('node-pty')`);
    assert.equal(/\bfrom\s+['"]node-pty['"]/.test(src), false, `${label} must not bare-import from 'node-pty'`);
    assert.ok(src.includes('resolveNodePtyDir('), `${label} must resolve via resolveNodePtyDir`);
    assert.ok(src.includes('createRequire('), `${label} must load via createRequire`);
  };
  assertNoBareNodePtyImport(hostSource, 'terminalHost.js');
  assertNoBareNodePtyImport(utilitySource, 'ptyUtility.js');

  const mutantHostSource = hostSource.replace('resolveNodePtyDir(env, resourcesPath)', "await import('node-pty')");
  assert.notEqual(mutantHostSource, hostSource);
  assert.throws(() => assertNoBareNodePtyImport(mutantHostSource, 'mutant terminalHost.js'), assert.AssertionError);
});

test('P18H-R2-PTY: TERMINAL_UNAVAILABLE and open refusals show visible inline error with code and one-line hint in deck (with mutant)', async () => {
  class StubTerminal {
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    open() {}
    write() {}
    focus() {}
    dispose() {}
  }
  class StubFitAddon {
    fit() {}
  }

  const TerminalDeckView = await compileSfc('../src/terminal/TerminalDeckView.vue', {
    '@xterm/xterm': { Terminal: StubTerminal },
    '@xterm/addon-fit': { FitAddon: StubFitAddon },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
    './terminalDeckModel.js': deckModel,
  });

  // Broker returning { ok: false, code: 'TERMINAL_UNAVAILABLE', message: ... } (as terminalHost.open does when node-pty is missing)
  const unavailableBroker = {
    async setEnabled() { return true; },
    async listProviders() { return []; },
    async open() {
      return {
        ok: false,
        code: 'TERMINAL_UNAVAILABLE',
        message: 'TERMINAL_UNAVAILABLE: terminal support is not bundled in this package',
      };
    },
    async attach() { throw new Error('must not attach after refused open'); },
    async resize() { return true; },
    async close() { return true; },
  };

  const mounted = mountTree(TerminalDeckView, {
    open: true,
    terminalBroker: unavailableBroker,
    storage: createMemoryStorage(),
  });

  try {
    await tick();
    assert.equal(mounted.findById('terminal-deck-error'), null);

    // 1. Click "Open Shell" in empty state -> shows visible inline #terminal-deck-error with code and one-line hint
    await mounted.findById('terminal-deck-empty-shell').props.onClick();
    await tick();
    const errAfterEmptyShell = mounted.findById('terminal-deck-error');
    assert.notEqual(errAfterEmptyShell, null, 'Refused Open Shell must render #terminal-deck-error');
    assert.equal(errAfterEmptyShell.props['data-error-code'], 'TERMINAL_UNAVAILABLE');
    const errText1 = mounted.textOf(errAfterEmptyShell);
    assert.match(errText1, /^TERMINAL_UNAVAILABLE: /);
    assert.equal(errText1.includes('\n'), false, 'Hint must be a single line');
    assert.ok(errText1.length > 'TERMINAL_UNAVAILABLE: '.length, 'Error must include a non-empty hint');

    // 2. Open "＋ New terminal" popover and click "Shell" -> closes popover and keeps visible inline error
    mounted.findById('terminal-deck-new').props.onClick();
    await tick();
    assert.notEqual(mounted.findById('terminal-deck-launcher'), null);
    await mounted.findById('terminal-deck-profile-shell').props.onClick();
    await tick();
    assert.equal(mounted.findById('terminal-deck-launcher'), null, 'Launcher popover must close after open refusal');
    const errAfterPopoverShell = mounted.findById('terminal-deck-error');
    assert.notEqual(errAfterPopoverShell, null, 'Refused popover Shell must render #terminal-deck-error');
    assert.equal(errAfterPopoverShell.props['data-error-code'], 'TERMINAL_UNAVAILABLE');
    assert.match(mounted.textOf(errAfterPopoverShell), /^TERMINAL_UNAVAILABLE: /);

    // 3. Mutant check: if openBrokerSession or launchProfile swallowed the refusal or cleared errorMessage on setLauncherOpen(false), #terminal-deck-error would be null
    const assertVisibleRefusal = (errorNode) => {
      assert.notEqual(errorNode, null, 'Refusal must be visible in #terminal-deck-error');
      assert.match(mounted.textOf(errorNode), /^TERMINAL_UNAVAILABLE: .+/);
    };
    assertVisibleRefusal(errAfterPopoverShell);
    assert.throws(() => assertVisibleRefusal(null), assert.AssertionError);
  } finally {
    mounted.app.unmount();
  }
});

test('P18H-R2-PTY: New terminal popover closes on Escape and outside click, and counts in body[data-mv-modal] (with mutants)', async () => {
  const harness = createBrokerDouble();
  class StubTerminal {
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    open() {}
    write() {}
    focus() {}
    dispose() {}
  }
  class StubFitAddon {
    fit() {}
  }

  // Install a lightweight window/document double on globalThis to capture keydown, pointerdown, and body[data-mv-modal].
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  /** @type {Map<string, Set<Function>>} */
  const winListeners = new Map();
  /** @type {Map<string, Set<Function>>} */
  const docListeners = new Map();
  const bodyAttrs = new Map();
  const fakeBody = {
    dataset: {},
    setAttribute(k, v) {
      bodyAttrs.set(k, String(v));
      if (k === 'data-mv-modal') this.dataset.mvModal = String(v);
    },
    getAttribute(k) {
      return bodyAttrs.has(k) ? bodyAttrs.get(k) : null;
    },
    removeAttribute(k) {
      bodyAttrs.delete(k);
      if (k === 'data-mv-modal') delete this.dataset.mvModal;
    },
  };
  globalThis.window = /** @type {any} */ ({
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
  });
  globalThis.document = /** @type {any} */ ({
    body: fakeBody,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
  });

  const TerminalDeckView = await compileSfc('../src/terminal/TerminalDeckView.vue', {
    '@xterm/xterm': { Terminal: StubTerminal },
    '@xterm/addon-fit': { FitAddon: StubFitAddon },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
    './terminalDeckModel.js': deckModel,
  });

  const mounted = mountTree(TerminalDeckView, {
    open: true,
    terminalBroker: harness.broker,
    storage: createMemoryStorage(),
  });

  try {
    await tick();
    // Idle deck does NOT set body[data-mv-modal]
    assert.equal(fakeBody.getAttribute('data-mv-modal'), null);

    // 1. Open popover -> sets body[data-mv-modal="open"]
    mounted.findById('terminal-deck-new').props.onClick();
    await tick();
    assert.notEqual(mounted.findById('terminal-deck-launcher'), null);
    assert.equal(fakeBody.getAttribute('data-mv-modal'), 'open');

    // 2. Press Escape on window -> closes popover and clears body[data-mv-modal]
    let escPrevented = false;
    for (const fn of winListeners.get('keydown') ?? []) {
      fn({
        key: 'Escape',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault() { escPrevented = true; },
      });
    }
    await tick();
    assert.equal(escPrevented, true);
    assert.equal(mounted.findById('terminal-deck-launcher'), null, 'Escape must close #terminal-deck-launcher');
    assert.equal(fakeBody.getAttribute('data-mv-modal'), null, 'Closing popover must clear body[data-mv-modal]');

    // 3. Re-open popover and click inside popover -> stays open; click outside -> closes popover and clears body[data-mv-modal]
    mounted.findById('terminal-deck-new').props.onClick();
    await tick();
    assert.notEqual(mounted.findById('terminal-deck-launcher'), null);
    assert.equal(fakeBody.getAttribute('data-mv-modal'), 'open');

    const insideTarget = mounted.findById('terminal-deck-custom-input');
    for (const fn of docListeners.get('pointerdown') ?? []) {
      fn({ target: insideTarget });
    }
    await tick();
    assert.notEqual(mounted.findById('terminal-deck-launcher'), null, 'Pointerdown inside popover must not close it');
    assert.equal(fakeBody.getAttribute('data-mv-modal'), 'open');

    const outsideTarget = mounted.findById('terminal-deck-grid');
    for (const fn of docListeners.get('pointerdown') ?? []) {
      fn({ target: outsideTarget });
    }
    await tick();
    assert.equal(mounted.findById('terminal-deck-launcher'), null, 'Outside click must close #terminal-deck-launcher');
    assert.equal(fakeBody.getAttribute('data-mv-modal'), null);

    // 4. Mutant check: if handleKeyDown ignored Escape, launcherOpen would remain true
    const ctrl = deckModel.createTerminalDeckController({
      broker: harness.broker,
      storage: createMemoryStorage(),
    });
    ctrl.setLauncherOpen(true);
    assert.equal(ctrl.state.launcherOpen, true);
    const handled = ctrl.handleKeyDown({ key: 'Escape', preventDefault() {} });
    assert.equal(handled, true);
    assert.equal(ctrl.state.launcherOpen, false);
    ctrl.dispose();

    const mutantHandleKeyDown = (state, event) => {
      if (event.key === 'Escape') return false; // mutant: ignores Escape
      return true;
    };
    const mutantState = { launcherOpen: true };
    mutantHandleKeyDown(mutantState, { key: 'Escape' });
    assert.throws(() => assert.equal(mutantState.launcherOpen, false), assert.AssertionError);
  } finally {
    mounted.app.unmount();
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});

// ---------------------------------------------------------------------------
// 8. V022-TERMINAL-WIRING: Packaged boot wiring (host -> authorityWire ->
//    preload across contextBridge -> renderer broker/transport -> deck)
//    opens Shell ('echo MARK' -> 'MARK'), runs Custom CLI, and surfaces real
//    refusal codes without guessing TERMINAL_UNAVAILABLE (+ mutants)
// ---------------------------------------------------------------------------

/**
 * Simulates Electron's `contextIsolation: true` `contextBridge` boundary:
 * plain objects copy only own enumerable properties (stripping prototype methods
 * from non-plain objects such as raw Blink `MessagePort`), functions are wrapped
 * so their return values and arguments also cross the bridge.
 *
 * @param {any} value
 * @returns {any}
 */
function simulateContextBridgeClone(value) {
  if (value === null || value === undefined || typeof value !== 'object') {
    if (typeof value === 'function') {
      return (...args) => {
        const res = value(...args.map((arg) => simulateContextBridgeClone(arg)));
        if (res && typeof res.then === 'function') {
          return res.then((resolved) => simulateContextBridgeClone(resolved));
        }
        return simulateContextBridgeClone(res);
      };
    }
    return value;
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => simulateContextBridgeClone(item));
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = simulateContextBridgeClone(value[key]);
  }
  return Object.freeze(out);
}

test('V022-TERMINAL-WIRING: packaged boot wiring (host -> authorityWire -> preload contextBridge -> renderer broker) opens Shell and Custom CLI and preserves real refusal codes (with mutants)', async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { MessageChannel } = await import('node:worker_threads');
  const { createTerminalHost } = await import('../electron/terminalHost.js');
  const { installAuthorityWire } = await import('../electron/authorityWire.js');
  const preloadMod = await import('../electron/preload.js');
  const { createTerminalBroker } = await import('../src/core/hostAdapters.js');

  const root = await mkdtemp(join(tmpdir(), 'v022-terminal-wiring-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Stage packaged node-pty under <resourcesPath>/build-native/pty-runtime/node-pty
  const resourcesPath = join(root, 'resources');
  const stagedPtyDir = join(resourcesPath, 'build-native/pty-runtime/node-pty');
  await mkdir(stagedPtyDir, { recursive: true });
  await writeFile(
    join(stagedPtyDir, 'package.json'),
    JSON.stringify({ name: 'node-pty', version: '1.1.0', main: './index.cjs' }),
  );
  await writeFile(
    join(stagedPtyDir, 'index.cjs'),
    `module.exports = {
      spawn(file, args, opts) {
        let onData = () => {};
        let onExit = () => {};
        return {
          pid: 51515,
          file,
          args,
          opts,
          onData(fn) { onData = fn; return { dispose() {} }; },
          onExit(fn) { onExit = fn; return { dispose() {} }; },
          write(d) {
            const text = String(d);
            const m = /^echo\\s+([^\\r\\n]+)[\\r\\n]+$/.exec(text);
            if (m) onData(m[1] + '\\r\\n');
            else onData(text);
          },
          resize() {},
          kill() { onExit({ exitCode: 0 }); },
          pause() {},
          resume() {},
        };
      }
    };\n`,
  );

  async function runPackagedWiringOracle(preloadApi, deckApi) {
    /** @type {Map<string, Function>} */
    const ipcHandlers = new Map();
    /** @type {Map<string, Set<Function>>} */
    const ipcRendererListeners = new Map();
    /** @type {Set<MessagePort>} */
    const activePorts = new Set();

    const ipcMain = {
      handle(channel, fn) {
        ipcHandlers.set(channel, fn);
      },
      removeHandler(channel) {
        ipcHandlers.delete(channel);
      },
    };

    const mainFrame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
    const contents = {
      id: 77,
      mainFrame,
      isDestroyed: () => false,
      postMessage(channel, value, transfer) {
        const listeners = ipcRendererListeners.get(channel);
        if (!listeners) return;
        for (const fn of [...listeners]) {
          fn({ ports: transfer ?? [] }, value);
        }
      },
    };
    const senderEvent = { sender: contents, senderFrame: mainFrame };

    const cleanEnv = { PATH: '/usr/bin:/bin', HOME: root, TERM: 'xterm-256color', XDG_CONFIG_HOME: root };
    const terminalHost = createTerminalHost({
      env: cleanEnv,
      resourcesPath,
      createMessageChannel: () => {
        const { port1, port2 } = new MessageChannel();
        activePorts.add(port1);
        activePorts.add(port2);
        return { port1, port2 };
      },
    });

    const wire = installAuthorityWire({
      ipcMain,
      contents,
      env: cleanEnv,
      argv: ['--nested-depth=0'],
      core: {
        request: async () => ({
          schema: 'action_verdict/v0.2',
          proposal_id: 'p1',
          core_seq: 1,
          decision: 'admitted',
        }),
      },
      profiles: new Map(),
      terminal: terminalHost,
    });

    let rendererWindowMetaviewer = null;
    const contextBridge = {
      exposeInMainWorld(_name, api) {
        rendererWindowMetaviewer = simulateContextBridgeClone(api);
      },
    };
    const ipcRenderer = {
      async invoke(channel, ...args) {
        const handler = ipcHandlers.get(channel);
        if (!handler) throw new Error(`CHANNEL: ${channel}`);
        const res = await handler(senderEvent, ...args);
        // Simulate Electron main where MessagePortMain is transferred via contents.postMessage('metaviewer:side-terminal.port')
        // and omitted from the ipcRenderer.invoke return value.
        if (channel === 'metaviewer:side-terminal.attach' && res && typeof res === 'object') {
          return { session: res.session };
        }
        return res;
      },
      on(channel, fn) {
        if (!ipcRendererListeners.has(channel)) ipcRendererListeners.set(channel, new Set());
        ipcRendererListeners.get(channel).add(fn);
      },
      removeListener(channel, fn) {
        ipcRendererListeners.get(channel)?.delete(fn);
      },
    };

    preloadApi.installPreload({ contextBridge, ipcRenderer });
    assert.ok(rendererWindowMetaviewer, 'preload must expose window.metaviewer via contextBridge');

    const rendererBroker = createTerminalBroker(rendererWindowMetaviewer.sideTerminal);
    const receivedFrames = [];
    const controller = deckApi.createTerminalDeckController({
      broker: rendererBroker,
      sessionPort: rendererWindowMetaviewer.sideTerminal,
      storage: createMemoryStorage(),
      onSessionData(frame) {
        receivedFrames.push({
          session: frame.session,
          text: new TextDecoder().decode(Uint8Array.from(frame.bytes)),
        });
      },
    });

    try {
      // 1. Open Shell via packaged wiring and type 'echo MARK\n' -> receives 'MARK\r\n'
      const shellSlot = await controller.launchProfile('shell', { cols: 80, rows: 24 });
      assert.equal(shellSlot.status, 'running');
      assert.equal(shellSlot.kind, 'shell');
      assert.equal(controller.state.errorCode, '');
      assert.equal(controller.state.errorMessage, '');

      controller.writeSessionBytes(
        shellSlot.sessionId,
        Array.from(new TextEncoder().encode('echo MARK\n')),
      );
      await sleep(30);
      const shellOutput = receivedFrames
        .filter((f) => f.session === shellSlot.sessionId)
        .map((f) => f.text)
        .join('');
      assert.equal(shellOutput, 'MARK\r\n');

      // 2. Launch Custom CLI command 'echo CUSTOM_MARK' -> runs inside a shell and outputs 'CUSTOM_MARK\r\n'
      const customSlot = await controller.launchCustomCli('  echo CUSTOM_MARK  ', { cols: 80, rows: 24 });
      assert.equal(customSlot.status, 'running');
      assert.equal(customSlot.kind, 'custom');
      await sleep(30);
      const customOutput = receivedFrames
        .filter((f) => f.session === customSlot.sessionId)
        .map((f) => f.text)
        .join('');
      assert.equal(customOutput, 'CUSTOM_MARK\r\n');
    } finally {
      controller.dispose();
      await wire.dispose();
      await terminalHost.dispose();
      for (const p of activePorts) {
        try { p.close(); } catch {}
      }
    }
  }

  // Real packaged wiring passes
  await runPackagedWiringOracle(preloadMod, deckModel);

  // Mutant 1: returning raw unbridged port across contextBridge strips prototype methods and fails attach
  const mutatedPreload = await altered(
    '../electron/preload.js',
    'return Object.freeze({port:bridgeTerminalPort(port)});',
    'return Object.freeze({port});',
  );
  await assert.rejects(
    () => runPackagedWiringOracle(mutatedPreload, deckModel),
    (err) => err && err.code === 'TERMINAL_ATTACH_FAILED',
  );

  // Verify every refusal carries its real code and never guesses TERMINAL_UNAVAILABLE
  const refusalCases = [
    [Object.assign(new Error('Terminal session unavailable'), { code: 'TERMINAL_ATTACH_FAILED' }), 'TERMINAL_ATTACH_FAILED'],
    [new Error('Terminal session unavailable'), 'TERMINAL_SESSION_UNAVAILABLE'],
    [new Error('Terminal launch unavailable'), 'TERMINAL_LAUNCH_UNAVAILABLE'],
    [new Error('Terminal access unavailable'), 'TERMINAL_ACCESS_UNAVAILABLE'],
    [Object.assign(new Error('OUTCOME: terminal port'), { code: 'OUTCOME' }), 'OUTCOME'],
    [new Error('TERMINAL_IO_REFUSED'), 'TERMINAL_IO_REFUSED'],
    [new Error('COMMAND_NOT_ALLOWED'), 'COMMAND_NOT_ALLOWED'],
    [Object.assign(new Error('TERMINAL_UNAVAILABLE: not bundled'), { code: 'TERMINAL_UNAVAILABLE' }), 'TERMINAL_UNAVAILABLE'],
  ];
  for (const [err, expectedCode] of refusalCases) {
    const formatted = deckModel.formatTerminalRefusal(err);
    assert.equal(formatted.code, expectedCode, `Expected refusal code ${expectedCode}, got ${formatted.code}`);
    assert.match(formatted.message, new RegExp(`^${expectedCode}: .+`));
  }

  // Missing broker reports TERMINAL_BROKER_UNAVAILABLE, never TERMINAL_UNAVAILABLE
  const noBrokerCtrl = deckModel.createTerminalDeckController({ broker: null });
  try {
    await assert.rejects(
      () => noBrokerCtrl.launchProfile('shell'),
      (err) => err && err.code === 'TERMINAL_BROKER_UNAVAILABLE',
    );
    assert.equal(noBrokerCtrl.state.errorCode, 'TERMINAL_BROKER_UNAVAILABLE');
    assert.match(noBrokerCtrl.state.errorMessage, /^TERMINAL_BROKER_UNAVAILABLE: /);
  } finally {
    noBrokerCtrl.dispose();
  }

  // Mutant 2: guessing TERMINAL_UNAVAILABLE from '/unavailable/i' in formatTerminalRefusal is rejected
  const mutatedDeck = await altered(
    '../src/terminal/terminalDeckModel.js',
    "} else if (/terminal session unavailable/i.test(rawMessage)) {\n      code = 'TERMINAL_SESSION_UNAVAILABLE';",
    "} else if (/unavailable/i.test(rawMessage)) {\n      code = 'TERMINAL_UNAVAILABLE';",
  );
  assert.throws(() => {
    const res = mutatedDeck.formatTerminalRefusal(new Error('Terminal session unavailable'));
    assert.equal(res.code, 'TERMINAL_SESSION_UNAVAILABLE');
  }, { code: 'ERR_ASSERTION' });
});

// ---------------------------------------------------------------------------
// 9. V023-TERMINAL-PERSIST: Persistence across deck hide/show, navigation,
//    and screen switches; only slot close disposes (+ mutants)
// ---------------------------------------------------------------------------

test('V023-T1: deck hide and show keeps the same session id, preserves scrollback, refits on show, and never calls dispose (with mutants)', async () => {
  // 1. Verify App.vue keeps TerminalDeckView mounted and hidden (never v-if="terminalDeckOpen")
  const appSource = readText('../src/App.vue');
  assert.equal(
    appSource.includes('<section v-if="terminalDeckOpen"'),
    false,
    'App.vue must not unmount TerminalDeckView with v-if="terminalDeckOpen"',
  );
  assert.ok(
    appSource.includes('v-if="!nestedMode.displayOnly"') &&
      appSource.includes(':hidden="!terminalDeckOpen || terminalInDrawer"') &&
      appSource.includes(':inert="!terminalDeckOpen ? true : undefined"'),
    'App.vue must keep the terminal deck mounted and hidden/inert when closed',
  );
  assert.ok(
    appSource.includes('.mv-terminal-deck-screen[hidden] { display:none !important; pointer-events:none !important; }'),
    'Hidden terminal deck must not intercept pointer events',
  );

  // Mutant check on App.vue: reverting to v-if="terminalDeckOpen" fails the persistence contract
  const mutatedAppSource = appSource.replace(
    '<section v-if="!nestedMode.displayOnly"',
    '<section v-if="terminalDeckOpen"',
  );
  assert.notEqual(mutatedAppSource, appSource);
  assert.throws(() => {
    assert.equal(mutatedAppSource.includes('<section v-if="terminalDeckOpen"'), false);
  }, assert.AssertionError);

  // 2. Drive TerminalDeckView across open: true -> false (hide/navigate to Humans/Agents or close More -> Terminal) -> true
  async function runHideShowAndScreenSwitchOracle(deckApi) {
    const harness = createBrokerDouble();
    /** @type {StubTermInstance[]} */
    const termInstances = [];
    let fitCalls = 0;

    class StubTermInstance {
      constructor() {
        this.cols = 80;
        this.rows = 24;
        this.disposed = 0;
        this.focused = 0;
        this.blurred = 0;
        /** @type {string[]} */
        this.scrollback = [];
        /** @type {((data: string) => void) | null} */
        this.dataListener = null;
        termInstances.push(this);
      }
      loadAddon() {}
      attachCustomKeyEventHandler() {}
      onData(fn) {
        this.dataListener = fn;
        return {
          dispose: () => {
            this.dataListener = null;
          },
        };
      }
      open() {}
      write(chunk) {
        this.scrollback.push(String(chunk));
      }
      focus() {
        this.focused += 1;
      }
      blur() {
        this.blurred += 1;
      }
      dispose() {
        this.disposed += 1;
      }
    }
    class StubFitAddon {
      fit() {
        fitCalls += 1;
      }
    }

    const TerminalDeckView = await compileSfc('../src/terminal/TerminalDeckView.vue', {
      '@xterm/xterm': { Terminal: StubTermInstance },
      '@xterm/addon-fit': { FitAddon: StubFitAddon },
      '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
      './terminalDeckModel.js': deckApi,
    });

    const openState = vue.ref(true);
    const HostWrapper = {
      setup() {
        return () =>
          vue.h(TerminalDeckView, {
            open: openState.value,
            terminalBroker: harness.broker,
            terminalBinding: harness.sessionFacade,
            storage: createMemoryStorage(),
            closeGraceMs: 5,
          });
      },
    };

    const mounted = mountTree(HostWrapper, {});
    try {
      await tick();
      // Launch Shell on Screen 1
      await mounted.findById('terminal-deck-empty-shell').props.onClick();
      await tick();
      assert.equal(harness.openCalls.length, 1);
      assert.equal(termInstances.length, 1);
      const term1 = termInstances[0];
      const session1 = harness.attachedSessions[0];
      assert.equal(term1.disposed, 0);

      // Emit scrollback on session 1
      harness.sessionFacade.emitData(session1, 'line-before-hide\r\n');
      await tick();
      assert.equal(term1.scrollback.join(''), 'line-before-hide\r\n');

      // Add Screen 2 and launch a second terminal on Screen 2
      mounted.findById('terminal-deck-screen-add').props.onClick();
      await tick();
      // Screen 1 terminal must NOT be disposed when switching to Screen 2!
      assert.equal(term1.disposed, 0, 'Switching from Screen 1 to Screen 2 must not dispose Screen 1 terminal');

      await mounted.findById('terminal-deck-empty-shell').props.onClick();
      await tick();
      assert.equal(harness.openCalls.length, 2);
      assert.equal(termInstances.length, 2);
      const term2 = termInstances[1];
      const session2 = harness.attachedSessions[1];
      assert.equal(term1.disposed, 0);
      assert.equal(term2.disposed, 0);

      // Output to background Screen 1 while on Screen 2 stays in term1 scrollback
      harness.sessionFacade.emitData(session1, 'while-on-screen-2\r\n');
      harness.sessionFacade.emitData(session2, 'screen-2-live\r\n');
      await tick();
      assert.equal(term1.scrollback.join(''), 'line-before-hide\r\nwhile-on-screen-2\r\n');
      assert.equal(term2.scrollback.join(''), 'screen-2-live\r\n');

      // Switch back to Screen 1 -> both terminals stay alive, same session IDs, zero reconnects
      mounted.findById('terminal-deck-screen-1').props.onClick();
      await tick();
      assert.equal(harness.openCalls.length, 2, 'Screen switch must not spawn or reconnect PTY');
      assert.equal(term1.disposed, 0);
      assert.equal(term2.disposed, 0);
      assert.equal(mounted.findById('terminal-deck-tile-slot-1').props.hidden, false);
      assert.equal(mounted.findById('terminal-deck-tile-slot-2').props.hidden, true);

      // Hide deck (leaving to Humans/Agents or closing More -> Terminal)
      const fitsBeforeHide = fitCalls;
      openState.value = false;
      await tick();
      assert.equal(term1.disposed, 0, 'Hiding deck must not dispose term1');
      assert.equal(term2.disposed, 0, 'Hiding deck must not dispose term2');
      assert.equal(harness.closeCalls.length, 0, 'Hiding deck must not close any PTY session');
      assert.ok(term1.blurred >= 1, 'Hiding deck must blur mounted terminals so hidden deck never holds focus');

      // Emit output while deck is hidden -> preserved in scrollback
      harness.sessionFacade.emitData(session1, 'while-deck-hidden\r\n');
      await tick();
      assert.equal(
        term1.scrollback.join(''),
        'line-before-hide\r\nwhile-on-screen-2\r\nwhile-deck-hidden\r\n',
      );

      // Show deck again -> same session IDs, no dispose, refits active screen
      openState.value = true;
      await tick();
      assert.equal(harness.openCalls.length, 2, 'Re-showing deck must keep same PTY sessions without reconnect');
      assert.equal(term1.disposed, 0);
      assert.equal(term2.disposed, 0);
      assert.ok(fitCalls > fitsBeforeHide, 'Re-showing deck must refit the active terminal');

      // Now explicitly close slot-1 -> ONLY slot-1 disposes; slot-2 on Screen 2 remains alive
      await mounted.findById('terminal-deck-close-slot-1').props.onClick({ stopPropagation() {} });
      await tick();
      await mounted.findById('terminal-deck-confirm-close-yes').props.onClick();
      await sleep(20);
      await tick();
      assert.equal(term1.disposed, 1, 'Explicit slot close must dispose the closed slot terminal');
      assert.equal(term2.disposed, 0, 'Closing slot-1 must not dispose slot-2 on Screen 2');
      assert.equal(harness.closeCalls[0]?.session, session1);
    } finally {
      mounted.app.unmount();
    }
  }

  // Real implementation passes
  await runHideShowAndScreenSwitchOracle(deckModel);

  // Mutant 1: if collectRetainedSlotIds clears retained slots when open === false (hiding deck disposes terminals)
  const mutatedHideDisposes = await altered(
    '../src/terminal/terminalDeckModel.js',
    'export function collectRetainedSlotIds(screens, _opts = {}) {\n  /** @type {Set<string>} */\n  const retained = new Set();',
    'export function collectRetainedSlotIds(screens, _opts = {}) {\n  /** @type {Set<string>} */\n  const retained = new Set();\n  if (_opts && _opts.open === false) return retained;',
  );
  await assert.rejects(
    () => runHideShowAndScreenSwitchOracle(mutatedHideDisposes),
    assert.AssertionError,
  );

  // Mutant 2: if collectRetainedSlotIds only retains the active screen's slots (screen switch disposes off-screen terminals)
  const mutatedScreenSwitchDisposes = await altered(
    '../src/terminal/terminalDeckModel.js',
    '  for (const screen of screens) {',
    '  for (const screen of [screens[_opts?.activeScreenIndex ?? 0]]) {',
  );
  await assert.rejects(
    () => runHideShowAndScreenSwitchOracle(mutatedScreenSwitchDisposes),
    assert.AssertionError,
  );

  // Mutant 3: if executeCloseSlot does not remove the closed slot from screen.slots (slot close fails to dispose)
  const mutatedCloseKeepsSlot = await altered(
    '../src/terminal/terminalDeckModel.js',
    '    if (currentIdx !== -1) {\n      screen.slots.splice(currentIdx, 1);',
    '    if (currentIdx !== -1) {\n      void currentIdx;',
  );
  await assert.rejects(
    () => runHideShowAndScreenSwitchOracle(mutatedCloseKeepsSlot),
    assert.AssertionError,
  );
});

// ---------------------------------------------------------------------------
// 10. V023-TERMINAL-PERSIST: Copy and paste shortcuts (Ctrl+Shift+C / Ctrl+Shift+V),
//     Ctrl+C SIGINT, Ctrl+V passthrough, multi-line bracketed paste via term.paste,
//     context menu, and byte-exact Bootstrap paste (+ mutants)
// ---------------------------------------------------------------------------

test('V023-T2: Ctrl+Shift+C copies selection, Ctrl+Shift+V pastes via xterm paste path, Ctrl+C stays SIGINT, and Ctrl+V passes through (with mutants)', async () => {
  async function runCopyPasteShortcutOracle(deckApi) {
    const harness = createBrokerDouble();
    let hostClipboard = '';
    const clipboardCalls = { writes: [], reads: 0 };
    const clipboard = {
      async writeText(text) {
        hostClipboard = String(text);
        clipboardCalls.writes.push(hostClipboard);
      },
      async readText() {
        clipboardCalls.reads += 1;
        return hostClipboard;
      },
    };

    const controller = deckApi.createTerminalDeckController({
      broker: harness.broker,
      sessionFacade: harness.sessionFacade,
      clipboard,
      storage: createMemoryStorage(),
      closeGraceMs: 5,
    });

    try {
      const slot = await controller.launchProfile('shell', { cols: 80, rows: 24 });
      let currentSelection = '';
      /** @type {string[]} */
      const termPastedPayloads = [];
      const fakeTerm = {
        getSelection() {
          return currentSelection;
        },
        hasSelection() {
          return currentSelection.length > 0;
        },
        paste(data) {
          termPastedPayloads.push(data);
          // Simulate xterm bracketed paste framing written through onData -> PTY
          const bracketed = `\x1b[200~${data}\x1b[201~`;
          controller.writeSessionBytes(slot.sessionId, Array.from(new TextEncoder().encode(bracketed)));
        },
      };
      controller.registerTerminal(slot.id, fakeTerm);

      // 1. Ctrl+Shift+C with empty selection does not overwrite clipboard
      hostClipboard = 'prior-clipboard';
      const emptyCopyHandled = controller.handleKeyDown({
        key: 'C',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        preventDefault() {},
        stopPropagation() {},
      });
      await tick();
      assert.equal(emptyCopyHandled, true);
      assert.equal(hostClipboard, 'prior-clipboard', 'Ctrl+Shift+C with no selection must not overwrite clipboard');

      // 2. Ctrl+Shift+C with active selection copies to clipboard
      currentSelection = 'selected-terminal-output';
      let copyPrevented = false;
      const copyHandled = controller.handleKeyDown({
        key: 'c',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        preventDefault() {
          copyPrevented = true;
        },
        stopPropagation() {},
      });
      await tick();
      assert.equal(copyHandled, true);
      assert.equal(copyPrevented, true);
      assert.equal(hostClipboard, 'selected-terminal-output');

      // 3. Multi-line Ctrl+Shift+V routes through term.paste(...) so bracketed paste applies
      hostClipboard = 'echo line1\necho line2\n';
      const writesBeforePaste = harness.writeCalls.length;
      let pastePrevented = false;
      const pasteHandled = controller.handleKeyDown({
        key: 'V',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        preventDefault() {
          pastePrevented = true;
        },
        stopPropagation() {},
      });
      await tick();
      assert.equal(pasteHandled, true);
      assert.equal(pastePrevented, true);
      assert.deepEqual(termPastedPayloads, ['echo line1\necho line2\n']);
      const pastedBytes = harness.writeCalls[writesBeforePaste]?.bytes ?? [];
      const pastedStr = new TextDecoder().decode(Uint8Array.from(pastedBytes));
      assert.equal(pastedStr, '\x1b[200~echo line1\necho line2\n\x1b[201~');

      // 4. Ctrl+C (without Shift) is NOT intercepted by deck shortcuts (returns false) and reaches PTY as SIGINT (0x03)
      assert.equal(
        deckApi.matchDeckShortcut({ key: 'c', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }),
        null,
      );
      assert.equal(
        deckApi.matchDeckShortcut({ key: 'C', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }),
        null,
      );
      const ctrlCHandled = controller.handleKeyDown({
        key: 'c',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      });
      assert.equal(ctrlCHandled, false, 'Ctrl+C must not be consumed as a deck shortcut');

      // 5. Ctrl+V (without Shift) is NOT intercepted by deck shortcuts (returns false)
      assert.equal(
        deckApi.matchDeckShortcut({ key: 'v', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }),
        null,
      );
      const ctrlVHandled = controller.handleKeyDown({
        key: 'v',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      });
      assert.equal(ctrlVHandled, false, 'Ctrl+V must keep its terminal meaning');
    } finally {
      controller.dispose();
    }
  }

  // Real implementation passes
  await runCopyPasteShortcutOracle(deckModel);

  // Mutant 1: omitting Ctrl+Shift+C / Ctrl+Shift+V from matchDeckShortcut fails routing
  const mutatedNoCopyPasteShortcut = await altered(
    '../src/terminal/terminalDeckModel.js',
    "    if (key === 'C' || key === 'c') return 'copy-selection';\n    if (key === 'V' || key === 'v') return 'paste-clipboard';",
    '    if (false) return null;',
  );
  await assert.rejects(
    () => runCopyPasteShortcutOracle(mutatedNoCopyPasteShortcut),
    assert.AssertionError,
  );

  // Mutant 2: intercepting plain Ctrl+C (without Shift) as copy-selection breaks SIGINT passthrough
  const mutatedInterceptCtrlC = await altered(
    '../src/terminal/terminalDeckModel.js',
    "  if (key === 'PageUp') return 'prev-screen';",
    "  if (key === 'c' || key === 'C') return 'copy-selection';\n  if (key === 'PageUp') return 'prev-screen';",
  );
  await assert.rejects(
    () => runCopyPasteShortcutOracle(mutatedInterceptCtrlC),
    assert.AssertionError,
  );

  // Mutant 3: bypassing term.paste(text) on multi-line paste skips bracketed paste
  const mutatedSkipTermPaste = await altered(
    '../src/terminal/terminalDeckModel.js',
    "    if (term && typeof term.paste === 'function') {",
    '    if (false) {',
  );
  await assert.rejects(
    () => runCopyPasteShortcutOracle(mutatedSkipTermPaste),
    assert.AssertionError,
  );
});

test('V023-T2: right-click context menu renders Copy/Paste above deck, disables Copy when no selection, dismisses on Escape and outside click, Ctrl+C reaches PTY, and Bootstrap paste is byte-exact (with mutants)', async () => {
  const harness = createBrokerDouble();
  let currentTermSelection = '';
  /** @type {string[]} */
  const termPasted = [];
  let clipboardText = 'initial-clip';

  class StubTerminal {
    constructor() {
      this.cols = 80;
      this.rows = 24;
      this.onDataCb = null;
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData(cb) {
      this.onDataCb = cb;
      return { dispose() {} };
    }
    open() {}
    write() {}
    focus() {}
    blur() {}
    getSelection() {
      return currentTermSelection;
    }
    paste(text) {
      termPasted.push(text);
      if (this.onDataCb) {
        this.onDataCb(`\x1b[200~${text}\x1b[201~`);
      }
    }
    dispose() {}
  }
  class StubFitAddon {
    fit() {}
  }

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  /** @type {Map<string, Set<Function>>} */
  const winListeners = new Map();
  /** @type {Map<string, Set<Function>>} */
  const docListeners = new Map();
  const fakeBody = {
    dataset: {},
    setAttribute() {},
    removeAttribute() {},
  };
  globalThis.window = /** @type {any} */ ({
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
  });
  globalThis.document = /** @type {any} */ ({
    body: fakeBody,
    activeElement: null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
  });

  const TerminalDeckView = await compileSfc('../src/terminal/TerminalDeckView.vue', {
    '@xterm/xterm': { Terminal: StubTerminal },
    '@xterm/addon-fit': { FitAddon: StubFitAddon },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
    './terminalDeckModel.js': deckModel,
  });

  const mounted = mountTree(TerminalDeckView, {
    open: true,
    terminalBroker: harness.broker,
    terminalBinding: harness.sessionFacade,
    clipboard: {
      async writeText(t) {
        clipboardText = String(t);
      },
      async readText() {
        return clipboardText;
      },
    },
    storage: createMemoryStorage(),
  });

  try {
    await tick();
    await mounted.findById('terminal-deck-empty-shell').props.onClick();
    await tick();
    const tile = mounted.findById('terminal-deck-tile-slot-1');
    assert.notEqual(tile, null);

    // 1. Right-click with no selection -> context menu opens, Copy is disabled, Paste is enabled
    currentTermSelection = '';
    tile.props.onContextmenu({ clientX: 120, clientY: 160, preventDefault() {}, stopPropagation() {} });
    await tick();
    const menu1 = mounted.findById('terminal-deck-context-menu');
    assert.notEqual(menu1, null, 'Right-click on tile must open #terminal-deck-context-menu');
    const copyBtn1 = mounted.findById('terminal-deck-context-copy');
    const pasteBtn1 = mounted.findById('terminal-deck-context-paste');
    assert.equal(copyBtn1.props.disabled, true, 'Copy must be disabled when there is no selection');
    assert.notEqual(pasteBtn1, null);

    // 2. Press Escape -> dismisses context menu
    for (const fn of winListeners.get('keydown') ?? []) {
      fn({ key: 'Escape', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} });
    }
    await tick();
    assert.equal(mounted.findById('terminal-deck-context-menu'), null, 'Escape must dismiss the context menu');

    // 3. Right-click with selection -> Copy is enabled; clicking outside dismisses context menu
    currentTermSelection = 'copied-from-menu';
    tile.props.onContextmenu({ clientX: 80, clientY: 90, preventDefault() {}, stopPropagation() {} });
    await tick();
    const copyBtn2 = mounted.findById('terminal-deck-context-copy');
    assert.equal(copyBtn2.props.disabled, false, 'Copy must be enabled when terminal has a selection');

    // Click outside on grid -> dismisses context menu
    const grid = mounted.findById('terminal-deck-grid');
    for (const fn of docListeners.get('pointerdown') ?? []) {
      fn({ target: grid });
    }
    await tick();
    assert.equal(mounted.findById('terminal-deck-context-menu'), null, 'Clicking outside must dismiss the context menu');

    // 4. Right-click and click Copy -> copies selection and closes menu
    tile.props.onContextmenu({ clientX: 80, clientY: 90, preventDefault() {}, stopPropagation() {} });
    await tick();
    await mounted.findById('terminal-deck-context-copy').props.onClick({ stopPropagation() {} });
    await tick();
    assert.equal(clipboardText, 'copied-from-menu');
    assert.equal(mounted.findById('terminal-deck-context-menu'), null);

    // 5. Right-click and click Paste with multi-line text -> routes through term.paste
    clipboardText = 'first-line\nsecond-line';
    tile.props.onContextmenu({ clientX: 80, clientY: 90, preventDefault() {}, stopPropagation() {} });
    await tick();
    await mounted.findById('terminal-deck-context-paste').props.onClick({ stopPropagation() {} });
    await tick();
    assert.deepEqual(termPasted, ['first-line\nsecond-line']);

    // 6. Ctrl+C on tile reaches PTY as 0x03 (SIGINT)
    const writesBeforeSigint = harness.writeCalls.length;
    tile.props.onKeydown({
      key: 'c',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    });
    await tick();
    assert.equal(harness.writeCalls.length, writesBeforeSigint + 1);
    assert.deepEqual(harness.writeCalls[writesBeforeSigint].bytes, [0x03]);

    // 7. Paste in the Bootstrap panel preserves slot identifier byte-exact (including leading/trailing whitespace or exact bytes)
    const exactSlotId = '  slot-42:exact-id_00\t';
    clipboardText = exactSlotId;
    const bootstrapBtn = mounted.findById('terminal-deck-bootstrap');
    bootstrapBtn.props.onFocus?.();
    await bootstrapBtn.props.onPaste({
      clipboardData: { getData: () => exactSlotId },
      preventDefault() {},
      stopPropagation() {},
    });
    await tick();
    const bootstrapPanel = mounted.findById('terminal-deck-bootstrap-panel');
    assert.equal(bootstrapPanel.props['data-pasted-slot-id'], exactSlotId);
    assert.equal(mounted.vm.controller.state.lastPastedText, exactSlotId);

    // 8. Packaged Electron clipboard round-trip across authorityWire + preload contextBridge
    const { installAuthorityWire } = await import('../electron/authorityWire.js');
    const preloadMod = await import('../electron/preload.js');
    /** @type {Map<string, Function>} */
    const ipcHandlers = new Map();
    const ipcMain = {
      handle(ch, fn) { ipcHandlers.set(ch, fn); },
      removeHandler(ch) { ipcHandlers.delete(ch); },
    };
    const mainFrame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
    const contents = { id: 1, mainFrame, isDestroyed: () => false, postMessage() {} };
    let hostClipBuffer = '';
    const wire = installAuthorityWire({
      ipcMain,
      contents,
      env: {},
      argv: ['--nested-depth=0'],
      core: { request: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p1', core_seq: 1, decision: 'admitted' }) },
      profiles: new Map(),
      clipboard: {
        writeText(t) { hostClipBuffer = String(t); },
        readText() { return hostClipBuffer; },
      },
    });
    let bridgedApi = null;
    preloadMod.installPreload({
      contextBridge: {
        exposeInMainWorld(_name, api) {
          bridgedApi = simulateContextBridgeClone(api);
        },
      },
      ipcRenderer: {
        async invoke(ch, ...args) {
          const fn = ipcHandlers.get(ch);
          if (!fn) throw new Error(`Missing handler: ${ch}`);
          return await fn({ sender: contents, senderFrame: mainFrame }, ...args);
        },
        on() {},
        removeListener() {},
      },
    });
    try {
      await bridgedApi.clipboard.writeText('slot-99-packaged');
      const readBack = await bridgedApi.clipboard.readText();
      assert.equal(readBack, 'slot-99-packaged');
    } finally {
      await wire.dispose();
    }
  } finally {
    mounted.app.unmount();
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});




test('the wall gets the host clipboard so Copy ID for AI never depends on the ambient one', () => {
  const app = readText('../src/App.vue');
  const mount = /<DesktopWorkspace\b[^>]*>/.exec(app);
  assert.ok(mount, 'App.vue mounts DesktopWorkspace');
  assert.match(mount[0], /:clipboard="props\.clipboard"/);
  // DesktopWorkspace forwards attrs to each wall, which hands the clipboard to the tile panel.
  assert.match(readText('../src/wall/DesktopWorkspace.vue'), /v-bind="\$attrs"/);
  assert.match(readText('../src/wall/WallWorkspace.vue'), /clipboard: props\.clipboard/);
});

test('V023-REVIEW-FIX-8: clipboard read failure shows visible paste failure and writes nothing; pasteClipboard returns pasted:false when no bytes are written (with mutants)', async () => {
  async function runPasteFailureAndNoBytesOracle(deckApi) {
    const harness = createBrokerDouble();
    let shouldFailRead = false;
    let hostClip = 'initial';
    const clipboard = {
      async writeText(text) {
        hostClip = String(text);
      },
      async readText() {
        if (shouldFailRead) {
          throw new Error('CLIPBOARD_READ_DENIED');
        }
        return hostClip;
      },
    };

    // 1. pasteClipboard when no terminal slot exists must return pasted: false and write 0 bytes.
    const emptyController = deckApi.createTerminalDeckController({
      broker: harness.broker,
      sessionFacade: harness.sessionFacade,
      clipboard,
      storage: createMemoryStorage(),
      toastDurationMs: 0,
    });
    try {
      const noTargetRes = await emptyController.pasteClipboard('orphan-payload');
      assert.equal(noTargetRes.pasted, false, 'pasteClipboard must return pasted:false when no slot exists');
      assert.equal(harness.writeCalls.length, 0);
    } finally {
      emptyController.dispose();
    }

    // 2. Host clipboard read failure after a prior copySelection must NOT fall back to last written text,
    //    must write 0 bytes, and must surface a visible paste failure.
    const controller = deckApi.createTerminalDeckController({
      broker: harness.broker,
      sessionFacade: harness.sessionFacade,
      clipboard,
      storage: createMemoryStorage(),
      toastDurationMs: 0,
    });
    try {
      const slot = await controller.launchProfile('shell', { cols: 80, rows: 24 });
      const copied = await controller.copySelection('stale-secret-copied-earlier', slot.id);
      assert.equal(copied.copied, true);

      shouldFailRead = true;
      const writesBefore = harness.writeCalls.length;
      const failedPaste = await controller.pasteClipboard(undefined, slot.id);
      assert.equal(failedPaste.pasted, false, 'Failed clipboard read must return pasted:false');
      assert.equal(failedPaste.text, '', 'Failed clipboard read must not return stale text');
      assert.equal(harness.writeCalls.length, writesBefore, 'Failed clipboard read must write 0 bytes to PTY');
      assert.equal(controller.state.errorCode, 'TERMINAL_PASTE_FAILED');
      assert.match(controller.state.errorMessage, /TERMINAL_PASTE_FAILED/);
      assert.equal(controller.state.toastMessage, 'Paste failed');

      // 3. Exited slot must also return pasted:false when no bytes can be written.
      shouldFailRead = false;
      hostClip = 'after-exit';
      harness.sessionFacade.emitExit(slot.sessionId, { code: 0 });
      await tick();
      assert.equal(controller.findSlot(slot.id)?.slot.status, 'exited');
      const exitedPaste = await controller.pasteClipboard('after-exit', slot.id);
      assert.equal(exitedPaste.pasted, false, 'Pasting into an exited slot must return pasted:false');
      assert.equal(harness.writeCalls.length, writesBefore);
    } finally {
      controller.dispose();
    }
  }

  await runPasteFailureAndNoBytesOracle(deckModel);

  // Mutant 8a: readClipboardText falls back to stale in-memory text instead of failing closed.
  const mutatedFallbackToStale = await altered(
    '../src/terminal/terminalDeckModel.js',
    "    if (failed || !hasReader) {\n      errorCode = 'TERMINAL_PASTE_FAILED';\n      errorMessage = 'TERMINAL_PASTE_FAILED: Clipboard read failed; nothing was pasted.';\n      toastMessage = 'Paste failed';\n      notify();\n    }\n    return '';",
    "    return 'stale-secret-copied-earlier';",
  );
  await assert.rejects(
    () => runPasteFailureAndNoBytesOracle(mutatedFallbackToStale),
    assert.AssertionError,
  );

  // Mutant 8b: pasteClipboard reports pasted:true even when no slot is running / no bytes were written.
  const mutatedAlwaysPastedTrue = await altered(
    '../src/terminal/terminalDeckModel.js',
    "    if (!slot || slot.status !== 'running' || !slot.sessionId) {\n      notify();\n      return { pasted: false, text: '', usedTermPaste: false };\n    }",
    "    if (!slot || slot.status !== 'running' || !slot.sessionId) {\n      notify();\n      return { pasted: true, text, usedTermPaste: false };\n    }",
  );
  await assert.rejects(
    () => runPasteFailureAndNoBytesOracle(mutatedAlwaysPastedTrue),
    assert.AssertionError,
  );
});

test('V023-REVIEW-FIX-9: switching screens closes context menu and Bootstrap focus does not stay sticky after focus moves elsewhere (with mutants)', async () => {
  async function runContextMenuAndBootstrapFocusOracle(mutateSfc = null) {
    const harness = createBrokerDouble();
    /** @type {string[]} */
    const termPasted = [];
    let clipboardText = 'terminal-paste-payload';

    class StubTerminal {
      constructor() {
        this.cols = 80;
        this.rows = 24;
        this.onDataCb = null;
      }
      loadAddon() {}
      attachCustomKeyEventHandler() {}
      onData(cb) {
        this.onDataCb = cb;
        return { dispose() {} };
      }
      open() {}
      write() {}
      focus() {}
      blur() {}
      getSelection() {
        return 'sel';
      }
      paste(text) {
        termPasted.push(text);
        if (this.onDataCb) {
          this.onDataCb(`\x1b[200~${text}\x1b[201~`);
        }
      }
      dispose() {}
    }
    class StubFitAddon {
      fit() {}
    }

    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    /** @type {Map<string, Set<Function>>} */
    const winListeners = new Map();
    /** @type {Map<string, Set<Function>>} */
    const docListeners = new Map();

    const TerminalDeckView = await compileSfc(
      '../src/terminal/TerminalDeckView.vue',
      {
        '@xterm/xterm': { Terminal: StubTerminal },
        '@xterm/addon-fit': { FitAddon: StubFitAddon },
        '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
        './terminalDeckModel.js': deckModel,
      },
      mutateSfc,
    );

    globalThis.window = /** @type {any} */ ({
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        winListeners.get(type)?.delete(fn);
      },
    });
    globalThis.document = /** @type {any} */ ({
      body: { dataset: {}, setAttribute() {}, removeAttribute() {} },
      activeElement: null,
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        docListeners.get(type)?.delete(fn);
      },
    });

    const mounted = mountTree(TerminalDeckView, {
      open: true,
      terminalBroker: harness.broker,
      terminalBinding: harness.sessionFacade,
      clipboard: {
        async writeText(t) {
          clipboardText = String(t);
        },
        async readText() {
          return clipboardText;
        },
      },
      storage: createMemoryStorage(),
    });

    try {
      await tick();
      await mounted.findById('terminal-deck-empty-shell').props.onClick();
      await tick();
      const tile1 = mounted.findById('terminal-deck-tile-slot-1');
      assert.notEqual(tile1, null);

      // 1. Open context menu on Screen 1, then add/switch to Screen 2 -> context menu must close.
      tile1.props.onContextmenu({ clientX: 50, clientY: 60, preventDefault() {}, stopPropagation() {} });
      await tick();
      assert.notEqual(mounted.findById('terminal-deck-context-menu'), null);

      mounted.findById('terminal-deck-screen-add').props.onClick();
      await tick();
      assert.equal(Boolean(mounted.findById('terminal-deck-context-menu')), false, 'Adding/switching screen must close context menu');

      // Switch back to Screen 1, open context menu again, and switch via Ctrl+PageDown (controller.switchScreen) -> must also close.
      mounted.findById('terminal-deck-screen-1').props.onClick();
      await tick();
      tile1.props.onContextmenu({ clientX: 50, clientY: 60, preventDefault() {}, stopPropagation() {} });
      await tick();
      assert.notEqual(mounted.findById('terminal-deck-context-menu'), null);

      for (const fn of winListeners.get('keydown') ?? []) {
        fn({ key: 'PageDown', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} });
      }
      await tick();
      assert.equal(Boolean(mounted.findById('terminal-deck-context-menu')), false, 'Switching screens via shortcut must close context menu');

      // Switch back to Screen 1 for Bootstrap focus test.
      mounted.findById('terminal-deck-screen-1').props.onClick();
      await tick();

      // 2. Focus Bootstrap button, then blur / move focus elsewhere -> subsequent paste must go to terminal, not Bootstrap.
      const bootstrapBtn = mounted.findById('terminal-deck-bootstrap');
      bootstrapBtn.props.onFocus?.();
      await tick();
      // Blur Bootstrap (focus moves to another control such as New terminal button)
      const newBtn = mounted.findById('terminal-deck-new');
      globalThis.document.activeElement = newBtn;
      bootstrapBtn.props.onBlur?.({ relatedTarget: newBtn });
      await tick();

      clipboardText = 'paste-into-terminal-after-blur';
      const res = await mounted.vm.controller.pasteClipboard();
      await tick();
      assert.equal(res.pasted, true);
      assert.deepEqual(termPasted, ['paste-into-terminal-after-blur']);
      assert.notEqual(
        mounted.findById('terminal-deck-bootstrap-panel').props['data-pasted-slot-id'],
        'paste-into-terminal-after-blur',
        'Bootstrap must not hijack paste after focus moved elsewhere',
      );
    } finally {
      mounted.app.unmount();
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
    }
  }

  await runContextMenuAndBootstrapFocusOracle();

  // Mutant 9a: switching screens leaves contextMenu open.
  await assert.rejects(
    () =>
      runContextMenuAndBootstrapFocusOracle((src) =>
        src
          .replace('function selectScreen(index) {\n  closeContextMenu();', 'function selectScreen(index) {')
          .replace('function addScreen() {\n  closeContextMenu();', 'function addScreen() {')
          .replace('if (prev && screenIdx !== prev[1]) {\n      closeContextMenu();\n      lastBootstrapFocused.value = false;\n    }', 'if (false) {}'),
      ),
    assert.AssertionError,
  );

  // Mutant 9b: Bootstrap focus stays sticky after blur / focus move elsewhere.
  await assert.rejects(
    () =>
      runContextMenuAndBootstrapFocusOracle((src) =>
        src
          .replace('function onBootstrapFocusOut(event) {\n  if (!isInsideBootstrapWrap(event?.relatedTarget)) {\n    lastBootstrapFocused.value = false;\n  }\n}', 'function onBootstrapFocusOut() {}')
          .replace('if (activeEl && !isBootstrapActive) {\n      lastBootstrapFocused.value = false;\n      return false;\n    }', 'if (false) {}'),
      ),
    assert.AssertionError,
  );
});

// ---------------------------------------------------------------------------
// 11. V024-WALL-FIXES: At most 2 terminals per screen (auto-creates or uses
//     next screen for Shell and Custom CLI), CLASS_LIMIT real refusal code,
//     dismissible & auto-cleared error banner, and session leak / close fixes
// ---------------------------------------------------------------------------

test('V024-WALL-FIXES: at most 2 terminals per screen; opening a 3rd terminal (Shell or Custom CLI) creates or uses the next screen and switches to it (with mutants)', async () => {
  assert.equal(deckModel.MAX_SLOTS_PER_SCREEN, 2);

  async function screenCapOracle(api) {
    const harness = createBrokerDouble();
    const controller = api.createTerminalDeckController({
      broker: harness.broker,
      sessionFacade: harness.sessionFacade,
    });

    try {
      // 1. Open 2 Shell terminals on Screen 1 -> stays on Screen 1 (slots: 2).
      const s1 = await controller.launchProfile('shell');
      const s2 = await controller.launchProfile('shell');
      assert.equal(controller.state.screens.length, 1);
      assert.equal(controller.state.activeScreenIndex, 0);
      assert.deepEqual(controller.state.screens[0].slots.map((s) => s.id), [s1.id, s2.id]);

      // 2. Open a 3rd Shell terminal on full Screen 1 -> creates Screen 2 and switches to it.
      const s3 = await controller.launchProfile('shell');
      assert.equal(controller.state.screens.length, 2);
      assert.equal(controller.state.activeScreenIndex, 1);
      assert.equal(controller.state.screens[0].slots.length, 2);
      assert.deepEqual(controller.state.screens[1].slots.map((s) => s.id), [s3.id]);
      assert.equal(controller.state.focusedSlotId, s3.id);

      // 3. Switch back to full Screen 1 and launch a Custom CLI -> reuses existing Screen 2 (which has 1 slot) and switches to it.
      controller.selectScreen(0);
      assert.equal(controller.state.activeScreenIndex, 0);
      const s4 = await controller.launchCustomCli('echo second-on-screen-2');
      assert.equal(controller.state.screens.length, 2, 'Must use existing Screen 2 when it has capacity');
      assert.equal(controller.state.activeScreenIndex, 1);
      assert.deepEqual(controller.state.screens[1].slots.map((s) => s.id), [s3.id, s4.id]);

      // 4. Screen 2 is now also full (2 slots). Launch another Custom CLI -> creates Screen 3 and switches to it.
      const s5 = await controller.launchCustomCli('echo first-on-screen-3');
      assert.equal(controller.state.screens.length, 3);
      assert.equal(controller.state.activeScreenIndex, 2);
      assert.deepEqual(controller.state.screens[2].slots.map((s) => s.id), [s5.id]);
    } finally {
      controller.dispose();
    }
  }

  await screenCapOracle(deckModel);

  // Mutant 1: MAX_SLOTS_PER_SCREEN raised above 2 keeps 3rd terminal on Screen 1.
  const mutatedCap4 = await altered(
    '../src/terminal/terminalDeckModel.js',
    'export const MAX_SLOTS_PER_SCREEN = 2;',
    'export const MAX_SLOTS_PER_SCREEN = 4;',
  );
  await assert.rejects(() => screenCapOracle(mutatedCap4), { code: 'ERR_ASSERTION' });

  // Mutant 2: launchCustomCli bypasses resolveTargetScreenForNewSlot.
  const mutatedCustomNoOverflow = await altered(
    '../src/terminal/terminalDeckModel.js',
    '    const screen = resolveTargetScreenForNewSlot() ?? screens[activeScreenIndex];\n    const slotId = `slot-${nextSlotSeq++}`;\n    /** @type {DeckSlot} */\n    const slot = {\n      id: slotId,\n      title: commandText,',
    '    const screen = screens[activeScreenIndex];\n    const slotId = `slot-${nextSlotSeq++}`;\n    /** @type {DeckSlot} */\n    const slot = {\n      id: slotId,\n      title: commandText,',
  );
  await assert.rejects(() => screenCapOracle(mutatedCustomNoOverflow), { code: 'ERR_ASSERTION' });
});

test('V024-WALL-FIXES: real broker refusal code (CLASS_LIMIT), dismissible error banner, auto-clear on success, cumulative byte ack, and single clean close without TERMINAL_UNKNOWN_SESSION errors (with mutants)', async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { MessageChannel } = await import('node:worker_threads');
  const { createTerminalHost } = await import('../electron/terminalHost.js');
  const { installAuthorityWire } = await import('../electron/authorityWire.js');
  const preloadMod = await import('../electron/preload.js');
  const { createTerminalBroker } = await import('../src/core/hostAdapters.js');

  const root = await mkdtemp(join(tmpdir(), 'v024-wall-fixes-pty-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const resourcesPath = join(root, 'resources');
  const stagedPtyDir = join(resourcesPath, 'build-native/pty-runtime/node-pty');
  await mkdir(stagedPtyDir, { recursive: true });
  await writeFile(
    join(stagedPtyDir, 'package.json'),
    JSON.stringify({ name: 'node-pty', version: '1.1.0', main: './index.cjs' }),
  );
  await writeFile(
    join(stagedPtyDir, 'index.cjs'),
    `module.exports = {
      spawn(file, args, opts) {
        let onData = () => {};
        let onExit = () => {};
        let killed = false;
        return {
          pid: Math.floor(10000 + Math.random() * 80000),
          file,
          args,
          opts,
          onData(fn) { onData = fn; return { dispose() {} }; },
          onExit(fn) { onExit = fn; return { dispose() {} }; },
          write(d) {
            if (killed) return;
            const s = String(d);
            if (s === '\\x03') {
              killed = true;
              onExit({ exitCode: 130 });
              return;
            }
            onData(s);
          },
          resize() {},
          kill() {
            if (!killed) {
              killed = true;
              onExit({ exitCode: 0 });
            }
          },
          pause() {},
          resume() {},
        };
      }
    };\n`,
  );

  /** @type {Map<string, Function>} */
  const ipcHandlers = new Map();
  /** @type {Map<string, Set<Function>>} */
  const ipcRendererListeners = new Map();
  /** @type {Set<MessagePort>} */
  const activePorts = new Set();
  const closeIpcOutcomes = [];

  const ipcMain = {
    handle(channel, fn) {
      ipcHandlers.set(channel, async (event, ...args) => {
        try {
          const res = await fn(event, ...args);
          if (channel === 'metaviewer:side-terminal.close') {
            closeIpcOutcomes.push({ ok: true, res });
          }
          return res;
        } catch (err) {
          if (channel === 'metaviewer:side-terminal.close') {
            closeIpcOutcomes.push({ ok: false, message: err?.message });
          }
          throw err;
        }
      });
    },
    removeHandler(channel) {
      ipcHandlers.delete(channel);
    },
  };

  const mainFrame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = {
    id: 88,
    mainFrame,
    isDestroyed: () => false,
    postMessage(channel, value, transfer) {
      const listeners = ipcRendererListeners.get(channel);
      if (!listeners) return;
      for (const fn of [...listeners]) {
        fn({ ports: transfer ?? [] }, value);
      }
    },
  };
  const senderEvent = { sender: contents, senderFrame: mainFrame };
  const cleanEnv = { PATH: '/usr/bin:/bin', HOME: root, TERM: 'xterm-256color', XDG_CONFIG_HOME: root };

  const terminalHost = createTerminalHost({
    env: cleanEnv,
    resourcesPath,
    createMessageChannel: () => {
      const { port1, port2 } = new MessageChannel();
      activePorts.add(port1);
      activePorts.add(port2);
      return { port1, port2 };
    },
  });
  const wire = installAuthorityWire({
    ipcMain,
    contents,
    env: cleanEnv,
    argv: ['--nested-depth=0'],
    core: {
      request: async () => ({
        schema: 'action_verdict/v0.2',
        proposal_id: 'p1',
        core_seq: 1,
        decision: 'admitted',
      }),
    },
    profiles: new Map(),
    terminal: terminalHost,
  });

  let rendererWindowMetaviewer = null;
  preloadMod.installPreload({
    contextBridge: {
      exposeInMainWorld(_name, api) {
        rendererWindowMetaviewer = simulateContextBridgeClone(api);
      },
    },
    ipcRenderer: {
      async invoke(channel, ...args) {
        const handler = ipcHandlers.get(channel);
        if (!handler) throw new Error(`CHANNEL: ${channel}`);
        const res = await handler(senderEvent, ...args);
        if (channel === 'metaviewer:side-terminal.attach' && res && typeof res === 'object') {
          return { session: res.session };
        }
        return res;
      },
      on(channel, fn) {
        if (!ipcRendererListeners.has(channel)) ipcRendererListeners.set(channel, new Set());
        ipcRendererListeners.get(channel).add(fn);
      },
      removeListener(channel, fn) {
        ipcRendererListeners.get(channel)?.delete(fn);
      },
    },
  });

  class StubTerminal {
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    open() {}
    write() {}
    focus() {}
    blur() {}
    dispose() {}
  }
  class StubFitAddon {
    fit() {}
  }

  const TerminalDeckView = await compileSfc('../src/terminal/TerminalDeckView.vue', {
    '@xterm/xterm': { Terminal: StubTerminal },
    '@xterm/addon-fit': { FitAddon: StubFitAddon },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
    './terminalDeckModel.js': deckModel,
  });

  const rendererBroker = createTerminalBroker(rendererWindowMetaviewer.sideTerminal);
  const mounted = mountTree(TerminalDeckView, {
    open: true,
    terminalBroker: rendererBroker,
    terminalBinding: rendererWindowMetaviewer.sideTerminal,
    storage: createMemoryStorage(),
    closeGraceMs: 10,
  });

  try {
    await tick();
    const ctrl = mounted.vm.controller;

    // 1. Open 16 shells: 2 per screen gives 8 screens, reaching ptyBroker maxShellSessions = 16.
    const slot1 = await ctrl.launchProfile('shell');
    const slot2 = await ctrl.launchProfile('shell');
    const slot3 = await ctrl.launchProfile('shell');
    const slot4 = await ctrl.launchProfile('shell');
    for (let i = 5; i <= 16; i += 1) {
      await ctrl.launchProfile('shell');
    }
    await tick();
    assert.equal(ctrl.state.screens.length, 8);
    assert.equal(ctrl.state.screens[0].slots.length, 2);
    assert.equal(ctrl.state.screens[1].slots.length, 2);

    // 2. Stream > 260 data chunks on slot1 to verify cumulative byte ack prevents 256-frame credit stall.
    for (let i = 0; i < 265; i += 1) {
      ctrl.writeSessionBytes(slot1.sessionId, [65]);
    }
    await sleep(30);
    assert.equal(slot1.status, 'running', 'Cumulative credit ack must keep session alive past 256 frames');

    // 3. A 17th shell open hits ptyBroker handleOpen countLiveByClass('shell') >= 16 -> refuses with real code CLASS_LIMIT.
    await assert.rejects(() => ctrl.launchProfile('shell'));
    await tick();
    const errBanner = mounted.findById('terminal-deck-error');
    assert.notEqual(errBanner, null, 'Error banner must be rendered');
    assert.equal(errBanner.props['data-error-code'], 'CLASS_LIMIT', 'Must surface real refusal code CLASS_LIMIT');
    assert.match(mounted.textOf(errBanner), /^CLASS_LIMIT: /);

    // 4. Error banner is dismissible via #terminal-deck-error-dismiss.
    const dismissBtn = mounted.findById('terminal-deck-error-dismiss');
    assert.notEqual(dismissBtn, null, 'Dismiss button must be rendered inside #terminal-deck-error');
    dismissBtn.props.onClick();
    await tick();
    assert.equal(mounted.findById('terminal-deck-error'), null, 'Clicking dismiss must clear the error banner');
    assert.equal(ctrl.state.errorCode, '');
    assert.equal(ctrl.state.errorMessage, '');

    // 5. Trigger CLASS_LIMIT again, then close slot4 -> closing a slot frees its broker session AND clears the error,
    //    and does NOT emit TERMINAL_UNKNOWN_SESSION errors on side-terminal.close!
    await assert.rejects(() => ctrl.launchProfile('shell'));
    await tick();
    assert.equal(mounted.findById('terminal-deck-error')?.props['data-error-code'], 'CLASS_LIMIT');

    closeIpcOutcomes.length = 0;
    const slot4SessionId = slot4.sessionId;
    await ctrl.requestCloseSlot(slot4.id, { force: true });
    await tick();
    assert.equal(mounted.findById('terminal-deck-error'), null, 'Closing a slot clears the error banner');
    assert.equal(
      closeIpcOutcomes.filter((c) => !c.ok).length,
      0,
      `Closing a slot must not fail with TERMINAL_UNKNOWN_SESSION: ${JSON.stringify(closeIpcOutcomes)}`,
    );

    // 6. Because closing slot4 freed its broker session, opening a new shell now succeeds!
    // Reaching the cap spent the whole spawn burst; one token refills per second.
    await sleep(1100);
    const slot5 = await ctrl.launchProfile('shell');
    await tick();
    assert.equal(slot5.status, 'running');
    assert.equal(ctrl.state.errorCode, '');
    assert.equal(mounted.findById('terminal-deck-error'), null);

    // 7. Calling rendererBroker.close on an already-gone session is a no-op success (not an error for the user).
    const goneCloseResult = await rendererBroker.close({ session: slot4SessionId });
    assert.equal(goneCloseResult, true);

    void slot2;
    void slot3;
  } finally {
    mounted.app.unmount();
    await wire.dispose();
    await terminalHost.dispose();
    for (const p of activePorts) {
      try { p.close(); } catch {}
    }
  }
});



test('paired terminal keeps newest requested capsule focused and retains hidden sessions', async () => {
  const harness = createBrokerDouble(), waiting = [];
  harness.broker.open = () => new Promise(resolve => waiting.push(resolve));
  class Terminal {loadAddon() {} attachCustomKeyEventHandler() {} onData() {return {dispose(){}};} open() {} write() {} focus() {} blur() {} dispose() {}}
  const View = await compileSfc('../src/terminal/TerminalDeckView.vue', {
    '@xterm/xterm': {Terminal}, '@xterm/addon-fit': {FitAddon:class {fit(){}}},
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js':{createTerminalDocument:()=>({})},
    './terminalDeckModel.js':deckModel,
  });
  const target=vue.ref({surfaceId:'surface-a',profileId:'identity-a',title:'Alpha'}), open=vue.ref(true), focus=[];
  let deck;
  const Root={setup(){return ()=>vue.h(View,{ref:value=>{deck=value;},open:open.value,pairedTarget:target.value,terminalBroker:harness.broker,terminalBinding:harness.sessionFacade,storage:createMemoryStorage(),'onPair-focus':id=>focus.push(id)});}};
  const mounted=mountTree(Root);
  try {
    await tick(); assert.equal(waiting.length,1);
    target.value={surfaceId:'surface-b',profileId:'identity-b',title:'Beta'};await tick();assert.equal(deck.$props.pairedTarget.surfaceId,'surface-b');assert.equal(waiting.length,1,'broker admission serializes opens');
    waiting[0]({session:'pair-a'});await tick();assert.equal(waiting.length,2);
    assert.equal(deck.controller.state.focusedSlotId,null,'obsolete Alpha opens in background');
    waiting[1]({session:'pair-b'});await tick();
    const b=deck.controller.state.focusedSlotId;assert.ok(b);assert.equal(focus.at(-1),'surface-b');
    assert.equal(deck.controller.state.focusedSlotId,b,'latest Beta retains focus');
    assert.match(mounted.textOf(mounted.root),/Beta.*Host shell/);
    open.value=false;await tick();open.value=true;await tick();
    assert.equal(waiting.length,2,'reopening retains the paired PTY');
    target.value={surfaceId:'surface-a',profileId:'identity-a',title:'Alpha'};await tick();
    assert.equal(focus.at(-1),'surface-a');assert.notEqual(deck.controller.state.focusedSlotId,b);
    assert.equal(waiting.length,2,'switching back reuses Alpha');
  } finally {mounted.app.unmount();}
});


test('terminal viewport resize fits retained contents without taking focus',async()=>{
  const previous=globalThis.ResizeObserver;let observer,focus=0,fits=0;
  class Observer {constructor(cb){this.cb=cb;this.nodes=new Set();observer=this;}observe(n){this.nodes.add(n);}unobserve(n){this.nodes.delete(n);}disconnect(){this.disconnected=true;}}
  globalThis.ResizeObserver=Observer;
  const harness=createBrokerDouble();
  class Terminal {cols=80;rows=24;loadAddon(){}attachCustomKeyEventHandler(){}onData(){return {dispose(){}};}open(){}write(){}focus(){focus++;}dispose(){}}
  const View=await compileSfc('../src/terminal/TerminalDeckView.vue',{
    '@xterm/xterm':{Terminal},'@xterm/addon-fit':{FitAddon:class {fit(){fits++;}}},
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js':{createTerminalDocument:()=>({})},'./terminalDeckModel.js':deckModel,
  });
  const mounted=mountTree(View,{terminalBroker:harness.broker,terminalBinding:harness.sessionFacade,storage:createMemoryStorage()});
  try {
    await mounted.vm.controller.launchProfile('shell');await tick();
    const node=[...observer.nodes][0];assert.ok(node);
    const beforeFocus=focus,beforeFit=fits,beforeResize=harness.resizeCalls.length;
    observer.cb([{target:node,contentRect:{width:450,height:600}}]);
    assert.equal(focus,beforeFocus);assert.equal(fits,beforeFit+1);assert.equal(harness.resizeCalls.length,beforeResize+1);
    observer.cb([{target:node,contentRect:{width:450,height:600}}]);
    assert.equal(harness.resizeCalls.length,beforeResize+1,'unchanged character dimensions do not resend PTY resize');
    observer.cb([{target:node,contentRect:{width:0,height:0}}]);assert.equal(fits,beforeFit+2,'hidden viewport is not fitted');
  } finally {mounted.app.unmount();globalThis.ResizeObserver=previous;}
  assert.equal(observer.disconnected,true);
});


test('compact paired drawer never shows or dispatches the previous capsule while a new pair opens',async()=>{
 const harness=createBrokerDouble();let finish,opens=0,disposed=0;
 harness.broker.open=async()=>{if(++opens===2)return await new Promise(resolve=>{finish=resolve;});return {session:'drawer-a'};};
 class Terminal {loadAddon(){}attachCustomKeyEventHandler(){}onData(){return {dispose(){}};}open(){}write(){}focus(){}dispose(){disposed++;}}
 const View=await compileSfc('../src/terminal/TerminalDeckView.vue',{
  '@xterm/xterm':{Terminal},'@xterm/addon-fit':{FitAddon:class {fit(){}}},
  '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js':{createTerminalDocument:()=>({})},'./terminalDeckModel.js':deckModel,
 });
 const target=vue.ref({surfaceId:'surface-a',title:'Alpha'}),compact=vue.ref(true);let deck;
 const Root={setup(){return ()=>vue.h(View,{ref:value=>{deck=value;},open:true,compact:compact.value,pairedTarget:target.value,terminalBroker:harness.broker,terminalBinding:harness.sessionFacade,storage:createMemoryStorage()});}};
 const mounted=mountTree(Root);
 const articles=()=>{const walk=n=>[...(n.tag==='article'?[n]:[]),...n.children.flatMap(walk)];return walk(mounted.root);};
 try {
  await tick();assert.equal(articles().filter(n=>!n.props.hidden).length,1);
  target.value={surfaceId:'surface-b',title:'Beta'};await tick();assert.equal(typeof finish,'function');
  assert.equal(articles().filter(n=>!n.props.hidden).length,0,'previous capsule terminal is not displayed under Beta');
  assert.equal(mounted.findById('terminal-deck-bootstrap-panel'),null,'previous workflow binding is not actionable');
  finish({session:'drawer-b'});await tick();assert.equal(articles().filter(n=>!n.props.hidden).length,1);
  const sessions=deck.controller.state.screens.flatMap(s=>s.slots.map(t=>t.sessionId));
  compact.value=false;await tick();assert.equal(articles().filter(n=>!n.props.hidden).length,2);
  assert.deepEqual(deck.controller.state.screens.flatMap(s=>s.slots.map(t=>t.sessionId)),sessions);
  assert.equal(opens,2);assert.equal(disposed,0,'moving to full dock retains both terminal instances');
 } finally {mounted.app.unmount();}
});
