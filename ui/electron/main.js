// @ts-check
'use strict';

/**
 * [TARGET, unit decision] Layout presentation storage is host-local and
 * validated by the pinned kit decoder; it carries no core authority.
 *
 * W0-SHELL-MAIN Electron main entry: window lifecycle, default-deny
 * navigation/permission policy, strict top-frame sender admission,
 * privileged bundle serving with a strict CSP, retail launch guards,
 * fuse policy constants and Rust core supervision wiring.
 *
 * Main supervises; Rust owns state. Every privileged receiver admits
 * through observeSender first. No top-level Electron import: the module
 * is inert under plain Node and the direct entry synchronously requires
 * Electron only behind the versions guard.
 *
 * @module main
 */

import { constants as fsConstants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findForbiddenEnv } from './coreLauncher.js';

// [TARGET, unit decision] Packaging seals ASAR renderer bytes into the loaded
// main module. A replaced archive cannot change the admitted asset contents.
const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({}));

/**
 * Typed main failure; a failure admits nothing.
 */
export class MainError extends Error {
  /**
   * @param {string} code Stable refusal code.
   * @param {string} message Human detail (never an authority grant).
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'MainError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * @param {string} code Stable refusal code.
 * @param {string} message Human detail.
 * @returns {never}
 */
function fail(code, message) {
  throw new MainError(code, message);
}

/**
 * Pinned Electron version; anything else refuses boot.
 * @type {string}
 */
export const ELECTRON_PIN = '44.9.2';

/**
 * Privileged bundled application origin. Only frames and URLs under
 * this origin may reach privileged IPC.
 * @type {string}
 */
export const PRIVILEGED_ORIGIN = 'app://metaviewer';

/**
 * Privileged scheme portion of the bundled origin.
 * @type {string}
 */
export const PRIVILEGED_SCHEME = 'app';

/**
 * Privileged host portion of the bundled origin.
 * @type {string}
 */
export const PRIVILEGED_HOST = 'metaviewer';

/**
 * Restrictive content security policy for the bundled renderer. The
 * renderer talks to main only through the narrow preload facade, so
 * network, frames, objects and forms are all closed.
 * @type {string}
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Maximum URL/origin characters accepted by the decision functions.
 * @type {number}
 */
export const MAX_URL_CHARS = 2048;

/**
 * Maximum preload path characters accepted by the options factory.
 * @type {number}
 */
export const MAX_PRELOAD_PATH_CHARS = 1024;

/**
 * Maximum single bundled file bytes served. Larger files refuse with
 * 403 so one oversized asset cannot balloon main memory.
 * @type {number}
 */
export const APP_MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Maximum bundle-root characters accepted.
 * @type {number}
 */
export const APP_MAX_ROOT_CHARS = 4096;

/**
 * Fixed preload channel literals, mirrored (never imported) from the
 * preload bundle so main and preload cannot drift silently.
 * @type {Readonly<{load: string, save: string}>}
 */
export const CHANNELS = Object.freeze({ load: 'metaviewer:layout.load', save: 'metaviewer:layout.save' });

/**
 * Maximum layout payload UTF-8 bytes on the save channel.
 * @type {number}
 */
export const LAYOUT_MAX_BYTES = 256 * 1024;

/**
 * Default window geometry: the fixed nested-capsule size.
 * @type {Readonly<{width: number, height: number}>}
 */
export const DEFAULT_GEOMETRY = Object.freeze({ width: 1280, height: 720 });

/**
 * Module registry: the files this unit owns. Router/config owners
 * register these paths without expanding this surface.
 * @type {Readonly<{id: string, entries: ReadonlyArray<string>}>}
 */
export const MODULE_REGISTRY = Object.freeze({
  id: 'W0-SHELL-MAIN',
  entries: Object.freeze(['ui/electron/main.js', 'ui/electron/coreLauncher.js', 'ui/test/coreLauncher.test.js']),
});

/**
 * Maximum argv items scanned.
 * @type {number}
 */
export const MAX_ARGV_ITEMS = 256;

/**
 * Maximum single argv item characters parsed.
 * @type {number}
 */
export const MAX_ARGV_CHARS = 4096;

/**
 * Forbidden retail argv flags (matched on the token before '=').
 * Covers V8 inspect/debug, module-loader injection, remote-debugging
 * endpoints and the test-only --no-sandbox escape.
 * @type {ReadonlyArray<string>}
 */
export const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  '--debug',
  '--debug-brk',
  '--debug-port',
  '--import',
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--inspect-publish-uid',
  '--inspect-wait',
  '--no-sandbox',
  '--remote-allow-origins',
  '--remote-debugging-pipe',
  '--remote-debugging-port',
  '--require',
]);

/**
 * Known runtime (Chromium/Electron) switches the launcher passes
 * through to the runtime. These are not application switches: anything
 * else dash-led reaching the retail guard is refused as unknown.
 * @type {ReadonlyArray<string>}
 */
export const KNOWN_RUNTIME_SWITCHES = Object.freeze(['--user-data-dir', '--ozone-platform']);

/**
 * Fuse wire version pinned with the packaged Electron.
 * @type {string}
 */
export const FUSE_VERSION = '1';

/**
 * One sole-config fuse row.
 * @typedef {object} FuseRow
 * @property {number} index Wire index 0..8.
 * @property {string} name FuseV1Options name.
 * @property {boolean} expect True for ENABLE, false for DISABLE.
 * @property {boolean} required True for a required retail protection.
 * @property {string} basis Requirement or allocation basis.
 */

/**
 * Sole retail fuse table. Exactly nine rows; required rows are the six
 * hardening protections, the other three are allocated retail defaults
 * enforced exactly against drift. Exported here, flipped at packaging.
 * @type {ReadonlyArray<FuseRow>}
 */
export const FUSE_TABLE = Object.freeze([
  Object.freeze({ index: 0, name: 'RunAsNode', expect: false, required: true, basis: 'NORM:12.8 RunAsNode off' }),
  Object.freeze({ index: 1, name: 'EnableCookieEncryption', expect: true, required: false, basis: 'retail default: encrypt cookies at rest' }),
  Object.freeze({ index: 2, name: 'EnableNodeOptionsEnvironmentVariable', expect: false, required: true, basis: 'NORM:12.8 NODE_OPTIONS environment off' }),
  Object.freeze({ index: 3, name: 'EnableNodeCliInspectArguments', expect: false, required: true, basis: 'NORM:12.8 CLI inspect arguments off' }),
  Object.freeze({ index: 4, name: 'EnableEmbeddedAsarIntegrityValidation', expect: true, required: true, basis: 'NORM:12.8 embedded ASAR integrity on where supported' }),
  Object.freeze({ index: 5, name: 'OnlyLoadAppFromAsar', expect: true, required: true, basis: 'NORM:12.8 OnlyLoadAppFromAsar on' }),
  Object.freeze({ index: 6, name: 'LoadBrowserProcessSpecificV8Snapshot', expect: false, required: false, basis: 'Electron 44.9.2 linux-arm64 ships no browser_v8_context_snapshot.bin; ENABLE aborts startup' }),
  Object.freeze({ index: 7, name: 'GrantFileProtocolExtraPrivileges', expect: false, required: true, basis: 'NORM:12.8 file-protocol extra privileges off' }),
  Object.freeze({ index: 8, name: 'WasmTrapHandlers', expect: false, required: false, basis: 'retail default: no signal-based WASM trap handlers' }),
]);

/**
 * Count of required protections in the fuse table.
 * @type {number}
 */
export const REQUIRED_FUSE_COUNT = 6;

/**
 * @typedef {'allow' | 'deny'} PolicyDecision
 */

/**
 * Fixed web preferences. Every security flag is pinned here; callers
 * supply no security input beyond the preload path.
 * @typedef {object} MainWebPreferences
 * @property {true} sandbox
 * @property {true} contextIsolation
 * @property {false} nodeIntegration
 * @property {false} nodeIntegrationInWorker
 * @property {false} nodeIntegrationInSubFrames
 * @property {true} webSecurity
 * @property {false} webviewTag
 * @property {false} allowRunningInsecureContent
 * @property {false} experimentalFeatures
 * @property {string} preload
 */

/**
 * @typedef {object} MainWindowOptions
 * @property {number} width
 * @property {number} height
 * @property {false} show Windows show only when readiness allows.
 * @property {MainWebPreferences} webPreferences
 */

/**
 * Build frozen BrowserWindow options with fixed security flags.
 * @param {unknown} request Alleged {width, height, preloadPath}.
 * @returns {MainWindowOptions} Frozen options.
 */
