// MVUI14 lane W: capture chrome follows entries added after mount.
// Regression: readSurfaceEntry guarded the plain-object read with
// hasOwnProperty, which never subscribes the key on a reactive({}) store,
// so a later-added entry left the badge frozen on its mount-time readout.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import { compileSfc, nodes, text, flush } from './mvui2-terminal-mount.mjs';
import { readSurfaceEntry } from '../src/wall/tileCapture.js';
import * as tileCapture from '../src/wall/tileCapture.js';

const SidebarIcon = await compileSfc('../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue', {});
const SaasRecordButton = await compileSfc('../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue', {});
const TileCaptureChrome = await compileSfc('wall/TileCaptureChrome.vue', {
  '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
  '../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue': SaasRecordButton,
  './tileCapture.js': tileCapture,
});

// Local renderer mirrors mvui10: the real kit children need an element style
// object for v-show.
function mountComponent(component, props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: (tag) => ({ tag, children: [], props: {}, style: {} }),
    createText: (content) => ({ text: content }),
    createComment: (content) => ({ text: content }),
    insert(node, parent, anchor) {
      if (node.parent) this.remove(node);
      node.parent = parent;
      const index = parent.children.indexOf(anchor);
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    },
    remove(node) {
      const list = node.parent?.children;
      if (list) list.splice(list.indexOf(node), 1);
    },
    setText(node, value) { node.text = value; },
    setElementText(node, value) { node.text = value; },
    patchProp(node, key, _old, value) { node.props[key] = value; },
    parentNode: (node) => node.parent,
    nextSibling: () => null,
    setScopeId() {},
  });
  const app = renderer.createApp(component, props);
  app.mount(root);
  return { root, close: () => app.unmount() };
}

/** Reactive capture store double shaped like the capturePort store. */
function stubStore(entries = {}) {
  return vue.reactive({
    bySurface: vue.reactive({ ...entries }),
    rows: vue.reactive([]),
    toggleRecord: async () => ({ ok: true }),
    screenshot: async () => ({ ok: true }),
  });
}

function recordingEntry(overrides = {}) {
  return {
    phase: 'recording', recordingId: 'rec-1', frames: 120, elapsedMs: 5000,
    lastShot: null, lastCode: '', ...overrides,
  };
}

function badgeText(root, surface) {
  const badge = nodes(root).find(
    (n) => n.props?.['data-semantic-anchor'] === `tile-${surface}-recording-badge`);
  assert.ok(badge, `badge mounts for ${surface}`);
  return text(badge);
}

describe('late capture entries', () => {
  test('a computed over the reader re-fires when the entry appears later', async () => {
    const store = stubStore();
    const entry = vue.computed(() => readSurfaceEntry(store, 'cap-1'));
    assert.equal(entry.value, null);
    store.bySurface['cap-1'] = recordingEntry();
    await vue.nextTick();
    assert.equal(entry.value?.phase, 'recording');
  });

  test('entry added after mount updates the badge', async () => {
    const store = stubStore();
    const mounted = mountComponent(TileCaptureChrome,
      { capsuleId: 'cap-1', capsuleLabel: 'Capsule cap-1', captureState: store });
    try {
      await flush();
      assert.match(badgeText(mounted.root, 'cap-1'), /Idle/);
      store.bySurface['cap-1'] = recordingEntry();
      await flush();
      assert.match(badgeText(mounted.root, 'cap-1'), /Recording 00:05/);
    } finally { mounted.close(); }
  });

  test('negative control: an unrelated surface entry leaves the badge idle', async () => {
    const store = stubStore();
    const mounted = mountComponent(TileCaptureChrome,
      { capsuleId: 'cap-1', capsuleLabel: 'Capsule cap-1', captureState: store });
    try {
      await flush();
      store.bySurface['cap-2'] = recordingEntry();
      await flush();
      assert.match(badgeText(mounted.root, 'cap-1'), /Idle/);
    } finally { mounted.close(); }
  });

  test('negative control: a malformed late entry keeps the idle readout', async () => {
    const store = stubStore();
    const mounted = mountComponent(TileCaptureChrome,
      { capsuleId: 'cap-1', capsuleLabel: 'Capsule cap-1', captureState: store });
    try {
      await flush();
      store.bySurface['cap-1'] = 'recording';
      await flush();
      assert.match(badgeText(mounted.root, 'cap-1'), /Idle/);
    } finally { mounted.close(); }
  });
});

describe('reader keeps refusing hostile shapes', () => {
  test('inherited members never resolve, even though the read is tracked', () => {
    for (const hostile of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
      assert.equal(readSurfaceEntry({ bySurface: {} }, hostile), null, hostile);
      assert.equal(readSurfaceEntry(stubStore(), hostile), null, hostile);
    }
  });

  test('Map stores and malformed entries behave as before', () => {
    const entry = recordingEntry();
    assert.equal(readSurfaceEntry({ bySurface: new Map([['cap-1', entry]]) }, 'cap-1'), entry);
    assert.equal(readSurfaceEntry({ bySurface: { 'cap-1': entry } }, 'cap-1'), entry);
    for (const bad of ['x', 7, ['recording'], null]) {
      assert.equal(readSurfaceEntry({ bySurface: { 'cap-1': bad } }, 'cap-1'), null);
    }
  });
});
