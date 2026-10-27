/**
 * W0-SHELL-MAIN suite: Electron main policy plus Rust core launcher.
 *
 * Runs under plain Node (`node --test`): no Electron binary, no display,
 * no real child spawn and no real signals. Every negative fixture asserts
 * zero authority change (no spawn, no window, no write, no grant).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANNELS,
  CONTENT_SECURITY_POLICY,
  DEFAULT_GEOMETRY,
  ELECTRON_PIN,
  FORBIDDEN_ARGV_FLAGS,
  FUSE_TABLE,
  LAYOUT_MAX_BYTES,
  MODULE_REGISTRY,
  PRIVILEGED_HOST,
  PRIVILEGED_ORIGIN,
  PRIVILEGED_SCHEME,
  attachWindowPolicy,
  bootProductionMain,
  buildCsp,
  buildFuseConfig,
  createLayoutBridge,
  createWindowOptions,
  decideNavigation,
  handleAppRequest,
  observeSender,
  registerPrivilegedScheme,
  resolveMainPaths,
  serveBundled,
  validateRetailLaunch,
} from '../electron/main.js';
import {
  createCoreLauncher,
  scrubChildEnv,
  validateKillTarget,
} from '../electron/coreLauncher.js';

/**
 * Assert a synchronous function throws an error carrying the exact code.
 * @param {() => unknown} fn Function expected to throw.
 * @param {string} code Expected error code.
 * @returns {void}
 */
function throwsCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(/** @type {{code?: unknown}} */ (/** @type {unknown} */ (error)).code, code);
    return;
  }
  assert.fail(`expected throw with code ${code}`);
}

/**
 * Assert a promise rejects with an error carrying the exact code.
 * @param {Promise<unknown>} promise Promise expected to reject.
 * @param {string} code Expected error code.
 * @returns {Promise<void>}
 */
async function rejectsCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(/** @type {{code?: unknown}} */ (/** @type {unknown} */ (error)).code, code);
    return;
  }
  assert.fail(`expected rejection with code ${code}`);
}

/**
 * @param {string} prefix Tmp prefix.
 * @returns {string} Fresh directory.
 */
function makeTempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {string} root Directory to remove.
 * @returns {void}
 */
function rmRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

/**
 * Build a minimal bundle fixture: renderer index.html plus preload entry.
 * @returns {{root: string, rendererRoot: string}} Fixture paths.
 */
function makeBundle() {
  const root = makeTempRoot('mv0main-bundle-');
  const rendererRoot = join(root, 'dist', 'renderer');
  mkdirSync(rendererRoot, { recursive: true });
  writeFileSync(join(rendererRoot, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>x</body></html>');
  writeFileSync(join(rendererRoot, 'app.js'), 'console.log(1);\n');
  writeFileSync(join(rendererRoot, 'style.css'), 'body{color:#fff}\n');
  const preloadDir = join(root, 'dist', 'preload');
  mkdirSync(preloadDir, { recursive: true });
  writeFileSync(join(preloadDir, 'preload.cjs'), 'module.exports = {};\n');
  return { root, rendererRoot };
}

/**
 * Build an owner-only XDG runtime fixture.
 * @returns {string} XDG directory.
 */
function makeXdg() {
  const xdg = makeTempRoot('mv0main-xdg-');
  chmodSync(xdg, 0o700);
  return xdg;
}

/**
 * Read a Response body as text.
 * @param {Response} response Fetch response.
 * @returns {Promise<string>} Body text.
 */
async function bodyText(response) {
  return await response.text();
}

describe('W0-SHELL-MAIN import and registry', () => {
  it('declares the exact module registry', () => {
    assert.deepEqual(MODULE_REGISTRY, {
      id: 'W0-SHELL-MAIN',
      entries: ['ui/electron/main.js', 'ui/electron/coreLauncher.js', 'ui/test/coreLauncher.test.js'],
    });
    assert.ok(Object.isFrozen(MODULE_REGISTRY));
    assert.ok(Object.isFrozen(MODULE_REGISTRY.entries));
  });

  it('mirrors the fixed preload channel literals', () => {
    assert.deepEqual(CHANNELS, { load: 'metaviewer:layout.load', save: 'metaviewer:layout.save' });
    assert.ok(Object.isFrozen(CHANNELS));
    assert.equal(LAYOUT_MAX_BYTES, 256 * 1024);
  });

  it('pins the privileged origin and Electron version', () => {
    assert.equal(PRIVILEGED_ORIGIN, 'app://metaviewer');
    assert.equal(PRIVILEGED_SCHEME, 'app');
    assert.equal(PRIVILEGED_HOST, 'metaviewer');
    assert.equal(ELECTRON_PIN, '44.9.2');
    assert.deepEqual(DEFAULT_GEOMETRY, { width: 1280, height: 720 });
    assert.ok(Object.isFrozen(DEFAULT_GEOMETRY));
  });
});

describe('W0-SHELL-MAIN window options', () => {
  it('freezes the exact secure shape', () => {
    const opts = createWindowOptions({ width: 1280, height: 720, preloadPath: '/bundle/preload.cjs' });
    assert.deepEqual(opts, {
      width: 1280,
      height: 720,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        preload: '/bundle/preload.cjs',
      },
    });
    assert.ok(Object.isFrozen(opts));
    assert.ok(Object.isFrozen(opts.webPreferences));
  });

  it('accepts the dimension rails 1 and 7680', () => {
    assert.equal(createWindowOptions({ width: 1, height: 1, preloadPath: '/p' }).width, 1);
    assert.equal(createWindowOptions({ width: 7680, height: 7680, preloadPath: '/p' }).height, 7680);
  });

  it('refuses malformed requests with zero options built', () => {
    const bad = [
      null, undefined, 42, 'x', true, [],
      {},
      { width: 800, height: 600 },
      { width: 800, height: 600, preloadPath: '/p', extra: 1 },
      { width: 0, height: 600, preloadPath: '/p' },
      { width: -1, height: 600, preloadPath: '/p' },
      { width: 7681, height: 600, preloadPath: '/p' },
      { width: 9000, height: 600, preloadPath: '/p' },
      { width: 1600.5, height: 600, preloadPath: '/p' },
      { width: NaN, height: 600, preloadPath: '/p' },
      { width: Infinity, height: 600, preloadPath: '/p' },
      { width: '1600', height: 600, preloadPath: '/p' },
      { width: 800, height: 0, preloadPath: '/p' },
      { width: 800, height: 7681, preloadPath: '/p' },
      { width: 800, height: 600, preloadPath: '' },
      { width: 800, height: 600, preloadPath: null },
      { width: 800, height: 600, preloadPath: 42 },
      { width: 800, height: 600, preloadPath: `/${'p'.repeat(1024)}` },
      { width: 800, height: 600, preloadPath: '/p\0x' },
    ];
    for (const request of bad) {
      throwsCode(() => createWindowOptions(request), 'OPTIONS');
    }
  });
});

describe('W0-SHELL-MAIN sender admission', () => {
  /**
   * @returns {{contents: Record<string, unknown>, frame: Record<string, unknown>, event: Record<string, unknown>}} Admit fixture.
   */
  function admitFixture() {
    const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html`, detached: false };
    const contents = { id: 7, mainFrame: frame, isDestroyed: () => false };
    return { contents, frame, event: { sender: contents, senderFrame: frame } };
  }

  it('admits the live top frame of the expected contents', () => {
    const { contents, event } = admitFixture();
    const verdict = observeSender(event, contents, PRIVILEGED_ORIGIN);
    assert.deepEqual(verdict, {
      verdict: 'admit',
      sender: { senderId: 7, frameOrigin: PRIVILEGED_ORIGIN, frameUrl: `${PRIVILEGED_ORIGIN}/index.html` },
    });
    assert.ok(Object.isFrozen(verdict));
  });

  it('admits same-origin dynamic about URLs and refuses foreign ones', () => {
    const frame = { origin: PRIVILEGED_ORIGIN, url: 'about:blank', detached: false };
    const contents = { id: 7, mainFrame: frame, isDestroyed: () => false };
    assert.equal(observeSender({ sender: contents, senderFrame: frame }, contents, PRIVILEGED_ORIGIN).verdict, 'admit');
    const foreign = { origin: 'https://evil.test', url: 'about:blank', detached: false };
    const contents2 = { id: 7, mainFrame: foreign, isDestroyed: () => false };
    assert.deepEqual(observeSender({ sender: contents2, senderFrame: foreign }, contents2, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'FRAME_ORIGIN',
    });
  });

  it('refuses malformed events and senders with SENDER', () => {
    const { contents, event } = admitFixture();
    const badEvents = [null, undefined, 42, 'x', [], {}, { sender: null }, { sender: 42 }, { sender: [] }];
    for (const bad of badEvents) {
      assert.deepEqual(observeSender(bad, contents, PRIVILEGED_ORIGIN), { verdict: 'refuse', code: 'SENDER' });
    }
    assert.deepEqual(observeSender(event, null, PRIVILEGED_ORIGIN), { verdict: 'refuse', code: 'SENDER' });
    const other = { id: 9, mainFrame: event.senderFrame, isDestroyed: () => false };
    assert.deepEqual(observeSender(event, other, PRIVILEGED_ORIGIN), { verdict: 'refuse', code: 'SENDER' });
    for (const id of [0, -1, 1.5, NaN, '7', null, undefined]) {
      const c = { id, mainFrame: event.senderFrame, isDestroyed: () => false };
      assert.deepEqual(observeSender({ sender: c, senderFrame: event.senderFrame }, c, PRIVILEGED_ORIGIN), {
        verdict: 'refuse',
        code: 'SENDER',
      });
    }
    const broken = { id: 7, mainFrame: null, isDestroyed: () => false };
    assert.deepEqual(observeSender({ sender: broken, senderFrame: event.senderFrame }, broken, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'SENDER',
    });
  });

  it('refuses destroyed senders and throwing getters without throwing', () => {
    const { frame } = admitFixture();
    const dead = { id: 7, mainFrame: frame, isDestroyed: () => true };
    assert.deepEqual(observeSender({ sender: dead, senderFrame: frame }, dead, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'SENDER',
    });
    const exploding = { id: 7, mainFrame: frame, isDestroyed: () => { throw new Error('boom'); } };
    assert.deepEqual(observeSender({ sender: exploding, senderFrame: frame }, exploding, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'SENDER',
    });
    const evilEvent = {};
    Object.defineProperty(evilEvent, 'sender', { enumerable: true, get: () => { throw new Error('boom'); } });
    assert.deepEqual(observeSender(evilEvent, {}, PRIVILEGED_ORIGIN), { verdict: 'refuse', code: 'SENDER' });
    const evilFrame = { origin: PRIVILEGED_ORIGIN, detached: false };
    Object.defineProperty(evilFrame, 'url', { enumerable: true, get: () => { throw new Error('boom'); } });
    const holder = { id: 7, mainFrame: evilFrame, isDestroyed: () => false };
    const verdict = observeSender({ sender: holder, senderFrame: evilFrame }, holder, PRIVILEGED_ORIGIN);
    assert.equal(verdict.verdict, 'refuse');
  });

  it('refuses null, detached and sub frames with typed codes', () => {
    const { contents, frame, event } = admitFixture();
    assert.deepEqual(observeSender({ sender: contents, senderFrame: null }, contents, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'FRAME_NULL',
    });
    assert.deepEqual(observeSender({ sender: contents }, contents, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'FRAME_NULL',
    });
    const detached = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html`, detached: true };
    const holder = { id: 7, mainFrame: detached, isDestroyed: () => false };
    assert.deepEqual(observeSender({ sender: holder, senderFrame: detached }, holder, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'FRAME_DETACHED',
    });
    const sub = { origin: frame.origin, url: frame.url, detached: false };
    assert.deepEqual(observeSender({ sender: contents, senderFrame: sub }, contents, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'SUBFRAME',
    });
  });

  it('refuses foreign origins and URLs with typed codes', () => {
    const foreign = { origin: 'https://evil.test', url: 'https://evil.test/', detached: false };
    const holder = { id: 7, mainFrame: foreign, isDestroyed: () => false };
    assert.deepEqual(observeSender({ sender: holder, senderFrame: foreign }, holder, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'FRAME_ORIGIN',
    });
    const empty = { origin: '', url: `${PRIVILEGED_ORIGIN}/index.html`, detached: false };
    const holder2 = { id: 7, mainFrame: empty, isDestroyed: () => false };
    assert.deepEqual(observeSender({ sender: holder2, senderFrame: empty }, holder2, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'FRAME_ORIGIN',
    });
    const badUrl = { origin: PRIVILEGED_ORIGIN, url: 'https://evil.test/', detached: false };
    const holder3 = { id: 7, mainFrame: badUrl, isDestroyed: () => false };
    assert.deepEqual(observeSender({ sender: holder3, senderFrame: badUrl }, holder3, PRIVILEGED_ORIGIN), {
      verdict: 'refuse',
      code: 'FRAME_URL',
    });
    const { contents, event } = admitFixture();
    assert.deepEqual(observeSender(event, contents, 'app://other'), { verdict: 'refuse', code: 'FRAME_ORIGIN' });
  });
});

