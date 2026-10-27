import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRole, statFields } from './proc_fields.mjs';

test('Electron proc titles and NUL argv preserve renderer and utility attribution', () => {
  for (const separator of ['\0', ' ']) {
    assert.equal(classifyRole(52, 41, ['electron', '--type=renderer', '--lang=en'].join(separator)), 'renderer');
    assert.equal(classifyRole(53, 41, ['electron', '--type=utility', '--service-sandbox-type=network'].join(separator)), 'utility');
  }
  assert.equal(classifyRole(41, 41, 'electron'), 'main');
  assert.equal(classifyRole(54, 41, 'electron --type=gpu-process'), 'helper');
  assert.equal(classifyRole(55, 41, 'electron --type=renderer-impostor'), 'helper');
});

test('stat generation survives closing parentheses and spaces in process name', () => {
  const tail = ['S', '41', ...Array(17).fill('0'), '123456', '0', '12'];
  const fields = statFields('52 (renderer) child) ' + tail.join(' '));
  assert.equal(fields[1], '41');
  assert.equal(fields[19], '123456');
  assert.throws(() => statFields('52 (child) S 41'), /Truncated/);
  assert.throws(() => statFields('invalid'), /Malformed/);
});
