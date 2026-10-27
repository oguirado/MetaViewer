// Lane V activity model: typed receipts, closed copy, stable anchors.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MV_ACTIVITY_EMPTY_TEXT,
  MV_ACTIVITY_LIMIT,
  MV_ACTIVITY_TONES,
  MV_ACTIVITY_TYPES,
  mvActivityListAccessibleName,
  mvActivityListAnchor,
  mvActivityListDomId,
  mvActivityRowAnchor,
  mvActivityRowDomId,
  mvActivityStripAccessibleName,
  mvActivityStripAnchor,
  mvActivityStripDomId,
  mvActivityToggleAnchor,
  mvActivityToggleDomId,
  normalizeActivityEntry,
} from '../src/activity/activityModel.js';

const ANCHOR = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const DOM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/** Visible text carries human sentences, never raw codes. */
function assertHumanText(text) {
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, 'row text is non-empty');
  assert.doesNotMatch(text, /[A-Z]{2,}_[A-Z_]+/, `no raw code in text: ${text}`);
  assert.doesNotMatch(text, /ERR_[A-Z_]+/, `no error literal in text: ${text}`);
}

describe('activity receipt normalization', () => {
  test('intent ack and admitted verdict map to success rows', () => {
    assert.deepEqual(normalizeActivityEntry({ seq: 1, code: 'INTENT_ACKNOWLEDGED' }),
      { seq: 1, type: 'intent-ack', tone: 'success', text: 'Request sent.' });
    assert.deepEqual(normalizeActivityEntry({ seq: 2, code: 'ACTION_ADMITTED' }),
      { seq: 2, type: 'verdict-admitted', tone: 'success', text: 'Action admitted.' });
  });

  test('every known refusal code maps to a typed refusal row', () => {
    const expected = {
      STALE_FRAME: 'The surface changed. Try again.',
      SURFACE_NOT_AGENT_CONTROLLED: 'Take control before proposing this action.',
      LOCKED_BY_OTHER: 'Another operator controls this surface.',
      BUDGET_EXCEEDED: 'The action exceeds the available budget.',
      OUT_OF_BOUNDS: 'The action is outside the surface.',
      POLICY: 'This action is unavailable under the current policy.',
      HOST_REQUEST_REFUSED: 'This request is unavailable. Please try again.',
    };
    for (const [code, text] of Object.entries(expected)) {
      const entry = normalizeActivityEntry({ seq: 4, code });
      assert.equal(entry?.text, text, code);
      assert.equal(entry?.tone, 'refusal', code);
      assert.equal(entry?.type, code === 'HOST_REQUEST_REFUSED' ? 'request-refused' : 'verdict-refused', code);
      assertHumanText(entry?.text ?? '');
    }
  });

  test('unknown or missing codes fail closed to the generic refusal', () => {
    for (const code of ['NOPE', '', 'action_verdict/v0.2', null, 7, undefined]) {
      const entry = normalizeActivityEntry({ seq: 1, code });
      assert.deepEqual(entry,
        { seq: 1, type: 'request-refused', tone: 'refusal', text: 'This request is unavailable. Please try again.' },
        String(code));
    }
  });

  test('malformed input is dropped, never rendered', () => {
    for (const bad of [null, undefined, 7, 'x', [], { seq: 0, code: 'ACTION_ADMITTED' },
      { seq: -1, code: 'ACTION_ADMITTED' }, { seq: 1.5, code: 'ACTION_ADMITTED' },
      { seq: '1', code: 'ACTION_ADMITTED' }, { code: 'ACTION_ADMITTED' }]) {
      assert.equal(normalizeActivityEntry(bad), null, JSON.stringify(bad));
    }
  });

  test('entries are frozen and types stay closed', () => {
    const entry = normalizeActivityEntry({ seq: 1, code: 'ACTION_ADMITTED' });
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual([...MV_ACTIVITY_TYPES],
      ['intent-ack', 'verdict-admitted', 'verdict-refused', 'request-refused']);
    assert.deepEqual([...MV_ACTIVITY_TONES], ['success', 'refusal']);
    assert.equal(MV_ACTIVITY_LIMIT, 8);
  });

  test('negative control: raw codes and malformed rows fail their predicates', () => {
    assertHumanText('Request sent.');
    for (const planted of ['STALE_FRAME refusal', 'ERR_EXPORT deno', 'ACTION_ADMITTED ok']) {
      assert.throws(() => assertHumanText(planted), assert.AssertionError, planted);
    }
    assert.equal(normalizeActivityEntry({ seq: 1, code: 'ACTION_ADMITTED' })?.type, 'verdict-admitted');
    assert.equal(normalizeActivityEntry({ seq: 0, code: 'ACTION_ADMITTED' }), null);
  });
});

describe('activity anchors and names', () => {
  test('strip, toggle and list anchors are kebab-case and deterministic', () => {
    assert.equal(mvActivityStripDomId(), 'mv-activity-strip');
    assert.equal(mvActivityStripAnchor(), 'activity/strip');
    assert.equal(mvActivityToggleDomId(), 'mv-activity-toggle');
    assert.equal(mvActivityToggleAnchor(), 'activity/toggle');
    assert.equal(mvActivityListDomId(), 'mv-activity-list');
    assert.equal(mvActivityListAnchor(), 'activity/list');
    for (const anchor of [mvActivityStripAnchor(), mvActivityToggleAnchor(), mvActivityListAnchor()]) {
      assert.match(anchor, ANCHOR, anchor);
    }
    for (const id of [mvActivityStripDomId(), mvActivityToggleDomId(), mvActivityListDomId()]) {
      assert.match(id, DOM_ID, id);
    }
  });

  test('row anchors derive deterministically from the feed sequence', () => {
    assert.equal(mvActivityRowDomId(3), 'mv-activity-row-3');
    assert.equal(mvActivityRowAnchor(3), 'activity/row-3');
    assert.match(mvActivityRowAnchor(3), ANCHOR);
    assert.match(mvActivityRowDomId(3), DOM_ID);
    for (const seq of [1, 2, 7, 8, 64]) {
      assert.notEqual(mvActivityRowDomId(seq), mvActivityRowDomId(seq + 1), `unique row id ${seq}`);
    }
    for (const bad of [0, -2, 1.5, 'x', null, undefined]) {
      assert.equal(mvActivityRowDomId(bad), 'mv-activity-row-0', String(bad));
      assert.equal(mvActivityRowAnchor(bad), 'activity/row-0', String(bad));
    }
  });

  test('accessible names are stable human labels without codes', () => {
    assert.equal(mvActivityStripAccessibleName(), 'Authority activity');
    assert.equal(mvActivityListAccessibleName(3), 'Latest authority outcomes, 3 shown');
    assert.equal(mvActivityListAccessibleName(-1), 'Latest authority outcomes, 0 shown');
    assertHumanText(mvActivityStripAccessibleName());
    assertHumanText(mvActivityListAccessibleName(2));
    assert.doesNotMatch(MV_ACTIVITY_EMPTY_TEXT, /placeholder|cannot|ERR_/i);
  });

  test('negative control: volatile or uncased anchors fail', () => {
    assert.match('activity/row-3', ANCHOR);
    for (const bad of ['Activity/Row', 'activity/row 3', 'activity', 'activity/row-{{ seq }}', 'wall/add capsule']) {
      assert.throws(() => assert.match(bad, ANCHOR), assert.AssertionError, bad);
    }
  });
});
