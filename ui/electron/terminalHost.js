// @ts-check
/** [TARGET, unit decision] Main-only capability: admitted server spec is copied
 * before utilityProcess launch. Caller authenticates renderer before transfer. */
import { fileURLToPath } from 'node:url';
import { validateSpawnSpec } from './ptySession.js';
/** @param {{utilityProcess:typeof import('electron').utilityProcess,session:string,spec:import('./ptySession.js').SpawnSpec,port:Electron.MessagePortMain}} options */
export function launchTerminalUtility({ utilityProcess, session, spec, port }) {
  const owned = validateSpawnSpec(spec);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error('INVALID_SESSION');
  const child = utilityProcess.fork(fileURLToPath(new URL('./ptyUtility.js', import.meta.url)), [], { serviceName: 'MetaViewer PTY' });
  child.once('spawn', () => child.postMessage({ session, spec: owned }, [port]));
  return child;
}
