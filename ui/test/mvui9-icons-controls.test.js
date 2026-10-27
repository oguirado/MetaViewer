// MVUI9 lane I: capsule action control contract audit (source level).
// Every capsule action control across the wall, the multislot host and the
// recording panel carries a stable id, a data-semantic-anchor and an
// accessible name. Kit-owned tile/multislot/record controls are pinned
// read-only so a kit swap fails loudly. Each checker ships a planted
// violation proving it can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/** Existing anchor contract: slash-separated kebab segments. */
const SLASH_ANCHOR = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
/** MVUI9 tile chrome anchors: kebab-case `tile-<surface>-<action>`. */
const TILE_ANCHOR = /^tile-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * @param {string} rel Repo-relative path under ui/.
 * @returns {string} File text.
 */
function readScope(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

/**
 * @param {string} sfc Single-file component source.
 * @returns {string} Template block (whole source when no template block).
 */
function templateOf(sfc) {
  const index = sfc.indexOf('<template>');
  return index < 0 ? sfc : sfc.slice(index);
}

/**
 * Native interactive opening tags plus full native button elements (for
 * text-name detection) and kit control-component usages.
 * @param {string} template Template source.
 * @returns {{ natives: string[], buttons: string[], kit: string[] }}
 */
function splitControls(template) {
  const natives = [
    ...(template.match(/<(?:input|select|textarea|a)\b[\s\S]*?>/g) ?? []),
  ];
  const buttons = [...(template.match(/<button\b[\s\S]*?<\/button>/g) ?? [])];
  const kit = [...(template.match(
    /<(?:UiButton|SaasRecordButton|AiRecordCluster|RecordingControlBar|AiSlotControlBar)\b[\s\S]*?(?:\/>|>)/g,
  ) ?? [])];
  return { natives, buttons, kit };
}

/**
 * Literal id stability: no whitespace, no moustaches, no Vue bindings.
 * @param {string} tag Opening tag.
 * @param {string} label Assertion label.
 */
function assertStableId(tag, label) {
  const literal = tag.match(/(?:^|\s)id="([^"]*)"/);
  const bound = /(?:^|\s):id=/.test(tag);
  assert.ok(literal || bound, `${label}: control without id: ${tag.slice(0, 90)}`);
  if (literal) {
    assert.ok(
      literal[1].length > 0 && /^[^"\s{}]+$/.test(literal[1]),
      `${label}: volatile id: ${literal[1]}`,
    );
  }
}

/**
 * Anchor presence; literal anchors must match the slash contract or the
 * MVUI9 tile form. Bound anchors resolve in the DOM mount audit.
 * @param {string} tag Opening tag.
 * @param {string} label Assertion label.
 */
function assertAnchor(tag, label) {
  const literal = tag.match(/(?:^|\s)data-semantic-anchor="([^"]*)"/);
  const bound = /(?:^|\s):data-semantic-anchor=/.test(tag);
  assert.ok(literal || bound, `${label}: control without data-semantic-anchor: ${tag.slice(0, 90)}`);
  if (literal) {
    assert.ok(
      SLASH_ANCHOR.test(literal[1]) || TILE_ANCHOR.test(literal[1]),
      `${label}: anchor is kebab-case and deterministic: ${literal[1]}`,
    );
  }
}

/**
 * Accessible name: kit label, aria link, or visible text content.
 * @param {string} element Full element source.
 * @param {string} label Assertion label.
 */
function assertAccessibleName(element, label) {
  if (/aria-label=/.test(element) || /aria-labelledby=/.test(element) || /\blabel=/.test(element)) return;
  const text = element.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, 'x').trim();
  assert.ok(text.length > 0, `${label}: control without accessible name: ${element.slice(0, 90)}`);
}

/**
 * Full source contract for one native control element.
 * @param {string} element Full element source.
 * @param {string} label Assertion label.
 */
function assertNativeContract(element, label) {
  let quote = '';
  let end = element.length;
  for (let index = 0; index < element.length; index += 1) {
    const character = element[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      end = index + 1;
      break;
    }
  }
  const open = element.slice(0, end);
  assertStableId(open, label);
  assertAnchor(open, label);
  assertAccessibleName(element, label);
}

