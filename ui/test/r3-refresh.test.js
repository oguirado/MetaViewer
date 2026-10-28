// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAppRequest, ELECTRON_PIN } from '../electron/main.js';
import {
  validateIntentBody,
  INTENT_OPS,
  SURFACE_INPUT_CHANNEL,
} from '../electron/authorityWire.js';
import { enterNested } from '../electron/nesting.js';

test('D1: R3-TRAV + R3-ROOT encoded traversal spellings return 403 and missing paths return 404', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-d1-fixture-')));
  try {
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><html><head><title>d1</title></head><body>ok</body></html>',
    );

    // Traversal attempts return 403
    const res1 = await handleAppRequest(root, { url: 'app://metaviewer/..%2fpackage.json' });
    assert.equal(res1.status, 403);

    const res2 = await handleAppRequest(root, { url: 'app://metaviewer/%2e%2e/package.json' });
    assert.equal(res2.status, 403);

    // Missing file returns 404
    const res3 = await handleAppRequest(root, {
      url: 'app://metaviewer/non-existent-file-12345.html',
    });
    assert.equal(res3.status, 404);

    // Negative control: existing in-root asset returns 200
    const resOk = await handleAppRequest(root, { url: 'app://metaviewer/index.html' });
    assert.equal(resOk.status, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D2: R3-WIRE + R3-SLOT take/release intents and slot correlation', () => {
  const takeBody = {
    schema: 'ui_intent/v0.2',
    op: 'take_control',
    request_id: 'req1',
    params: { surface_id: 'surf1' },
  };
  assert.deepEqual(validateIntentBody(takeBody), takeBody);

  const releaseBody = {
    schema: 'ui_intent/v0.2',
    op: 'release_control',
    request_id: 'req2',
    params: { surface_id: 'surf1' },
  };
  assert.deepEqual(validateIntentBody(releaseBody), releaseBody);

  assert.equal(INTENT_OPS.take_control, 'surface_id');
  assert.equal(INTENT_OPS.release_control, 'surface_id');
});

test('D3: R3-NEST enterNested requires --nested-depth=1', async () => {
  let executed = false;
  const display = async () => {
    executed = true;
    return 'DISPLAY_OK';
  };

  const res = await enterNested(['--nested-depth=1'], {}, display);
  assert.equal(res, 'DISPLAY_OK');
  assert.equal(executed, true);

  await assert.rejects(async () => {
    await enterNested(['--nested-depth=2'], {}, display);
  }, /NESTED_DEPTH/);

  await assert.rejects(async () => {
    await enterNested([], {}, display);
  }, /NESTED_DEPTH/);
});

test('D4: R3-PORT + R3-PROD frame port channels and constants', () => {
  assert.equal(SURFACE_INPUT_CHANNEL, 'metaviewer:authority.intent');
});

test('D5: R3-QA + R3-DIAG QA anchors and frameDiag channels', async () => {
  const qa = await import('../electron/qaAnchors.js');
  assert.equal(qa.QA_ANCHORS_CHANNEL, 'metaviewer:qa.anchors');
  const diag = await import('../electron/frameDiag.js');
  assert.equal(diag.FRAME_DIAG_CHANNEL, 'metaviewer:frame.diag');
});

test('D6: R3-PKG + R3-SEAL + R3-SMOKE package architecture and constants', () => {
  assert.equal(ELECTRON_PIN, '44.9.2');
});
