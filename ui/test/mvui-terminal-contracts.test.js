import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSideTerminalFacade } from '../src/terminal/sideTerminalFacade.js';

const OVERLAY_URL = new URL('../src/terminal/SideTerminalOverlay.vue', import.meta.url);
const CSS_URL = new URL('../src/terminal/terminal.css', import.meta.url);
const KIT_PANEL_URL = new URL('../.kit/capsule-ui-kit/src/side-terminal/SideTerminalPanel.vue', import.meta.url);
const overlay = readFileSync(OVERLAY_URL, 'utf8');
const css = readFileSync(CSS_URL, 'utf8');
const brokerControls = readFileSync(new URL('../src/terminal/BrokerLaunchControls.vue', import.meta.url), 'utf8');

test('overlay wrapper is stable, anchored and contributes no layout box', () => {
  const template = overlay.slice(overlay.indexOf('<template>'));
  assert.ok(template.includes('id="mv-side-terminal-overlay"'));
  assert.ok(template.includes('data-semantic-anchor="terminal/overlay"'));
  assert.ok(css.includes('.mv-side-terminal-overlay'));
  assert.ok(css.includes('display: contents'), 'wrapper must never reflow wall tiles');
});

test('overlay builds on the kit side-terminal panel with facade, providers and offsets', () => {
  assert.ok(overlay.includes('side-terminal/SideTerminalPanel.vue'));
  assert.ok(overlay.includes(':facade="facadeRef ?? undefined"'));
  assert.ok(overlay.includes(':providers="kitProviders"'));
  assert.ok(overlay.includes(':top-offset="topOffset"'));
  assert.ok(overlay.includes(':bottom-offset="bottomOffset"'));
  assert.ok(overlay.includes("defineEmits(['update:open', 'state-change'])"));
});

test('kit panel floats above the dock layer: fixed right overlay with kit z-index', () => {
  const panel = readFileSync(KIT_PANEL_URL, 'utf8');
  const style = panel.slice(panel.indexOf('<style'));
  assert.ok(style.includes('.cui-side-terminal {'));
  assert.ok(style.includes('position: fixed'));
  assert.ok(style.includes('z-index: var(--cuk-semantic-z-index-overlay)'));
});

test('overlay files honor strict CSP: no inline styles, no style bindings, no v-show', () => {
  for (const [name, text] of [['SideTerminalOverlay.vue', overlay], ['BrokerLaunchControls.vue', brokerControls], ['terminal.css', css]]) {
    assert.doesNotMatch(text, /(^|[^a-zA-Z-])style\s*=/, `${name} carries a style attribute`);
    assert.ok(!text.includes(':style'), `${name} carries a style binding`);
    assert.ok(!text.includes('v-show'), `${name} mutates element.style through v-show`);
    assert.ok(!text.includes('.style.'), `${name} writes element.style`);
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});

test('CSP check fails on a planted style binding (negative control)', () => {
  assert.ok('<aside :style="rootStyle">x</aside>'.includes(':style'));
});

test('overlay adds no unanchored interactive controls (negative control included)', () => {
  const template = overlay.slice(overlay.indexOf('<template>'));
  const tags = [...template.matchAll(/<(button|input|select|textarea)\b[^>]*>/g)].map((match) => match[0]);
  assert.deepEqual(tags, [], 'overlay interactivity stays kit-owned');
  const planted = '<button class="rogue">x</button>';
  assert.ok(!/(^|\s):?id=/.test(planted) || !/(^|\s):?data-semantic-anchor=/.test(planted));
});

test('facade serves the kit attach flow and advertises no broker launch', () => {
  const port = {
    postMessage: () => {},
    start: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const facade = createSideTerminalFacade({ session: 's', port });
  for (const method of ['capabilities', 'attach', 'onData', 'onExit', 'ack', 'write', 'resize', 'close', 'dispose']) {
    assert.equal(typeof facade[method], 'function', `facade.${method} is required by the kit model`);
  }
  assert.equal(typeof facade.open, 'undefined', 'no launch broker in this handoff: hosts refuse typed');
  assert.equal(typeof facade.setEnabled, 'undefined', 'no opt-in broker: developerMode stays host-true');
  facade.dispose();
});


test('imported broker controls expose anchored controls and the terminal anchor family',()=>{
  const template=brokerControls.slice(brokerControls.indexOf('<template>'));
  const controls=[...template.matchAll(/<(button|input|select|textarea)\b[^>]*>/g)];
  assert.ok(controls.length>0);
  for(const [tag] of controls) {
    assert.match(tag,/(^|\s):?id=/);
    assert.match(tag,/(^|\s):?data-semantic-anchor=/);
  }
  assert.ok(brokerControls.includes("anchorPrefix: { type: String, default: 'terminal' }"));
});
