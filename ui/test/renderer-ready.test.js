import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRendererReadyGate, PRIVILEGED_ORIGIN } from '../electron/main.js';

test('renderer readiness requires a successful index, finish and authenticated private preload ping', () => {
  for (const order of [[0,1,2], [2,1,0], [1,0,2]]) {
    const frame = { url: `${PRIVILEGED_ORIGIN}/index.html`, origin: PRIVILEGED_ORIGIN };
    const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
    const event = { sender: contents, senderFrame: frame };
    let ready = 0;
    const gate = createRendererReadyGate(contents, () => ready++);
    assert.throws(() => gate.ping({ ...event, sender: { ...contents } }), /RENDERER_READY/);
    assert.throws(() => gate.ping({ ...event, senderFrame: { ...frame } }), /RENDERER_READY/);
    assert.throws(() => gate.ping(event, 'forged'), /RENDERER_READY/);
    const steps = [() => gate.response(200), () => gate.finish(), () => gate.ping(event)];
    steps[order[0]](); steps[order[1]]();
    assert.equal(ready, 0);
    steps[order[2]]();
    assert.equal(ready, 1);
    gate.finish(); gate.ping(event); gate.response(200);
    assert.equal(ready, 1);
  }
});

test('MUT-RENDERER-FORBIDDEN: a finished 403 document and preload ping never prove readiness', () => {
  const frame = { url: `${PRIVILEGED_ORIGIN}/index.html`, origin: PRIVILEGED_ORIGIN };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
  let ready = 0;
  const gate = createRendererReadyGate(contents, () => ready++);
  gate.response(403); gate.finish(); gate.ping({ sender: contents, senderFrame: frame });
  assert.equal(ready, 0);
  frame.url = `${PRIVILEGED_ORIGIN}/other.html`;
  assert.throws(() => gate.ping({ sender: contents, senderFrame: frame }), /RENDERER_READY/);
  gate.response(200);
  assert.equal(ready, 0);
});