describe('W0-SHELL-MAIN navigation decisions', () => {
  it('allows only canonical bundled URLs', () => {
    assert.equal(decideNavigation(`${PRIVILEGED_ORIGIN}/index.html`), 'allow');
    assert.equal(decideNavigation(PRIVILEGED_ORIGIN), 'allow');
    assert.equal(decideNavigation(`${PRIVILEGED_ORIGIN}/a/b/c.js`), 'allow');
  });

  it('denies foreign, credentialed, ported and escaping URLs', () => {
    const bad = [
      null, undefined, 42, '', 'http://metaviewer/index.html', 'file:///etc/passwd',
      'app://evil/index.html', 'app://metaviewer.evil.test/index.html',
      'app://user@metaviewer/index.html', 'app://metaviewer:8080/index.html',
      'app://metaviewer/../secret', 'app://metaviewer/%2e%2e/secret',
      'app://metaviewer/a%2fb', 'app://metaviewer/a%5cb', 'app://metaviewer/%00',
      'app://metaviewer/a\\b', 'not a url', `app://metaviewer/${'a'.repeat(2048)}`,
    ];
    for (const url of bad) {
      assert.equal(decideNavigation(url), 'deny', String(url));
    }
  });
});

describe('W0-SHELL-MAIN privileged protocol and CSP', () => {
  it('keeps the exact restrictive 10-directive CSP', () => {
    assert.equal(
      CONTENT_SECURITY_POLICY,
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        + "font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; "
        + "base-uri 'none'; form-action 'none'",
    );
    assert.ok(!CONTENT_SECURITY_POLICY.includes('unsafe-'));
  });

  it('serves bundle bytes with the strict CSP', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      const response = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/index.html` }, { styleNonce: false });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);
      assert.equal(response.headers.get('Content-Type'), 'text/html');
      assert.ok((await bodyText(response)).includes('<title>t</title>'));
      const js = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/app.js` }, { styleNonce: false });
      assert.equal(js.headers.get('Content-Type'), 'text/javascript');
      const css = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/style.css` }, { styleNonce: false });
      assert.equal(css.headers.get('Content-Type'), 'text/css');
    } finally {
      rmRoot(root);
    }
  });

  it('binds a fresh style nonce to HTML meta and CSP only', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      writeFileSync(join(rendererRoot, 'index.html'), `<html><head><meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"></head><body></body></html>`);
      const first = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/index.html` }, { styleNonce: true });
      assert.equal(first.status, 200);
      const csp = String(first.headers.get('Content-Security-Policy'));
      const body = await bodyText(first);
      const nonce = csp.match(/'nonce-([A-Za-z0-9+/]{32})'/);
      assert.ok(nonce, csp);
      assert.ok(body.includes(`<meta name="metaviewer-style-nonce" content="${nonce[1]}">`), body);
      assert.ok(body.includes(`http-equiv="Content-Security-Policy" content="${csp}"`));
      assert.ok(!body.includes(`content="${CONTENT_SECURITY_POLICY}"`), 'stale meta policy blocks nonce styles');
      assert.ok(/^[A-Za-z0-9+/]{32}$/.test(nonce[1]));
      const second = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/index.html` }, { styleNonce: true });
      assert.notEqual(second.headers.get('Content-Security-Policy'), csp);
      const plain = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/app.js` }, { styleNonce: true });
      assert.equal(plain.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);
    } finally {
      rmRoot(root);
    }
  });

  it('refuses nonce HTML without an insertion point', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      writeFileSync(join(rendererRoot, 'bare.html'), '<!doctype html><html><body>no head</body></html>');
      const response = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/bare.html` }, { styleNonce: true });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);
    } finally {
      rmRoot(root);
    }
  });

  it('refuses escapes with 403/404 while keeping the base CSP', async () => {
    const { root, rendererRoot } = makeBundle();
    const outside = makeTempRoot('mv0main-outside-');
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(rendererRoot, 'link.txt'));
      mkdirSync(join(rendererRoot, 'empty-dir'));
      mkdirSync(join(rendererRoot, 'with-index'));
      writeFileSync(join(withIndex(), 'index.html'), '<html><head></head><body>i</body></html>');
      const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
      writeFileSync(join(rendererRoot, 'big.bin'), big);
      const cases = [
        ['http://metaviewer/index.html', 403],
        ['file:///etc/passwd', 403],
        ['app://evil/index.html', 403],
        [`${PRIVILEGED_ORIGIN}/../secret`, 403],
        [`${PRIVILEGED_ORIGIN}/%2e%2e/secret`, 403],
        [`${PRIVILEGED_ORIGIN}/%2E%2E/x`, 403],
        [`${PRIVILEGED_ORIGIN}/a%2fb`, 403],
        [`${PRIVILEGED_ORIGIN}/a%5cb`, 403],
        [`${PRIVILEGED_ORIGIN}/%00`, 403],
        [`${PRIVILEGED_ORIGIN}/a\\b`, 403],
        ['app://metaviewer:8080/index.html', 403],
        ['app://user@metaviewer/index.html', 403],
        [`${PRIVILEGED_ORIGIN}/link.txt`, 403],
        [`${PRIVILEGED_ORIGIN}/big.bin`, 403],
        [`${PRIVILEGED_ORIGIN}/missing.html`, 404],
        [`${PRIVILEGED_ORIGIN}/empty-dir`, 404],
      ];
      for (const [url, status] of cases) {
        const response = await handleAppRequest(rendererRoot, { url }, { styleNonce: true });
        assert.equal(response.status, status, url);
        assert.equal(response.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY, url);
      }
      const dirIndex = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/with-index` }, { styleNonce: false });
      assert.equal(dirIndex.status, 200);
      assert.ok((await bodyText(dirIndex)).includes('<body>i</body>'));

      function withIndex() {
        return join(rendererRoot, 'with-index');
      }
    } finally {
      rmRoot(root);
      rmRoot(outside);
    }
  });

  it('refuses malformed roots and requests without throwing', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      for (const badRoot of [null, '', '/nonexistent-root-mv0', `${PRIVILEGED_ORIGIN}/index.html`.slice(0, 0)]) {
        const response = await handleAppRequest(badRoot, { url: `${PRIVILEGED_ORIGIN}/index.html` }, { styleNonce: false });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);
      }
      for (const badRequest of [null, undefined, 42, {}, { url: null }, { url: 42 }]) {
        const response = await handleAppRequest(rendererRoot, badRequest, { styleNonce: false });
        assert.equal(response.status, 403);
      }
    } finally {
      rmRoot(root);
    }
  });

  it('builds CSP with an optional validated nonce', () => {
    assert.equal(buildCsp(null), CONTENT_SECURITY_POLICY);
    const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    assert.equal(
      buildCsp(nonce),
      CONTENT_SECURITY_POLICY.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`),
    );
    for (const bad of ['', 'short', `${nonce}x`, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcde-', 42, {}, []]) {
      throwsCode(() => buildCsp(bad), 'CSP_NONCE');
    }
  });

  it('registers the privileged scheme and serves through handles', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      const seen = [];
      let handler = null;
      const protocol = {
        registerSchemesAsPrivileged: (specs) => { seen.push(['privileged', specs]); },
        handle: (scheme, fn) => { seen.push(['handle', scheme]); handler = fn; },
      };
      const summary = registerPrivilegedScheme(protocol);
      assert.deepEqual(summary, { scheme: 'app', privileges: { standard: true, secure: true } });
      assert.ok(Object.isFrozen(summary));
      const served = serveBundled(protocol, rendererRoot, { styleNonce: false });
      assert.equal(served.scheme, 'app');
      assert.ok(typeof handler === 'function');
      const response = await handler({ url: `${PRIVILEGED_ORIGIN}/index.html` });
      assert.equal(response.status, 200);
      throwsCode(() => registerPrivilegedScheme(null), 'HANDLE');
      throwsCode(() => serveBundled({}, rendererRoot), 'HANDLE');
      throwsCode(() => serveBundled(protocol, '/nonexistent-root-mv0'), 'ROOT');
    } finally {
      rmRoot(root);
    }
  });
});

