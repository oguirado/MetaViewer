// Lane U1 agent_lane/v1: every lane control carries id, anchor and a name.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const EMPTY_URL = new URL('../src/wall/EmptyWallView.vue', import.meta.url);
const PANEL_URL = new URL('../src/wall/SurfacePanel.vue', import.meta.url);

/** Extract raw opening tags for interactive elements from a template. */
function interactiveTags(template) {
  const tags = [];
  for (const pattern of [/<button\b[^>]*>/g, /<UiButton\b[^>]*>/gs, /<input\b[^>]*>/g,
    /<select\b[^>]*>/g, /<a\b[^>]*>/g]) {
    tags.push(...(template.match(pattern) ?? []));
  }
  return tags;
}

/** Fail-closed control predicate: stable id, kebab-case anchor, named label. */
function assertAnchoredControl(tag) {
  assert.match(tag, /\bid="[^"]+"/, `control keeps a stable id: ${tag}`);
  const anchor = tag.match(/\bdata-semantic-anchor="([^"]+)"/);
  assert.ok(anchor, `control keeps a data-semantic-anchor: ${tag}`);
  assert.match(anchor[1], /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/,
    `anchor is kebab-case and deterministic: ${anchor[1]}`);
  const hasSlotName = />[^<]+<\//.test(tag);
  assert.ok(tag.includes('label=') || tag.includes('aria-label=') || hasSlotName,
    `control keeps an accessible name: ${tag}`);
  assert.doesNotMatch(tag, /\b(id|data-semantic-anchor)="\s*[^"]*\{\{/, `no template id: ${tag}`);
}

describe('lane control anchors', () => {
  test('empty-wall action is anchored, stable and named', () => {
    const source = readFileSync(EMPTY_URL, 'utf8');
    const template = source.slice(source.indexOf('<template>'));
    const tags = interactiveTags(template);
    assert.equal(tags.length, 1, 'exactly one lane control in the empty view');
    assertAnchoredControl(tags[0]);
    assert.ok(tags[0].includes('id="empty-wall-add"'), 'wall add id survives the kit swap');
    assert.ok(tags[0].includes('data-semantic-anchor="wall/add-capsule"'), 'wall add anchor');
    assert.ok(tags[0].includes('label="Add capsule"'), 'wall add accessible name');
  });

  test('panel adds zero bare controls: kit owns buttons, tile owns state only', () => {
    const source = readFileSync(PANEL_URL, 'utf8');
    const template = source.slice(source.indexOf('<template>'));
    assert.deepEqual(interactiveTags(template), [], 'no lane-owned button/input/select/link');
    assert.doesNotMatch(template, /tabindex/, 'no lane focus order overrides');
    assert.match(template, /<div class="mv-tile" :data-tile-state="tile\.tile" :data-error-code="row\?\.refusal\?\.code \?\? snapshot\?\.error\?\.code">/,
      'tile state rides a CSP-safe data attribute, never an id');
  });

  test('negative control: unanchored, unnamed or volatile controls fail', () => {
    assertAnchoredControl('<UiButton id="a" data-semantic-anchor="wall/add-capsule" label="Add" />');
    for (const bad of [
      '<UiButton label="Add" />',
      '<UiButton id="a" label="Add" />',
      '<UiButton id="a" data-semantic-anchor="wall/add-capsule" />',
      '<UiButton id="a" data-semantic-anchor="Wall/Add" label="Add" />',
      '<UiButton id="a" data-semantic-anchor="wall/add capsule" label="Add" />',
      '<UiButton id="add-{{ n }}" data-semantic-anchor="wall/add-capsule" label="Add" />',
      '<button>Go</button>',
    ]) {
      assert.throws(() => assertAnchoredControl(bad), assert.AssertionError, bad);
    }
  });
});
