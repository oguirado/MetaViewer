import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWindowOptions, CONTENT_SECURITY_POLICY, attachWindowPolicy } from '../electron/main.js';

for (const [pin, expected] of Object.entries({
  contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
})) {
  test(`BrowserWindow pins ${pin}=${expected}; inverted pin fails`, () => {
    const prefs = createWindowOptions({ width: 800, height: 600, preloadPath: '/preload.cjs' }).webPreferences;
    const verify = (value) => assert.equal(value[pin], expected);
    verify(prefs);
    assert.throws(() => verify({ ...prefs, [pin]: !expected }), assert.AssertionError);
  });
}

test('installed setWindowOpenHandler denies every destination', () => {
  let open;
  attachWindowPolicy({ webContents: { on() {}, setWindowOpenHandler(handler) { open = handler; } } },
    { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} });
  assert.equal(typeof open, 'function');
  for (const url of ['app://metaviewer/index.html', 'https://example.invalid', 'javascript:alert(1)']) {
    assert.deepEqual(open({ url }), { action: 'deny' });
  }
});

test('HTML CSP equals the restrictive main policy', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.equal(csp, CONTENT_SECURITY_POLICY);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
  for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "object-src 'none'"]) {
    assert.ok(csp.includes(directive));
  }
});