describe('W0-SHELL-MAIN window policy wiring', () => {
  /**
   * @param {Array<string>} calls Call log.
   * @returns {{win: Record<string, unknown>, session: Record<string, unknown>, listeners: Map<string, Function>}} Fakes.
   */
  function policyFakes(calls) {
    const listeners = new Map();
    const webContents = {
      on(eventName, listener) {
        assert.equal(this, webContents);
        calls.push(`contents.on:${eventName}`);
        listeners.set(eventName, listener);
      },
      setWindowOpenHandler(handler) {
        assert.equal(this, webContents);
        calls.push('contents.setWindowOpenHandler');
        listeners.set('window-open', handler);
      },
    };
    const session = {
      setPermissionRequestHandler(handler) {
        assert.equal(this, session);
        calls.push('session.request');
        listeners.set('permission-request', handler);
      },
      setPermissionCheckHandler(handler) {
        assert.equal(this, session);
        calls.push('session.check');
        listeners.set('permission-check', handler);
      },
    };
    return { win: { webContents }, session, listeners };
  }

  it('attaches all seven default-deny handlers', () => {
    const calls = [];
    const { win, session, listeners } = policyFakes(calls);
    const summary = attachWindowPolicy(win, session);
    assert.deepEqual(summary, {
      attached: [
        'window-open', 'will-navigate', 'will-redirect', 'will-frame-navigate',
        'will-attach-webview', 'permission-request', 'permission-check',
      ],
    });
    assert.ok(Object.isFrozen(summary));
    assert.ok(Object.isFrozen(summary.attached));

    const open = listeners.get('window-open');
    assert.deepEqual(open({ url: `${PRIVILEGED_ORIGIN}/index.html` }), { action: 'deny' });

    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      let prevented = 0;
      const event = { preventDefault: () => { prevented += 1; } };
      listeners.get(name)(event, 'https://evil.test/');
      assert.equal(prevented, 1, name);
      listeners.get(name)(event, `${PRIVILEGED_ORIGIN}/index.html`);
      assert.equal(prevented, 1, name);
      listeners.get(name)(event, `${PRIVILEGED_ORIGIN}/%2e%2e/x`);
      assert.equal(prevented, 2, name);
    }
    let webviewPrevented = 0;
    listeners.get('will-attach-webview')({ preventDefault: () => { webviewPrevented += 1; } });
    assert.equal(webviewPrevented, 1);

    let granted = true;
    listeners.get('permission-request')({}, 'media', (value) => { granted = value; });
    assert.equal(granted, false);
    assert.equal(listeners.get('permission-check')({}, 'media', PRIVILEGED_ORIGIN), false);
  });

  it('refuses malformed handles', () => {
    const calls = [];
    const { win, session } = policyFakes(calls);
    for (const badWin of [null, {}, { webContents: null }, { webContents: {} }]) {
      throwsCode(() => attachWindowPolicy(badWin, session), 'HANDLE');
    }
    for (const badSession of [null, {}, { setPermissionRequestHandler: () => {} }]) {
      throwsCode(() => attachWindowPolicy(win, badSession), 'HANDLE');
    }
  });
});

