// UI-TILE: the Network toolbar and the capture chrome share one rail row so
// the tile canvas keeps the height those two stacked rows used to take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('SurfacePanel wraps NetworkPanel and TileCaptureChrome in one rail', () => {
  const source = read('../src/wall/SurfacePanel.vue');
  const template = source.slice(source.indexOf('<template>'));
  const rail = template.indexOf('<div class="mv-tile-rail">');
  const network = template.indexOf('<NetworkPanel');
  const chrome = template.indexOf('<TileCaptureChrome');
  const railEnd = template.indexOf('</div>', chrome);
  const panel = template.indexOf('<CapsulePanel');
  assert.ok(rail >= 0, 'rail mounts');
  assert.ok(rail < network && network < chrome && chrome < railEnd && railEnd < panel,
    'Network then capture chrome inside the rail, kit panel after it');
});

test('rail is one wrapping flex row; the chrome drops its own divider inside it', () => {
  const css = read('../src/wall/wall.css');
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  const rail = rule('.mv-tile-rail');
  assert.match(rail, /display:\s*flex/);
  assert.match(rail, /flex-wrap:\s*wrap/);
  assert.match(rail, /flex:\s*0 0 auto/);
  assert.doesNotMatch(rail, /#[0-9a-f]{3,8}\b/i, 'kit tokens only');
  const chrome = rule('.mv-tile-rail > .mv-tile-chrome');
  assert.match(chrome, /flex:\s*1 1 auto/);
  assert.match(chrome, /border-bottom:\s*0/);
  // Negative control: the kit panel still fills the remaining tile body.
  assert.match(rule('.mv-tile > .cuk-capsule-panel'), /flex:\s*1 1 auto/);
});
