// Lane V anchors: every interactive control keeps id, anchor and name.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ANCHOR = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

const strip = readFileSync(new URL('../src/activity/ActivityStrip.vue', import.meta.url), 'utf8');
const stripTemplate = strip.slice(strip.indexOf('<template>'));
const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');

/** agent_lane/v1 predicate: stable id, deterministic anchor, accessible name.
 * A bound anchor (`:data-semantic-anchor="ident"`) must be a plain const
 * identifier; a literal anchor must be kebab-case. */
function assertAnchoredControl(tag, label) {
  assert.match(tag, /(:id|id)="[^"]+"/, `${label}: stable id`);
  const bound = tag.match(/:data-semantic-anchor="([A-Za-z_$][\w$]*)"/);
  const literal = tag.match(/(?<!:)data-semantic-anchor="([^"]+)"/);
  assert.ok(bound ?? literal, `${label}: data-semantic-anchor`);
  if (literal) assert.match(literal[1], ANCHOR, `${label}: kebab-case anchor ${literal[1]}`);
  assert.ok(tag.includes('label=') || tag.includes('aria-label=') || tag.includes(':aria-label='),
    `${label}: accessible name`);
}

describe('lane V anchors', () => {
  test('strip toggle, section and outcomes list are anchored and named', () => {
    const toggle = stripTemplate.match(/<UiButton\b[^>]*\/>/s)?.[0];
    assert.ok(toggle, 'toggle located');
    assertAnchoredControl(toggle, 'activity toggle');
    assert.ok(toggle.includes('label="Activity"'), 'toggle keeps its human label');
    const section = stripTemplate.match(/<section\b[^>]*>/s)?.[0];
    assert.ok(section, 'strip section located');
    assertAnchoredControl(section, 'activity strip');
    const list = stripTemplate.match(/<ol\b[^>]*>/s)?.[0];
    assert.ok(list, 'outcomes list located');
    assertAnchoredControl(list, 'activity list');
  });

  test('activity rows keep deterministic per-sequence anchors', () => {
    const row = stripTemplate.match(/<li\b[^>]*v-for="entry in rows"[^>]*>/s)?.[0];
    assert.ok(row, 'row template located');
    assert.match(row, /:id="mvActivityRowDomId\(entry\.seq\)"/, 'row id derives from the feed sequence');
    assert.match(row, /:data-semantic-anchor="mvActivityRowAnchor\(entry\.seq\)"/, 'row anchor derives from the feed sequence');
  });

  test('bench hook adds no interactive controls', () => {
    const block = app.slice(app.indexOf('const benchHook'), app.indexOf('delete benchWindow.__metaviewerBench'));
    assert.ok(block.includes('__metaviewerBench'), 'hook block located');
    assert.doesNotMatch(block, /<[A-Za-z][^>]*>/, 'hook is script-only: no new tags, no new controls');
  });

  test('negative control: missing anchor, id or name fails', () => {
    assertAnchoredControl('<UiButton :id="toggleId" :data-semantic-anchor="toggleAnchor" label="Activity" />', 'planted ok');
    assertAnchoredControl('<ol id="mv-activity-list" data-semantic-anchor="activity/list" tabindex="0" aria-label="Authority outcomes">', 'planted ok');
    for (const bad of [
      '<UiButton label="Activity" />',
      '<UiButton :id="toggleId" label="Activity" />',
      '<UiButton :id="toggleId" :data-semantic-anchor="toggleAnchor" />',
      '<ol :id="listId" tabindex="0" :aria-label="listName">',
      '<ol :id="listId" :data-semantic-anchor="Activity/List" tabindex="0" :aria-label="listName">',
    ]) {
      assert.throws(() => assertAnchoredControl(bad, 'planted'), assert.AssertionError, bad);
    }
  });
});