describe('W0-SHELL-MAIN retail launch and fuses', () => {
  it('exports the exact 14 forbidden flags', () => {
    assert.deepEqual([...FORBIDDEN_ARGV_FLAGS], [
      '--debug', '--debug-brk', '--debug-port', '--import', '--inspect', '--inspect-brk',
      '--inspect-port', '--inspect-publish-uid', '--inspect-wait', '--no-sandbox',
      '--remote-allow-origins', '--remote-debugging-pipe', '--remote-debugging-port', '--require',
    ]);
    assert.ok(Object.isFrozen(FORBIDDEN_ARGV_FLAGS));
  });

  it('accepts safe argv and the display-only nested flag', () => {
    assert.deepEqual(validateRetailLaunch(['metaviewer'], {}), { ok: true, nested: false });
    assert.deepEqual(validateRetailLaunch([], {}), { ok: true, nested: false });
    assert.deepEqual(validateRetailLaunch(['metaviewer', '--', 'pos'], {}), { ok: true, nested: false });
    assert.deepEqual(validateRetailLaunch(['metaviewer', '--nested-depth=1'], {}), { ok: true, nested: true });
    assert.deepEqual(
      validateRetailLaunch(['metaviewer', '--user-data-dir=/profile/app', '--ozone-platform=x11'], {}),
      { ok: true, nested: false },
    );
    const verdict = validateRetailLaunch(['metaviewer'], {});
    assert.ok(Object.isFrozen(verdict));
  });

  it('refuses every forbidden flag including equals variants', () => {
    for (const flag of FORBIDDEN_ARGV_FLAGS) {
      assert.deepEqual(validateRetailLaunch(['exe', flag], {}), { ok: false, code: 'RETAIL_FLAG' }, flag);
      assert.deepEqual(validateRetailLaunch(['exe', `${flag}=1`], {}), { ok: false, code: 'RETAIL_FLAG' }, flag);
    }
    assert.deepEqual(validateRetailLaunch(['exe', '--inspect=127.0.0.1:9229'], {}), { ok: false, code: 'RETAIL_FLAG' });
    assert.deepEqual(validateRetailLaunch(['exe', '--no-sandbox'], {}), { ok: false, code: 'RETAIL_FLAG' });
  });

  it('refuses unknown switches and malformed nested depth', () => {
    for (const argv of [
      ['exe', '--unknown-flag'], ['exe', '-x'], ['exe', '--single-process'], ['exe', '--no-zygote'],
    ]) {
      assert.deepEqual(validateRetailLaunch(argv, {}), { ok: false, code: 'UNKNOWN_SWITCH' }, String(argv));
    }
    for (const argv of [
      ['exe', '--nested-depth=2'], ['exe', '--nested-depth=0'], ['exe', '--nested-depth'],
      ['exe', '--nested-depth='], ['exe', '--nested-depth=1x'],
      ['exe', '--nested-depth=1', '--nested-depth=1'],
    ]) {
      assert.deepEqual(validateRetailLaunch(argv, {}), { ok: false, code: 'NESTED_DEPTH' }, String(argv));
    }
  });

  it('refuses malformed argv shapes', () => {
    for (const argv of [null, {}, 'x', [42], ['ok', 42], [`x\0y`], ['x'.repeat(4097)], new Array(257).fill('x')]) {
      assert.deepEqual(validateRetailLaunch(argv, {}), { ok: false, code: 'ARGV_SHAPE' });
    }
    for (const env of [null, [], 'x']) {
      assert.deepEqual(validateRetailLaunch(['exe'], env), { ok: false, code: 'ENV_SHAPE' });
    }
  });

  it('refuses unsafe retail environments', () => {
    for (const name of [
      'ELECTRON_DISABLE_SANDBOX', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH',
      'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PYTHONHOME', 'BASH_ENV',
    ]) {
      assert.deepEqual(validateRetailLaunch(['exe'], { [name]: '1' }), { ok: false, code: 'RETAIL_ENV' }, name);
    }
    assert.deepEqual(validateRetailLaunch(['exe'], { LANG: 'C.UTF-8', PATH: '/usr/bin' }), { ok: true, nested: false });
    assert.deepEqual(validateRetailLaunch(['exe'], { ELECTRON_DISABLE_SANDBOX: 42 }), { ok: true, nested: false });
  });

  it('builds the exact frozen fuse config', () => {
    assert.deepEqual(buildFuseConfig(), {
      version: '1',
      0: false,
      1: true,
      2: false,
      3: false,
      4: true,
      5: true,
      6: false,
      7: false,
      8: false,
      strictlyRequireAllFuses: true,
    });
    assert.ok(Object.isFrozen(buildFuseConfig()));
    assert.equal(FUSE_TABLE.length, 9);
    assert.deepEqual(FUSE_TABLE.map((row) => row.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(FUSE_TABLE.filter((row) => row.required).length, 6);
    assert.ok(Object.isFrozen(FUSE_TABLE));
    for (const row of FUSE_TABLE) {
      assert.ok(Object.isFrozen(row));
    }
  });
});

describe('W0-SHELL-MAIN main paths', () => {
  it('resolves canonical bundle, preload, userData and runtime dir', () => {
    const { root } = makeBundle();
    const xdg = makeXdg();
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      const app = { getAppPath: () => root, getPath: (name) => join(root, `user-${name}`) };
      const paths = resolveMainPaths(app, root, { xdgRuntimeDir: xdg, uid });
      assert.equal(paths.rendererRoot, join(root, 'dist', 'renderer'));
      assert.equal(paths.preloadPath, join(root, 'dist', 'preload', 'preload.cjs'));
      assert.equal(paths.userData, join(root, 'user-userData'));
      assert.equal(paths.runtimeDir, join(xdg, 'metaviewer'));
      assert.ok(Object.isFrozen(paths));
    } finally {
      rmRoot(root);
      rmRoot(xdg);
    }
  });

  it('falls back to shellRoot when the app path is empty', () => {
    const { root } = makeBundle();
    const xdg = makeXdg();
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      const app = { getAppPath: () => '', getPath: () => join(root, 'ud') };
      const paths = resolveMainPaths(app, root, { xdgRuntimeDir: xdg, uid });
      assert.equal(paths.preloadPath, join(root, 'dist', 'preload', 'preload.cjs'));
    } finally {
      rmRoot(root);
      rmRoot(xdg);
    }
  });

  it('creates the runtime dir owner-only and refuses unsafe state', () => {
    const { root } = makeBundle();
    const xdg = makeXdg();
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      const otherUid = uid + 1000;
      const app = { getAppPath: () => root, getPath: () => join(root, 'ud') };
      const runtime = { xdgRuntimeDir: xdg, uid };
      const before = (() => {
        try {
          return lstatSync(join(xdg, 'metaviewer'));
        } catch {
          return null;
        }
      })();
      assert.equal(before, null);
      const paths = resolveMainPaths(app, root, runtime);
      assert.equal(statSync(paths.runtimeDir).mode & 0o777, 0o700);
      assert.equal(statSync(paths.runtimeDir).uid, uid);
      chmodSync(paths.runtimeDir, 0o755);
      throwsCode(() => resolveMainPaths(app, root, runtime), 'RUNTIME_DIR');
      chmodSync(paths.runtimeDir, 0o700);
      throwsCode(() => resolveMainPaths(app, root, { xdgRuntimeDir: xdg, uid: otherUid }), 'RUNTIME_XDG');
      throwsCode(() => resolveMainPaths(app, root, { xdgRuntimeDir: join(xdg, 'nope'), uid }), 'RUNTIME_XDG');
      throwsCode(() => resolveMainPaths(app, root, { xdgRuntimeDir: 'relative', uid }), 'PATHS_RUNTIME');
    } finally {
      rmRoot(root);
      rmRoot(xdg);
    }
  });

  it('refuses symlinked or foreign runtime roots', () => {
    const { root } = makeBundle();
    const xdg = makeXdg();
    const other = makeTempRoot('mv0main-other-');
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      const app = { getAppPath: () => root, getPath: () => join(root, 'ud') };
      const runtime = { xdgRuntimeDir: xdg, uid };
      symlinkSync(other, join(xdg, 'linkdir'));
      throwsCode(() => resolveMainPaths(app, root, { xdgRuntimeDir: join(xdg, 'linkdir'), uid }), 'RUNTIME_XDG');
      symlinkSync(other, join(xdg, 'metaviewer'));
      throwsCode(() => resolveMainPaths(app, root, runtime), 'RUNTIME_DIR');
    } finally {
      rmRoot(root);
      rmRoot(xdg);
      rmRoot(other);
    }
  });

  it('refuses missing bundles, preloads and malformed handles', () => {
    const { root } = makeBundle();
    const xdg = makeXdg();
    const empty = makeTempRoot('mv0main-empty-');
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      const app = { getAppPath: () => root, getPath: () => join(root, 'ud') };
      const runtime = { xdgRuntimeDir: xdg, uid };
      const appEmpty = { getAppPath: () => empty, getPath: () => join(root, 'ud') };
      throwsCode(() => resolveMainPaths(appEmpty, empty, runtime), 'PATHS_BUNDLE');
      const noPreload = makeTempRoot('mv0main-nopreload-');
      try {
        mkdirSync(join(noPreload, 'dist', 'renderer'), { recursive: true });
        const app2 = { getAppPath: () => noPreload, getPath: () => join(root, 'ud') };
        throwsCode(() => resolveMainPaths(app2, noPreload, runtime), 'PRELOAD_ABSENT');
      } finally {
        rmRoot(noPreload);
      }
      throwsCode(() => resolveMainPaths(null, root, runtime), 'PATHS_APP');
      throwsCode(() => resolveMainPaths({}, root, runtime), 'PATHS_APP');
      throwsCode(() => resolveMainPaths(app, 'relative', runtime), 'PATHS_ROOT');
      throwsCode(() => resolveMainPaths(app, root, null), 'PATHS_RUNTIME');
      throwsCode(() => resolveMainPaths(app, root, {}), 'PATHS_RUNTIME');
    } finally {
      rmRoot(root);
      rmRoot(xdg);
      rmRoot(empty);
    }
  });
});

  /**
   * @param {Record<string, unknown>} [overrides] Option overrides.
   * @returns {Record<string, any>} Launcher world.
   */
  function launcherWorld(overrides = {}) {
    const spawned = [];
    const killed = [];
    const statuses = [];
    const waits = [];
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const options = {
      spawn: (command, args, opts) => {
        spawned.push({ command, args, opts });
        if (overrides.spawnThrows) {
          throw new Error('spawn boom');
        }
        return Object.hasOwn(overrides, 'spawnResult') ? overrides.spawnResult : child;
      },
      command: '/bundle/metaviewer-core',
      args: [],
      env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin', ELECTRON_DISABLE_SANDBOX: '1' },
      runtimeDir: '/run/user/1000/metaviewer',
      selfPid: 100,
      selfPgid: 100,
      killFn: (pid, signal) => {
        killed.push([pid, signal]);
        if (overrides.killThrows) {
          throw new Error('kill boom');
        }
      },
      handshake: overrides.handshake ?? (async () => ({ authority_epoch: 7 })),
      transport: overrides.transport ?? {
        connect: async () => {},
        request: async (message) => ({ echo: message }),
        close: async () => {},
      },
      limits: overrides.limits ?? {
        maxStdoutLineBytes: 64,
        maxStderrTailBytes: 256,
        maxQueuedRequests: 2,
        maxQueuedBytes: 512,
        maxRequestBytes: 128,
        handshakeTimeoutMs: 100,
        requestTimeoutMs: 100,
        shutdownTimeoutMs: 100,
      },
      ownership: overrides.ownership ?? {
        ownedPids: () => [4242],
        waitForExit: async (pid) => {
          waits.push(pid);
        },
      },
      callbacks: overrides.callbacks ?? {
        onStatus: (status) => {
          statuses.push(status);
        },
      },
    };
    return { spawned, killed, statuses, waits, child, options };
  }

