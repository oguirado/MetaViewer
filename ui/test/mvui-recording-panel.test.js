// MetaViewer recording panel (AC-07): strict-CSP, agent_lane anchor,
// accessible-name, kit-wiring and literal-free source audits. Every
// checker ships with a planted violation proving it can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sfcUrl = new URL('../src/recording/MvRecordingPanel.vue', import.meta.url);
const cssUrl = new URL('../src/recording/recording.css', import.meta.url);
const sfc = readFileSync(sfcUrl, 'utf8');
const css = readFileSync(cssUrl, 'utf8');

/**
 * Strict CSP audit: no inline style attribute, no :style binding, no
 * v-show (runtime el.style write), no setAttribute('style'), no
 * element.style writes.
 * @param {string} source
 * @param {string} label
 */
function assertCspClean(source, label) {
  assert.doesNotMatch(source, /(?:^|[\s"'`:=])style\s*=/m, `${label}: inline style attribute`);
  assert.doesNotMatch(source, /v-bind:style/, `${label}: v-bind:style`);
  assert.doesNotMatch(source, /v-show/, `${label}: v-show writes el.style`);
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]/, `${label}: setAttribute style`);
  assert.doesNotMatch(source, /\.style\.[a-zA-Z]/, `${label}: element.style write`);
}

/**
 * agent_lane/v1 audit: every native button/input/select carries a stable
 * id AND a data-semantic-anchor.
 * @param {string} template
 * @param {string} label
 * @returns {number} Audited control count.
 */
function assertAnchoredControls(template, label) {
  const tags = template.match(/<(?:button|input|select)\b[\s\S]*?>/g) ?? [];
  for (const tag of tags) {
    assert.ok(
      /(?:^|\s):?id=/.test(tag),
      `${label}: control without id: ${tag.slice(0, 80)}`,
    );
    assert.ok(
      /(?:^|\s):?data-semantic-anchor=/.test(tag),
      `${label}: control without data-semantic-anchor: ${tag.slice(0, 80)}`,
    );
  }
  return tags.length;
}

/**
 * Accessible-name audit: every native button/input has an accessible
 * name (aria-label, associated label text, or button text).
 * @param {string} template
 * @param {string} label
 */
function assertNamedControls(template, label) {
  for (const tag of template.match(/<input\b[\s\S]*?>/g) ?? []) {
    assert.ok(
      /aria-label=/.test(tag) || /aria-labelledby=/.test(tag),
      `${label}: input without accessible name: ${tag.slice(0, 80)}`,
    );
  }
  for (const el of template.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
    const text = el
      .replace(/<[^>]*>/g, ' ')
      .replace(/\{\{[^}]*\}\}/g, 'x')
      .trim();
    assert.ok(
      /aria-label=/.test(el) || /aria-labelledby=/.test(el) || text.length > 0,
      `${label}: button without accessible name: ${el.slice(0, 80)}`,
    );
  }
}

test('recording SFC and CSS are strict-CSP clean; planted styles fail', () => {
  assertCspClean(sfc, 'MvRecordingPanel.vue');
  assertCspClean(css, 'recording.css');
  assert.throws(() => assertCspClean('<button style="color:red">x</button>', 'planted'), /inline style/);
  assert.throws(() => assertCspClean('<div :style="s" />', 'planted'), /inline style/);
  assert.throws(() => assertCspClean('<div v-show="open" />', 'planted'), /v-show/);
  assert.throws(
    () => assertCspClean(`el.setAttribute('style', 'display:none')`, 'planted'),
    /setAttribute style/,
  );
  assert.throws(() => assertCspClean('el.style.display = "none"', 'planted'), /element\.style/);
});

test('recording refusal row carries id, anchor, code and accessible name', () => {
  assert.ok(sfc.includes('mvDiskRefusalDomId'), 'refusal dom id helper wired');
  assert.ok(sfc.includes('mvDiskRefusalAnchor'), 'refusal anchor helper wired');
  assert.ok(sfc.includes('data-refusal-code'), 'typed refusal code attribute');
  assert.ok(sfc.includes('role="status"'), 'refusal live region role');
  assert.ok(sfc.includes('mvDiskRefusalAccessibleName'), 'refusal accessible name wired');
});

test('recording controls carry id, anchor and name; planted gaps fail', () => {
  const count = assertAnchoredControls(sfc, 'MvRecordingPanel.vue');
  assert.ok(count >= 4, `expected toggle, screenshot, select and export, saw ${count}`);
  assertNamedControls(sfc, 'MvRecordingPanel.vue');
  assert.throws(
    () => assertAnchoredControls('<button id="x">Go</button>', 'planted'),
    /without data-semantic-anchor/,
  );
  assert.throws(
    () => assertAnchoredControls('<button data-semantic-anchor="a/b">Go</button>', 'planted'),
    /without id/,
  );
  assert.throws(
    () => assertNamedControls('<button id="x" data-semantic-anchor="a"></button>', 'planted'),
    /without accessible name/,
  );
  assert.throws(
    () => assertNamedControls('<input id="x" data-semantic-anchor="a" type="radio" />', 'planted'),
    /without accessible name/,
  );
});

test('recording panel emits kit intents and gates export on destination and seal', () => {
  assert.ok(sfc.includes('recordings/recordingsIntents.js'), 'kit intent vocabulary imported');
  for (const builder of [
    'buildRecordAiIntent',
    'buildScreenshotIntent',
    'buildRecordingSelectIntent',
    'buildRecordingExportIntent',
  ]) {
    assert.ok(sfc.includes(builder), `kit builder wired: ${builder}`);
  }
  assert.ok(sfc.includes('./recordingModel.js'), 'lane model imported');
  assert.ok(sfc.includes("defineEmits(['submit-intent'])"), 'single intent channel');
  assert.ok(sfc.includes('rowExportGateFor'), 'per-row export gate wired');
  assert.ok(sfc.includes('recordToDiskGate'), 'export dispatch re-checks the disk gate');
  assert.ok(sfc.includes('panelDiskRefusalFor'), 'panel refusal gate wired');
  assert.ok(sfc.includes('src="./recording.css"'), 'lane CSS file used');
});

test('recording SFC and CSS carry no raw colour literals; planted hex fails', () => {
  /** @param {string} source @param {string} label */
  const assertNoHex = (source, label) => {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${label}: raw colour literal`);
  };
  assertNoHex(sfc, 'MvRecordingPanel.vue');
  assertNoHex(css, 'recording.css');
  assert.throws(() => assertNoHex('.x { color: #fff; }', 'planted'), /raw colour/);
});

test('recording sources carry no placeholder, debug or raw error text', () => {
  /** @param {string} source @param {string} label */
  const assertNoDebug = (source, label) => {
    assert.doesNotMatch(source, /TODO|FIXME|XXX|HACK|console\.log|debugger|placeholder\s*=/, `${label}`);
  };
  assertNoDebug(sfc, 'MvRecordingPanel.vue');
  assertNoDebug(css, 'recording.css');
  assert.throws(() => assertNoDebug('<!-- TODO: wire -->', 'planted'), /planted/);
});
