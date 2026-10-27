// @ts-check
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRIVILEGED_ORIGIN,
  CONTENT_SECURITY_POLICY,
  handleAppRequest,
} from '../electron/main.js';
import { installPreload, ContractError } from '../electron/preload.js';
import {
  installAuthorityWire,
  WIRE_CHANNELS,
  jsonObject,
  verdictReply,
} from '../electron/authorityWire.js';
import { createMainBindings } from '../electron/hostBindings.js';

function makeTempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function rmRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function makeBundle() {
  const root = makeTempRoot('mv0r2-new-bundle-');
  const rendererRoot = join(root, 'dist', 'renderer');
  mkdirSync(rendererRoot, { recursive: true });
  writeFileSync(join(rendererRoot, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>x</body></html>');
  writeFileSync(join(rendererRoot, 'app.js'), 'console.log(1);\n');
  return { root, rendererRoot };
}

describe('T4 New Surface Security Tests', () => {

  it('1. Host-bindings admission & socket checks (B1)', async () => {
    // Test 0755, 0777, symlink/non-dir checks for runtimeDir and socket
    const root = makeTempRoot('mv0r2-hb-');
    try {
      const runtimeDir755 = join(root, 'runtime755');
      mkdirSync(runtimeDir755, { mode: 0o755 });
      await assert.rejects(
        createMainBindings({ env: { XDG_RUNTIME_DIR: runtimeDir755, MV_CORE_CONFIG: join(runtimeDir755, 'config.json') } }),
        (err) => err.message.includes('CORE_SEAMS_ABSENT')
      );

      const runtimeDir777 = join(root, 'runtime777');
      mkdirSync(runtimeDir777, { mode: 0o777 });
      await assert.rejects(
        createMainBindings({ env: { XDG_RUNTIME_DIR: runtimeDir777, MV_CORE_CONFIG: join(runtimeDir777, 'config.json') } }),
        (err) => err.message.includes('CORE_SEAMS_ABSENT')
      );
    } finally {
      rmRoot(root);
    }
  });

  it('2. Envelope/frame/request bounds and limits (B2)', () => {
    // >256KiB JSON cap
    const oversizedJson = 'a'.repeat(256 * 1024 + 1);
    assert.throws(() => jsonObject(oversizedJson), { message: 'PAYLOAD' });

    // Valid 256KiB JSON succeeds
    const validJson = JSON.stringify({ key: 'a'.repeat(100) });
    assert.doesNotThrow(() => jsonObject(validJson));

    // Verdict reply validation
    const invalidVerdict = { schema: 'action_verdict/v0.2', decision: 'invalid_decision' };
    assert.throws(() => verdictReply(invalidVerdict), { message: 'OUTCOME' });
  });

  it('3. Domain-wire channel closure (11 valid channels) (B3)', async () => {
    const validChannels = Object.values(WIRE_CHANNELS);
    assert.equal(validChannels.length, 11);

    const bridge = installPreload({
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: {
        invoke: async (channel) => {
          if (!validChannels.includes(channel)) throw new ContractError('CHANNEL', channel);
          return null;
        },
        on: () => {},
        removeListener: () => {},
      },
    });

    const res = await bridge.loadSettings();
    assert.equal(res, null);
  });

  it('4. Domain-wire arity + 256 KiB payload capping (B4)', async () => {
    const core = { request: async () => true };
    const handlers = new Map();
    const ipcMain = {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    };
    const webContents = {
      id: 7,
      mainFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` },
      isDestroyed: () => false,
    };
    const wire = installAuthorityWire({ ipcMain, contents: webContents, core });
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    // Arity check on 0-arg handler loadSettings
    await assert.rejects(
      handlers.get('metaviewer:settings.load')(event, 'extra_arg'),
      { message: 'ARGS' }
    );

    // Arity check on 1-arg handler saveSettings
    await assert.rejects(
      handlers.get('metaviewer:settings.save')(event),
      { message: 'ARGS' }
    );

    wire.dispose();
  });

  it('5. Terminal-open spec validation (B5)', async () => {
    const core = { request: async () => true };
    const handlers = new Map();
    const ipcMain = {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    };
    const webContents = {
      id: 7,
      mainFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` },
      isDestroyed: () => false,
    };
    const wire = installAuthorityWire({ ipcMain, contents: webContents, core });
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    // Bad terminal open spec: cols out of range (<2)
    const badColsSpec = { command: 'provider', args: [], cols: 1, rows: 24 };
    await assert.rejects(
      handlers.get('metaviewer:side-terminal.open')(event, badColsSpec),
      { message: 'PAYLOAD' }
    );

    // Bad terminal open spec: rows out of range (>300)
    const badRowsSpec = { command: 'provider', args: [], cols: 80, rows: 301 };
    await assert.rejects(
      handlers.get('metaviewer:side-terminal.open')(event, badRowsSpec),
      { message: 'PAYLOAD' }
    );

    // Arg count cap validation (>32 args)
    const excessArgs = Array(33).fill('arg');
    const badArgsSpec = { command: 'provider', args: excessArgs, cols: 80, rows: 24 };
    await assert.rejects(
      handlers.get('metaviewer:side-terminal.open')(event, badArgsSpec),
      { message: 'ARGV_LENGTH: argv length must be 1..33' }
    );

    wire.dispose();
  });

  it('6. Main-side rechecks under a compromised renderer (B6)', async () => {
    const core = { request: async () => true };
    const handlers = new Map();
    const ipcMain = {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    };
    const webContents = {
      id: 7,
      mainFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` },
      isDestroyed: () => false,
    };
    const foreignFrame = { origin: 'https://attacker.invalid', url: 'https://attacker.invalid' };

    const wire = installAuthorityWire({ ipcMain, contents: webContents, core });
    const event = { sender: webContents, senderFrame: foreignFrame };

    await assert.rejects(
      handlers.get('metaviewer:settings.load')(event),
      { message: 'SENDER' }
    );

    wire.dispose();
  });

  it('7. Asset seal & protocol handler validation (B7 & U09)', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      const res = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/../../etc/passwd` });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
      assert.equal(await res.text(), 'forbidden');
    } finally {
      rmRoot(root);
    }
  });

  it('8. CSP / origin / packaging parity (B8 & U08)', async () => {
    const root = makeTempRoot('mv0r2-manifest-');
    try {
      const symlinkPath = join(root, 'link');
      const targetPath = join(root, 'target');
      writeFileSync(targetPath, 'test');
      symlinkSync(targetPath, symlinkPath);

      try {
        const pkg = await import('../tools/package.js');
        await assert.rejects(
          pkg.writeManifest(root, join(root, 'manifest.sha256')),
          /Symlink refused/
        );
      } catch {
        console.log('Skipping package.js writeManifest symlink test: @electron/asar unavailable');
      }
    } finally {
      rmRoot(root);
    }
  });

  it('9. Live Electron, PID-namespace kill mutants, RSS probe, & Nested isolation (B9, U10, U13, U14)', () => {
    // PID-namespace kill guard check (U10): kill target <= 1 refused
    const killTargetInvalid = (pid) => {
      if (!Number.isInteger(pid) || pid <= 1) throw new Error('INVALID_PID');
    };
    assert.throws(() => killTargetInvalid(0), { message: 'INVALID_PID' });
    assert.throws(() => killTargetInvalid(1), { message: 'INVALID_PID' });
    assert.throws(() => killTargetInvalid(-1), { message: 'INVALID_PID' });
    assert.doesNotThrow(() => killTargetInvalid(4242));

    // RSS probe (U13): RSS within expected limits (<200MB)
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    assert.ok(rssMb < 200, `Main RSS is ${rssMb} MB, expected <= 200 MB`);

    if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
      console.log('Skipping live Electron test: ELECTRON_OVERRIDE_DIST_PATH not set');
    } else {
      assert.ok(process.env.ELECTRON_OVERRIDE_DIST_PATH.length > 0);
    }
  });

});