/**
 * Kit control-component usages carry capsule identity so the kit can scope
 * stable ids and anchors; the kit SFC itself is pinned separately.
 * @param {string} tag Component usage tag.
 * @param {string} label Assertion label.
 */
function assertKitUsage(tag, label) {
  if (tag.startsWith('<UiButton')) {
    assert.match(tag, /(?:^|\s)id="[^"\s{}]+"/, `${label}: UiButton keeps a literal id`);
    assert.match(tag, /(?:^|\s)data-semantic-anchor="[^"]+"/, `${label}: UiButton keeps a literal anchor`);
    assert.match(tag, /(?:^|\s)label="[^"]+"/, `${label}: UiButton keeps a label`);
    return;
  }
  assert.ok(
    /(?:^|\s):?capsule-id=/.test(tag),
    `${label}: kit control without capsule identity: ${tag.slice(0, 90)}`,
  );
}

/** Require a visible decorative icon through the imported kit wrapper.
 * @param {string} button Full native button element.
 * @param {string} label Assertion label.
 */
function assertKitIcon(button, label) {
  assert.match(button, /<SidebarIcon\b[^>]*\bname="[^"]+"[^>]*\baria-hidden="true"[^>]*\/>/,
    `${label}: action without decorative kit icon`);
  assert.doesNotMatch(button, /<SidebarIcon\b[^>]*(?:\bv-if=|\bv-show=|\shidden(?:\s|=|>))/,
    `${label}: action icon must stay visible`);
}

