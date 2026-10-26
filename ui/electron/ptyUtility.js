// @ts-check
/** [TARGET, unit decision] One trusted main-owned spawn specification and one
 * renderer byte port per utility process. No renderer spawn requests accepted. */
import { createPtySession } from './ptySession.js';
import { spawn } from 'node-pty';
/** @param {Electron.ParentPort} parent */
export function startPtyUtility(parent) {
  let bound = false;
  parent.on('message', event => {
    if (bound || event.ports.length !== 1) return;
    bound = true;
    const port = event.ports[0];
    const { session, spec } = event.data;
    const runtime = createPtySession({ session, spec, spawn, send: message => port.postMessage(message) });
    port.on('message', message => {
      try { runtime.receive(message.data); }
      catch { runtime.close(); port.close(); }
    });
    port.on('close', () => runtime.close());
    port.start();
  });
}
if (process.parentPort) startPtyUtility(process.parentPort);