describe('W0-SHELL-MAIN production boot', () => {
  /**
   * @param {Record<string, unknown>} [overrides] Fault injection.
   * @returns {Record<string, any>} Fake world.
   */
  function bootWorld(overrides = {}) {
    const calls = [];
    const { root } = makeBundle();
    const xdg = makeXdg();
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html`, detached: false };
    const contentsListeners = new Map();
    const winSession = {
      setPermissionRequestHandler: (handler) => {
        calls.push('win-session.request');
        contentsListeners.set('permission-request', handler);
      },
      setPermissionCheckHandler: (handler) => {
        calls.push('win-session.check');
        contentsListeners.set('permission-check', handler);
      },
    };
    const webContents = {
      id: 7,
      mainFrame: frame,
      isDestroyed: () => false,
      session: winSession,
      setWindowOpenHandler: (handler) => {
        calls.push('contents.setWindowOpenHandler');
        contentsListeners.set('window-open', handler);
      },
      on: (name, handler) => {
        calls.push(`contents.on:${name}`);
        contentsListeners.set(name, handler);
      },
      loadURL: async (url) => {
        calls.push(`loadURL:${url}`);
      },
    };
    const constructed = [];
    const windows = [];
    class FakeWindow {
      constructor(opts) {
        calls.push('new-BrowserWindow');
        if (overrides.windowThrows) {
          throw new Error('window boom');
        }
        constructed.push(opts);
        this.webContents = webContents;
        this.readyToShow = null;
        windows.push(this);
      }

      once(name, fn) {
        calls.push(`window.once:${name}`);
        if (name === 'ready-to-show') {
          this.readyToShow = fn;
        }
      }

      show() {
        calls.push('window.show');
      }

      destroy() {
        calls.push('window.destroy');
      }

      isDestroyed() {
        return false;
      }
    }
    const handlers = new Map();
    const appListeners = new Map();
    const app = {
      requestSingleInstanceLock: () => {
        calls.push('lock');
        return overrides.lock ?? true;
      },
      whenReady: async () => {
        calls.push('ready');
        if (overrides.readyRejects) {
          throw new Error('ready boom');
        }
      },
      on: (name, handler) => {
        calls.push(`app.on:${name}`);
        appListeners.set(name, handler);
      },
      quit: () => {
        calls.push('app.quit');
      },
      exit: (code) => {
        calls.push(`app.exit:${code}`);
      },
      getAppPath: () => root,
      getPath: () => join(root, 'user-data'),
    };
    const ipcMain = {
      handle: (channel, fn) => {
        calls.push(`ipc.handle:${channel}`);
        handlers.set(channel, fn);
      },
      removeHandler: (channel) => {
        calls.push(`ipc.remove:${channel}`);
        handlers.delete(channel);
      },
    };
    const protocol = {
      registerSchemesAsPrivileged: () => {
        calls.push('protocol.privileged');
      },
      handle: (scheme, fn) => {
        calls.push(`protocol.handle:${scheme}`);
        if (overrides.protocolThrows) {
          throw new Error('protocol boom');
        }
      },
      unhandle: (scheme) => {
        calls.push(`protocol.unhandle:${scheme}`);
      },
    };
    const defaultSession = {
      setPermissionRequestHandler: () => {
        calls.push('default-session.request');
      },
      setPermissionCheckHandler: () => {
        calls.push('default-session.check');
      },
    };
    const coreStatus = overrides.coreStatus ?? { availability: 'live', pid: 4242, authority_epoch: 7, reason: null };
    const core = {
      start: async () => {
        calls.push('core.start');
        if (overrides.startThrows) {
          throw new Error('start boom');
        }
        return coreStatus;
      },
      request: async (message) => ({ echo: message }),
      dispose: async () => {
        calls.push('core.dispose');
      },
      getStatus: () => coreStatus,
    };
    const decoded = [];
    const invoked = [];
    const bridge = overrides.bridge ?? [
      {
        channel: CHANNELS.load,
        decode: (raw) => {
          decoded.push(['load', raw]);
          return null;
        },
        invoke: async (value) => {
          invoked.push(['load', value]);
          return 'layout-json';
        },
      },
      {
        channel: CHANNELS.save,
        decode: (raw) => {
          decoded.push(['save', raw]);
          return raw;
        },
        invoke: async (value) => {
          invoked.push(['save', value]);
          return true;
        },
      },
    ];
    const handles = {
      app,
      BrowserWindow: overrides.windowClass ?? FakeWindow,
      ipcMain,
      protocol,
      session: { defaultSession },
      electronVersion: overrides.electronVersion ?? ELECTRON_PIN,
      shellRoot: root,
      argv: overrides.argv ?? ['metaviewer'],
      env: overrides.env ?? {},
      runtime: { xdgRuntimeDir: xdg, uid },
      core,
      bridge,
      geometry: overrides.geometry ?? { width: 1280, height: 720 },
    };
    return {
      calls, root, xdg, handles, constructed, windows, handlers, appListeners,
      contentsListeners, webContents, frame, decoded, invoked,
      cleanup: () => {
        rmRoot(root);
        rmRoot(xdg);
      },
    };
  }

  /**
   * @param {Array<string>} calls Call log.
   * @param {string} marker Marker to wait for.
   * @returns {Promise<void>}
   */
  async function flushUntil(calls, marker) {
    for (let i = 0; i < 100; i += 1) {
      if (calls.includes(marker)) {
        return;
      }
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    assert.fail(`marker ${marker} never logged`);
  }

  /**
   * @param {Array<string>} calls Call log.
   * @param {string} first Earlier marker.
   * @param {string} second Later marker.
   * @returns {void}
   */
  function assertOrder(calls, first, second) {
    assert.ok(calls.indexOf(first) !== -1 && calls.indexOf(first) < calls.indexOf(second), `${first} < ${second}`);
  }

  it('boots the ordered acquisition and shows on ready-to-show', async () => {
    const world = bootWorld();
    try {
      const boot = await bootProductionMain(world.handles);
      assert.ok(Object.isFrozen(boot));
      assert.equal(world.constructed.length, 1);
      assert.equal(world.constructed[0].width, 1280);
      assert.equal(world.constructed[0].height, 720);
      assert.equal(world.constructed[0].show, false);
      assert.equal(world.constructed[0].webPreferences.preload, join(world.root, 'dist', 'preload', 'preload.cjs'));
      assertOrder(world.calls, 'lock', 'protocol.privileged');
      assertOrder(world.calls, 'protocol.privileged', 'ready');
      assertOrder(world.calls, 'ready', 'new-BrowserWindow');
      assertOrder(world.calls, 'new-BrowserWindow', 'contents.setWindowOpenHandler');
      assertOrder(world.calls, 'core.start', `ipc.handle:${CHANNELS.load}`);
      assertOrder(world.calls, `ipc.handle:${CHANNELS.save}`, `loadURL:${PRIVILEGED_ORIGIN}/index.html`);
      assert.ok(!world.calls.includes('window.show'));
      assert.equal(world.windows.length, 1);
      world.windows[0].readyToShow();
      assert.ok(world.calls.includes('window.show'));
      await boot.dispose();
      assert.ok(world.calls.includes('window.destroy'));
      assert.ok(world.calls.includes('protocol.unhandle:app'));
      assert.ok(world.calls.includes('core.dispose'));
    } finally {
      world.cleanup();
    }
  });

  it('version-mismatch handshake refusal surfaces with zero windows', async () => {
    for (const mismatch of [true, false]) {
      const world = bootWorld();
      const child = launcherWorld({ handshake: async () => {
        if (mismatch) throw Object.assign(new Error('incompatible core'), { code: 'VERSION_MISMATCH' });
        return { authority_epoch: 7 };
      } });
      const launcher = createCoreLauncher(child.options);
      world.handles.core = launcher;
      try {
        const status = await launcher.start();
        if (mismatch) {
          assert.equal(status.availability, 'unavailable');
          assert.equal(status.authority_epoch, null);
          assert.match(status.reason, /VERSION_MISMATCH/);
          await rejectsCode(bootProductionMain(world.handles), 'CORE_UNAVAILABLE');
          assert.equal(world.constructed.length, 0);
          assert.equal(world.handlers.size, 0);
          assert.ok(!world.calls.includes('window.show'));
        } else {
          assert.equal(status.availability, 'live');
          const boot = await bootProductionMain(world.handles);
          assert.equal(world.constructed.length, 1);
          await boot.dispose();
        }
        assert.equal(child.spawned.length, 1);
      } finally {
        await launcher.dispose();
        world.cleanup();
      }
    }
  });

  it('refuses boot gates before any window or spawn', async () => {
    const pin = bootWorld({ electronVersion: '44.9.1' });
    try {
      await rejectsCode(bootProductionMain(pin.handles), 'ELECTRON_PIN');
      assert.equal(pin.constructed.length, 0);
      assert.ok(!pin.calls.includes('core.start'));
      assert.ok(!pin.calls.includes('window.show'));
    } finally {
      pin.cleanup();
    }
    const retail = bootWorld({ argv: ['exe', '--no-sandbox'] });
    try {
      await rejectsCode(bootProductionMain(retail.handles), 'RETAIL_FLAG');
      assert.equal(retail.constructed.length, 0);
      assert.ok(!retail.calls.includes('core.start'));
    } finally {
      retail.cleanup();
    }
    const single = bootWorld({ lock: false });
    try {
      await rejectsCode(bootProductionMain(single.handles), 'SINGLE_INSTANCE');
      assert.equal(single.constructed.length, 0);
      assert.ok(single.calls.includes('app.quit'));
    } finally {
      single.cleanup();
    }
    const badGeometry = bootWorld({ geometry: { width: 0, height: 720 } });
    try {
      await rejectsCode(bootProductionMain(badGeometry.handles), 'OPTIONS');
      assert.equal(badGeometry.constructed.length, 0);
    } finally {
      badGeometry.cleanup();
    }
  });

  it('unwinds the owned prefix on acquisition faults', async () => {
    const ready = bootWorld({ readyRejects: true });
    try {
      await rejectsCode(bootProductionMain(ready.handles), 'READY');
      assert.ok(ready.calls.includes('protocol.unhandle:app'));
      assert.equal(ready.constructed.length, 0);
    } finally {
      ready.cleanup();
    }
    const win = bootWorld({ windowThrows: true });
    try {
      await rejectsCode(bootProductionMain(win.handles), 'WINDOW');
      assert.ok(win.calls.includes('protocol.unhandle:app'));
    } finally {
      win.cleanup();
    }
    const proto = bootWorld({ protocolThrows: true });
    try {
      await rejectsCode(bootProductionMain(proto.handles), 'PROTOCOL');
      assert.equal(proto.constructed.length, 0);
    } finally {
      proto.cleanup();
    }
    const dead = bootWorld({ coreStatus: { availability: 'unavailable', pid: null, authority_epoch: null, reason: 'nope' } });
    try {
      await rejectsCode(bootProductionMain(dead.handles), 'CORE_UNAVAILABLE');
      assert.equal(dead.constructed.length, 0);
      assert.ok(!dead.calls.includes('new-BrowserWindow'));
      assert.ok(dead.calls.includes('protocol.unhandle:app'));
      assert.ok(dead.calls.includes('core.dispose'));
    } finally {
      dead.cleanup();
    }
    const throwing = bootWorld({ startThrows: true });
    try {
      await rejectsCode(bootProductionMain(throwing.handles), 'CORE_UNAVAILABLE');
    } finally {
      throwing.cleanup();
    }
    const session = bootWorld();
    try {
      session.handles.session = {};
      await rejectsCode(bootProductionMain(session.handles), 'BOOT_SESSION');
      assert.ok(session.calls.includes('protocol.unhandle:app'));
    } finally {
      session.cleanup();
    }
    const noLoad = bootWorld({
      windowClass: class NoLoadWindow {
        constructor() {
          noLoad.calls.push('new-BrowserWindow');
          this.webContents = {
            id: 7,
            mainFrame: noLoad.frame,
            isDestroyed: () => false,
            session: {
              setPermissionRequestHandler: () => {},
              setPermissionCheckHandler: () => {},
            },
            setWindowOpenHandler: () => {},
            on: () => {},
          };
        }

        once() {}

        show() {}

        destroy() {
          noLoad.calls.push('window.destroy');
        }
      },
    });
    try {
      await rejectsCode(bootProductionMain(noLoad.handles), 'LOAD');
      assert.ok(noLoad.calls.includes('window.destroy'));
      assert.ok(noLoad.calls.includes('protocol.unhandle:app'));
    } finally {
      noLoad.cleanup();
    }
  });

  it('gates bridge parity before the core starts', async () => {
    const variants = [
      [{ channel: CHANNELS.load, decode: () => null, invoke: async () => null }],
      [
        { channel: CHANNELS.load, decode: () => null, invoke: async () => null },
        { channel: 'metaviewer:layout.evil', decode: () => null, invoke: async () => null },
      ],
      [
        { channel: CHANNELS.load, decode: () => null, invoke: async () => null },
        { channel: CHANNELS.save, decode: () => null },
      ],
      'not-an-array',
    ];
    for (const bridge of variants) {
      const world = bootWorld({ bridge });
      try {
        await rejectsCode(bootProductionMain(world.handles), 'BRIDGE_PARITY');
        assert.ok(!world.calls.includes('core.start'));
        assert.ok(world.calls.includes('protocol.unhandle:app'));
      } finally {
        world.cleanup();
      }
    }
  });

  it('gates every receiver on the sender before decode or invoke', async () => {
    const world = bootWorld();
    try {
      await bootProductionMain(world.handles);
      const save = world.handlers.get(CHANNELS.save);
      const sub = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html`, detached: false };
      await rejectsCode(save({ sender: world.webContents, senderFrame: sub }, '"{}"'), 'SUBFRAME');
      assert.deepEqual(world.decoded, []);
      assert.deepEqual(world.invoked, []);
      await rejectsCode(save({ sender: world.webContents, senderFrame: world.frame }, `"${'x'.repeat(LAYOUT_MAX_BYTES)}"`), 'LAYOUT_BOUNDS');
      assert.deepEqual(world.invoked, []);
      await rejectsCode(save({ sender: world.webContents, senderFrame: world.frame }, 'not-json'), 'LAYOUT_BOUNDS');
      const ok = await save({ sender: world.webContents, senderFrame: world.frame }, '"{}"');
      assert.equal(ok, true);
      assert.deepEqual(world.invoked, [['save', '"{}"']]);
      const load = world.handlers.get(CHANNELS.load);
      await rejectsCode(load({ sender: world.webContents, senderFrame: world.frame }, 'payload'), 'LAYOUT_BOUNDS');
      assert.equal(await load({ sender: world.webContents, senderFrame: world.frame }), 'layout-json');
    } finally {
      world.cleanup();
    }
  });

  it('refuses surplus receiver arguments before decode or invoke', async () => {
    const world = bootWorld();
    try {
      await bootProductionMain(world.handles);
      const event = { sender: world.webContents, senderFrame: world.frame };
      for (const [channel, args] of [
        [CHANNELS.load, [undefined]],
        [CHANNELS.save, ['"{}"', 'surplus']],
      ]) {
        await rejectsCode(world.handlers.get(channel)(event, ...args), 'LAYOUT_BOUNDS');
      }
      assert.deepEqual(world.decoded, []);
      assert.deepEqual(world.invoked, []);
    } finally {
      world.cleanup();
    }
  });

  it('wires lifecycle handlers and refuses malformed handles', async () => {
    const world = bootWorld();
    try {
      await bootProductionMain(world.handles);
      let prevented = 0;
      world.appListeners.get('will-quit')({ preventDefault: () => { prevented += 1; } });
      assert.equal(prevented, 1);
      await flushUntil(world.calls, 'core.dispose');
      await flushUntil(world.calls, 'app.quit');
      world.appListeners.get('window-all-closed')();
      assert.ok(world.calls.filter((call) => call === 'app.quit').length >= 2);
    } finally {
      world.cleanup();
    }
    const broken = bootWorld();
    try {
      const { core, ...missing } = broken.handles;
      assert(core);
      await rejectsCode(bootProductionMain(missing), 'BOOT_HANDLES');
      await rejectsCode(bootProductionMain({ ...broken.handles, extra: 1 }), 'BOOT_HANDLES');
      await rejectsCode(bootProductionMain(null), 'BOOT_HANDLES');
    } finally {
      broken.cleanup();
    }
  });

  it('boots nested display-only without core or receivers', async () => {
    const world = bootWorld({ argv: ['metaviewer', '--nested-depth=1'] });
    try {
      const boot = await bootProductionMain(world.handles);
      assert.equal(world.constructed.length, 1);
      assert.ok(!world.calls.includes('core.start'));
      assert.ok(!world.calls.some((call) => call.startsWith('ipc.handle:')));
      assert.ok(world.calls.includes(`loadURL:${PRIVILEGED_ORIGIN}/index.html`));
      world.windows[0].readyToShow();
      assert.ok(world.calls.includes('window.show'));
      await boot.dispose();
      assert.ok(world.calls.includes('core.dispose'));
    } finally {
      world.cleanup();
    }
    const deep = bootWorld({ argv: ['metaviewer', '--nested-depth=2'] });
    try {
      await rejectsCode(bootProductionMain(deep.handles), 'NESTED_DEPTH');
      assert.equal(deep.constructed.length, 0);
    } finally {
      deep.cleanup();
    }
  });
});

