import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOST_URL = new URL('../src/multislot/MultislotHost.vue', import.meta.url);
const CSS_URL = new URL('../src/multislot/multislot.css', import.meta.url);
const GATE_URL = new URL('../src/multislot/multislotInputGate.js', import.meta.url);
const PROVIDERS_URL = new URL('../src/multislot/multislotProviders.js', import.meta.url);
const COPY_URL = new URL('../src/multislot/multislotCopy.js', import.meta.url);
const ATTACH_URL = new URL('../src/multislot/multislotAttach.js', import.meta.url);
const host = readFileSync(HOST_URL, 'utf8');
const css = readFileSync(CSS_URL, 'utf8');
const brokerControls = readFileSync(new URL('../src/terminal/BrokerLaunchControls.vue', import.meta.url), 'utf8');
const sources = [host, css].join('\n');
const scripts = [GATE_URL, PROVIDERS_URL, COPY_URL, ATTACH_URL].map((url) => readFileSync(url, 'utf8')).join('\n');

/**
 * @param {string} template Vue template source.
 * @returns {string[]} Interactive elements missing a stable id, a
 * data-semantic-anchor, or an accessible name.
 */
function interactiveWithoutContract(template) {
  const missing = [];
  const tagPattern = /<(button|input|select|textarea|a)\b[^>]*>/g;
  let match = tagPattern.exec(template);
  while (match !== null) {
    const tag = match[0];
    const hasId = /(^|\s):?id=/.test(tag);
    const hasAnchor = /(^|\s):?data-semantic-anchor=/.test(tag);
    const labelled = /aria-label=|aria-labelledby=/.test(tag);
    const nameFromText = match[1] === 'button' || match[1] === 'a';
    if (!hasId || !hasAnchor || (!labelled && !nameFromText)) missing.push(tag);
    match = tagPattern.exec(template);
  }
  const clickPattern = /<([a-zA-Z][a-zA-Z0-9]*)[^>]*@click[^>]*>/g;
  let clicked = clickPattern.exec(template);
  while (clicked !== null) {
    if (!/(^|\s):?id=/.test(clicked[0]) || !/(^|\s):?data-semantic-anchor=/.test(clicked[0])) {
      missing.push(clicked[0]);
    }
    clicked = clickPattern.exec(template);
  }
  return missing;
}

test('every interactive control in MultislotHost carries id, anchor and an accessible name', () => {
  const template = host.slice(host.indexOf('<template>'));
  assert.deepEqual(interactiveWithoutContract(template), []);
  assert.ok(host.includes('mv-multislot-'), 'dismiss ids derive from the capsule id');
  assert.ok(host.includes('capsule/'), 'anchors follow the capsule/<id>/<action> family');
});

test('anchor check fails on a planted control without id or anchor (negative control)', () => {
  assert.deepEqual(interactiveWithoutContract('<button class="x">No contract</button>'), [
    '<button class="x">',
  ]);
  assert.deepEqual(
    interactiveWithoutContract(
      '<button id="a" data-semantic-anchor="b" aria-label="c" @click="d">Ok</button>',
    ),
    [],
  );
});

test('multislot files honor strict CSP: no inline styles, no style bindings, no v-show', () => {
  for (const [name, text] of [['MultislotHost.vue', host], ['BrokerLaunchControls.vue', brokerControls], ['multislot.css', css]]) {
    assert.doesNotMatch(text, /(^|[^a-zA-Z-])style\s*=/, `${name} carries a style attribute`);
    assert.ok(!text.includes(':style'), `${name} carries a style binding`);
    assert.ok(!text.includes('v-bind:style'), `${name} carries a style binding`);
    assert.ok(!text.includes('v-show'), `${name} mutates element.style through v-show`);
    assert.ok(!text.includes("setAttribute('style'"), `${name} writes a style attribute`);
    assert.ok(!text.includes('.style.'), `${name} writes element.style`);
  }
});

test('CSP check fails on a planted style attribute and on v-show (negative controls)', () => {
  const planted = '<button style="color:red">x</button>';
  assert.match(planted, /(^|[^a-zA-Z-])style\s*=/);
  assert.ok('<div v-show="open">x</div>'.includes('v-show'));
});

test('multislot styles use kit tokens only: no colour literals, no new fonts', () => {
  assert.doesNotMatch(sources, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(sources, /\brgba?\(/);
  assert.doesNotMatch(sources, /\bhsla?\(/);
  assert.doesNotMatch(css, /@font-face|font-family\s*:/);
  assert.ok(css.includes('var(--cuk-semantic-'));
});

test('colour-literal check fails on a planted hex code (negative control)', () => {
  assert.match('.x{color:#ff0000}', /#[0-9a-fA-F]{3,8}\b/);
});

test('multislot host builds on kit components and names no third-party products', () => {
  assert.ok(host.includes('multislot/AiMultiSlot.vue'));
  assert.ok(host.includes('multislot/AiSlotControlBar.vue'));
  assert.ok(host.includes("from 'capsule-ui-kit/TerminalView'"));
  assert.doesNotMatch(sources + scripts, /claude code|codex|openai|anthropic/i);
});

test('launch refusals render as a typed alert row, never raw broker text', () => {
  const template = host.slice(host.indexOf('<template>'));
  assert.ok(template.includes('role="alert"'));
  assert.ok(template.includes('refusal.code'));
  assert.ok(template.includes('refusal.message'));
  assert.doesNotMatch(template, /\{\{\s*(payload|error|err)\b/);
});

test('READ-mode gating is wired at both boundaries in the host', () => {
  assert.ok(host.includes('leaseForInputMode'));
  assert.ok(host.includes('createGatedTerminalWriter'));
  assert.ok(host.includes(':has-control-lease="hasLease"'));
  assert.ok(host.includes('onSendAuthorizedPtyInput'));
});


test('imported broker controls preserve interactive contracts and receive capsule anchor family',()=>{
  assert.deepEqual(interactiveWithoutContract(brokerControls.slice(brokerControls.indexOf('<template>'))),[]);
  assert.ok(host.includes(':anchor-prefix="`capsule/${capsuleId}`"'));
});
