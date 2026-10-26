import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES } from '../src/fixtures/states.js';
import { collectAgentControls } from '../src/agent/agentLane.js';

// Feed rendered SFC elements through the actual agent collector, so fixture
// roles follow the published DOM rather than source-text predictions.
function renderedControls(html) {
  const nodes = [...html.matchAll(/<([a-z][\w-]*)([^>]*)>/gi)].map(([, tag, attributes]) => {
    const attrs = new Map([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    return {
      tagName: tag.toUpperCase(), id: attrs.get('id') ?? '', textContent: '',
      getAttribute: key => attrs.get(key) ?? null,
      hasAttribute: key => attrs.has(key),
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    };
  }).filter(node => node.hasAttribute('data-semantic-anchor'));
  return collectAgentControls({ querySelectorAll: () => nodes }).controls;
}
function assertExpected(actual, expected) {
  for (const row of expected) {
    assert.ok(actual.some(control => control.anchor === row.anchor && control.role === row.role), JSON.stringify(row));
  }
}

test('fixture wall, recording and settings anchors match mounted SFC output', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'mvui-f4-vite-'));
  let server;
  try {
    server = await createServer({ cacheDir, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
    const { default: EmptyWall } = await server.ssrLoadModule('/src/wall/EmptyWallView.vue');
    const empty = renderedControls(await renderToString(createSSRApp(EmptyWall)));
    assertExpected(empty, FIXTURES.empty.expectedAnchors.filter(row => row.anchor === 'wall/add-capsule'));
    const { default: Recording } = await server.ssrLoadModule('/src/recording/MvRecordingPanel.vue');
    const { default: Settings } = await server.ssrLoadModule('/src/settings/MvSettingsPanel.vue');
    const recording = renderedControls(await renderToString(createSSRApp(Recording, { capsuleId: 'cap-01' })));
    assertExpected(recording, FIXTURES.recording.expectedAnchors.filter(row => row.anchor.startsWith('recording/')));
    const settings = renderedControls(await renderToString(createSSRApp(Settings, {
      settingsHost: { loadSettings: async () => ({ scheme: 'mv-dark', density: 'compact' }), saveSettings: async () => {} },
    })));
    assertExpected(settings, FIXTURES['settings-dark'].expectedAnchors.filter(row => row.anchor === 'settings/density'));
    assert.throws(() => assertExpected(recording, [{ anchor: 'recording/cap-01/missing', role: 'button' }]));
    assert.throws(() => assertExpected(settings, [{ anchor: 'settings/density', role: 'combobox' }]));
  } finally {
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