export function createWindowOptions(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    fail('OPTIONS', 'window request must be an object');
  }
  const o = /** @type {Record<string, unknown>} */ (request);
  const keys = Object.keys(o);
  if (keys.length !== 3 || !Object.hasOwn(o, 'width') || !Object.hasOwn(o, 'height') || !Object.hasOwn(o, 'preloadPath')) {
    fail('OPTIONS', 'window request must be exactly {width,height,preloadPath}');
  }
  const width = o.width;
  const height = o.height;
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width < 1 || width > 7680) {
    fail('OPTIONS', 'width outside 1..7680');
  }
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1 || height > 7680) {
    fail('OPTIONS', 'height outside 1..7680');
  }
  const preloadPath = o.preloadPath;
  if (typeof preloadPath !== 'string' || preloadPath.length < 1 || preloadPath.length > MAX_PRELOAD_PATH_CHARS) {
    fail('OPTIONS', 'preloadPath outside bounds');
  }
  if (preloadPath.includes(String.fromCharCode(0))) {
    fail('OPTIONS', 'preloadPath must not contain NUL');
  }
  return Object.freeze({
    width,
    height,
    show: /** @type {false} */ (false),
    webPreferences: Object.freeze({
      sandbox: /** @type {true} */ (true),
      contextIsolation: /** @type {true} */ (true),
      nodeIntegration: /** @type {false} */ (false),
      nodeIntegrationInWorker: /** @type {false} */ (false),
      nodeIntegrationInSubFrames: /** @type {false} */ (false),
      webSecurity: /** @type {true} */ (true),
      webviewTag: /** @type {false} */ (false),
      allowRunningInsecureContent: /** @type {false} */ (false),
      experimentalFeatures: /** @type {false} */ (false),
      preload: preloadPath,
    }),
  });
}

/**
 * True only for URLs under the privileged bundled origin with no
 * credentials and no port. Total: every malformed value is false.
 * @param {unknown} value Alleged URL.
 * @returns {boolean} True for admitted bundled URLs.
 */
export function isPrivilegedAppUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length < 1 || value.length > MAX_URL_CHARS) {
    return false;
  }
  /** @type {URL | null} */
  let parsed = null;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'app:') {
    return false;
  }
  if (parsed.host !== PRIVILEGED_HOST) {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    return false;
  }
  return true;
}

/**
 * True when the raw request-target path carries an escape: dot
 * segments, decoded separators, NUL or undecodable escapes. The scan
 * runs on the raw segments because WHATWG normalization would erase
 * `..` before the check. Total: malformed values are escapes.
 * @param {string} rawUrl Raw URL text.
 * @returns {boolean} True for escaping paths.
 */
function hasPathEscape(rawUrl) {
  if (rawUrl.includes('\\') || rawUrl.includes(String.fromCharCode(0))) {
    return true;
  }
  const schemeSep = rawUrl.indexOf('://');
  if (schemeSep === -1) {
    return true;
  }
  let pathEnd = rawUrl.length;
  const queryAt = rawUrl.indexOf('?', schemeSep + 3);
  if (queryAt !== -1 && queryAt < pathEnd) {
    pathEnd = queryAt;
  }
  const hashAt = rawUrl.indexOf('#', schemeSep + 3);
  if (hashAt !== -1 && hashAt < pathEnd) {
    pathEnd = hashAt;
  }
  const slashAt = rawUrl.indexOf('/', schemeSep + 3);
  const rawPath = slashAt === -1 || slashAt >= pathEnd ? '/' : rawUrl.slice(slashAt, pathEnd);
  for (const part of rawPath.split('/')) {
    if (part === '') {
      continue;
    }
    /** @type {string | null} */
    let decoded = null;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return true;
    }
    if (decoded === '' || decoded === '.' || decoded === '..') {
      return true;
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes(String.fromCharCode(0))) {
      return true;
    }
  }
  return false;
}

/**
 * Navigation decision. Total: malformed, foreign or escaping URLs deny.
 * @param {unknown} url Candidate destination.
 * @returns {PolicyDecision} allow only for canonical bundled URLs.
 */
export function decideNavigation(url) {
  if (!isPrivilegedAppUrl(url)) {
    return 'deny';
  }
  return hasPathEscape(/** @type {string} */ (url)) ? 'deny' : 'allow';
}

/**
 * Window-creation decision. Total: creation always denies; main opens
 * windows itself and the renderer never does.
 * @param {unknown} _url Candidate URL, ignored by design.
 * @returns {PolicyDecision} Always deny.
 */
export function decideWindowOpen(_url) {
  return 'deny';
}

/**
 * Permission decision for both the request and check handlers. Total:
 * every permission denies, including malformed inputs.
 * @param {unknown} _permission Candidate permission name, ignored.
 * @param {unknown} _origin Candidate origin, ignored.
 * @returns {PolicyDecision} Always deny.
 */
export function decidePermission(_permission, _origin) {
  return 'deny';
}

/**
 * Webview-attach decision. Total: attach always denies.
 * @returns {PolicyDecision} Always deny.
 */
export function decideWebviewAttach() {
  return 'deny';
}

/**
 * True for privileged frame URLs: bundled `app://metaviewer/*` URLs via
 * the navigation decision, plus `about:srcdoc`/`about:blank` when the
 * frame origin is privileged (same-origin dynamic content inheriting
 * the embedding origin). Total: malformed values are false.
 * @param {unknown} url Alleged frame URL.
 * @param {unknown} origin Alleged frame origin.
 * @param {unknown} privilegedOrigin Expected privileged origin.
 * @returns {boolean} True for admitted frame URLs.
 */
export function isPrivilegedFrameUrl(url, origin, privilegedOrigin) {
  if (typeof url !== 'string' || typeof origin !== 'string') {
    return false;
  }
  if (url.length < 1 || url.length > MAX_URL_CHARS) {
    return false;
  }
  if (decideNavigation(url) === 'allow') {
    return true;
  }
  if ((url === 'about:srcdoc' || url === 'about:blank') && origin === privilegedOrigin) {
    return true;
  }
  return false;
}

/**
 * Main-observed transport sender. Built by main from the ipcMain event
 * and the expected contents; no renderer argument may supply or alter
 * it. Mirrors the caller guard's record shape.
 * @typedef {object} ObservedSender
 * @property {number} senderId Positive webContents identity.
 * @property {string} frameOrigin Observed frame origin.
 * @property {string} frameUrl Observed frame URL.
 */

/**
 * @typedef {{verdict: 'admit', sender: ObservedSender} | {verdict: 'refuse', code: string}} SenderVerdict
 */

/**
 * Build the observed sender from an `IpcMainInvokeEvent`-shaped value
 * against the expected live contents. Total: every refusal is a frozen
 * verdict, never a throw, and refusal mutates nothing. Throwing
 * getters and destroyed handles refuse with SENDER.
 *
 * Refusal reasons: `SENDER` (malformed event, mismatched or destroyed
 * sender), `FRAME_NULL` (senderFrame null or missing),
 * `FRAME_DETACHED` (detached frame), `SUBFRAME` (senderFrame is not the
 * sender's top frame by strict identity), `FRAME_ORIGIN` (origin is not
 * privileged), `FRAME_URL` (URL is not privileged).
 * @param {unknown} event Alleged invoke event with sender/senderFrame.
 * @param {unknown} expectedContents The one live contents admitted.
 * @param {unknown} privilegedOrigin Expected privileged origin.
 * @returns {SenderVerdict} Frozen admit with the sender, or refusal.
 */
export function observeSender(event, expectedContents, privilegedOrigin) {
  /**
   * @param {string} code Typed refusal code (never an authority grant).
   * @returns {SenderVerdict} Frozen refusal.
   */
  const refuse = (code) => Object.freeze({ verdict: /** @type {'refuse'} */ ('refuse'), code });
  try {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      return refuse('SENDER');
    }
    const rec = /** @type {Record<string, unknown>} */ (event);
    const sender = rec.sender;
    if (sender === null || typeof sender !== 'object' || Array.isArray(sender)) {
      return refuse('SENDER');
    }
    if (sender !== expectedContents) {
      return refuse('SENDER');
    }
    const srec = /** @type {Record<string, unknown>} */ (sender);
    if (typeof srec.isDestroyed === 'function') {
      /** @type {unknown} */
      let dead = false;
      try {
        dead = /** @type {() => unknown} */ (srec.isDestroyed).call(sender) === true;
      } catch {
        return refuse('SENDER');
      }
      if (dead === true) {
        return refuse('SENDER');
      }
    }
    const id = srec.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      return refuse('SENDER');
    }
    const mainFrame = srec.mainFrame;
    if (mainFrame === null || typeof mainFrame !== 'object' || Array.isArray(mainFrame)) {
      return refuse('SENDER');
    }
    const frame = rec.senderFrame;
    if (frame === null || frame === undefined) {
      return refuse('FRAME_NULL');
    }
    if (typeof frame !== 'object' || Array.isArray(frame)) {
      return refuse('FRAME_NULL');
    }
    const frec = /** @type {Record<string, unknown>} */ (frame);
    if (frec.detached === true) {
      return refuse('FRAME_DETACHED');
    }
    // Top-frame identity: strict reference equality against the
    // sender's main frame. Never compare URLs, origins, ids or
    // serialized tokens here; only identity proves the sending frame
    // is the top frame.
    if (frame !== mainFrame) {
      return refuse('SUBFRAME');
    }
    const origin = frec.origin;
    const url = frec.url;
    if (typeof origin !== 'string' || origin.length < 1 || origin.length > MAX_URL_CHARS) {
      return refuse('FRAME_ORIGIN');
    }
    if (origin !== privilegedOrigin) {
      return refuse('FRAME_ORIGIN');
    }
    if (typeof url !== 'string' || url.length < 1 || url.length > MAX_URL_CHARS) {
      return refuse('FRAME_URL');
    }
    if (!isPrivilegedFrameUrl(url, origin, privilegedOrigin)) {
      return refuse('FRAME_URL');
    }
    return Object.freeze({
      verdict: /** @type {'admit'} */ ('admit'),
      sender: Object.freeze({
        senderId: /** @type {number} */ (id),
        frameOrigin: origin,
        frameUrl: url,
      }),
    });
  } catch {
    return refuse('SENDER');
  }
}