describe('W0-SHELL-MAIN layout bridge', () => {
  it('exposes the closed refusing registry', async () => {
    const bridge = createLayoutBridge();
    assert.equal(bridge.length, 2);
    assert.deepEqual(bridge.map((entry) => entry.channel), [CHANNELS.load, CHANNELS.save]);
    assert.ok(Object.isFrozen(bridge));
    for (const entry of bridge) {
      assert.deepEqual(Object.keys(entry).sort(), ['channel', 'decode', 'invoke']);
      assert.ok(Object.isFrozen(entry));
    }
    const [load, save] = bridge;
    assert.equal(load.decode(undefined), null);
    throwsCode(() => load.decode('payload'), 'LAYOUT_BOUNDS');
    assert.equal(save.decode('"{}"'), '"{}"');
    throwsCode(() => save.decode(42), 'LAYOUT_BOUNDS');
    throwsCode(() => save.decode(`"${'x'.repeat(LAYOUT_MAX_BYTES)}"`), 'LAYOUT_BOUNDS');
    throwsCode(() => save.decode('not-json'), 'LAYOUT_BOUNDS');
    await rejectsCode(load.invoke(null), 'LAYOUT_CONTRACT_ABSENT');
    await rejectsCode(save.invoke('"{}"'), 'LAYOUT_CONTRACT_ABSENT');
  });
});

