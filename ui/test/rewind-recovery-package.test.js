import test from 'node:test';
import assert from 'node:assert/strict';
import {stat, readFile} from 'node:fs/promises';
import {OPERATOR_RESOURCES} from '../tools/package.js';

test('public operator package includes explicit rewind recovery CLI and library', async () => {
  const required = ['daemon-adapter/tools/rewind_recover.py', 'daemon-adapter/rewind_runtime/recovery.py'];
  for (const path of required) {
    const source = new URL('../../' + path, import.meta.url);
    assert.equal((await stat(source)).isFile(), true, 'public source exists: ' + path);
    assert.ok((await readFile(source)).length > 0, 'public source nonempty: ' + path);
    assert.equal(OPERATOR_RESOURCES.filter(value => value === path).length, 1, 'packaged exactly once: ' + path);
  }
  assert.equal(OPERATOR_RESOURCES.some(value => value.includes('node_modules') || value.startsWith('/') || value.includes('..')), false);
});