test('capsule action icons use the kit wrapper and reject every removed icon', () => {
  for (const [rel, count] of [
    ['src/recording/MvRecordingPanel.vue', 5],
    ['src/multislot/MultislotHost.vue', 2],
    ['src/terminal/BrokerLaunchControls.vue', 1],
  ]) {
    const source = readScope(rel);
    assert.match(source, /import SidebarIcon from ['"]\.\.\/\.\.\/\.kit\/capsule-ui-kit\/src\/shell\/SidebarIcon\.vue['"]/,
      `${rel}: real kit icon import`);
    const { buttons } = splitControls(templateOf(source));
    assert.equal(buttons.length, count, `${rel}: complete action inventory`);
    for (const button of buttons) {
      assertKitIcon(button, rel);
      const withoutIcon = button.replace(/<SidebarIcon\b[^>]*\/>/g, '');
      assert.throws(() => assertKitIcon(withoutIcon, rel), /without decorative kit icon/,
        `${rel}: removing any action icon fails`);
    }
  }
});

test('recording panel controls are contracted: toggle, screenshot, select, export, shots export', () => {
  const sfc = readScope('src/recording/MvRecordingPanel.vue');
  const template = templateOf(sfc);
  const { buttons } = splitControls(template);
  assert.equal(buttons.length, 5, `toggle, screenshot, select, export and shots-export buttons, saw ${buttons.length}`);
  for (const button of buttons) assertNativeContract(button, 'MvRecordingPanel.vue');
  // MVUI19B lane I: the five-control inventory pins each family, so a
  // swapped-in foreign button cannot hold the count at 5.
  for (const [token, family] of [
    ['mvRecordToggleAnchor', 'toggle'],
    ['mvScreenshotAnchor', 'screenshot'],
    ['entry.selectAnchor', 'select'],
  ]) {
    assert.ok(buttons.some((button) => button.includes(token)), `${family} present`);
  }
  assert.equal(
    buttons.filter((button) => button.includes('entry.exportAnchor')).length,
    2,
    'recordings export plus screenshots-section export present',
  );
  // The fifth control lives in the screenshots section and is its only action.
  const shotsSection = template.indexOf('mv4-shots-title');
  assert.ok(shotsSection >= 0, 'screenshots section present');
  const shotsButtons = template.slice(shotsSection).match(/<button\b[\s\S]*?<\/button>/g) ?? [];
  assert.equal(shotsButtons.length, 1, `screenshots section owns one action, saw ${shotsButtons.length}`);
  assert.ok(shotsButtons[0].includes('entry.exportDomId'), 'shots export keeps a stable id binding');
  assert.ok(shotsButtons[0].includes('entry.exportAnchor'), 'shots export keeps an anchor binding');
  for (const helper of [
    'mvRecordToggleAnchor',
    'mvScreenshotAnchor',
    'mvManifestSelectAnchor',
    'mvExportAnchor',
    'mvRecordToggleDomId',
    'mvScreenshotDomId',
    'mvManifestSelectDomId',
    'mvExportDomId',
  ]) {
    assert.ok(sfc.includes(helper), `panel anchor/id helper wired: ${helper}`);
  }
});

test('multislot host keeps two contracted dismiss buttons; broker menu is contracted', () => {
  const host = templateOf(readScope('src/multislot/MultislotHost.vue'));
  const { buttons } = splitControls(host);
  assert.equal(buttons.length, 2, `notice + refusal dismiss buttons, saw ${buttons.length}`);
  for (const button of buttons) assertNativeContract(button, 'MultislotHost.vue');
  assert.ok(buttons.some((tag) => tag.includes('noticeDismissAnchor')), 'session-notice dismiss anchor');
  assert.ok(buttons.some((tag) => tag.includes('refusalDismissAnchor')), 'launch-refusal dismiss anchor');
  const broker = templateOf(readScope('src/terminal/BrokerLaunchControls.vue'));
  const brokerControls = splitControls(broker);
  assert.ok(brokerControls.natives.length >= 1, 'terminal enable input present');
  for (const input of brokerControls.natives) assertNativeContract(input, 'BrokerLaunchControls.vue');
  for (const button of brokerControls.buttons) assertNativeContract(button, 'BrokerLaunchControls.vue');
  assert.ok(broker.includes('/provider/'), 'provider menu anchors stay capsule-scoped');
});

test('shell capsule actions keep literal id, anchor and label', () => {
  const template = templateOf(readScope('src/App.vue'));
  for (const [id, anchor] of [
    ['shell-terminal', 'terminal/toggle'],
    ['shell-multislot', 'capsule/open-multislot'],
    ['multislot-back', 'multislot/back'],
  ]) {
    const usage = template.match(new RegExp(`<UiButton\\b[^>]*id="${id}"[^>]*>`));
    assert.ok(usage, `shell action present: ${id}`);
    assert.ok(usage[0].includes(`data-semantic-anchor="${anchor}"`), `shell action anchor: ${anchor}`);
    assert.match(usage[0], /label="[^"]+"/, `shell action label: ${id}`);
    assert.ok(SLASH_ANCHOR.test(anchor), `shell anchor keeps the slash contract: ${anchor}`);
  }
});

test('wall SFCs: every native control is contracted; kit usages carry identity', () => {
  const dir = new URL('../src/wall/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.vue')).sort();
  assert.ok(files.includes('SurfacePanel.vue'), 'public tile component present');
  assert.ok(files.includes('WallWorkspace.vue'), 'public wall component present');
  for (const file of files) {
    const template = templateOf(readScope(`src/wall/${file}`));
    const { natives, buttons, kit } = splitControls(template);
    for (const input of natives) assertNativeContract(input, file);
    for (const button of buttons) assertNativeContract(button, file);
    for (const usage of kit) assertKitUsage(usage, file);
    if (file === 'TileCaptureChrome.vue') {
      const helpers = readScope('src/wall/tileCapture.js');
      for (const family of ['-record-ai', '-screenshot', '-recording-badge']) {
        assert.ok(helpers.includes(family), `tileCapture.js owns the tile-*-${family} family`);
      }
      for (const binding of ['recordAnchor', 'shotAnchor', 'badgeAnchor']) {
        assert.ok(template.includes(binding), `tile chrome binds ${binding}`);
      }
    }
  }
});