describe('W0-SHELL-MAIN child environment scrub', () => {
  const RUNTIME = '/run/user/1000/metaviewer';

  it('keeps only the allowlist with a sanitized PATH and admitted runtime', () => {
    const scrubbed = scrubChildEnv(
      {
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        TMPDIR: '/tmp',
        TZ: 'UTC',
        HOME: '/root',
        PYTHONPATH: '/tmp/evil',
        NODE_OPTIONS: '--inspect',
        LD_PRELOAD: '/tmp/evil.so',
        ELECTRON_RUN_AS_NODE: '1',
        BASH_ENV: '/tmp/evil.sh',
      },
      RUNTIME,
    );
    assert.deepEqual(scrubbed, {
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: '/tmp',
      TZ: 'UTC',
      XDG_RUNTIME_DIR: RUNTIME,
    });
    assert.ok(Object.isFrozen(scrubbed));
  });

  it('drops unkeepable ambient values but refuses a broken PATH', () => {
    const scrubbed = scrubChildEnv(
      { LANG: 'x\0y', LC_ALL: 'z'.repeat(4097), PATH: '/usr/bin:/bin', TMPDIR: 42 },
      RUNTIME,
    );
    assert.deepEqual(scrubbed, { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: RUNTIME });
    const capped = scrubChildEnv({ PATH: `${'/a'.repeat(1)}:${new Array(40).fill('/b').join(':')}` }, RUNTIME);
    assert.equal(capped.PATH.split(':').length, 32);
    const relative = scrubChildEnv({ PATH: 'rel:/usr/bin::./x' }, RUNTIME);
    assert.equal(relative.PATH, '/usr/bin');
    for (const path of [undefined, null, 42, '', '   '.trim(), 'rel/bin', 'a:b:c', 'x\0/usr/bin', 'y'.repeat(4097)]) {
      throwsCode(() => scrubChildEnv({ PATH: path }, RUNTIME), 'ENV_PATH');
    }
    throwsCode(() => scrubChildEnv({}, RUNTIME), 'ENV_PATH');
  });

  it('refuses malformed inputs and never passes the parent runtime through', () => {
    for (const env of [null, undefined, 42, 'x', []]) {
      throwsCode(() => scrubChildEnv(env, RUNTIME), 'ENV_SHAPE');
    }
    for (const dir of [null, '', 'relative', `/x\0y`, 'r'.repeat(4097)]) {
      throwsCode(() => scrubChildEnv({ PATH: '/usr/bin' }, dir), 'ENV_RUNTIME');
    }
    const scrubbed = scrubChildEnv({ PATH: '/usr/bin', XDG_RUNTIME_DIR: '/tmp/spoof' }, RUNTIME);
    assert.equal(scrubbed.XDG_RUNTIME_DIR, RUNTIME);
  });
});

describe('W0-SHELL-MAIN kill guard', () => {
  it('admits only a safe live integer distinct from caller identities', () => {
    assert.equal(validateKillTarget(4242, 100, 100), true);
    assert.equal(validateKillTarget(2, 100, 101), true);
    const bad = [
      0, 1, -1, -100, 3.14, NaN, Infinity, -Infinity, 2 ** 53,
      '1234', '4242', true, false, null, undefined, {}, [], [4242],
      {}, Object.create(null), new Number(4242),
      { valueOf: () => 4242, toString: () => '4242' },
      new Proxy({}, {}),
    ];
    for (const pid of bad) {
      assert.equal(validateKillTarget(pid, 100, 100), false, String(typeof pid));
    }
    assert.equal(validateKillTarget(100, 100, 200), false);
    assert.equal(validateKillTarget(200, 100, 200), false);
    assert.equal(validateKillTarget(4242, 100, undefined), false);
    assert.equal(validateKillTarget(4242, undefined, 100), false);
    assert.equal(validateKillTarget(4242, 100, null), false);
    assert.equal(validateKillTarget(4242, 1.5, 100), false);
    assert.equal(validateKillTarget(4242, 100, '100'), false);
    assert.equal(validateKillTarget(4242, 100, NaN), false);
  });
});

