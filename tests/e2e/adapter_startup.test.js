'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { waitForAdapterConnection } = require('./adapter-startup.cjs');

const neverConnected = () => new Promise(() => {});

test('adapter startup refusal rejects the pending connection with its diagnostic', async () => {
  const child = spawn(process.execPath, ['-e',
    "process.stderr.write('configuration: disjoint profile RAM roots required'); process.exit(2);"],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await assert.rejects(waitForAdapterConnection(neverConnected(), child, () => stderr),
    (error) => error.code === 'E2E_STARTUP'
      && /code=2/.test(error.message)
      && /disjoint profile RAM roots required/.test(error.message));
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('adapter startup spawn error rejects instead of leaving core listening', async () => {
  const child = spawn(process.execPath, [], { cwd: `${__filename}.absent`, stdio: 'ignore' });
  await assert.rejects(waitForAdapterConnection(neverConnected(), child, () => ''),
    (error) => error.code === 'E2E_STARTUP' && /spawn failed/.test(error.message));
});

test('adapter startup without a connection has a finite deadline', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await assert.rejects(waitForAdapterConnection(neverConnected(), child, () => '', 50),
      (error) => error.code === 'E2E_TIMEOUT');
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
});

test('connected adapter clears the startup deadline and preserves its connection', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const connection = {};
    assert.equal(await waitForAdapterConnection(Promise.resolve(connection), child, () => ''), connection);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
});
