// Identical chord grammar in the renderer and native xpra input boundary.
/** @param {any} input */
export function desktopShortcut(input) {
  if (input && (input.control ?? input.ctrlKey) && (input.alt ?? input.altKey) && !(input.meta ?? input.metaKey) && !(input.shift ?? input.shiftKey)) {
    const actions = /** @type {Record<string,string>} */ ({ArrowLeft:'narrower',ArrowRight:'wider',ArrowUp:'shorter',ArrowDown:'taller'});
    const action = actions[input.key];
    if (action) return {type:'resize',action};
  }
  if (!input || !(input.control ?? input.ctrlKey) || input.alt || input.altKey || input.meta || input.metaKey || input.shift || input.shiftKey) return null;
  if (input.key === 'Tab') return {type:'toggle'};
  if (/^[1-9]$/.test(input.key || '')) return {type:'select',desktop:Number(input.key)};
  return null;
}
/** @param {{preventDefault:()=>void}} event @param {any} input @param {Pick<import('electron').BrowserWindow,'webContents'>} window @param {Set<string>} captured @param {string} [capsuleId] */
export function interceptDesktopShortcut(event, input, window, captured, capsuleId) {
  if (!input) return false;
  const chord = desktopShortcut(input), code = input.code || input.key;
  const released = input.type === 'keyUp';
  if (!chord && !captured.has(code)) return false;
  event.preventDefault();
  if (released) { captured.delete(code); return true; }
  if (!chord) return true;
  captured.add(code);
  const detail = chord.type === 'resize' && capsuleId ? {...chord,capsuleId} : chord;
  // Fixed event and closed payload; no remote text or bridge capability.
  void window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('metaviewer:desktop-shortcut',{detail:${JSON.stringify(detail)}}))`).catch(() => {});
  return true;
}
