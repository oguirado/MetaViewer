import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('an inactive desktop stays hidden: forwarded attrs never override its hidden state', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/wall/DesktopWorkspace.vue', import.meta.url)), 'utf8');
  const wall = /<WallWorkspace\b[\s\S]*?\s@ready=/.exec(source)?.[0] ?? '';
  const attrs = wall.indexOf('v-bind="$attrs"');
  const hidden = wall.indexOf(':hidden="!isActive(view,desktop.id)"');
  assert.ok(attrs >= 0 && hidden >= 0, 'both bindings exist');
  assert.ok(attrs < hidden, 'App passes hidden too, so the per-desktop binding must come after v-bind');
});
