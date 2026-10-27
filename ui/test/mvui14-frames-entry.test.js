// MVUI14 lane F: entry + tile wiring. main.js installs the frame-port router
// on live boots only through a dynamic import (the closed static stub-map
// surface stays pinned), provides it for tiles, and disposes it on teardown;
// SurfaceCanvas binds/unbinds its surface without touching the pinned mount
// call. Source-shape checks in the mount-wiring idiom, each with a negative
// control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const tile = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');

test('entry installs the router live-only before the authority runtime subscribes', () => {
  const install = "await import('./frames/framePortRouter.js')";
  assert.ok(main.includes(install), 'router loads through a dynamic import');
  assert.ok(main.includes('if (!fixture)'), 'fixture boots skip the router');
  assert.ok(main.includes('installRouter({ target: window })'), 'router listens on the window');
  assert.ok(
    main.indexOf(install) < main.indexOf('createAuthorityRuntime(host'),
    'listener precedes the eager frames subscription',
  );
});

test('negative control: the install check fails without the live-only dynamic import', () => {
  const wired = (source) => source.includes("await import('./frames/framePortRouter.js')")
    && source.includes('if (!fixture)')
    && source.indexOf("await import('./frames/framePortRouter.js')") < source.indexOf('createAuthorityRuntime(host');
  assert.equal(wired(main), true);
  assert.equal(wired(main.replaceAll("await import('./frames/framePortRouter.js')", 'null')), false);
  assert.equal(wired(main.replaceAll('if (!fixture) {', 'if (true) {')), false);
});

test('entry keeps the closed static import surface while wiring the router', () => {
  const specifiers = [...main.matchAll(/^import\s+[^\n]+?\s+from\s+(['"])(.*?)\1;?$/gm)].map((match) => match[2]);
  assert.deepEqual(specifiers, [
    'vue',
    './App.vue',
    './core/hostAdapters.js',
    './settings/settingsHost.js',
    './fixtures/resolveState.js',
    './fixtures/fixtureRuntime.js',
    './wall/layout.js',
    'capsule-ui-kit/theme',
  ]);
  assert.ok(main.includes("application.provide?.('framePortRouter', framePortRouter)"), 'tiles inject the router');
  assert.ok(main.includes('framePortRouter?.dispose?.()'), 'teardown disposes the router');
});

test('negative control: the surface check fails on a planted static frames import', () => {
  const specifiers = (source) => [...source.matchAll(/^import\s+[^\n]+?\s+from\s+(['"])(.*?)\1;?$/gm)]
    .map((match) => match[2]);
  assert.deepEqual(specifiers(main).length, 8);
  assert.throws(() => assert.deepEqual(
    specifiers(`${main}\nimport installFramePortRouter from './frames/framePortRouter.js';`).length, 8),
  assert.AssertionError);
});

test('SurfaceCanvas binds the tile to the router and keeps the pinned mount call', () => {
  for (const token of [
    "inject('framePortRouter'",
    'bindFramePort',
    'unbindFramePort',
    'onRegistered',
    'onMounted(attachCanvas)',
    'onMounted(bindFramePort)',
  ]) {
    assert.ok(tile.includes(token), `tile keeps ${token}`);
  }
});

test('negative control: the tile check fails when the binding is stripped', () => {
  const bound = (source) => source.includes("inject('framePortRouter'")
    && source.includes('onMounted(bindFramePort)')
    && source.includes('onMounted(attachCanvas)');
  assert.equal(bound(tile), true);
  assert.equal(bound(tile.replaceAll('framePortRouter', 'tileScheduler')), false);
});

test('judge note 4: the pagehide teardown guard covers a router-only boot', () => {
  assert.ok(
    main.includes('if (framePortRouter || captureState || liveRuntime || replayRuntime'),
    'guard registers pagehide when only the frame router is live',
  );
  assert.ok(main.includes("window.addEventListener?.('pagehide', teardown"), 'teardown listens for pagehide');
  assert.ok(main.includes('framePortRouter?.dispose?.()'), 'teardown disposes the router');
  assert.ok(main.includes('disposeQa()'), 'teardown keeps the combined QA-collector disposal');
});

test('negative control: the pagehide check fails when the router leaves the guard', () => {
  const guarded = (source) => source.includes('if (framePortRouter || captureState || liveRuntime || replayRuntime');
  assert.equal(guarded(main), true);
  assert.equal(guarded(main.replace(
    'if (framePortRouter || captureState || liveRuntime || replayRuntime',
    'if (captureState || liveRuntime || replayRuntime',
  )), false);
});
