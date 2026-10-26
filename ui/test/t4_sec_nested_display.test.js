import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enterNested, installReadOnlyLayout } from '../electron/nesting.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';

test('enterNested refuses when depth!=1 or unsafe env with zero display calls', async () => {
  let displayCalls = 0;
  const dummyDisplay = async () => {
    displayCalls += 1;
    return 'display_result';
  };

  // Positive witness: valid depth=1 and clean env calls display
  displayCalls = 0;
  const res = await enterNested(['node', 'app.js', '--nested-depth=1'], {}, dummyDisplay);
  assert.equal(res, 'display_result');
  assert.equal(displayCalls, 1);

  // Negative control 1: depth != 1 (--nested-depth=2)
  displayCalls = 0;
  await assert.rejects(
    () => enterNested(['node', 'app.js', '--nested-depth=2'], {}, dummyDisplay),
    /NESTED_DEPTH/
  );
  assert.equal(displayCalls, 0, 'Zero display calls when depth!=1');

  // Negative control 2: no --nested-depth=1 argument
  displayCalls = 0;
  await assert.rejects(
    () => enterNested(['node', 'app.js'], {}, dummyDisplay),
    /NESTED_DEPTH/
  );
  assert.equal(displayCalls, 0, 'Zero display calls when nested flag missing');

  // Negative control 3: unsafe env (e.g. NODE_OPTIONS)
  displayCalls = 0;
  await assert.rejects(
    () => enterNested(['node', 'app.js', '--nested-depth=1'], { NODE_OPTIONS: '--require=evil' }, dummyDisplay),
    /RETAIL_ENV/
  );
  assert.equal(displayCalls, 0, 'Zero display calls on unsafe environment');
});

test('installReadOnlyLayout load/save/subframe refusal guarantees', async () => {
  const handlers = new Map();
  const mockIpcMain = {
    handle: (channel, fn) => {
      handlers.set(channel, fn);
    },
  };

  const topFrame = {
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    detached: false,
  };

  const mockContents = {
    id: 1,
    isDestroyed: () => false,
    mainFrame: topFrame,
  };

  installReadOnlyLayout(mockIpcMain, mockContents);

  const loadHandler = handlers.get('metaviewer:layout.load');
  const saveHandler = handlers.get('metaviewer:layout.save');

  assert.equal(typeof loadHandler, 'function');
  assert.equal(typeof saveHandler, 'function');

  // 1. Load with valid top-frame sender and no args returns null
  const validEvent = { sender: mockContents, senderFrame: topFrame };
  const loadRes = loadHandler(validEvent);
  assert.equal(loadRes, null);

  // 2. Load with any arg refuses
  assert.throws(
    () => loadHandler(validEvent, 'extraArg'),
    /DISPLAY_ONLY: layout sender refused/
  );

  // 3. Subframe-identity load refuses
  const subFrame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const subFrameEvent = { sender: mockContents, senderFrame: subFrame };
  assert.throws(
    () => loadHandler(subFrameEvent),
    /DISPLAY_ONLY: layout sender refused/
  );

  // 4. Save always refuses regardless of sender/args
  assert.throws(
    () => saveHandler(validEvent),
    /DISPLAY_ONLY: layout persistence is disabled/
  );
});
