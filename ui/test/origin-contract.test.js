import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const main = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8');

function privilegedOrigin(source) {
  const declarations = [...source.matchAll(/^\s*(?:export\s+)?const PRIVILEGED_ORIGIN = (['"])([^'"\r\n]+)\1;/gm)];
  assert.equal(declarations.length, 1, 'exactly one privileged origin literal is required');
  return declarations[0][2];
}

function assertOriginContract(mainSource, preloadSource) {
  assert.equal(privilegedOrigin(preloadSource), privilegedOrigin(mainSource),
    'sandboxed preload must target the origin served by main');
}

test('sandboxed preload origin matches the origin main serves', () => {
  assertOriginContract(main, preload);
});

test('origin contract negative control rejects a planted preload mismatch', () => {
  const mismatched = preload.replace(
    /^(\s*const PRIVILEGED_ORIGIN = )(['"])[^'"\r\n]+\2;/m,
    "$1'metaviewer://app';",
  );
  assert.notEqual(mismatched, preload, 'negative control must mutate the preload');
  assert.throws(() => assertOriginContract(main, mismatched), {
    name: 'AssertionError',
    message: /sandboxed preload must target the origin served by main/,
  });
});
