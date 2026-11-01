import { execFile } from 'node:child_process';
/** Read only XKB layout metadata from the app's own host display.
 * @param {NodeJS.ProcessEnv} env @returns {Promise<string>} */
export function hostKeyboardLayout(env) {
  return new Promise((resolve,reject) => {
    execFile('setxkbmap',['-query'],{env,timeout:3000,maxBuffer:4096},(error,stdout) => {
      const layout = /^layout:\s*([a-z0-9_,-]+)\s*$/m.exec(stdout)?.[1]?.split(',')[0];
      if (error || !layout) reject(Object.assign(Error('XPRA_KEYMAP_UNAVAILABLE'),{code:'XPRA_KEYMAP_UNAVAILABLE'}));
      else resolve(layout);
    });
  });
}
