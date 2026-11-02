import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as deckModel from '../src/terminal/terminalDeckModel.js';
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

async function compileSfc(relPath, deps = {}) {
  const source = readText(relPath);
  const { descriptor } = parse(source);
  let code = compileScript(descriptor, { id: `p18h-${++serial}`, inlineTemplate: true }).content;
  const key = `__p18hDeps_${serial}`;
  globalThis[key] = deps;
  code = code.replace(/^import\s+(['"])(.*?)\1;?\s*$/gm, '');
  code = code.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (line, binding, _q, spec) => {
    if (spec === 'vue') {
      return line.replace(/(['"])vue\1/, JSON.stringify(import.meta.resolve('vue')));
    }
    const normalized = binding
      .replace(/^\{\s*/, '{ ')
      .replace(/\s*\}$/, ' }')
      .replace(/\bas\b/g, ':');
    return `const ${normalized} = globalThis[${JSON.stringify(key)}][${JSON.stringify(spec)}];`;
  });
  const encoded = Buffer.from(code, 'utf8').toString('base64');
  const mod = await import(`data:text/javascript;base64,${encoded}#sfc-${serial}`);
  delete globalThis[key];
  return mod.default;
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

test('P18H App.vue mounts TerminalDeckView on More -> Terminal and hides capsule walls without revoking human views', () => {
  const appSource = readText('../src/App.vue');
  assert.ok(
    appSource.includes('<UiButton role="menuitem" id="shell-terminal" data-semantic-anchor="terminal/toggle" label="Terminal"'),
    'More menu must contain the Terminal item',
  );
  assert.ok(
    appSource.includes('<TerminalDeckView :open="terminalDeckOpen"'),
    'App.vue must mount TerminalDeckView when terminalDeckOpen is true',
  );
  assert.ok(
    appSource.includes('<DesktopWorkspace v-else :hidden="creativeOpen || terminalDeckOpen"'),
    'Entering the Terminal deck must hide the capsule wall (hide-not-revoke)',
  );
  assert.ok(
    appSource.includes('<RoleSurface :presentation-active="desktopActive && !creativeOpen && !terminalDeckOpen"'),
    'Entering the Terminal deck must deactivate RoleSurface presentation (hide-not-revoke) and restore it on exit',
  );
});
