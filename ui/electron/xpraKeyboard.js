import { execFile } from 'node:child_process';

// DOM physical positions to XKB physical positions, never character mappings.
/** @type {Record<string,string>} */
const positions = {
  Escape:'ESC', Backquote:'TLDE', Minus:'AE11', Equal:'AE12', Backspace:'BKSP', Tab:'TAB',
  BracketLeft:'AD11', BracketRight:'AD12', Backslash:'BKSL', CapsLock:'CAPS',
  Semicolon:'AC10', Quote:'AC11', Enter:'RTRN', ShiftLeft:'LFSH', ShiftRight:'RTSH',
  IntlBackslash:'LSGT', Comma:'AB08', Period:'AB09', Slash:'AB10',
  ControlLeft:'LCTL', ControlRight:'RCTL', AltLeft:'LALT', AltRight:'RALT',
  MetaLeft:'LWIN', MetaRight:'RWIN', Space:'SPCE', ContextMenu:'MENU',
  Insert:'INS', Delete:'DELE', Home:'HOME', End:'END', PageUp:'PGUP', PageDown:'PGDN',
  ArrowLeft:'LEFT', ArrowRight:'RGHT', ArrowUp:'UP', ArrowDown:'DOWN',
  NumLock:'NMLK', NumpadDivide:'KPDV', NumpadMultiply:'KPMU', NumpadSubtract:'KPSU',
  NumpadAdd:'KPAD', NumpadEnter:'KPEN', NumpadDecimal:'KPDL',
  PrintScreen:'PRSC', ScrollLock:'SCLK', Pause:'PAUS',
};
for (let i=1;i<=10;i++) positions['Digit'+i%10] = 'AE'+String(i).padStart(2,'0');
for (const [row,letters] of [['AD','QWERTYUIOP'],['AC','ASDFGHJKL'],['AB','ZXCVBNM']]) {
  [...letters].forEach((letter,i) => { positions['Key'+letter] = row+String(i+1).padStart(2,'0'); });
}
for (let i=1;i<=12;i++) positions['F'+i] = 'FK'+String(i).padStart(2,'0');
for (let i=0;i<=9;i++) positions['Numpad'+i] = 'KP'+i;

/** @param {string} source */
export function physicalXkbKeycodes(source) {
  const names = new Map([...source.matchAll(/<([A-Z0-9]+)>\s*=\s*(\d+)\s*;/g)]
    .map(m => [m[1],Number(m[2])]));
  /** @type {Record<string,number>} */
  const keycodes = Object.fromEntries(Object.entries(positions).filter(([,name]) => names.has(name))
    .map(([code,name]) => [code,/** @type {number} */ (names.get(name))]));
  if (!['KeyA','Digit2','Quote','IntlBackslash','AltRight','ShiftLeft'].every(code =>
    Number.isSafeInteger(keycodes[code]) && keycodes[code]>=8 && keycodes[code]<=255)) throw Error('XPRA_KEYMAP_UNAVAILABLE');
  return keycodes;
}

/** Read only the app display's public XKB metadata. @param {NodeJS.ProcessEnv} env */
export function hostPhysicalKeycodes(env) {
  return new Promise((resolve,reject) => {
    if (!env.DISPLAY) { reject(Error('XPRA_KEYMAP_UNAVAILABLE')); return; }
    execFile('xkbcomp',['-xkb',env.DISPLAY,'-'],{env,timeout:3000,maxBuffer:262144},(error,stdout) => {
      if (error) { reject(Error('XPRA_KEYMAP_UNAVAILABLE')); return; }
      try { resolve(physicalXkbKeycodes(stdout)); } catch (e) { reject(e); }
    });
  });
}

/** Compatibility for the shipped HTML5 client: raw XKB transport, no glyph
 * synthesis. Executed after Client.js and before its connection hello.
 * @param {{layout:string,keycodes:Record<string,number>}} keyboard */
export function rawKeyboardPatch(keyboard) {
  if (!/^[a-z0-9_-]{1,32}$/.test(keyboard.layout) || !keyboard.keycodes ||
      Object.entries(keyboard.keycodes).some(([code,n]) => !/^[A-Za-z0-9]+$/.test(code) || !Number.isSafeInteger(n) || n<8 || n>255)) throw Error('XPRA_KEYMAP_INVALID');
  return `\n;(()=>{
const layout=${JSON.stringify(keyboard.layout)}, codes=${JSON.stringify(keyboard.keycodes)};
const p=XpraClient.prototype, hello=p._make_hello;
if(typeof hello!=='function'||typeof p._keyb_process!=='function')throw Error('XPRA_KEYMAP_UNSUPPORTED');
p._make_hello=function(){this.keyboard_layout=layout;hello.call(this);this._update_capabilities({xkbmap_layout:layout,xkbmap_raw:true});this.metaviewer_raw_keyboard=true;};
p._check_browser_language=function(){};
p._keyb_process=function(pressed,event){
 if(this.server_readonly)return;
 if(!this.capture_keyboard)return true;
 const code=codes[event.code];if(!code)return;
 if(event.key==='AltGraph')this.altgr_state=pressed;
 const names={ShiftLeft:'Shift_L',ShiftRight:'Shift_R',ControlLeft:'Control_L',ControlRight:'Control_R',AltLeft:'Alt_L',AltRight:event.key==='AltGraph'?'ISO_Level3_Shift':'Alt_R',MetaLeft:'Super_L',MetaRight:'Super_R'};
 const name=names[event.code]||event.code;
 this.send(['key-action',this.topwindow,name,pressed,this._keyb_get_modifiers(event),0,'',code,0]);
};
// XKB on the capsule composes dead keys. The browser's local IME must not also
// synthesize a second text packet for that same physical key sequence.
document.addEventListener('input',event=>event.stopImmediatePropagation(),true);
})();\n`;
}