describe('W0-SHELL-MAIN core launcher lifecycle', () => {
  it('validates every option before any spawn', () => {
    const world = launcherWorld();
    throwsCode(() => createCoreLauncher(null), 'OPTIONS');
    throwsCode(() => createCoreLauncher({}), 'OPTIONS');
    throwsCode(() => createCoreLauncher({ ...world.options, extra: 1 }), 'OPTIONS');
    const { spawn, ...missing } = world.options;
    assert(spawn);
    throwsCode(() => createCoreLauncher(missing), 'OPTIONS');
    throwsCode(() => createCoreLauncher({ ...world.options, spawn: null }), 'SPAWN');
    for (const command of ['', 'relative/bin', 42, null]) {
      throwsCode(() => createCoreLauncher({ ...world.options, command }), 'COMMAND');
    }
    throwsCode(() => createCoreLauncher({ ...world.options, args: 'x' }), 'ARGS');
    throwsCode(() => createCoreLauncher({ ...world.options, args: ['ok', 42] }), 'ARGS');
    throwsCode(() => createCoreLauncher({ ...world.options, env: null }), 'ENV_SHAPE');
    throwsCode(() => createCoreLauncher({ ...world.options, env: {} }), 'ENV_PATH');
    throwsCode(() => createCoreLauncher({ ...world.options, runtimeDir: 'relative' }), 'ENV_RUNTIME');
    throwsCode(() => createCoreLauncher({ ...world.options, selfPid: undefined }), 'IDENTITY');
    throwsCode(() => createCoreLauncher({ ...world.options, selfPgid: undefined }), 'IDENTITY');
    throwsCode(() => createCoreLauncher({ ...world.options, killFn: null }), 'KILLFN');
    throwsCode(() => createCoreLauncher({ ...world.options, handshake: null }), 'HANDSHAKE');
    throwsCode(() => createCoreLauncher({ ...world.options, transport: {} }), 'TRANSPORT');
    throwsCode(() => createCoreLauncher({ ...world.options, ownership: {} }), 'OWNERSHIP');
    throwsCode(() => createCoreLauncher({ ...world.options, callbacks: {} }), 'CALLBACKS');
    throwsCode(() => createCoreLauncher({ ...world.options, limits: {} }), 'LIMITS');
    throwsCode(
      () => createCoreLauncher({ ...world.options, limits: { ...world.options.limits, maxStdoutLineBytes: 0 } }),
      'LIMITS',
    );
    throwsCode(
      () => createCoreLauncher({ ...world.options, limits: { ...world.options.limits, handshakeTimeoutMs: -1 } }),
      'LIMITS',
    );
    assert.equal(world.spawned.length, 0);
  });

  it('spawns once with pipes, no shell and a scrubbed environment', async () => {
    const world = launcherWorld();
    const launcher = createCoreLauncher(world.options);
    assert.deepEqual(launcher.getStatus(), { availability: 'idle', pid: null, authority_epoch: null, reason: null });
    const status = await launcher.start();
    assert.deepEqual(status, { availability: 'live', pid: 4242, authority_epoch: 7, reason: null });
    assert.ok(Object.isFrozen(status));
    assert.equal(world.spawned.length, 1);
    assert.equal(world.spawned[0].command, '/bundle/metaviewer-core');
    assert.deepEqual(world.spawned[0].args, []);
    assert.deepEqual(world.spawned[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(world.spawned[0].opts.shell, false);
    assert.deepEqual(world.spawned[0].opts.env, {
      LANG: 'C.UTF-8',
      PATH: '/usr/bin:/bin',
      XDG_RUNTIME_DIR: '/run/user/1000/metaviewer',
    });
    const again = await launcher.start();
    assert.deepEqual(again, status);
    assert.equal(world.spawned.length, 1);
    assert.deepEqual(world.statuses.map((entry) => entry.availability), ['starting', 'live']);
    await launcher.dispose();
  });

  it('goes live only after the deferred authenticated handshake', async () => {
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const world = launcherWorld({ handshake: () => gate.then(() => ({ authority_epoch: 3 })) });
    const launcher = createCoreLauncher(world.options);
    const pending = launcher.start();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(launcher.getStatus().availability, 'starting');
    assert.equal(launcher.getStatus().pid, 4242);
    assert.equal(launcher.getStatus().authority_epoch, null);
    release();
    const status = await pending;
    assert.deepEqual(status, { availability: 'live', pid: 4242, authority_epoch: 3, reason: null });
    await launcher.dispose();
  });

  // [TARGET, unit decision] The host supplies production limits (main.js,
  // mainDirectEntry). Enforce its deadline ceiling at launcher admission;
  // a fixture-only limits constant would not guard production callers.
  it('production handshakeTimeoutMs <= 10000 is enforced at launcher admission', async () => {
    const world = launcherWorld();
    const limits = { ...world.options.limits, handshakeTimeoutMs: 10000 };
    const launcher = createCoreLauncher({ ...world.options, limits });
    try {
      assert.equal((await launcher.start()).availability, 'live');
    } finally {
      await launcher.dispose();
    }
    const rejected = launcherWorld();
    throwsCode(() => createCoreLauncher({ ...rejected.options,
      limits: { ...limits, handshakeTimeoutMs: 10001 },
    }), 'LIMITS');
    assert.equal(rejected.spawned.length, 0);
  });

  it('silent-core deadline yields unavailable with one spawn', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    const world = launcherWorld({ handshake: (_adapter, abortSignal) => {
      signal = abortSignal;
      return new Promise(() => {});
    } });
    world.options.limits.handshakeTimeoutMs = 10000;
    const launcher = createCoreLauncher(world.options);
    try {
      const pending = launcher.start();
      const concurrent = launcher.start();
      // Drain the immediately successful connect before advancing the hello clock.
      for (let i = 0; i < 20 && !signal; i += 1) await Promise.resolve();
      assert.ok(signal);
      t.mock.timers.tick(9999);
      await Promise.resolve();
      assert.equal(launcher.getStatus().availability, 'starting');
      assert.equal(signal.aborted, false);
      t.mock.timers.tick(1);
      const status = await pending;
      assert.equal(status.availability, 'unavailable');
      assert.equal(status.authority_epoch, null);
      assert.match(status.reason, /handshake failed/);
      assert.equal(signal.aborted, true);
      assert.deepEqual(await concurrent, status);
      assert.deepEqual(await launcher.start(), status);
      assert.equal(world.spawned.length, 1);
      assert.deepEqual(world.statuses.map((entry) => entry.availability), ['starting', 'unavailable']);
    } finally {
      await launcher.dispose();
      t.mock.timers.reset();
    }
  });

  it('survives callback exceptions without reviving state', async () => {
    const world = launcherWorld({ callbacks: { onStatus: () => { throw new Error('listener boom'); } } });
    const launcher = createCoreLauncher(world.options);
    const status = await launcher.start();
    assert.equal(status.availability, 'live');
    await launcher.dispose();
    assert.equal(launcher.getStatus().availability, 'unavailable');
  });

  it('marks spawn and handshake failures unavailable without respawn', async () => {
    const throwing = launcherWorld({ spawnThrows: true });
    const first = createCoreLauncher(throwing.options);
    const failed = await first.start();
    assert.equal(failed.availability, 'unavailable');
    assert.equal(typeof failed.reason, 'string');
    assert.equal((await first.start()).availability, 'unavailable');
    assert.equal(throwing.spawned.length, 1);
    await first.dispose();

    const nullSpawn = launcherWorld({ spawnResult: null });
    const second = createCoreLauncher(nullSpawn.options);
    assert.equal((await second.start()).availability, 'unavailable');
    await second.dispose();

    const unsafePid = launcherWorld();
    unsafePid.child.pid = '4242';
    const third = createCoreLauncher(unsafePid.options);
    assert.equal((await third.start()).availability, 'unavailable');
    assert.deepEqual(unsafePid.killed, []);
    await third.dispose();

    const hanging = launcherWorld({ handshake: () => new Promise(() => {}) });
    const fourth = createCoreLauncher(hanging.options);
    assert.equal((await fourth.start()).availability, 'unavailable');
    assert.deepEqual(hanging.killed, [[4242, 'SIGTERM']]);
    await fourth.dispose();

    const badEpoch = launcherWorld({ handshake: async () => ({ authority_epoch: '7' }) });
    const fifth = createCoreLauncher(badEpoch.options);
    assert.equal((await fifth.start()).availability, 'unavailable');
    await fifth.dispose();

    const badConnect = launcherWorld({
      transport: {
        connect: async () => { throw new Error('connect boom'); },
        request: async () => null,
        close: async () => {},
      },
    });
    const sixth = createCoreLauncher(badConnect.options);
    assert.equal((await sixth.start()).availability, 'unavailable');
    await sixth.dispose();
  });

  it('forwards live requests with count, byte and deadline gates', async () => {
    const world = launcherWorld();
    const launcher = createCoreLauncher(world.options);
    await rejectsCode(launcher.request({ hello: 1 }), 'NOT_LIVE');
    await launcher.start();
    assert.deepEqual(await launcher.request({ hello: 1 }), { echo: { hello: 1 } });
    await rejectsCode(launcher.request('x'.repeat(129)), 'REQUEST_BYTES');
    await rejectsCode(launcher.request({ big: 'x'.repeat(200) }), 'REQUEST_BYTES');
    const circular = {};
    circular.self = circular;
    await rejectsCode(launcher.request(circular), 'REQUEST_SHAPE');
    assert.equal(launcher.getStatus().availability, 'live');
    await launcher.dispose();
    await rejectsCode(launcher.request({ hello: 1 }), 'NOT_LIVE');
  });

  it('bounds the in-flight queue and times out stalled transports', async () => {
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const world = launcherWorld({
      limits: { ...launcherWorld().options.limits, maxQueuedRequests: 1, maxQueuedBytes: 64 },
      transport: {
        connect: async () => {},
        request: () => gate.then(() => 'slow'),
        close: async () => {},
      },
    });
    const launcher = createCoreLauncher(world.options);
    await launcher.start();
    const slow = launcher.request('a');
    await rejectsCode(launcher.request('b'), 'QUEUE_FULL');
    release();
    assert.equal(await slow, 'slow');
    await launcher.dispose();

    const stalled = launcherWorld({ transport: {
      connect: async () => {},
      request: () => new Promise(() => {}),
      close: async () => {},
    } });
    const second = createCoreLauncher(stalled.options);
    await second.start();
    await rejectsCode(second.request('a'), 'REQUEST_TIMEOUT');
    assert.equal(second.getStatus().availability, 'live');
    await second.dispose();
  });

  it('scans stdout lines across chunk and UTF-8 boundaries', async () => {
    const world = launcherWorld();
    const launcher = createCoreLauncher(world.options);
    await launcher.start();
    world.child.stdout.emit('data', Buffer.from('hel', 'utf8'));
    world.child.stdout.emit('data', Buffer.from('lo\nwo', 'utf8'));
    world.child.stdout.emit('data', Buffer.from('rld\n', 'utf8'));
    const euro = Buffer.from('€\n', 'utf8');
    world.child.stdout.emit('data', euro.subarray(0, 1));
    world.child.stdout.emit('data', euro.subarray(1));
    world.child.stdout.emit('data', 'plain string line\n');
    assert.equal(launcher.getStatus().availability, 'live');
    assert.deepEqual(await launcher.request('ok'), { echo: 'ok' });
    await launcher.dispose();
  });

  it('fails oversized stdout lines and protocol violations without respawn', async () => {
    const world = launcherWorld();
    const launcher = createCoreLauncher(world.options);
    await launcher.start();
    world.child.stdout.emit('data', Buffer.alloc(65, 0x61));
    assert.equal(launcher.getStatus().availability, 'unavailable');
    assert.deepEqual(world.killed, [[4242, 'SIGTERM']]);
    await launcher.request('x').then(
      () => assert.fail('request after unavailable must reject'),
      (error) => assert.equal(error.code, 'NOT_LIVE'),
    );
    await launcher.start();
    assert.equal(world.spawned.length, 1);
    await launcher.dispose();

    const binary = launcherWorld();
    const second = createCoreLauncher(binary.options);
    await second.start();
    binary.child.stdout.emit('data', { not: 'bytes' });
    assert.equal(second.getStatus().availability, 'unavailable');
    await second.dispose();
  });

  it('drains stderr floods with a bounded tail and stays live', async () => {
    const world = launcherWorld();
    const launcher = createCoreLauncher(world.options);
    await launcher.start();
    for (let i = 0; i < 20; i += 1) {
      world.child.stderr.emit('data', Buffer.alloc(10000, 0x62));
    }
    assert.equal(launcher.getStatus().availability, 'live');
    assert.deepEqual(await launcher.request('ok'), { echo: 'ok' });
    await launcher.dispose();
  });

  it('treats EOF and child exit as terminal without respawn', async () => {
    const world = launcherWorld();
    const launcher = createCoreLauncher(world.options);
    await launcher.start();
    world.child.stdout.emit('end');
    assert.equal(launcher.getStatus().availability, 'unavailable');
    await launcher.dispose();
    assert.equal(world.spawned.length, 1);

    const exited = launcherWorld();
    const second = createCoreLauncher(exited.options);
    await second.start();
    exited.child.emit('exit', 1, null);
    assert.equal(second.getStatus().availability, 'unavailable');
    assert.match(String(second.getStatus().reason), /exit/);
    await second.start();
    assert.equal(exited.spawned.length, 1);
    await second.dispose();
    assert.deepEqual(exited.killed, []);
  });

  it('disposes idempotently with TERM then bounded KILL escalation', async () => {
    const world = launcherWorld();
    const launcher = createCoreLauncher(world.options);
    await launcher.start();
    await launcher.dispose();
    assert.deepEqual(world.killed, [[4242, 'SIGTERM']]);
    assert.deepEqual(world.waits, [4242]);
    await launcher.dispose();
    assert.deepEqual(world.killed, [[4242, 'SIGTERM']]);
    assert.equal(launcher.getStatus().availability, 'unavailable');

    const hanging = launcherWorld({ ownership: { ownedPids: () => [4242], waitForExit: () => new Promise(() => {}) } });
    const second = createCoreLauncher(hanging.options);
    await second.start();
    await second.dispose();
    assert.deepEqual(hanging.killed, [[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  });

  it('signals only owned live safe pids in reverse ledger order', async () => {
    const world = launcherWorld({ ownership: {
      ownedPids: () => [0, -5, 'x', null, 100, 5001, 5002, 5003],
      waitForExit: async () => {},
    } });
    const launcher = createCoreLauncher(world.options);
    await launcher.start();
    await launcher.dispose();
    assert.deepEqual(world.killed, [
      [5003, 'SIGTERM'],
      [5002, 'SIGTERM'],
      [5001, 'SIGTERM'],
      [4242, 'SIGTERM'],
    ]);
  });

  it('emits zero signals when ownership is missing or kill fails', async () => {
    const missing = launcherWorld({ ownership: { ownedPids: () => { throw new Error('ledger boom'); }, waitForExit: async () => {} } });
    const first = createCoreLauncher(missing.options);
    await first.start();
    await first.dispose();
    assert.deepEqual(missing.killed, []);

    const shaped = launcherWorld({ ownership: { ownedPids: () => 'nope', waitForExit: async () => {} } });
    const second = createCoreLauncher(shaped.options);
    await second.start();
    await second.dispose();
    assert.deepEqual(shaped.killed, []);

    const killFail = launcherWorld({ killThrows: true });
    const third = createCoreLauncher(killFail.options);
    await third.start();
    await third.dispose();
    assert.equal(third.getStatus().availability, 'unavailable');

    const idle = launcherWorld();
    const fourth = createCoreLauncher(idle.options);
    await fourth.dispose();
    assert.deepEqual(idle.killed, []);
    assert.deepEqual(fourth.getStatus(), { availability: 'unavailable', pid: null, authority_epoch: null, reason: 'disposed' });
    await fourth.start();
    assert.equal(idle.spawned.length, 0);
  });
});
