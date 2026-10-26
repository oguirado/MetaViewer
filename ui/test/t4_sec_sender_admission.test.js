import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeSender, PRIVILEGED_ORIGIN } from '../electron/main.js';

function createValidSender(overrides = {}) {
  const mainFrame = {
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    detached: false,
    ...overrides.mainFrame,
  };

  const sender = {
    id: 1,
    isDestroyed: () => false,
    mainFrame,
    ...overrides.sender,
  };

  const senderFrame = overrides.senderFrame !== undefined ? overrides.senderFrame : mainFrame;

  const event = {
    sender,
    senderFrame,
    ...overrides.event,
  };

  return { event, expectedContents: sender };
}

test('observeSender positive witness admits valid top-frame sender', () => {
  const { event, expectedContents } = createValidSender();
  const verdict = observeSender(event, expectedContents, PRIVILEGED_ORIGIN);
  assert.equal(verdict.verdict, 'admit');
  assert.equal(verdict.sender.senderId, 1);
  assert.equal(verdict.sender.frameOrigin, PRIVILEGED_ORIGIN);
  assert.equal(verdict.sender.frameUrl, `${PRIVILEGED_ORIGIN}/index.html`);
});

test('observeSender sender admission matrix negative controls', () => {
  const { event: validEvent, expectedContents: validContents } = createValidSender();

  // 1. Subframe object with identical origin+url but different identity
  const subframe = {
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    detached: false,
  };
  const subframeEvent = { ...validEvent, senderFrame: subframe };
  assert.deepEqual(
    observeSender(subframeEvent, validContents, PRIVILEGED_ORIGIN),
    Object.freeze({ verdict: 'refuse', code: 'SUBFRAME' })
  );

  // 2. Detached frame
  const detachedFrame = {
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    detached: true,
  };
  const detachedSender = { ...validContents, mainFrame: detachedFrame };
  const detachedEvent = { sender: detachedSender, senderFrame: detachedFrame };
  assert.deepEqual(
    observeSender(detachedEvent, detachedSender, PRIVILEGED_ORIGIN),
    Object.freeze({ verdict: 'refuse', code: 'FRAME_DETACHED' })
  );

  // 3. Destroyed sender
  const destroyedSender = { ...validContents, isDestroyed: () => true };
  const destroyedEvent = { sender: destroyedSender, senderFrame: destroyedSender.mainFrame };
  assert.deepEqual(
    observeSender(destroyedEvent, destroyedSender, PRIVILEGED_ORIGIN),
    Object.freeze({ verdict: 'refuse', code: 'SENDER' })
  );

  // 4. senderFrame null / non-object
  for (const badFrame of [null, undefined, 'not-an-object', 123]) {
    const badFrameEvent = { ...validEvent, senderFrame: badFrame };
    assert.deepEqual(
      observeSender(badFrameEvent, validContents, PRIVILEGED_ORIGIN),
      Object.freeze({ verdict: 'refuse', code: 'FRAME_NULL' })
    );
  }

  // 5. Origin mismatch
  const foreignOriginFrame = {
    origin: 'https://attacker.example',
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    detached: false,
  };
  const foreignOriginSender = { ...validContents, mainFrame: foreignOriginFrame };
  const foreignOriginEvent = { sender: foreignOriginSender, senderFrame: foreignOriginFrame };
  assert.deepEqual(
    observeSender(foreignOriginEvent, foreignOriginSender, PRIVILEGED_ORIGIN),
    Object.freeze({ verdict: 'refuse', code: 'FRAME_ORIGIN' })
  );

  // 6. URL outside privileged origin
  const foreignUrlFrame = {
    origin: PRIVILEGED_ORIGIN,
    url: 'https://attacker.example/index.html',
    detached: false,
  };
  const foreignUrlSender = { ...validContents, mainFrame: foreignUrlFrame };
  const foreignUrlEvent = { sender: foreignUrlSender, senderFrame: foreignUrlFrame };
  assert.deepEqual(
    observeSender(foreignUrlEvent, foreignUrlSender, PRIVILEGED_ORIGIN),
    Object.freeze({ verdict: 'refuse', code: 'FRAME_URL' })
  );

  // 7. Invalid sender ID (0, negative, non-integer, missing)
  for (const badId of [0, -1, 1.5, undefined, null, '1']) {
    const badIdSender = { ...validContents, id: badId };
    const badIdEvent = { sender: badIdSender, senderFrame: badIdSender.mainFrame };
    assert.deepEqual(
      observeSender(badIdEvent, badIdSender, PRIVILEGED_ORIGIN),
      Object.freeze({ verdict: 'refuse', code: 'SENDER' })
    );
  }

  // 8. Foreign sender object (sender !== expectedContents)
  const otherSender = { ...validContents, id: 2 };
  assert.deepEqual(
    observeSender(validEvent, otherSender, PRIVILEGED_ORIGIN),
    Object.freeze({ verdict: 'refuse', code: 'SENDER' })
  );
});