/**
 * Minimal event surface the policy needs (structural; real Electron
 * events satisfy it).
 * @typedef {{preventDefault: () => void}} MainPreventable
 */

/**
 * @typedef {object} MainAttachSummary
 * @property {ReadonlyArray<string>} attached Frozen attached-handler names.
 */

/**
 * @param {unknown} value Alleged handle object.
 * @param {string} label Handle label for diagnostics.
 * @returns {Record<string, unknown>} The handle as a record.
 */
function assertHandleObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('HANDLE', `${label} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Wire the policy onto injected window/session handles. Throws only for
 * malformed handles (a main wiring bug); every runtime decision itself
 * is total and default-deny.
 * @param {unknown} win Alleged window with webContents.on/setWindowOpenHandler.
 * @param {unknown} session Alleged session with permission handlers.
 * @returns {MainAttachSummary} Frozen summary of attached handlers.
 */
export function attachWindowPolicy(win, session) {
  const wrec = assertHandleObject(win, 'win');
  const contents = assertHandleObject(wrec.webContents, 'win.webContents');
  if (typeof contents.on !== 'function' || typeof contents.setWindowOpenHandler !== 'function') {
    fail('HANDLE', 'webContents must provide on and setWindowOpenHandler');
  }
  const srec = assertHandleObject(session, 'session');
  if (typeof srec.setPermissionRequestHandler !== 'function' || typeof srec.setPermissionCheckHandler !== 'function') {
    fail('HANDLE', 'session must provide permission handlers');
  }
  // Bound receivers: Electron exposes these as prototype methods that
  // read `this`. Never destructure them; every call below is a method
  // call on the same handle object so the receiver is preserved.
  const webContents = /** @type {{ on: (eventName: string, listener: Function) => unknown, setWindowOpenHandler: (handler: () => {action: string}) => unknown }} */ (
    /** @type {unknown} */ (contents)
  );
  const sess = /** @type {{ setPermissionRequestHandler: (handler: Function) => unknown, setPermissionCheckHandler: (handler: Function) => unknown }} */ (
    /** @type {unknown} */ (srec)
  );
  webContents.setWindowOpenHandler(
    /** @returns {{action: string}} */
    () => ({ action: decideWindowOpen('') }),
  );
  webContents.on(
    'will-navigate',
    /**
     * @param {MainPreventable} event Navigation event.
     * @param {string} url Destination URL.
     * @returns {void}
     */
    (event, url) => {
      if (decideNavigation(url) !== 'allow') {
        event.preventDefault();
      }
    },
  );
  webContents.on(
    'will-redirect',
    /**
     * @param {MainPreventable} event Redirect event.
     * @param {string} url Redirect destination URL.
     * @returns {void}
     */
    (event, url) => {
      if (decideNavigation(url) !== 'allow') {
        event.preventDefault();
      }
    },
  );
  webContents.on(
    'will-frame-navigate',
    /**
     * @param {MainPreventable} event Frame-navigation event.
     * @param {string} url Destination URL.
     * @returns {void}
     */
    (event, url) => {
      if (decideNavigation(url) !== 'allow') {
        event.preventDefault();
      }
    },
  );
  webContents.on(
    'will-attach-webview',
    /**
     * @param {MainPreventable} event Attach event.
     * @returns {void}
     */
    (event) => {
      if (decideWebviewAttach() !== 'allow') {
        event.preventDefault();
      }
    },
  );
  sess.setPermissionRequestHandler(
    /**
     * @param {unknown} _webContents Requesting contents, ignored.
     * @param {string} permission Candidate permission.
     * @param {(granted: boolean) => void} callback Grant callback.
     * @returns {void}
     */
    (_webContents, permission, callback) => {
      callback(decidePermission(permission, '') === 'allow');
    },
  );
  sess.setPermissionCheckHandler(
    /**
     * @param {unknown} _webContents Requesting contents, ignored.
     * @param {string} permission Candidate permission.
     * @param {string} _origin Candidate origin, ignored.
     * @returns {boolean}
     */
    (_webContents, permission, _origin) => decidePermission(permission, '') === 'allow',
  );
  return Object.freeze({
    attached: Object.freeze([
      'window-open',
      'will-navigate',
      'will-redirect',
      'will-frame-navigate',
      'will-attach-webview',
      'permission-request',
      'permission-check',
    ]),
  });
}

/**
 * Nonce shape: base64 of 24 random bytes, validated so request data can
 * never be interpolated into the policy.
 * @type {RegExp}
 */
const NONCE_PATTERN = /^[A-Za-z0-9+/]{32}$/;

/**
 * Build the response CSP: the exact base list, optionally extending
 * only style-src with a main-generated nonce.
 * @param {unknown} styleNonce Null for the base list, or the nonce.
 * @returns {string} CSP header value.
 */
export function buildCsp(styleNonce) {
  if (styleNonce === null || styleNonce === undefined) {
    return CONTENT_SECURITY_POLICY;
  }
  if (typeof styleNonce !== 'string' || !NONCE_PATTERN.test(styleNonce)) {
    fail('CSP_NONCE', 'style nonce must be 32 base64 characters');
  }
  return CONTENT_SECURITY_POLICY.replace("style-src 'self'", `style-src 'self' 'nonce-${styleNonce}'`);
}

/**
 * Content type by file extension. Unknown extensions fall back to
 * bytes; no extension is ever sniffed or executed by main.
 * @param {string} filePath Resolved file path.
 * @returns {string} Content-Type value.
 */
function contentTypeFor(filePath) {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html';
    case '.js':
    case '.mjs':
      return 'text/javascript';
    case '.css':
      return 'text/css';
    case '.json':
    case '.map':
      return 'application/json';
    case '.txt':
      return 'text/plain';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}

/**
 * @param {string} candidate Filesystem path to stat without following.
 * @returns {import('node:fs').Stats | null} Stats, or null when absent.
 */
function lstatOrNull(candidate) {
  try {
    return lstatSync(candidate);
  } catch {
    return null;
  }
}

/**
 * Admit one bundle root: a bounded absolute path resolving to a real
 * directory. The canonical (symlink-resolved) root anchors every
 * containment check the handler performs.
 * @param {unknown} root Alleged bundle root.
 * @returns {string} Canonical root.
 */
function canonicalizeRoot(root) {
  if (typeof root !== 'string' || root.length < 1 || root.length > APP_MAX_ROOT_CHARS) {
    fail('ROOT', 'bundle root must be a bounded nonempty string');
  }
  if (root.includes(String.fromCharCode(0))) {
    fail('ROOT', 'bundle root must not contain NUL');
  }
  if (!isAbsolute(root)) {
    fail('ROOT', 'bundle root must be absolute');
  }
  /** @type {string | null} */
  let canonical = null;
  try {
    canonical = realpathSync(root);
  } catch {
    canonical = null;
  }
  if (canonical === null) {
    fail('ROOT', 'bundle root is not readable');
  }
  /** @type {import('node:fs').Stats | null} */
  let st = null;
  try {
    st = statSync(/** @type {string} */ (canonical));
  } catch {
    st = null;
  }
  if (st === null || !st.isDirectory()) {
    fail('ROOT', 'bundle root is not a directory');
  }
  return /** @type {string} */ (canonical);
}

/**
 * Serve one `app://` request from the admitted bundle root. Total:
 * every refusal is a status response carrying the CSP header, never a
 * throw. The traversal analysis runs on the raw request-target
 * segments; the resolved file is symlink-resolved and containment is
 * re-checked, and the opened descriptor identity (not a prior stat) is
 * validated before bytes are read.
 * @param {unknown} rendererRoot Alleged bundle root.
 * @param {unknown} request Fetch-API request delivered by Electron.
 * @param {{styleNonce?: boolean, beforeOpen?: () => void}} [options] Main-owned style policy and deterministic open seam.
 * @returns {Promise<Response>} File or refusal, always with the CSP header.
 */
export async function handleAppRequest(rendererRoot, request, options) {
  /**
   * @param {number} status Refusal status.
   * @param {string} text Refusal body.
   * @returns {Response} Refusal carrying the base CSP header.
   */
  const refusal = (status, text) => new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    },
  });
  try {
    /** @type {string} */
    let canonicalRoot;
    try {
      canonicalRoot = canonicalizeRoot(rendererRoot);
    } catch {
      return refusal(403, 'forbidden');
    }
    const nonceEnabled = typeof options === 'object' && options !== null && !Array.isArray(options)
      ? /** @type {{styleNonce?: unknown}} */ (options).styleNonce === true
      : false;
    if (request === null || typeof request !== 'object') {
      return refusal(403, 'forbidden');
    }
    const rawUrl = /** @type {Record<string, unknown>} */ (request).url;
    if (typeof rawUrl !== 'string' || rawUrl.length < 1 || rawUrl.length > MAX_URL_CHARS) {
      return refusal(403, 'forbidden');
    }
    if (rawUrl.includes('\\') || rawUrl.includes(String.fromCharCode(0))) {
      return refusal(403, 'forbidden');
    }
    /** @type {URL | null} */
    let parsed = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return refusal(403, 'forbidden');
    }
    if (parsed.protocol !== `${PRIVILEGED_SCHEME}:`) {
      return refusal(403, 'forbidden');
    }
    // Case-sensitive host parity with isPrivilegedAppUrl: WHATWG does
    // not lowercase hosts of non-special schemes, so an uppercase host
    // is a different host and refuses here too.
    if (parsed.host !== PRIVILEGED_HOST) {
      return refusal(403, 'forbidden');
    }
    if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '') {
      return refusal(403, 'forbidden');
    }
    const schemeSep = rawUrl.indexOf('://');
    if (schemeSep === -1) {
      return refusal(403, 'forbidden');
    }
    let pathEnd = rawUrl.length;
    const queryAt = rawUrl.indexOf('?', schemeSep + 3);
    if (queryAt !== -1 && queryAt < pathEnd) {
      pathEnd = queryAt;
    }
    const hashAt = rawUrl.indexOf('#', schemeSep + 3);
    if (hashAt !== -1 && hashAt < pathEnd) {
      pathEnd = hashAt;
    }
    const slashAt = rawUrl.indexOf('/', schemeSep + 3);
    const rawPath = slashAt === -1 || slashAt >= pathEnd ? '/' : rawUrl.slice(slashAt, pathEnd);
    /** @type {Array<string>} */
    const segments = [];
    for (const part of rawPath.split('/')) {
      if (part === '') {
        continue;
      }
      /** @type {string | null} */
      let decoded = null;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        decoded = null;
      }
      if (decoded === null) {
        return refusal(403, 'forbidden');
      }
      if (decoded === '' || decoded === '.' || decoded === '..') {
        return refusal(403, 'forbidden');
      }
      if (decoded.includes('/') || decoded.includes('\\') || decoded.includes(String.fromCharCode(0))) {
        return refusal(403, 'forbidden');
      }
      segments.push(decoded);
    }
    const resolved = join(canonicalRoot, ...segments);
    const rel = relative(canonicalRoot, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      return refusal(403, 'forbidden');
    }
    let target = resolved;
    let st = lstatOrNull(target);
    if (st !== null && st.isDirectory() && !st.isSymbolicLink()) {
      target = join(target, 'index.html');
      st = lstatOrNull(target);
    }
    if (st === null) {
      return refusal(404, 'not found');
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      return refusal(403, 'forbidden');
    }
    /** @type {string | null} */
    let real = null;
    try {
      real = realpathSync(target);
    } catch {
      real = null;
    }
    if (real === null) {
      return refusal(404, 'not found');
    }
    const realRel = relative(canonicalRoot, real);
    if (realRel === '..' || realRel.startsWith(`..${sep}`)) {
      return refusal(403, 'forbidden');
    }
    // Opened-descriptor identity: size and kind come from the open
    // descriptor, so a swap between check and read cannot escape.
    /** @type {number | null} */
    let fd = null;
    /** @type {Buffer | null} */
    let bytes = null;
    try {
      options?.beforeOpen?.();
      // [TARGET, unit decision] Linux descriptor-relative, no-follow traversal.
      // The admitted root is pinned before opening any descendant. ASAR paths
      // are Electron's immutable build namespace (package gate forbids links).
      if (process.versions.electron && canonicalRoot.includes('.asar/')) {
        fd = openSync(real, 'r');
      } else {
        let parent = openSync(canonicalRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        try {
          if (realpathSync(`/proc/self/fd/${parent}`) !== canonicalRoot) return refusal(403, 'forbidden');
          const parts = relative(canonicalRoot, real).split(sep);
          for (const part of parts.slice(0, -1)) {
            const child = openSync(`/proc/self/fd/${parent}/${part}`,
              fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
            closeSync(parent);
            parent = child;
          }
          fd = openSync(`/proc/self/fd/${parent}/${parts.at(-1)}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        } finally { closeSync(parent); }
      }
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > APP_MAX_FILE_BYTES) {
        return refusal(403, 'forbidden');
      }
      bytes = readFileSync(fd);
      if (process.versions.electron && canonicalRoot.includes('.asar/')) {
        const expected = PACKAGED_ASSET_DIGESTS[relative(canonicalRoot, real).split(sep).join('/')];
        if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) {
          return refusal(403, 'forbidden');
        }
      }
    } catch {
      return refusal(403, 'forbidden');
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* descriptor release best-effort */
        }
      }
    }
    if (bytes === null) {
      return refusal(404, 'not found');
    }
    // A fresh nonce belongs to this HTML response, never a renderer
    // request. HTML without an insertion point refuses rather than
    // serving a kit the theme installer would reject.
    let csp = CONTENT_SECURITY_POLICY;
    if (nonceEnabled && contentTypeFor(real).startsWith('text/html')) {
      const nonce = randomBytes(24).toString('base64');
      csp = buildCsp(nonce);
      const text = bytes.toString('utf8');
      if (!text.includes('<head>')) {
        return refusal(403, 'forbidden');
      }
      // Both policies apply in Chromium. Bind the static meta policy to the
      // same nonce as the response header so the kit's styles are admitted.
      bytes = Buffer.from(text.replaceAll(
        `content="${CONTENT_SECURITY_POLICY}"`, `content="${csp}"`,
      ).replace('<head>', `<head><meta name="metaviewer-style-nonce" content="${nonce}">`));
    }
    // ArrayBuffer (not the Node Buffer) so the body satisfies both the
    // undici and DOM Response typings across every checkJs context.
    const body = /** @type {ArrayBuffer} */ (
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    );
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(real),
        'Content-Security-Policy': csp,
      },
    });
  } catch {
    return refusal(403, 'forbidden');
  }
}

/**
 * @typedef {object} MainSchemePrivileges
 * @property {true} standard
 * @property {true} secure
 */

/**
 * @typedef {object} MainServeSummary
 * @property {string} scheme Served scheme.
 * @property {string} root Canonical admitted bundle root.
 */

const privilegedProtocols = new WeakSet();

/**
 * Register the privileged bundled scheme on an injected protocol
 * handle. Main must call this before app ready; the exact privilege
 * record is `{standard: true, secure: true}` with no `bypassCSP` and
 * no other key.
 * @param {unknown} protocol Alleged protocol with registerSchemesAsPrivileged.
 * @returns {Readonly<{scheme: string, privileges: MainSchemePrivileges}>} Frozen registration summary.
 */
export function registerPrivilegedScheme(protocol) {
  const rec = assertHandleObject(protocol, 'protocol');
  if (typeof rec.registerSchemesAsPrivileged !== 'function') {
    fail('HANDLE', 'protocol must provide registerSchemesAsPrivileged');
  }
  const typed = /** @type {{ registerSchemesAsPrivileged: (specs: Array<{scheme: string, privileges: MainSchemePrivileges}>) => unknown }} */ (
    /** @type {unknown} */ (rec)
  );
  if (!privilegedProtocols.has(rec)) {
    typed.registerSchemesAsPrivileged([
      { scheme: PRIVILEGED_SCHEME, privileges: { standard: true, secure: true } },
    ]);
    privilegedProtocols.add(rec);
  }
  return Object.freeze({
    scheme: PRIVILEGED_SCHEME,
    privileges: Object.freeze({ standard: /** @type {true} */ (true), secure: /** @type {true} */ (true) }),
  });
}

/**
 * Serve the admitted bundle root on the `app` scheme through an
 * injected protocol handle (`protocol.handle('app', ...)`). The
 * handler serves only real files under the root and sets the CSP
 * header on every response.
 * @param {unknown} protocol Alleged protocol with handle.
 * @param {unknown} root Alleged absolute bundle-root directory.
 * @param {{styleNonce?: boolean, beforeOpen?: () => void}} [options] Main-owned style policy.
 * @returns {MainServeSummary} Frozen serving summary with the canonical root.
 */
export function serveBundled(protocol, root, options) {
  const rec = assertHandleObject(protocol, 'protocol');
  if (typeof rec.handle !== 'function') {
    fail('HANDLE', 'protocol must provide handle');
  }
  const canonicalRoot = canonicalizeRoot(root);
  const nonceEnabled = typeof options === 'object' && options !== null && !Array.isArray(options)
    ? /** @type {{styleNonce?: unknown}} */ (options).styleNonce === true
    : false;
  const typed = /** @type {{ handle: (scheme: string, handler: (request: Request) => Promise<Response>) => unknown }} */ (
    /** @type {unknown} */ (rec)
  );
  typed.handle(
    PRIVILEGED_SCHEME,
    /**
     * @param {Request} request Fetch-API request delivered by Electron.
     * @returns {Promise<Response>} File or refusal, always with the CSP header.
     */
    (request) => handleAppRequest(canonicalRoot, request, { styleNonce: nonceEnabled }),
  );
  return Object.freeze({ scheme: PRIVILEGED_SCHEME, root: canonicalRoot });
}

/**
 * Trusted host runtime context: the XDG runtime dir and caller uid the
 * trusted entry observed. Never read from the child environment.
 * @typedef {object} RuntimeContext
 * @property {string} xdgRuntimeDir Absolute XDG runtime directory.
 * @property {number} uid Caller uid owning the runtime tree.
 */

/**
 * Resolved main paths: canonical bundle root, verified preload entry,
 * Electron userData and the owner-only runtime directory.
 * @typedef {object} MainPaths
 * @property {string} rendererRoot Canonical bundle root.
 * @property {string} preloadPath Verified preload entry.
 * @property {string} userData Electron userData directory.
 * @property {string} runtimeDir Owner-only `$XDG_RUNTIME_DIR/metaviewer/`.
 */

/**
 * Resolve the canonical bundle root, verify the preload entry is a
 * regular file (never a symlink), and admit or create the owner-only
 * runtime directory (mode 0700, caller-owned, never a symlink). The
 * core creates its own sockets inside; main only owns the directory.
 * @param {unknown} app Alleged app with getAppPath/getPath.
 * @param {unknown} shellRoot Alleged shell root fallback.
 * @param {unknown} runtime Alleged trusted runtime context.
 * @returns {MainPaths} Frozen resolved paths.
 */
export function resolveMainPaths(app, shellRoot, runtime) {
  if (app === null || typeof app !== 'object' || Array.isArray(app)) {
    fail('PATHS_APP', 'app must be an object');
  }
  const arec = /** @type {Record<string, unknown>} */ (app);
  if (typeof arec.getAppPath !== 'function' || typeof arec.getPath !== 'function') {
    fail('PATHS_APP', 'app must provide getAppPath and getPath');
  }
  if (
    typeof shellRoot !== 'string' || shellRoot.length < 1 || shellRoot.length > APP_MAX_ROOT_CHARS ||
    shellRoot.includes(String.fromCharCode(0)) || !isAbsolute(shellRoot)
  ) {
    fail('PATHS_ROOT', 'shellRoot must be a bounded absolute path');
  }
  if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) {
    fail('PATHS_RUNTIME', 'runtime must be a context object');
  }
  const rrec = /** @type {Record<string, unknown>} */ (runtime);
  const xdgRuntimeDir = rrec.xdgRuntimeDir;
  const uid = rrec.uid;
  if (
    typeof xdgRuntimeDir !== 'string' || xdgRuntimeDir.length < 1 || xdgRuntimeDir.length > APP_MAX_ROOT_CHARS ||
    xdgRuntimeDir.includes(String.fromCharCode(0)) || !isAbsolute(xdgRuntimeDir)
  ) {
    fail('PATHS_RUNTIME', 'xdgRuntimeDir must be a bounded absolute path');
  }
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) {
    fail('PATHS_RUNTIME', 'uid must be a safe integer at or above zero');
  }
  const appHandle = /** @type {{getAppPath: () => unknown, getPath: (name: string) => unknown}} */ (/** @type {unknown} */ (arec));
  /** @type {unknown} */
  let appPath = null;
  try {
    appPath = appHandle.getAppPath();
  } catch {
    fail('PATHS_APP', 'getAppPath refused');
  }
  const root = typeof appPath === 'string' && appPath.length > 0 ? appPath : shellRoot;
  /** @type {string} */
  let rendererRoot;
  try {
    rendererRoot = canonicalizeRoot(resolve(root, 'dist', 'renderer'));
  } catch {
    fail('PATHS_BUNDLE', 'renderer bundle root is not admitted');
    throw new MainError('PATHS_BUNDLE', 'unreachable');
  }
  let preloadPath = join(root, 'dist', 'preload', 'preload.cjs');
  const preloadStat = lstatOrNull(preloadPath);
  if (preloadStat === null || !preloadStat.isFile() || preloadStat.isSymbolicLink()) {
    fail('PRELOAD_ABSENT', 'preload entry is not a regular file');
  }
  const canonicalPreload = realpathSync(preloadPath);
  const preloadRel = relative(rendererRoot, canonicalPreload);
  if (preloadRel === '' || (preloadRel !== '..' && !preloadRel.startsWith(`..${sep}`))) {
    fail('PRELOAD_CONTAINMENT', 'preload overlaps renderer root');
  }
  // Reject aliases anywhere beneath the canonical app root.
  const canonicalApp = realpathSync(root);
  let parent = canonicalApp;
  for (const part of ['dist', 'preload', 'preload.cjs']) {
    parent = join(parent, part);
    if (lstatOrNull(parent)?.isSymbolicLink()) fail('PRELOAD_CONTAINMENT', 'preload parent alias');
  }
  preloadPath = canonicalPreload;
  /** @type {unknown} */
  let userData = null;
  try {
    userData = appHandle.getPath('userData');
  } catch {
    fail('PATHS_USERDATA', 'userData path refused');
  }
  if (typeof userData !== 'string' || userData.length < 1 || userData.length > APP_MAX_ROOT_CHARS) {
    fail('PATHS_USERDATA', 'userData path is not admitted');
  }
  const xdgStat = lstatOrNull(xdgRuntimeDir);
  if (
    xdgStat === null || !xdgStat.isDirectory() || xdgStat.isSymbolicLink() ||
    xdgStat.uid !== uid || (xdgStat.mode & 0o777 & 0o077) !== 0
  ) {
    fail('RUNTIME_XDG', 'XDG runtime dir is missing, unsafe or foreign-owned');
  }
  const runtimeDir = join(xdgRuntimeDir, 'metaviewer');
  let dirStat = lstatOrNull(runtimeDir);
  if (dirStat === null) {
    try {
      mkdirSync(runtimeDir, { mode: 0o700, recursive: false });
    } catch {
      /* re-stat below; a racing creator still has to pass admission */
    }
    dirStat = lstatOrNull(runtimeDir);
  }
  if (
    dirStat === null || !dirStat.isDirectory() || dirStat.isSymbolicLink() ||
    dirStat.uid !== uid || (dirStat.mode & 0o777) !== 0o700
  ) {
    fail('RUNTIME_DIR', 'runtime dir is not an owner-only caller-owned directory');
  }
  return Object.freeze({ rendererRoot, preloadPath, userData, runtimeDir });
}

/**
 * @typedef {{ok: true, nested: boolean} | {ok: false, code: string}} RetailVerdict
 */

/**
 * Judge the trusted application argument vector and environment. Total:
 * malformed inputs refuse, never throw. Forbidden flags match on the
 * token before '='; `--nested-depth=1` selects display-only mode while
 * deeper or malformed nesting refuses; any other dash-led switch is
 * unknown except the documented runtime pass-throughs; unsafe
 * ELECTRON/loader/debug environment names refuse.
 * @param {unknown} argv Alleged application argument vector.
 * @param {unknown} env Alleged environment record.
 * @returns {RetailVerdict} Frozen verdict.
 */
export function validateRetailLaunch(argv, env) {
  /**
   * @param {string} code Refusal code.
   * @returns {RetailVerdict} Frozen refusal.
   */
  const refuse = (code) => Object.freeze({ ok: /** @type {false} */ (false), code });
  if (!Array.isArray(argv) || argv.length > MAX_ARGV_ITEMS) {
    return refuse('ARGV_SHAPE');
  }
  for (const item of argv) {
    if (typeof item !== 'string' || item.length > MAX_ARGV_CHARS || item.includes(String.fromCharCode(0))) {
      return refuse('ARGV_SHAPE');
    }
  }
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return refuse('ENV_SHAPE');
  }
  for (const item of /** @type {Array<string>} */ (argv)) {
    const token = item.split('=', 1)[0];
    if (FORBIDDEN_ARGV_FLAGS.includes(/** @type {string} */ (token))) {
      return refuse('RETAIL_FLAG');
    }
  }
  if (findForbiddenEnv(env).length > 0) {
    return refuse('RETAIL_ENV');
  }
  let nested = 0;
  for (const item of /** @type {Array<string>} */ (argv)) {
    if (item === '--') {
      continue;
    }
    if (item === '--nested-depth=1') {
      nested += 1;
      continue;
    }
    if (item.startsWith('--nested-depth')) {
      return refuse('NESTED_DEPTH');
    }
    if (item.startsWith('-') && item.length > 1) {
      const token = item.split('=', 1)[0];
      if (!KNOWN_RUNTIME_SWITCHES.includes(/** @type {string} */ (token))) {
        return refuse('UNKNOWN_SWITCH');
      }
    }
  }
  if (nested > 1) {
    return refuse('NESTED_DEPTH');
  }
  return Object.freeze({ ok: /** @type {true} */ (true), nested: nested === 1 });
}

/**
 * Build the exact frozen flip config packaging applies to the binary
 * (version V1, one boolean per wire index, strict drift guard on).
 * Values derive from the sole table above, so the table stays the
 * single source of truth.
 * @returns {Readonly<Record<string, boolean | string>>} Frozen flip config.
 */
export function buildFuseConfig() {
  const config = /** @type {Record<string, boolean | string>} */ ({ version: FUSE_VERSION });
  for (const row of FUSE_TABLE) {
    config[String(row.index)] = row.expect;
  }
  config.strictlyRequireAllFuses = true;
  return Object.freeze(config);
}

/**
 * One closed bridge entry: fixed channel, closed decoder, forwarding
 * invoke. The registry stays private; Rust remains the authority.
 * @typedef {object} BridgeEntry
 * @property {string} channel Fixed preload channel literal.
 * @property {(raw: unknown) => unknown} decode Closed payload decoder.
 * @property {(decoded: unknown) => Promise<unknown>} invoke Forwarding call.
 */

/**
 * Measure UTF-8 bytes of a string payload.
 * @param {string} value Payload.
 * @returns {number} Byte length.
 */
function utf8Length(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Decode the load payload: load accepts no payload.
 * @param {unknown} raw Alleged payload.
 * @returns {null} Always null.
 */
function decodeLayoutLoad(raw) {
  if (raw !== undefined) {
    fail('LAYOUT_BOUNDS', 'load accepts no payload');
  }
  return null;
}

/**
 * Decode the save payload: one bounded validated JSON string.
 * @param {unknown} raw Alleged payload.
 * @returns {string} Validated JSON text.
 */
function decodeLayoutSave(raw) {
  if (typeof raw !== 'string' || utf8Length(raw) > LAYOUT_MAX_BYTES) {
    fail('LAYOUT_BOUNDS', 'save payload is not a bounded string');
  }
  try {
    JSON.parse(raw);
  } catch {
    fail('LAYOUT_BOUNDS', 'save payload is not valid JSON');
  }
  return raw;
}

/**
 * [TARGET, unit decision] Host-local presentation storage uses the shipped kit's
 * closed layout decoder and fixed product scope. No core authority is persisted.
 * An unconfigured bridge remains closed for capability-free callers.
 * @param {{directory?:string,app?:BootAppHandle}} [options]
 * @returns {ReadonlyArray<BridgeEntry>} Fixed layout registry.
 */
export function createLayoutBridge({directory,app} = {}) {
  const absent = () => { throw new MainError('LAYOUT_CONTRACT_ABSENT', 'layout storage unavailable'); };
  const invalid = () => { throw new MainError('LAYOUT_CONTRACT_INVALID', 'layout contract refused'); };
  /** @param {unknown} raw */
  const validate = async (raw) => {
    if (typeof raw !== 'string' || utf8Length(raw) > LAYOUT_MAX_BYTES) return invalid();
    const { decodeAndMigrateLayoutProfile } = await import('../.kit/capsule-ui-kit/src/workspace/layoutProfile.js');
    let value;
    try { value = JSON.parse(raw); } catch { return invalid(); }
    const result = decodeAndMigrateLayoutProfile(value, { expectedScope: {
      product:'metaviewer', profileId:'default', workspaceId:'main-wall',
    } });
    if (!result.ok) return invalid();
    return raw;
  };
  const location = () => {
    if (directory === undefined && app) directory = join(String(app.getPath('userData')), 'presentation');
    if (!directory || !isAbsolute(directory)) return absent();
    mkdirSync(directory, {recursive:true,mode:0o700});
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) return invalid();
    return join(directory,'layout.json');
  };
  return Object.freeze([
    Object.freeze({ channel: CHANNELS.load, decode: decodeLayoutLoad, invoke: async () => {
      const path = location();
      let fd;
      try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
      catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
        throw error;
      }
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > LAYOUT_MAX_BYTES || info.uid !== process.getuid?.() || (info.mode & 0o022)) return invalid();
        const bytes = Buffer.alloc(LAYOUT_MAX_BYTES + 1);
        const size = readSync(fd, bytes, 0, bytes.length, 0);
        if (size > LAYOUT_MAX_BYTES) return invalid();
        return await validate(new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(0,size)));
      } finally { closeSync(fd); }
    } }),
    Object.freeze({ channel: CHANNELS.save, decode: decodeLayoutSave, invoke: async (/** @type {unknown} */ raw) => {
      const path = location();
      const value = await validate(raw);
      const fs = await import('node:fs/promises');
      const temp = path + '.' + randomBytes(16).toString('hex');
      try {
        const file = await fs.open(temp,'wx',0o600);
        try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
        await fs.rename(temp,path);
        return true;
      } finally { await fs.rm(temp,{force:true}); }
    } }),
  ]);
}

/**
 * @typedef {import('./coreLauncher.js').CoreLauncher} CoreLauncher
 */

/**
 * Minimal structural surfaces. Real Electron handles satisfy them.
 * @typedef {object} BootAppHandle
 * @property {() => unknown} requestSingleInstanceLock
 * @property {() => Promise<unknown>} whenReady
 * @property {(name: string, handler: (...args: Array<any>) => void) => void} on
 * @property {() => void} quit
 * @property {() => unknown} getAppPath
 * @property {(name: string) => unknown} getPath
 */

/**
 * @typedef {object} BootContentsHandle
 * @property {(url: string) => Promise<unknown>} loadURL
 */

/**
 * @typedef {object} BootWindowHandle
 * @property {unknown} webContents
 * @property {(name: string, handler: (...args: Array<any>) => void) => void} once
 * @property {() => void} show
 * @property {() => void} destroy
 */

/**
 * @typedef {new (opts: MainWindowOptions) => BootWindowHandle} BootWindowConstructor
 */

/**
 * @typedef {object} BootIpcHandle
 * @property {(channel: string, listener: (event: unknown, ...args: Array<unknown>) => unknown) => void} handle
 */

/**
 * @typedef {object} BootProtocolHandle
 * @property {(specs: Array<{scheme: string, privileges: MainSchemePrivileges}>) => void} registerSchemesAsPrivileged
 * @property {(scheme: string, handler: (request: Request) => Promise<Response>) => void} handle
 */

/**
 * Exact boot handles. The trusted entry supplies every field.
 * @typedef {object} MainHandles
 * @property {unknown} app Narrow Electron app handle.
 * @property {unknown} BrowserWindow Window constructor.
 * @property {unknown} ipcMain Narrow ipcMain handle.
 * @property {unknown} protocol Narrow protocol handle.
 * @property {unknown} session Narrow session handle.
 * @property {string} electronVersion Running Electron version.
 * @property {string} shellRoot Shell root fallback.
 * @property {ReadonlyArray<string>} argv Application argument vector.
 * @property {Readonly<Record<string, string | undefined>>} env Environment record.
 * @property {RuntimeContext} runtime Trusted runtime context.
 * @property {CoreLauncher} core Constructed core launcher.
 * @property {ReadonlyArray<BridgeEntry>} bridge Parity-gated IPC registry.
 * @property {{width: number, height: number}} geometry Window geometry.
 * @property {any} [wire] Trusted frame and PTY capabilities, never renderer values.
 */

/**
 * @typedef {object} MainBoot
 * @property {BootWindowHandle} window Booted window.
 * @property {CoreLauncher} core Core launcher.
 * @property {() => Promise<void>} dispose Idempotent teardown.
 */

/**
 * @type {ReadonlyArray<string>}
 */
const HANDLE_KEYS = Object.freeze([
  'app', 'BrowserWindow', 'ipcMain', 'protocol', 'session', 'electronVersion',
  'shellRoot', 'argv', 'env', 'runtime', 'core', 'bridge', 'geometry',
]);

/**
 * Validate the injected bridge carries exactly the mirrored channel
 * literals with closed decoders and forwarding invokes.
 * @param {unknown} bridge Alleged bridge registry.
 * @returns {ReadonlyArray<BridgeEntry>} Validated registry.
 */
function admitBridge(bridge) {
  if (!Array.isArray(bridge) || bridge.length !== 2) {
    fail('BRIDGE_PARITY', 'bridge must carry exactly the two layout entries');
  }
  /** @type {Array<BridgeEntry>} */
  const admitted = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const entry of bridge) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('BRIDGE_PARITY', 'bridge entries must be objects');
    }
    const rec = /** @type {Record<string, unknown>} */ (entry);
    const keys = Object.keys(rec);
    if (keys.length !== 3 || !Object.hasOwn(rec, 'channel') || !Object.hasOwn(rec, 'decode') || !Object.hasOwn(rec, 'invoke')) {
      fail('BRIDGE_PARITY', 'bridge entries must be exactly {channel,decode,invoke}');
    }
    if ((rec.channel !== CHANNELS.load && rec.channel !== CHANNELS.save) || seen.has(/** @type {string} */ (rec.channel))) {
      fail('BRIDGE_PARITY', 'bridge channels must mirror the fixed literals once each');
    }
    if (typeof rec.decode !== 'function' || typeof rec.invoke !== 'function') {
      fail('BRIDGE_PARITY', 'bridge decode and invoke must be functions');
    }
    seen.add(/** @type {string} */ (rec.channel));
    admitted.push(/** @type {BridgeEntry} */ (/** @type {unknown} */ (rec)));
  }
  return Object.freeze(admitted);
}

/**
 * Harden the default session (or the session itself) with deny
 * permission handlers. The window session is hardened separately by
 * the window policy.
 * @param {unknown} session Alleged session handle.
 * @returns {void}
 */
function hardenSession(session) {
  if (session === null || typeof session !== 'object' || Array.isArray(session)) {
    fail('BOOT_SESSION', 'session must be an object');
  }
  const rec = /** @type {Record<string, unknown>} */ (session);
  const target = rec.defaultSession !== undefined && rec.defaultSession !== null &&
      typeof rec.defaultSession === 'object' && !Array.isArray(rec.defaultSession)
    ? /** @type {Record<string, unknown>} */ (rec.defaultSession)
    : rec;
  if (typeof target.setPermissionRequestHandler !== 'function' || typeof target.setPermissionCheckHandler !== 'function') {
    fail('BOOT_SESSION', 'session must provide permission handlers');
  }
  /** @type {(handler: Function) => unknown} */ (target.setPermissionRequestHandler).call(
    target,
    /**
     * @param {unknown} _webContents Requesting contents, ignored.
     * @param {string} _permission Candidate permission, ignored.
     * @param {(granted: boolean) => void} callback Grant callback.
     * @returns {void}
     */
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
  /** @type {(handler: Function) => unknown} */ (target.setPermissionCheckHandler).call(target, () => false);
}

/**
 * Boot the production main on injected handles. The acquisition ledger
 * unwinds the owned prefix on every failure: handlers removed, window
 * destroyed, scheme unhandled, core disposed. Nested display-only mode
 * never starts the core and publishes no receivers.
 * @param {MainHandles} handles Exact trusted boot handles.
 * @returns {Promise<MainBoot>} Frozen boot record.
 */
export async function bootProductionMain(handles) {
  if (handles === null || typeof handles !== 'object' || Array.isArray(handles)) {
    fail('BOOT_HANDLES', 'handles must be an object');
  }
  const typed = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (handles));
  const ownKeys = Object.keys(typed).filter(key => key !== 'wire');
  if (ownKeys.length !== HANDLE_KEYS.length) {
    fail('BOOT_HANDLES', 'handles must carry exactly the boot keys');
  }
  for (const key of HANDLE_KEYS) {
    if (!Object.hasOwn(typed, key)) {
      fail('BOOT_HANDLES', 'handles must carry exactly the boot keys');
    }
  }
  const appRec = assertHandleObject(typed.app, 'app');
  if (
    typeof appRec.requestSingleInstanceLock !== 'function' || typeof appRec.whenReady !== 'function' ||
    typeof appRec.on !== 'function' || typeof appRec.quit !== 'function'
  ) {
    fail('BOOT_HANDLES', 'app must provide lock, ready, on and quit');
  }
  const app = /** @type {BootAppHandle} */ (/** @type {unknown} */ (appRec));
  if (typeof typed.BrowserWindow !== 'function') {
    fail('BOOT_HANDLES', 'BrowserWindow must be a constructor');
  }
  const WindowCtor = /** @type {BootWindowConstructor} */ (typed.BrowserWindow);
  const ipcRec = assertHandleObject(typed.ipcMain, 'ipcMain');
  if (typeof ipcRec.handle !== 'function') {
    fail('BOOT_HANDLES', 'ipcMain must provide handle');
  }
  const ipcMain = /** @type {BootIpcHandle} */ (/** @type {unknown} */ (ipcRec));
  const protocolRec = assertHandleObject(typed.protocol, 'protocol');
  if (typeof protocolRec.registerSchemesAsPrivileged !== 'function' || typeof protocolRec.handle !== 'function') {
    fail('BOOT_HANDLES', 'protocol must provide scheme registration and handle');
  }
  const protocol = /** @type {BootProtocolHandle} */ (/** @type {unknown} */ (protocolRec));
  const coreRec = assertHandleObject(typed.core, 'core');
  if (
    typeof coreRec.start !== 'function' || typeof coreRec.request !== 'function' ||
    typeof coreRec.dispose !== 'function' || typeof coreRec.getStatus !== 'function'
  ) {
    fail('BOOT_CORE', 'core must provide start, request, dispose and getStatus');
  }
  const core = /** @type {CoreLauncher} */ (/** @type {unknown} */ (coreRec));
  if (typed.session === null || typeof typed.session !== 'object' || Array.isArray(typed.session)) {
    fail('BOOT_HANDLES', 'session must be an object');
  }
  if (typed.geometry === null || typeof typed.geometry !== 'object' || Array.isArray(typed.geometry)) {
    fail('BOOT_HANDLES', 'geometry must be an object');
  }

  const retail = validateRetailLaunch(typed.argv, typed.env);
  if (!retail.ok) {
    fail(retail.code, 'retail launch refused');
  }
  if (typed.electronVersion !== ELECTRON_PIN) {
    fail('ELECTRON_PIN', `electron version must be ${ELECTRON_PIN}`);
  }
  /** @type {unknown} */
  let locked = false;
  try {
    locked = app.requestSingleInstanceLock();
  } catch {
    locked = false;
  }
  if (locked !== true) {
    try {
      app.quit();
    } catch {
      /* quit best-effort */
    }
    fail('SINGLE_INSTANCE', 'another instance holds the lock');
  }

  /** @type {BootWindowHandle | null} */
  let window = null;
  /** @type {Array<string>} */
  const registered = [];
  let wireBridge = /** @type {{dispose:()=>Promise<void>} | null} */(null);
  let captureBridge = /** @type {{dispose:()=>Promise<void>} | null} */(null);
  let schemeRegistered = false;
  let unwound = false;

  /**
   * Release the owned acquisition prefix in reverse order. Never throws.
   * @returns {Promise<void>}
   */
  const unwind = async () => {
    if (unwound) {
      return;
    }
    unwound = true;
    const remove = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (ipcRec)).removeHandler;
    for (let index = registered.length - 1; index >= 0; index -= 1) {
      try {
        if (typeof remove === 'function') {
          /** @type {(channel: string) => void} */ (remove).call(ipcRec, /** @type {string} */ (registered[index]));
        }
      } catch {
        /* unwind best-effort */
      }
    }
    await captureBridge?.dispose();
    await wireBridge?.dispose();
    registered.length = 0;
    if (window !== null) {
      try {
        window.destroy();
      } catch {
        /* unwind best-effort */
      }
      window = null;
    }
    if (schemeRegistered) {
      schemeRegistered = false;
      const unhandle = protocolRec.unhandle;
      try {
        if (typeof unhandle === 'function') {
          /** @type {(scheme: string) => void} */ (unhandle).call(protocolRec, PRIVILEGED_SCHEME);
        }
      } catch {
        /* unwind best-effort */
      }
    }
    try {
      await core.dispose();
    } catch {
      /* core dispose never rejects; guard foreign handles anyway */
    }
  };

  try {
    registerPrivilegedScheme(protocol);
  } catch (error) {
    if (error instanceof MainError) {
      throw error;
    }
    fail('PROTOCOL', 'privileged scheme registration refused');
  }
  schemeRegistered = true;
  try {
    await app.whenReady();
  } catch {
    await unwind();
    fail('READY', 'app readiness refused');
  }
  /** @type {MainPaths} */
  let paths;
  try {
    paths = resolveMainPaths(typed.app, typed.shellRoot, typed.runtime);
  } catch (error) {
    await unwind();
    throw error;
  }
  try {
    serveBundled(protocol, paths.rendererRoot, { styleNonce: true });
  } catch {
    await unwind();
    fail('PROTOCOL', 'bundle serving refused');
  }
  /** @type {ReadonlyArray<BridgeEntry>} */
  let bridge;
  try {
    bridge = admitBridge(typed.bridge);
  } catch (error) {
    await unwind();
    throw error;
  }
  /** @type {MainWindowOptions} */
  let windowOptions;
  try {
    const geometry = /** @type {Record<string, unknown>} */ (typed.geometry);
    windowOptions = createWindowOptions({
      width: geometry.width,
      height: geometry.height,
      preloadPath: paths.preloadPath,
    });

  } catch (error) {
    await unwind();
    throw error;
  }
  // Refused core readiness must leave zero windows allocated.
  try {
    hardenSession(typed.session);
  } catch (error) {
    await unwind();
    throw error;
  }
  if (!retail.nested) {
    /** @type {import('./coreLauncher.js').CoreStatus | null} */
    let coreStatus = null;
    try {
      coreStatus = await core.start();
    } catch {
      coreStatus = null;
    }
    if (coreStatus === null || coreStatus.availability !== 'live') {
      await unwind();
      fail('CORE_UNAVAILABLE', 'core did not reach live');
    }
  }
  try {
    window = new WindowCtor(windowOptions);
  } catch {
    await unwind();
    fail('WINDOW', 'window construction refused');
    throw new MainError('WINDOW', 'unreachable');
  }
  const built = /** @type {BootWindowHandle} */ (window);
  /** @type {unknown} */
  let contentsUnknown = null;
  try {
    const winRec = /** @type {{webContents?: unknown}} */ (/** @type {unknown} */ (built));
    const contentsRec = assertHandleObject(winRec.webContents, 'win.webContents');
    attachWindowPolicy(built, contentsRec.session);
    // [TARGET, unit decision] Convey the admitted nested-depth signal through
    // the native document user agent before preload runs, without host globals.
    if (retail.nested && typeof contentsRec.setUserAgent === 'function') {
      contentsRec.setUserAgent('MetaViewer --nested-depth=1');
    }
    contentsUnknown = winRec.webContents;
  } catch (error) {
    await unwind();
    throw error;
  }
  if (!retail.nested) {
    const contents = contentsUnknown;
    for (const entry of bridge) {
      const channel = entry.channel;
      /**
       * @param {unknown} event Invoke event.
       * @param {...unknown} args Positional payload vector.
       * @returns {Promise<unknown>} Forwarded answer.
       */
      const listener = async (event, ...args) => {
        const verdict = observeSender(event, contents, PRIVILEGED_ORIGIN);
        if (verdict.verdict !== 'admit') {
          throw new MainError(verdict.code, 'sender refused');
        }
        if (args.length !== (channel === CHANNELS.load ? 0 : 1)) {
          throw new MainError('LAYOUT_BOUNDS', 'invalid positional argument count');
        }
        const raw = args[0];
        if (channel === CHANNELS.load) {
          decodeLayoutLoad(raw);
        } else {
          decodeLayoutSave(raw);
        }
        const decoded = await entry.decode(raw);
        return entry.invoke(decoded);
      };
      try {
        ipcMain.handle(channel, listener);
      } catch {
        await unwind();
        fail('IPC', `receiver for ${channel} refused`);
      }
      registered.push(channel);
    }
  }
  try {
    if (!retail.nested) captureBridge = (await import('./captureBridge.js')).installCaptureBridge({ipcMain, contents:contentsUnknown, core, nested:retail.nested});
    if (!retail.nested) wireBridge = (await import('./authorityWire.js')).installAuthorityWire({ ...(typed.wire || {}), ipcMain,
      contents: contentsUnknown, core, env: typed.env, argv: typed.argv });
  } catch (error) { await unwind(); throw error; }
  try {
    built.once('ready-to-show', () => {
      try {
        built.show();
      } catch {
        /* show best-effort; the window may be gone */
      }
    });
  } catch {
    await unwind();
    fail('LIFECYCLE', 'ready-to-show wiring refused');
  }
  const contentsHandle = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (contentsUnknown));
  if (contentsUnknown === null || typeof contentsHandle.loadURL !== 'function') {
    await unwind();
    fail('LOAD', 'contents cannot load the bundle URL');
  }
  try {
    await /** @type {(url: string) => Promise<unknown>} */ (contentsHandle.loadURL).call(
      contentsHandle,
      `${PRIVILEGED_ORIGIN}/index.html`,
    );
  } catch {
    await unwind();
    fail('LOAD', 'bundle URL load refused');
  }
  let quitting = false;
  try {
    app.on('will-quit', (event) => {
      if (quitting) {
        return;
      }
      quitting = true;
      try {
        /** @type {{preventDefault: () => void}} */ (/** @type {unknown} */ (event)).preventDefault();
      } catch {
        /* prevent best-effort */
      }
      void dispose().finally(() => {
        try {
          app.quit();
        } catch {
          /* quit best-effort */
        }
      });
    });
    app.on('window-all-closed', () => {
      try {
        app.quit();
      } catch {
        /* quit best-effort */
      }
    });
  } catch {
    await unwind();
    fail('LIFECYCLE', 'lifecycle wiring refused');
  }

  let disposed = false;
  /**
   * Idempotent boot teardown: close the window, unserve the scheme,
   * dispose the core. Never rejects.
   * @returns {Promise<void>}
   */
  async function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    await unwind();
  }

  return Object.freeze({ window: built, core, dispose });
}

/** Resolve and validate host capabilities before constructing any window.
 * @param {NodeJS.ProcessEnv} [env] @param {any} [options] */
export async function loadMainBindings(env = process.env, options = {}) {
  try {
    const bootstrap = env.MV_CORE_BOOTSTRAP;
    if (bootstrap !== undefined && (!bootstrap || !isAbsolute(bootstrap))) throw new Error();
    const host = await import(bootstrap === undefined ? './hostBindings.js' : (await import('node:url')).pathToFileURL(bootstrap).href);
    if (typeof host.createMainBindings !== 'function') throw new Error();
    const bindings = await host.createMainBindings({...options,env});
    if (!bindings?.core || ['start','request','dispose','getStatus'].some(name => typeof bindings.core[name] !== 'function')
        || typeof bindings.wire?.frames?.subscribe !== 'function') {
      await bindings?.core?.dispose?.();throw new Error();
    }
    return bindings;
  } catch {throw new MainError('CORE_SEAMS_ABSENT','trusted host bindings unavailable');}
}

/** Direct Electron entry: use the shipped host or an absolute trusted override.
 * Plain Node imports remain inert. @returns {Promise<void>} */
async function mainDirectEntry() {
  /** @type {Record<string, unknown>} */
  let electron = {};
  try {
    electron = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (createRequire(import.meta.url)('electron')));
  } catch {
    process.exitCode = 1;
    return;
  }
  const app = /** @type {{exit: (code: number) => void} | null} */ (
    electron.app !== null && typeof electron.app === 'object' ? /** @type {{exit: (code: number) => void}} */ (/** @type {unknown} */ (electron.app)) : null
  );
  /**
   * @param {unknown} error Failure.
   * @returns {void}
   */
  const failClosed = (error) => {
    try {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
    } catch {
      /* diagnostics best-effort */
    }
    try {
      if (app !== null && typeof app.exit === 'function') {
        app.exit(1);
        return;
      }
    } catch {
      /* fall through to the exit code */
    }
    process.exitCode = 1;
  };
  try {
    const argv = Array.isArray(process.argv) ? process.argv.slice(1) : [];
    const retail = validateRetailLaunch(argv, process.env);
    if (!retail.ok) {
      throw new MainError(retail.code, 'retail launch refused');
    }
    const running = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (process.versions)).electron;
    if (running !== ELECTRON_PIN) {
      throw new MainError('ELECTRON_PIN', `electron version must be ${ELECTRON_PIN}`);
    }
    // [TARGET, unit decision] This direct-entry call runs during module
    // evaluation: privileges must precede every await, including host bootstrap.
    // bootProductionMain reuses the same protocol registration exactly once.
    try { registerPrivilegedScheme(electron.protocol); }
    catch (error) {
      if (error instanceof MainError) throw error;
      throw new MainError('PROTOCOL', 'privileged scheme registration refused');
    }
    const bindings = await loadMainBindings();
    await bootProductionMain({ core:bindings.core, wire:bindings.wire, electronVersion: running,
      app: electron.app, BrowserWindow: electron.BrowserWindow, ipcMain: electron.ipcMain,
      protocol: electron.protocol, session: electron.session, argv, env: process.env,
      shellRoot: fileURLToPath(new URL('..',import.meta.url)),
      runtime: {xdgRuntimeDir:process.env.XDG_RUNTIME_DIR || '',uid:process.getuid ? process.getuid() : -1},
      geometry: DEFAULT_GEOMETRY, bridge:createLayoutBridge({app:/** @type {BootAppHandle} */ (electron.app)}) });
    console.log('METAVIEWER_MAIN_READY');
  } catch (error) {
    failClosed(error);
  }
}

if (typeof process !== 'undefined' && process.versions?.electron !== undefined
    && process.argv[1] && [fileURLToPath(import.meta.url), resolve(fileURLToPath(new URL('..',import.meta.url)))].includes(resolve(process.argv[1]))) {
  void mainDirectEntry();
}
