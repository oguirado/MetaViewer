import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { handleAppRequest, CONTENT_SECURITY_POLICY } from '../electron/main.js';

function createFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mv-sec-test-'));

  // Normal index.html
  writeFileSync(join(dir, 'index.html'), '<html><head><title>MetaViewer</title></head><body>OK</body></html>');

  // Subdir with index.html
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'index.html'), '<html><head></head><body>Sub</body></html>');

  // Subdir without index.html
  mkdirSync(join(dir, 'empty_dir'));

  // HTML without head tag
  writeFileSync(join(dir, 'nohead.html'), '<html><body>No Head</body></html>');

  // Oversized file (> 8MiB)
  const over8MB = Buffer.alloc(8 * 1024 * 1024 + 1, 'a');
  writeFileSync(join(dir, 'large.bin'), over8MB);

  // Symlink file inside root
  writeFileSync(join(dir, 'real.txt'), 'real content');
  symlinkSync(join(dir, 'real.txt'), join(dir, 'symlink.txt'));

  // Symlink escaping root
  const outsideDir = mkdtempSync(join(tmpdir(), 'mv-sec-outside-'));
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
  symlinkSync(join(outsideDir, 'secret.txt'), join(dir, 'escape_symlink.txt'));

  // FIFO named pipe (if mkfifo is available on Linux/macOS)
  let fifoPath = null;
  try {
    fifoPath = join(dir, 'test_fifo');
    execSync(`mkfifo "${fifoPath}"`);
  } catch {
    fifoPath = null;
  }

  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  };

  return { dir, outsideDir, fifoPath, cleanup };
}

test('handleAppRequest protocol traversal battery', async () => {
  const fixture = createFixtureDir();

  try {
    const checkRequest = async (url, expectedStatus, options) => {
      const res = await handleAppRequest(fixture.dir, { url }, options);
      assert.equal(res.status, expectedStatus, `URL ${url} expected status ${expectedStatus}`);

      const csp = res.headers.get('Content-Security-Policy');
      assert.ok(csp, `URL ${url} must include Content-Security-Policy header`);

      if (expectedStatus === 403 || expectedStatus === 404) {
        // Refusals and 404s must carry the exact base CSP header
        assert.equal(csp, CONTENT_SECURITY_POLICY, `URL ${url} refusal CSP must match base CONTENT_SECURITY_POLICY`);
      }
      return res;
    };

    // Positive witness
    const posRes = await checkRequest('app://metaviewer/index.html', 200);
    const posText = await posRes.text();
    assert.ok(posText.includes('MetaViewer'));

    // 1. %2e%2e
    await checkRequest('app://metaviewer/%2e%2e/index.html', 403);
    await checkRequest('app://metaviewer/sub/%2e%2e/%2e%2e/index.html', 403);

    // 2. %252e%252e
    // %252e%252e decodes to literal segment "%2e%2e".
    // When no file/dir named "%2e%2e" exists, handleAppRequest returns 404 carrying base CSP.
    await checkRequest('app://metaviewer/%252e%252e/index.html', 404);

    // 3. Backslash \ in URL
    await checkRequest('app://metaviewer/sub\\index.html', 403);

    // 4. NUL byte \0 in URL
    await checkRequest('app://metaviewer/index.html\0', 403);
    await checkRequest('app://metaviewer/index.html%00', 403);

    // 5. ?/# smuggling
    await checkRequest('app://metaviewer/../index.html?smuggle=1', 403);
    await checkRequest('app://metaviewer/../index.html#smuggle', 403);
    // Valid query on valid file should work (200)
    await checkRequest('app://metaviewer/index.html?valid=1#hash', 200);

    // 6. Uppercase host
    await checkRequest('app://METAVIEWER/index.html', 403);
    await checkRequest('app://MetaViewer/index.html', 403);

    // 7. Credentials / port in URL
    await checkRequest('app://user:pass@metaviewer/index.html', 403);
    await checkRequest('app://metaviewer:8080/index.html', 403);

    // 8. Wrong scheme
    await checkRequest('http://metaviewer/index.html', 403);
    await checkRequest('https://metaviewer/index.html', 403);
    await checkRequest('file:///etc/passwd', 403);

    // 9. Dir without index.html
    await checkRequest('app://metaviewer/empty_dir', 404);
    await checkRequest('app://metaviewer/nonexistent.html', 404);

    // 10. Symlink file
    await checkRequest('app://metaviewer/symlink.txt', 403);

    // 11. Symlink dir escape
    await checkRequest('app://metaviewer/escape_symlink.txt', 403);

    // 12. FIFO / special device file
    if (fixture.fifoPath) {
      await checkRequest('app://metaviewer/test_fifo', 403);
    }

    // 13. Over-8MiB file
    await checkRequest('app://metaviewer/large.bin', 403);

    // 14. HTML without <head> under styleNonce: true
    await checkRequest('app://metaviewer/nohead.html', 403, { styleNonce: true });

    // 15. Nonce uniqueness across two HTML responses
    const res1 = await checkRequest('app://metaviewer/index.html', 200, { styleNonce: true });
    const text1 = await res1.text();
    const csp1 = res1.headers.get('Content-Security-Policy');

    const res2 = await checkRequest('app://metaviewer/index.html', 200, { styleNonce: true });
    const text2 = await res2.text();
    const csp2 = res2.headers.get('Content-Security-Policy');

    const nonceMatch1 = csp1.match(/'nonce-([A-Za-z0-9+/]{32})'/);
    const nonceMatch2 = csp2.match(/'nonce-([A-Za-z0-9+/]{32})'/);

    assert.ok(nonceMatch1, 'CSP 1 must carry a valid nonce');
    assert.ok(nonceMatch2, 'CSP 2 must carry a valid nonce');
    assert.notEqual(nonceMatch1[1], nonceMatch2[1], 'Nonces must be unique across requests');

    assert.ok(text1.includes(`content="${nonceMatch1[1]}"`), 'HTML 1 must include nonce meta tag');
    assert.ok(text2.includes(`content="${nonceMatch2[1]}"`), 'HTML 2 must include nonce meta tag');

    // 16. 2049-char URL
    const longPath = 'a'.repeat(2040);
    const url2049 = `app://metaviewer/${longPath}`;
    assert.ok(url2049.length >= 2049);
    await checkRequest(url2049, 403);
  } finally {
    fixture.cleanup();
  }
});