test('kit 0.2.1 pins (read-only): tile, multislot and record controls stay anchored', () => {
  const panel = readScope('.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue');
  const segments = panel.split('<button').slice(1);
  /** @param {string} token @param {string} family */
  const segmentFor = (token, family) => {
    const found = segments.filter((segment) => segment.includes(token));
    assert.ok(found.length >= 1, `kit CapsulePanel renders ${family}`);
    return found;
  };
  for (const [token, family] of [
    ['anchors.fold', 'fold'],
    ['anchors.control', 'take/release control'],
    ['anchors.close', 'close'],
    ['anchors.pin', 'pin'],
    ['anchors.popout', 'popout'],
    ['anchors.dockBack', 'dock-back'],
    ['capsule/${capsuleId}/hide', 'window hide'],
    ['capsule/${capsuleId}/float', 'window float'],
    ['capsule/${capsuleId}/maximize', 'window maximize'],
  ]) {
    for (const segment of segmentFor(token, family)) {
      const open = `<button${segment.slice(0, segment.indexOf('>'))}>`;
      assert.ok(/(?:^|\s):id=/.test(open), `kit ${family} keeps an id binding`);
      assert.ok(/aria-label=/.test(open), `kit ${family} keeps an accessible name binding`);
    }
  }
  const closeStyled = segments.find((segment) => segment.includes('anchors.close'));
  assert.ok(closeStyled.includes('<svg'), 'kit close keeps its styled-branch glyph icon');
  const dockStyled = segments.find((segment) => segment.includes('anchors.dockBack'));
  assert.ok(dockStyled.includes('<svg'), 'kit dock-back keeps its styled-branch glyph icon');
  for (const [rel, tokens] of [
    ['.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue', ['entry.anchor', 'closeAnchor']],
    ['.kit/capsule-ui-kit/src/multislot/AiRecordCluster.vue', ['aiAnchor', 'shotAnchor', 'exportAnchorValue']],
    ['.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue', [':data-semantic-anchor="anchor"']],
    ['.kit/capsule-ui-kit/src/recordings/RecordingControlBar.vue', ['toggleAnchorValue', 'shotAnchorValue']],
  ]) {
    const source = readScope(rel);
    for (const token of tokens) assert.ok(source.includes(token), `${rel} keeps ${token}`);
    assert.ok(source.includes(':id='), `${rel} keeps id bindings`);
    assert.ok(source.includes('aria-label'), `${rel} keeps accessible names`);
  }
});

/**
 * Renderer-owned native buttons without a kit wrapper. Fixes (a kit-wrapper
 * swap) only shrink the found set; any unlisted native button fails.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const KNOWN_NATIVE = Object.freeze([
  ['src/recording/MvRecordingPanel.vue', 'mvRecordToggleAnchor'],
  ['src/recording/MvRecordingPanel.vue', 'mvScreenshotAnchor'],
  ['src/recording/MvRecordingPanel.vue', 'entry.selectAnchor'],
  ['src/recording/MvRecordingPanel.vue', 'entry.exportAnchor'],
  ['src/multislot/MultislotHost.vue', 'noticeDismissAnchor'],
  ['src/multislot/MultislotHost.vue', 'refusalDismissAnchor'],
  ['src/terminal/BrokerLaunchControls.vue', '/provider/'],
]);

/**
 * @param {string} rel Repo-relative path.
 * @param {string} button Full native button element.
 * @returns {boolean} True when the button is a known kit-wrapper gap.
 */
function isKnownNative(rel, button) {
  if (rel.startsWith('src/wall/')) {
    const binding = button.match(/:data-semantic-anchor="([^"]+)"/)?.[1] ?? '';
    const literal = button.match(/(?:^|\s)data-semantic-anchor="([^"]+)"/)?.[1] ?? '';
    return ['recordAnchor', 'shotAnchor', 'badgeAnchor'].includes(binding)
      || binding.includes('tile') || TILE_ANCHOR.test(literal);
  }
  return KNOWN_NATIVE.some(([file, key]) => rel === file && button.includes(key));
}

test('native-button inventory: unknown renderer-owned buttons fail', () => {
  const scope = [
    'src/App.vue',
    'src/multislot/MultislotHost.vue',
    'src/recording/MvRecordingPanel.vue',
    'src/terminal/BrokerLaunchControls.vue',
  ];
  const wallDir = new URL('../src/wall/', import.meta.url);
  for (const name of readdirSync(wallDir).filter((entry) => entry.endsWith('.vue')).sort()) {
    scope.push(`src/wall/${name}`);
  }
  const found = [];
  for (const rel of scope) {
    const { buttons } = splitControls(templateOf(readScope(rel)));
    for (const button of buttons) {
      found.push(rel);
      assert.ok(
        isKnownNative(rel, button),
        `${rel}: native button without a kit wrapper is not inventoried: ${button.slice(0, 90)}`,
      );
    }
  }
  assert.ok(found.length >= 7, `inventory covers the known native buttons, saw ${found.length}`);
  assert.throws(
    () => assert.ok(
      isKnownNative('src/recording/MvRecordingPanel.vue', '<button :id="x" :data-semantic-anchor="new/thing">x</button>'),
      'planted',
    ),
    /planted/,
    'an unlisted native button fails the inventory',
  );
});

