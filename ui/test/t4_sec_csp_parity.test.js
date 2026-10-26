import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONTENT_SECURITY_POLICY, buildCsp, handleAppRequest } from '../electron/main.js';

test('CSP parity: served headers, build meta, nonce extension, and directive restrictions', async () => {
  // 1. Verify CONTENT_SECURITY_POLICY constant restrictions
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval|https?:|\*/);

  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    assert.ok(CONTENT_SECURITY_POLICY.includes(directive), `CSP must include ${directive}`);
  }

  // 2. Style nonce extends ONLY style-src
  const testNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'; // 32 base64 chars
  const noncedCsp = buildCsp(testNonce);
  assert.ok(noncedCsp.includes(`style-src 'self' 'nonce-${testNonce}'`));
  // Script src, default src etc. remain unchanged without nonce
  assert.ok(noncedCsp.includes("script-src 'self'"));
  assert.ok(noncedCsp.includes("default-src 'none'"));
  assert.doesNotMatch(noncedCsp, /script-src[^;]*nonce-/);

  // 3. Static ui/index.html meta equals the CONTENT_SECURITY_POLICY constant
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const cspMetaMatch = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(cspMetaMatch, 'ui/index.html must contain a CSP meta tag');
  assert.equal(cspMetaMatch[1], CONTENT_SECURITY_POLICY, 'ui/index.html CSP meta content must equal CONTENT_SECURITY_POLICY constant');

  // 4. Served header equals CONTENT_SECURITY_POLICY for non-HTML, refusals and 404s
  const tmpDir = mkdtempSync(join(tmpdir(), 'mv-csp-test-'));
  writeFileSync(join(tmpDir, 'script.js'), 'console.log("hi");');
  writeFileSync(join(tmpDir, 'style.css'), 'body { color: red; }');

  try {
    // Non-HTML files must have exact CONTENT_SECURITY_POLICY
    const jsRes = await handleAppRequest(tmpDir, { url: 'app://metaviewer/script.js' }, { styleNonce: true });
    assert.equal(jsRes.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);

    const cssRes = await handleAppRequest(tmpDir, { url: 'app://metaviewer/style.css' }, { styleNonce: true });
    assert.equal(cssRes.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);

    // Refusal (403) must have exact CONTENT_SECURITY_POLICY
    const refRes = await handleAppRequest(tmpDir, { url: 'app://metaviewer/%2e%2e/script.js' }, { styleNonce: true });
    assert.equal(refRes.status, 403);
    assert.equal(refRes.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);

    // 404 must have exact CONTENT_SECURITY_POLICY
    const missingRes = await handleAppRequest(tmpDir, { url: 'app://metaviewer/missing.js' }, { styleNonce: true });
    assert.equal(missingRes.status, 404);
    assert.equal(missingRes.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
