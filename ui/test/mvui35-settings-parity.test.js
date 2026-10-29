// MVUI35 lane T: settings decode parity D3 (float fps lexemes refuse) + D4
// (unknown keys refuse on load). Per-key lexeme matrix, full-defaults
// fallback through the store load and the boot parser, and data-URL mutant
// negative controls proving each new check is live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';
import {
  createHostSettingsStore,
  createMemorySettingsHost,
  decodeMvSettings,
  decodeStoredSettings,
  defaultMvSettings,
} from '../src/settings/settingsModel.js';

const FULL_DEFAULTS = { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 };
const FPS_KEYS = [
  { key: 'wallFps', code: 'ERR_SETTINGS_UNKNOWN_WALL_FPS', fallback: 30 },
  { key: 'recordingFps', code: 'ERR_SETTINGS_UNKNOWN_RECORDING_FPS', fallback: 3 },
];

/**
 * @param {string} key wallFps or recordingFps.
 * @param {string} lexeme Raw JSON lexeme injected for that key.
 */
function settingsText(key, lexeme) {
  const parts = { scheme: '"mv-dark"', density: '"comfortable"', wallFps: '60', recordingFps: '12' };
  parts[key] = lexeme;
  return `{${Object.entries(parts).map(([k, v]) => `"${k}":${v}`).join(',')}}`;
}

test('mvui35 D3: float fps lexemes refuse in strict and stored decode with the existing codes', async () => {
  for (const { key, code } of FPS_KEYS) {
    for (const lexeme of ['30.0', '3e1', '3E1']) {
      const text = settingsText(key, lexeme);
      const strict = decodeMvSettings(text);
      assert.equal(strict.ok, false, `${key} ${lexeme} strict`);
      assert.equal(strict.ok === false && strict.error.code, code, `${key} ${lexeme} strict code`);
      const stored = decodeStoredSettings(text);
      assert.equal(stored.ok, false, `${key} ${lexeme} stored`);
      assert.equal(stored.ok === false && stored.error.code, code, `${key} ${lexeme} stored code`);
      const store = createHostSettingsStore(createMemorySettingsHost(text));
      await assert.rejects(store.load(), new RegExp(code), `${key} ${lexeme} store load`);
    }
  }
});

test('mvui35 D3: plain integer lexemes stay accepted, string values refuse as non-numbers', () => {
  for (const { key, code, fallback } of FPS_KEYS) {
    const strict = decodeMvSettings(settingsText(key, '30'));
    assert.equal(strict.ok, true, `${key} 30 strict`);
    assert.equal(strict.ok && strict.settings[key], 30, `${key} 30 strict value`);
    const stored = decodeStoredSettings(settingsText(key, '30'));
    assert.equal(stored.ok, true, `${key} 30 stored`);
    assert.equal(stored.ok && stored.settings[key], 30, `${key} 30 stored value`);

    const strictString = decodeMvSettings(settingsText(key, '"30.0"'));
    assert.equal(strictString.ok, false, `${key} "30.0" strict`);
    assert.equal(strictString.ok === false && strictString.error.code, code, `${key} "30.0" strict code`);
    const storedString = decodeStoredSettings(settingsText(key, '"30.0"'));
    assert.equal(storedString.ok, true, `${key} "30.0" stored falls back per value, not whole`);
    assert.deepEqual(
      storedString.ok && { ...storedString.settings },
      { scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 12, [key]: fallback },
      `${key} "30.0" stored per-value fallback`,
    );

    assert.equal(decodeMvSettings({ [key]: 30 }).ok, true, `${key} object input unchanged`);
    assert.equal(decodeStoredSettings({ [key]: 30 }).ok, true, `${key} object load unchanged`);
  }
});

/**
 * Store load with the panel-style catch: any coded refusal falls back to
 * FULL defaults.
 * @param {string} text
 */
async function loadWithFullDefaultFallback(text) {
  const store = createHostSettingsStore(createMemorySettingsHost(text));
  try {
    return await store.load();
  } catch {
    return defaultMvSettings();
  }
}