test('renderer scope renders no hand-owned svg icons: kit wrappers only', () => {
  const scope = [
    'src/App.vue',
    'src/multislot/MultislotHost.vue',
    'src/recording/MvRecordingPanel.vue',
    'src/terminal/BrokerLaunchControls.vue',
  ];
  const wallDir = new URL('../src/wall/', import.meta.url);
  for (const name of readdirSync(wallDir).filter((entry) => entry.endsWith('.vue')).sort()) {
    scope.push(`src/wall/${name}`);
  }
  for (const rel of scope) {
    assert.doesNotMatch(readScope(rel), /<svg[\s>]/, `${rel}: icons render through kit wrappers only`);
  }
  assert.throws(
    () => assert.doesNotMatch('<button><svg viewBox="0 0 1 1"></svg></button>', /<svg[\s>]/, 'planted'),
    /planted/,
    'a planted renderer-owned svg fails',
  );
});

test('negative controls: id, anchor, shape, name and uniqueness checkers fail', () => {
  assertNativeContract('<button id="a" data-semantic-anchor="wall/add-capsule" aria-label="Add">x</button>', 'planted-good');
  assertNativeContract('<button id="tile-cap-01-record-ai" data-semantic-anchor="tile-cap-01-record-ai" aria-label="Record">x</button>', 'planted-tile');
  for (const [bad, pattern] of [
    ['<button data-semantic-anchor="wall/add-capsule" aria-label="Add">x</button>', /without id/],
    ['<button id="a b" data-semantic-anchor="wall/add-capsule" aria-label="Add">x</button>', /volatile id/],
    ['<button id="a-{{ n }}" data-semantic-anchor="wall/add-capsule" aria-label="Add">x</button>', /volatile id/],
    ['<button id="a" aria-label="Add">x</button>', /without data-semantic-anchor/],
    ['<button id="a" data-semantic-anchor="Wall/Add" aria-label="Add">x</button>', /kebab-case/],
    ['<button id="a" data-semantic-anchor="wall/add capsule" aria-label="Add">x</button>', /kebab-case/],
    ['<button id="a" data-semantic-anchor="tile-CAP-01-record-ai" aria-label="Add">x</button>', /kebab-case/],
    ['<button id="a" data-semantic-anchor="wall/add-capsule"></button>', /without accessible name/],
    ['<input id="a" data-semantic-anchor="wall/add-capsule" type="checkbox" />', /without accessible name/],
  ]) {
    assert.throws(() => assertNativeContract(bad, 'planted'), pattern, bad);
  }
  /** @param {string[]} anchors */
  const assertUniqueAnchors = (anchors) => {
    const seen = new Set();
    for (const anchor of anchors) {
      assert.ok(!seen.has(anchor), `duplicate anchor in snapshot: ${anchor}`);
      seen.add(anchor);
    }
  };
  assertUniqueAnchors(['wall/add-capsule', 'tile-cap-01-record-ai']);
  assert.throws(
    () => assertUniqueAnchors(['wall/add-capsule', 'wall/add-capsule']),
    /duplicate anchor/,
    'a duplicated anchor fails the uniqueness checker',
  );
});

test('native contract scans past greater-than signs inside quoted attributes', () => {
  for (const quote of ['"', "'"]) {
    const element = `<button :disabled=${quote}count > 0${quote} id="cap-action" data-semantic-anchor="capsule/cap/action">Go</button>`;
    assert.doesNotThrow(() => assertNativeContract(element, 'quoted comparison'));
    assert.throws(() => assertNativeContract(element.replace(' id="cap-action"', ''), 'missing id'));
  }
});
