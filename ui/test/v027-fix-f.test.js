import test from 'node:test';
import assert from 'node:assert/strict';
import {createTerminalHost} from '../electron/terminalHost.js';

test('F12 broker shell preserves host runtime directory for attachment discovery and scrubs credentials', async () => {
  const runtime = '/tmp/mv-runtime-f';
  let spawned;
  let exit;
  const pty = {spawn(file, args, options) {
    spawned = options;
    return {pid:12345,onData(){return {dispose(){}};},onExit(fn){exit=fn;return {dispose(){}};},
      write(){},resize(){},pause(){},resume(){},kill(){exit({exitCode:0});}};
  }};
  const host = createTerminalHost({pty,env:{HOME:'/tmp',PATH:process.env.PATH, XDG_RUNTIME_DIR:runtime, API_TOKEN:'do-not-export'}});
  try {
    await host.setEnabled(true);
    const opened = await host.open({command:'shell',cols:80,rows:24});
    assert.ok(opened.session);
    assert.equal(spawned.env.XDG_RUNTIME_DIR, runtime);
    assert.equal(spawned.env.API_TOKEN, undefined);
  } finally {await host.dispose();}
});