test('mvui35 D4: unknown keys refuse as a whole, store path falls back to full defaults', async () => {
  const valid = '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12}';
  assert.deepEqual({ ...(await loadWithFullDefaultFallback(valid)) }, JSON.parse(valid));
  for (const text of [
    '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12,"extra":1}',
    '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12,"limits":{"memory_bytes":1,"ring_bytes":1,"max_fps":30}}',
    '{"scheme":"mv-dark","density":"comfortable","wallFps":30.0,"recordingFps":3}',
  ]) {
    const stored = decodeStoredSettings(text);
    assert.equal(stored.ok, false, text);
    const store = createHostSettingsStore(createMemorySettingsHost(text));
    await assert.rejects(store.load(), /ERR_SETTINGS/, text);
    assert.deepEqual({ ...(await loadWithFullDefaultFallback(text)) }, FULL_DEFAULTS, text);
  }
  const limits = decodeStoredSettings(
    '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12,"limits":{"max_fps":30}}',
  );
  assert.equal(limits.ok === false && limits.error.code, 'ERR_SETTINGS_UNKNOWN_KEY');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let bootSerial = 0;

/**
 * Minimal live-boot harness (mirrors the mvui29sc bootEntry shape): boots
 * the real entry with stubbed modules and records the painted settings.
 * @param {string} text Stored settings text served by the stub host.
 */
async function bootWithSettingsText(text) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const mount = { textContent: '', dataset: {} };
  const documentElement = { dataset: {} };
  let mounted = null;
  const kitSchemes = [];
  globalThis.window = {
    location: { search: '' },
    metaviewer: {
      load: async () => null,
      save: async () => true,
      loadSettings: async () => text,
      saveSettings: async () => true,
    },
  };
  globalThis.document = { documentElement, querySelector: () => mount };
  globalThis.__mvui35Boot = {
    vue: {
      createApp: (_App, props) => ({
        mount: (selector) => { mounted = { props, selector }; },
      }),
    },
    './App.vue': {},
    './core/hostAdapters.js': hostAdapters,
    './settings/settingsHost.js': { createSettingsHost },
    './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
    './fixtures/fixtureRuntime.js': { createFixtureRuntime },
    './wall/layout.js': { createWallLayout, migrateWallLayout },
    'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme: (scheme) => kitSchemes.push(scheme) },
  };
  try {
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const code = main
      .replace(
        /^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvui35Boot[${JSON.stringify(specifier)}];`,
      )
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    bootSerial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui35-${bootSerial}`);
    for (let i = 0; i < 300 && mounted === null && mount.textContent === ''; i++) {
      await sleep(10);
    }
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    delete globalThis.__mvui35Boot;
  }
  return { mount, mounted, kitSchemes, documentElement };
}

test('mvui35 D4+D3: boot parser paints full defaults for unknown-key and float-lexeme storage', async () => {
  for (const text of [
    '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12,"extra":1}',
    '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12,"limits":{"max_fps":30}}',
    '{"scheme":"mv-dark","density":"comfortable","wallFps":30.0,"recordingFps":3}',
  ]) {
    const { mount, mounted, kitSchemes, documentElement } = await bootWithSettingsText(text);
    assert.equal(mount.textContent, '', text);
    assert.ok(mounted, text);
    assert.equal(mounted.props.initialScheme, 'mv-light', `boot scheme for ${text}`);
    assert.equal(mounted.props.initialDensity, 'compact', `boot density for ${text}`);
    assert.deepEqual(kitSchemes, ['mv-light'], `kit scheme for ${text}`);
    assert.equal(documentElement.dataset.themeDensity, 'compact', `theme density for ${text}`);
  }
});

test('mvui35 control: boot parser still paints valid stored values as-is', async () => {
  const { mount, mounted, kitSchemes, documentElement } = await bootWithSettingsText(
    '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12}',
  );
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.equal(mounted.props.initialScheme, 'mv-dark');
  assert.equal(mounted.props.initialDensity, 'comfortable');
  assert.deepEqual(kitSchemes, ['mv-dark']);
  assert.equal(documentElement.dataset.themeDensity, 'comfortable');
});

const MODEL_URL = new URL('../src/settings/settingsModel.js', import.meta.url);
const MODEL_SOURCE = readFileSync(fileURLToPath(MODEL_URL), 'utf8');

/**
 * @param {string} source Mutant source.
 * @param {string} tag Unique data-URL fragment.
 */
async function importMutant(source, tag) {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${tag}`);
}

test('mvui35 negative control: mutant without the lexeme check fails the new D3 tests', async () => {
  const needle = 'const lexemeRefusal = floatFpsLexemeRefusal(candidate, lexemes);';
  const occurrences = MODEL_SOURCE.split(needle).length - 1;
  assert.equal(occurrences, 2, 'both strict and stored call sites are mutated');
  const mutantSource = MODEL_SOURCE.split(needle).join('const lexemeRefusal = null;');
  assert.notEqual(mutantSource, MODEL_SOURCE, 'mutant source differs from the original');
  const mutant = await importMutant(mutantSource, 'mvui35-no-lexeme');
  for (const { key } of FPS_KEYS) {
    assert.equal(
      mutant.decodeMvSettings(settingsText(key, '30.0')).ok,
      true,
      `mutant accepts strict ${key} 30.0, failing the new test`,
    );
    assert.equal(
      mutant.decodeStoredSettings(settingsText(key, '3e1')).ok,
      true,
      `mutant accepts stored ${key} 3e1, failing the new test`,
    );
  }
  assert.equal(
    mutant.decodeStoredSettings('{"scheme":"mv-dark","extra":1}').ok,
    false,
    'mutant still refuses unknown keys: only the lexeme check was removed',
  );
});

test('mvui35 negative control: mutant without the load unknown-key check fails the new D4 tests', async () => {
  const start = MODEL_SOURCE.indexOf('export function decodeStoredSettings');
  const end = MODEL_SOURCE.indexOf('export function encodeMvSettings');
  assert.ok(start !== -1 && end !== -1 && start < end, 'stored decode body is addressable');
  const body = MODEL_SOURCE.slice(start, end);
  const needle = 'if (!MV_SETTINGS_KEYS.includes(key)) {';
  assert.equal(body.split(needle).length - 1, 1, 'exactly the load unknown-key check is mutated');
  const mutantSource = MODEL_SOURCE.slice(0, start) + body.split(needle).join('if (false) {') + MODEL_SOURCE.slice(end);
  assert.notEqual(mutantSource, MODEL_SOURCE, 'mutant source differs from the original');
  const mutant = await importMutant(mutantSource, 'mvui35-no-load-key-check');
  assert.equal(
    mutant.decodeStoredSettings('{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12,"extra":1}').ok,
    true,
    'mutant accepts the unknown key, failing the new test',
  );
  assert.equal(
    mutant.decodeStoredSettings('{"scheme":"mv-dark","recordingFps":30.0}').ok,
    false,
    'mutant still refuses float lexemes: only the unknown-key check was removed',
  );
  assert.equal(
    mutant.decodeMvSettings('{"scheme":"mv-dark","extra":1}').ok,
    false,
    'strict decode is untouched by the load-only mutant',
  );
});
