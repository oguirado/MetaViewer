import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowOptions } from '../electron/main.js';

test('createWindowOptions pins all ten webPreferences with negative control mutants', () => {
  const dummyPreload = '/path/to/preload.cjs';
  const opts = createWindowOptions({ width: 1280, height: 720, preloadPath: dummyPreload });
  const prefs = opts.webPreferences;

  const expectedPins = {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    preload: dummyPreload,
  };

  // Positive witness: assert exact values for all 10 pins
  for (const [pin, expected] of Object.entries(expectedPins)) {
    assert.equal(prefs[pin], expected, `Pin ${pin} must equal ${expected}`);
  }

  // Negative control: for each pin, prove an inverted/mutated value fails verification
  for (const [pin, expected] of Object.entries(expectedPins)) {
    let mutatedValue;
    if (typeof expected === 'boolean') {
      mutatedValue = !expected;
    } else {
      mutatedValue = '/path/to/malicious_preload.cjs';
    }

    const mutatedPrefs = { ...prefs, [pin]: mutatedValue };
    const verify = (p) => assert.equal(p[pin], expected, `Pin ${pin} verification`);

    assert.throws(
      () => verify(mutatedPrefs),
      assert.AssertionError,
      `Mutated pin ${pin}=${mutatedValue} must fail verification`
    );
  }
});
