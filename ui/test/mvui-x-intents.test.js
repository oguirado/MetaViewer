import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildAuthorityIntent } from '../src/core/intents.js';
import { createAuthorityAdapter, createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { validates, intentSchema } from './mvui-x-schema.js';

const examples = new URL('../../contracts/examples/v0.2/', import.meta.url);
test('schema oracle accepts the valid example and rejects every invalid ui_intent example', () => {
  const read = name => JSON.parse(readFileSync(new URL(name, examples), 'utf8'));
  assert.equal(validates(intentSchema, read('ui_intent.valid.json')), true);
  const invalid = readdirSync(examples).filter(name => /^ui_intent\.invalid.*\.json$/.test(name));
  assert.ok(invalid.length > 0);
  for (const name of invalid) assert.equal(validates(intentSchema, read(name)), false, name);
});

test('all authority builder ops and boundary values validate against the schema itself', async () => {
  const sent = [], adapter = createAuthorityAdapter({ intent: async text => { sent.push(JSON.parse(text)); return true; } });
  const ids = new Set();
  for (const branch of intentSchema.oneOf) {
    const op = branch.properties.op.const;
    for (const upper of [false, true]) {
      const params = Object.fromEntries(Object.entries(branch.properties.params.properties).map(([key, rule]) => [key,
        rule.type === 'boolean' ? upper : rule.type === 'integer' ? upper ? rule.maximum : rule.minimum : upper ? 'A'.repeat(rule.maxLength) : 'a']));
      const body = buildAuthorityIntent({ op, params });
      assert.equal(validates(intentSchema, body), true, op);
      await adapter.intent(body);
      await adapter.intent(body);
      for (const emitted of sent.splice(0)) {
        assert.equal(validates(intentSchema, emitted), true, op);
        assert.deepEqual(emitted.params, params);
        assert.equal(ids.has(emitted.request_id), false);
        ids.add(emitted.request_id);
      }
      for (const key of branch.properties.params.required) {
        const missing = { ...params }; delete missing[key];
        await assert.rejects(adapter.intent({ op, params: missing }));
      }
      await assert.rejects(adapter.intent({ op, params: { ...params, extra: true } }));
    }
  }
  await assert.rejects(adapter.intent({ op: 'destroy', params: {} }));
  await assert.rejects(adapter.intent({ op: 'fold', surfaceId: 'surface-a' }));
  for (const surfaceId of ['', ' ', ':1', 'a/b', 'a'.repeat(129), null, 2]) {
    await assert.rejects(adapter.intent({ op: 'take_control', surfaceId }));
  }
});

test('live tile control builders emit ui_intent bodies for both control verbs', async () => {
  const runtime = createAuthorityRuntime({ subscribeFrames: () => () => {} });
  const sent = [], adapter = createAuthorityAdapter({ intent: async text => { sent.push(JSON.parse(text)); return true; } });
  try {
    for (const verb of ['take_control', 'release_control']) {
      const body = runtime.intentBuilders.control({ capsuleId: 'surface-demo', verb });
      assert.equal(validates(intentSchema, body), true);
      await adapter.intent(body);
      assert.equal(sent.at(-1).op, verb);
      assert.deepEqual(sent.at(-1).params, { surface_id: 'surface-demo' });
    }
    for (const verb of ['fold', 'unfold', 'pin']) {
      const local = runtime.intentBuilders.visibility({ capsuleId: 'surface-demo', verb, ...(verb === 'pin' ? { pinned: true } : {}) });
      await assert.rejects(adapter.intent(local));
    }
  } finally { runtime.dispose(); }
});

test('tile control handlers flow through App dispatch and the host adapter as schema-valid bodies', async () => {
  const panel = readFileSync(new URL('../src/wall/SurfacePanel.vue', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
  const handler = panel.match(/function onControlRequest\(payload\) \{([\s\S]*?)\n\}/)?.[1];
  const dispatcher = app.match(/function dispatch\(intent\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(handler); assert.ok(dispatcher);
  const { controlVerbForRow } = await import('../src/wall/tileStates.js');
  const bodies = [], pending = [], local = [];
  const adapter = createAuthorityAdapter({ intent: async text => { bodies.push(JSON.parse(text)); return true; } });
  const dispatch = new Function('nestedMode', 'props', 'emit', 'submitHost', 'intent', dispatcher)
    .bind(null, { displayOnly: false }, { authorityHost: adapter }, (...args) => local.push(args), action => { pending.push(action()); });
  const runtime = createAuthorityRuntime({ subscribeFrames: () => () => {} });
  try {
    for (const verb of ['take_control', 'release_control']) {
      const phase = { value: 'idle' };
      new Function('row', 'controlVerbForRow', 'uiPhase', 'emit', 'props', 'payload', handler)(
        { value: { control: 'human' } }, controlVerbForRow, phase,
        (event, body) => { assert.equal(event, 'submit-intent'); dispatch(body); },
        { capsuleId: 'surface-demo', intentBuilders: runtime.intentBuilders }, { verb });
      await Promise.all(pending.splice(0));
      assert.equal(bodies.at(-1).op, verb);
      assert.equal(validates(intentSchema, bodies.at(-1)), true);
      assert.deepEqual(bodies.at(-1).params, { surface_id: 'surface-demo' });
      // Legacy bare controls are refused; the tile path still sends the full body.
      const sentBefore = bodies.length;
      dispatch({ type: verb, capsuleId: 'surface-demo' });
      await Promise.all(pending.splice(0));
      assert.equal(bodies.length, sentBefore, 'bare controls cannot reach authority.intent');
      assert.equal(validates(intentSchema, bodies.at(-1)), true);
      assert.equal(bodies.at(-1).op, verb);
    }
    assert.equal(new Set(bodies.map(body => body.request_id)).size, bodies.length);
    for (const op of ['fold', 'unfold', 'pin']) dispatch({ op, surfaceId: 'surface-demo' });
    assert.equal(local.length, 5);
    assert.equal(bodies.length, 2);
  } finally { runtime.dispose(); }
});
