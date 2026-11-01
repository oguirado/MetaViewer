// SPIKE: child xpra view gets no exposed API, filesystem, or host capability.
const { ipcRenderer } = require('electron');
const navigation = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp',
  'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);
let lastMove = -Infinity;
function send(event) {
  // Redact BEFORE IPC. The main recorder also redacts against capsule AX state.
  const key = navigation.has(event.key) ? event.key : null;
  const page = event.view || window;
  const common = { width: page.innerWidth, height: page.innerHeight };
  const type = event.type;
  if (type === 'keydown' || type === 'keyup') {
    ipcRenderer.send('metaviewer:human-trace.v0.3', { ...common, kind: 'key', key,
      phase: type === 'keyup' ? 'up' : 'down' });
    return;
  }
  if (type === 'mousemove') {
    const now = performance.now();
    if (now - lastMove < 16) return;
    lastMove = now;
  }
  ipcRenderer.send('metaviewer:human-trace.v0.3', { ...common,
    kind: type === 'mousedown' ? 'click' : type === 'wheel' ? 'scroll' : 'move',
    x: event.clientX, y: event.clientY,
    ...(type === 'mousedown' ? { button: event.button } : {}),
    ...(type === 'wheel' ? { dx: event.deltaX, dy: event.deltaY, deltaMode: event.deltaMode } : {}) });
}
const types = ['mousedown', 'mousemove', 'keydown', 'keyup', 'wheel'];
addEventListener('DOMContentLoaded', () => {
  const frame = document.getElementById('metaviewer-xpra-client');
  if (!frame) return;
  // Same-origin child DOM only. IPC stays in this main-frame preload; the
  // iframe receives neither Node integration nor an exposed host API.
  frame.addEventListener('load', () => {
    for (const type of types) frame.contentDocument.addEventListener(type, send, {capture:true,passive:true});
  });
});
for (const type of types) addEventListener(type, send, {capture:true,passive:true});
