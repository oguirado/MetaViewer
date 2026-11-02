// @ts-check
/** [TARGET, unit decision] One trusted main-owned spawn specification and one
 * renderer byte port per utility process. No renderer spawn requests accepted. */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { resolveNodePtyDir } from './ptyBroker.js';
import { createPtySession } from './ptySession.js';

/**
 * Load node-pty from the resolved packaged or host directory using createRequire.
 * @param {unknown} [env]
 * @param {unknown} [resourcesPath]
 */
export function loadNodePty(env = process.env, resourcesPath = process.resourcesPath) {
  const dir = resolveNodePtyDir(env, resourcesPath);
  const req = createRequire(join(dir, 'package.json'));
  const mod = req('.');
  if (!mod || typeof mod.spawn !== 'function') {
    throw new Error('TERMINAL_UNAVAILABLE: node-pty spawn is unavailable');
  }
  return mod;
}

/** @param {Electron.ParentPort} parent @param {{ env?: unknown, resourcesPath?: unknown }} [options] */
export function startPtyUtility(parent, options = {}) {
  let bound = false;
  parent.on('message', event => {
    if (bound || event.ports.length !== 1) return;
    bound = true;
    const port = event.ports[0];
    const { session, spec } = event.data;
    let spawn;
    try {
      spawn = loadNodePty(
        options.env !== undefined ? options.env : process.env,
        options.resourcesPath !== undefined ? options.resourcesPath : process.resourcesPath,
      ).spawn;
    } catch {
      try { port.postMessage({ session, error: 'TERMINAL_UNAVAILABLE' }); } catch {}
      try { port.close(); } catch {}
      return;
    }
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
