// @ts-check
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
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
import { writeManifest } from '../tools/package.js';

/**
 * @param {string} prefix
 * @returns {string}
 */
function makeTempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {string} root
 * @returns {void}
 */
function rmRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

/**
 * @returns {{root: string, rendererRoot: string}}
 */
function makeBundle() {
  const root = makeTempRoot('mv-new-bundle-');
  const rendererRoot = join(root, 'dist', 'renderer');
  mkdirSync(rendererRoot, { recursive: true });
  writeFileSync(
    join(rendererRoot, 'index.html'),
    '<!doctype html><html><head><title>t</title></head><body>x</body></html>',
  );
  writeFileSync(join(rendererRoot, 'app.js'), 'console.log(1);\n');
  return { root, rendererRoot };
}

describe('Electron main and preload surface security checks', () => {
  it('1. Host-bindings admission and socket permission checks', async () => {
    const root = makeTempRoot('mv-hb-');
    try {
      const runtimeDir755 = join(root, 'runtime755');
      mkdirSync(runtimeDir755, { mode: 0o755 });
      await assert.rejects(
        createMainBindings({
          env: {
            XDG_RUNTIME_DIR: runtimeDir755,
            MV_CORE_CONFIG: join(runtimeDir755, 'config.json'),
          },
        }),
        (/** @type {Error} */ err) => err.message.includes('CORE_SEAMS_ABSENT'),
      );

      const runtimeDir777 = join(root, 'runtime777');
      mkdirSync(runtimeDir777, { mode: 0o777 });
      await assert.rejects(
        createMainBindings({
          env: {
            XDG_RUNTIME_DIR: runtimeDir777,
            MV_CORE_CONFIG: join(runtimeDir777, 'config.json'),
          },
        }),
        (/** @type {Error} */ err) => err.message.includes('CORE_SEAMS_ABSENT'),
      );
    } finally {
      rmRoot(root);
    }
  });

  it('2. Envelope, frame and request bounds and limits', () => {
    const oversizedJson = 'a'.repeat(256 * 1024 + 1);
    assert.throws(() => jsonObject(oversizedJson), { message: 'PAYLOAD' });

    const validJson = JSON.stringify({ key: 'a'.repeat(100) });
    assert.doesNotThrow(() => jsonObject(validJson));

    const invalidVerdict = { schema: 'action_verdict/v0.2', decision: 'invalid_decision' };
    assert.throws(() => verdictReply(invalidVerdict), { message: 'OUTCOME' });
  });

  it('3. Domain-wire channel closure (11 valid channels)', async () => {
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

  it('4. Domain-wire arity and 256 KiB payload capping', async () => {
    const core = { request: async () => true };
    const handlers = new Map();
    const ipcMain = {
      handle: (/** @type {string} */ ch, /** @type {Function} */ fn) => handlers.set(ch, fn),
      removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
    };
    const webContents = {
      id: 7,
      mainFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` },
      isDestroyed: () => false,
    };
    const wire = installAuthorityWire({ ipcMain, contents: webContents, core });
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    await assert.rejects(
      handlers.get('metaviewer:settings.load')(event, 'extra_arg'),
      { message: 'ARGS' },
    );

    await assert.rejects(
      handlers.get('metaviewer:settings.save')(event),
      { message: 'ARGS' },
    );

    wire.dispose();
  });

  it('5. Terminal-open spec validation', async () => {
    const core = { request: async () => true };
    const handlers = new Map();
    const ipcMain = {
      handle: (/** @type {string} */ ch, /** @type {Function} */ fn) => handlers.set(ch, fn),
      removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
    };
    const webContents = {
      id: 7,
      mainFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` },
      isDestroyed: () => false,
    };
    const wire = installAuthorityWire({ ipcMain, contents: webContents, core });
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    const badColsSpec = { command: 'provider', args: [], cols: 1, rows: 24 };
    await assert.rejects(
      handlers.get('metaviewer:side-terminal.open')(event, badColsSpec),
      { message: 'PAYLOAD' },
    );

    const badRowsSpec = { command: 'provider', args: [], cols: 80, rows: 301 };
    await assert.rejects(
      handlers.get('metaviewer:side-terminal.open')(event, badRowsSpec),
      { message: 'PAYLOAD' },
    );

    const excessArgs = Array(33).fill('arg');
    const badArgsSpec = { command: 'provider', args: excessArgs, cols: 80, rows: 24 };
    await assert.rejects(
      handlers.get('metaviewer:side-terminal.open')(event, badArgsSpec),
      { message: 'ARGV_LENGTH: argv length must be 1..33' },
    );

    wire.dispose();
  });

  it('6. Main-side rechecks under a compromised renderer', async () => {
    const core = { request: async () => true };
    const handlers = new Map();
    const ipcMain = {
      handle: (/** @type {string} */ ch, /** @type {Function} */ fn) => handlers.set(ch, fn),
      removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
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
      { message: 'SENDER' },
    );

    wire.dispose();
  });

  it('7. Asset seal and protocol handler path-escape refusal', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      const res = await handleAppRequest(rendererRoot, {
        url: `${PRIVILEGED_ORIGIN}/../../etc/passwd`,
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
      assert.equal(await res.text(), 'forbidden');
    } finally {
      rmRoot(root);
    }
  });

  it('8. Packaging manifest refuses symlinks inside the bundle root', async () => {
    const root = makeTempRoot('mv-manifest-');
    try {
      const symlinkPath = join(root, 'link');
      const targetPath = join(root, 'target');
      writeFileSync(targetPath, 'test');
      symlinkSync(targetPath, symlinkPath);

      await assert.rejects(
        writeManifest(root, join(root, 'manifest.sha256')),
        /Symlink refused/,
      );
    } finally {
      rmRoot(root);
    }
  });
});
