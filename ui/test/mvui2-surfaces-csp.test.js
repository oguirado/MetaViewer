// Lane V5: SurfaceCanvas strict-CSP (v-show removal), hidden-attribute
// visibility, canvas-always-mounted binding contract, and stable host
// identity. Every checker ships with a planted violation proving it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SFC_URL = new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url);
const FRAME_TILE_URL = new URL('../src/surfaces/frameTile.js', import.meta.url);
const SCHEDULER_URL = new URL('../src/surfaces/tileScheduler.js', import.meta.url);
const sfc = readFileSync(SFC_URL, 'utf8');
const frameTile = readFileSync(FRAME_TILE_URL, 'utf8');
const scheduler = readFileSync(SCHEDULER_URL, 'utf8');
const template = sfc.match(/<template>([\s\S]*?)<\/template>/)[1];
const css = sfc.match(/<style scoped>([\s\S]*?)<\/style>/)[1];

/**
 * Strict CSP audit: no inline style attribute, no :style binding, no
 * v-show (runtime el.style write), no setAttribute('style'), no
 * element.style writes.
 * @param {string} source
 * @param {string} label
 */
function assertCspClean(source, label) {
  assert.doesNotMatch(source, /v-bind:style/, `${label}: v-bind:style`);
  assert.doesNotMatch(source, /(?:^|[\s"'`:=])style\s*=/m, `${label}: inline style attribute`);
  assert.doesNotMatch(source, /v-show/, `${label}: v-show writes el.style`);
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]/, `${label}: setAttribute style`);
  assert.doesNotMatch(source, /\.style\.[a-zA-Z]/, `${label}: element.style write`);
}

/**
 * Canvas visibility audit: exactly one canvas element (always mounted),
 * hidden through the `:hidden` attribute with the live/stale condition.
 * v-show is rejected (it writes el.style) and v-if is rejected (it would
 * unmount the scheduler-bound canvas and break attach/detach identity).
 * @param {string} templateSource
 * @param {string} label
 */
function assertCanvasVisibility(templateSource, label) {
  const tags = templateSource.match(/<canvas\b[\s\S]*?\/>/g) ?? [];
  assert.equal(tags.length, 1, `${label}: exactly one canvas stays mounted`);
  const canvas = tags[0];
  assert.doesNotMatch(canvas, /v-show/, `${label}: v-show writes el.style`);
  assert.doesNotMatch(canvas, /v-if/, `${label}: v-if would unmount the bound canvas`);
  assert.ok(/:hidden=/.test(canvas), `${label}: canvas binds :hidden`);
  assert.ok(
    /resolvedState !== 'live' && resolvedState !== 'stale'/.test(canvas),
    `${label}: hidden condition mirrors the waiting branch`,
  );
}

/**
 * Hidden-guard audit: the scoped stylesheet defeats the `display: block`
 * canvas base with a `[hidden]` guard, otherwise the author rule would
 * override the user-agent `[hidden] { display: none }` treatment.
 * @param {string} cssSource
 * @param {string} label
 */
function assertHiddenGuard(cssSource, label) {
  const guard = cssSource.match(/\.mv-surface__canvas\[hidden\]\s*\{[^}]*\}/);
  assert.ok(guard, `${label}: scoped [hidden] guard exists`);
  assert.match(guard[0], /display\s*:\s*none/, `${label}: guard hides the canvas`);
}

/**
 * Binding-wiring audit: the SFC side of the scheduler contract keeps the
 * injected scheduler, attach/detach calls, mount/unmount lifecycle, and
 * metadata-only emits, so the engine mount harness behaviour is intact.
 * @param {string} source
 * @param {string} label
 */
function assertBindingWiring(source, label) {
  for (const token of [
    "inject('tileScheduler'",
    'attachCanvas',
    'detachCanvas',
    'onMounted(attachCanvas)',
    'onBeforeUnmount',
    'canvas-ready',
    'canvas-released',
  ]) {
    assert.ok(source.includes(token), `${label}: keeps ${token}`);
  }
}

/**
 * Host-identity audit: the tile host section keeps a stable id, anchor,
 * and accessible name binding.
 * @param {string} templateSource
 * @param {string} label
 */
