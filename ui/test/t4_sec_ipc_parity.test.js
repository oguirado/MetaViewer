import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLayoutBridge, MainError } from '../electron/main.js';

test('main vs preload CHANNELS text literal equality without importing', () => {
  const mainSrc = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  const preloadSrc = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8');

  // Extract CHANNELS literal definitions from main.js source
  const mainChannelsMatch = mainSrc.match(/export const CHANNELS = Object\.freeze\(\{([^}]+)\}\)/);
  assert.ok(mainChannelsMatch, 'main.js must define CHANNELS');
  const mainChannelsText = mainChannelsMatch[1].replace(/,\s*$/, '').replace(/\s+/g, '');

  // Extract CHANNELS literal definitions from preload.js source
  const preloadChannelsMatch = preloadSrc.match(/export const CHANNELS = Object\.freeze\(\{([^}]+)\}\)/);
  assert.ok(preloadChannelsMatch, 'preload.js must define CHANNELS');
  const preloadChannelsText = preloadChannelsMatch[1].replace(/,\s*$/, '').replace(/\s+/g, '');

  // Assert exact text equality of the literal channel definitions
  assert.equal(
    mainChannelsText,
    preloadChannelsText,
    'main.js and preload.js CHANNELS text definitions must be identical'
  );

  // Assert exact channel names and string values
  assert.ok(mainChannelsText.includes("load:'metaviewer:layout.load'"));
  assert.ok(mainChannelsText.includes("save:'metaviewer:layout.save'"));
});

test('createLayoutBridge invoke rejects with LAYOUT_CONTRACT_ABSENT and decodes bounds/JSON', async () => {
  const bridgeEntries = createLayoutBridge();
  assert.equal(bridgeEntries.length, 2);

  const loadEntry = bridgeEntries.find((e) => e.channel === 'metaviewer:layout.load');
  const saveEntry = bridgeEntries.find((e) => e.channel === 'metaviewer:layout.save');

  assert.ok(loadEntry, 'Bridge must include load entry');
  assert.ok(saveEntry, 'Bridge must include save entry');

  // 1. invoke rejects with LAYOUT_CONTRACT_ABSENT for both entries
  await assert.rejects(
    () => loadEntry.invoke(null),
    (err) => err instanceof MainError && err.code === 'LAYOUT_CONTRACT_ABSENT'
  );

  await assert.rejects(
    () => saveEntry.invoke('{"key":"value"}'),
    (err) => err instanceof MainError && err.code === 'LAYOUT_CONTRACT_ABSENT'
  );

  // 2. Load decoder accepts undefined, refuses anything else
  assert.equal(loadEntry.decode(undefined), null);
  assert.throws(
    () => loadEntry.decode('unexpected'),
    (err) => err instanceof MainError && err.code === 'LAYOUT_BOUNDS'
  );

  // 3. Save decoder accepts valid JSON under 256KiB
  const validJson = JSON.stringify({ layout: 'grid' });
  assert.equal(saveEntry.decode(validJson), validJson);

  // Save decoder refuses invalid JSON
  assert.throws(
    () => saveEntry.decode('{ invalid json }'),
    (err) => err instanceof MainError && err.code === 'LAYOUT_BOUNDS'
  );

  // Save decoder refuses over-cap payload (> 256KiB = 262,144 bytes)
  const overCapJson = JSON.stringify({ data: 'a'.repeat(262144) });
  assert.throws(
    () => saveEntry.decode(overCapJson),
    (err) => err instanceof MainError && err.code === 'LAYOUT_BOUNDS'
  );

  // Save decoder refuses non-string types
  for (const nonString of [123, null, undefined, {}, []]) {
    assert.throws(
      () => saveEntry.decode(nonString),
      (err) => err instanceof MainError && err.code === 'LAYOUT_BOUNDS'
    );
  }
});