function assertHostIdentity(templateSource, label) {
  const section = templateSource.match(/<section\b[\s\S]*?>/);
  assert.ok(section, `${label}: host section exists`);
  assert.ok(/(?:^|\s):id=/.test(section[0]), `${label}: host without :id`);
  assert.ok(/(?:^|\s):data-anchor=/.test(section[0]), `${label}: host without :data-anchor`);
  assert.ok(/(?:^|\s):aria-label=/.test(section[0]), `${label}: host without accessible name`);
}

test('surfaces lane is strict-CSP clean; planted styles fail', () => {
  assertCspClean(sfc, 'SurfaceCanvas.vue');
  assertCspClean(frameTile, 'frameTile.js');
  assertCspClean(scheduler, 'tileScheduler.js');
  assert.throws(() => assertCspClean('<canvas style="display:none">x</canvas>', 'planted'), /inline style/);
  assert.throws(() => assertCspClean('<div :style="s" />', 'planted'), /inline style/);
  assert.throws(() => assertCspClean('<div v-bind:style="s" />', 'planted'), /v-bind:style/);
  assert.throws(() => assertCspClean('<div v-show="open" />', 'planted'), /v-show/);
  assert.throws(
    () => assertCspClean(`el.setAttribute('style', 'display:none')`, 'planted'),
    /setAttribute style/,
  );
  assert.throws(() => assertCspClean('el.style.display = "none"', 'planted'), /element\.style/);
});

test('canvas hides through :hidden and never unmounts; planted directives fail', () => {
  assertCanvasVisibility(template, 'SurfaceCanvas.vue');
  assert.throws(
    () => assertCanvasVisibility('<canvas v-show="live" class="mv-surface__canvas" />', 'planted'),
    /v-show/,
  );
  assert.throws(
    () => assertCanvasVisibility('<canvas v-if="live" :hidden="gone" />', 'planted'),
    /v-if/,
  );
  assert.throws(
    () => assertCanvasVisibility('<canvas class="mv-surface__canvas" />', 'planted'),
    /binds :hidden/,
  );
  assert.throws(
    () => assertCanvasVisibility('<canvas :hidden="isLive" />', 'planted'),
    /mirrors the waiting branch/,
  );
  assert.throws(() => assertCanvasVisibility('<div>no canvas</div>', 'planted'), /exactly one canvas/);
});

test('scoped [hidden] guard defeats the display:block base; guard-free CSS fails', () => {
  assert.ok(css.includes('.mv-surface__canvas'), 'canvas base rule stays');
  assertHiddenGuard(css, 'SurfaceCanvas.vue');
  assert.throws(
    () => assertHiddenGuard('.mv-surface__canvas{display:block}', 'planted'),
    /guard exists/,
  );
  assert.throws(
    () => assertHiddenGuard('.mv-surface__canvas[hidden]{visibility:hidden}', 'planted'),
    /guard hides/,
  );
});

test('scheduler binding lifecycle is untouched; stripped wiring fails', () => {
  assertBindingWiring(sfc, 'SurfaceCanvas.vue');
  assert.throws(
    () => assertBindingWiring(sfc.replace('onMounted(attachCanvas)', 'onMounted(noop)'), 'planted'),
    /onMounted\(attachCanvas\)/,
  );
  assert.throws(
    () => assertBindingWiring(sfc.replaceAll('detachCanvas', 'removed'), 'planted'),
    /detachCanvas/,
  );
});

test('host section keeps stable id, anchor and name; missing anchor fails', () => {
  assertHostIdentity(template, 'SurfaceCanvas.vue');
  assert.throws(
    () => assertHostIdentity('<section class="mv-surface" :id="domId"></section>', 'planted'),
    /without :data-anchor/,
  );
  assert.throws(
    () => assertHostIdentity('<section :data-anchor="a" :aria-label="n"></section>', 'planted'),
    /without :id/,
  );
  assert.throws(
    () => assertHostIdentity('<section :id="i" :data-anchor="a"></section>', 'planted'),
    /without accessible name/,
  );
});
