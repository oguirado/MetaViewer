// MVUI9 lane T: tile capture chrome unit + static contracts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TILE_CAPTURE_PHASES,
  TILE_CAPTURE_ELAPSED_UNKNOWN,
  TILE_CAPTURE_UNAVAILABLE_REASON,
  hasCaptureActions,
  isCaptureUnavailable,
  isTileCapturePhase,
  normalizeTileCapturePhase,
  readSurfaceEntry,
  surfaceEntryPhase,
  tileBadgeAnchor,
  tileBadgeDomId,
  tileBadgeText,
  tileBadgeVariant,
  tileCapturePhaseBusy,
  tileChromeGroupName,
  tileChromeLabel,
  tileIdSegment,
  tileRecordAnchor,
  tileRecordDomId,
  tileScreenshotAnchor,
  tileScreenshotDomId,
  tileShotAccessibleName,
  tileShotLabel,
  formatTileElapsedMs,
} from '../src/wall/tileCapture.js';
import { MV_RECORDING_PHASES } from '../src/recording/recordingModel.js';

const CHROME_URL = new URL('../src/wall/TileCaptureChrome.vue', import.meta.url);
const PANEL_URL = new URL('../src/wall/SurfacePanel.vue', import.meta.url);
const WALL_URL = new URL('../src/wall/WallWorkspace.vue', import.meta.url);
const CSS_URL = new URL('../src/wall/wall.css', import.meta.url);
const KIT_PANEL_URL = new URL('../.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue', import.meta.url);

describe('tile capture phases', () => {
  test('closed phase set matches the recording model and freezes', () => {
    assert.deepEqual(TILE_CAPTURE_PHASES,
      ['idle', 'starting', 'recording', 'stopping', 'sealed', 'error']);
    assert.deepEqual([...TILE_CAPTURE_PHASES], [...MV_RECORDING_PHASES]);
    assert.equal(Object.isFrozen(TILE_CAPTURE_PHASES), true);
    assert.throws(() => TILE_CAPTURE_PHASES.push('mutant'), TypeError);
  });

  test('phase guard admits the six phases only; every mutant refuses', () => {
    for (const phase of TILE_CAPTURE_PHASES) assert.equal(isTileCapturePhase(phase), true);
    for (const bad of ['', 'IDLE', 'record', 'capturing', 'done', 'sealed ', 7,
      null, undefined, {}, ['idle']]) {
      assert.equal(isTileCapturePhase(bad), false, JSON.stringify(bad));
      assert.equal(normalizeTileCapturePhase(bad), 'idle', JSON.stringify(bad));
    }
  });

  test('busy is true only while the host transition is pending', () => {
    assert.equal(tileCapturePhaseBusy('starting'), true);
    assert.equal(tileCapturePhaseBusy('stopping'), true);
    for (const phase of ['idle', 'recording', 'sealed', 'error', 'mutant', null]) {
      assert.equal(tileCapturePhaseBusy(phase), false, String(phase));
    }
  });
});

describe('tile id segments and anchors', () => {
  test('canonical surfaces pass through; reserved prefix is encoded', () => {
    assert.equal(tileIdSegment('cap-1'), 'cap-1');
    assert.equal(tileIdSegment('a'), 'a');
    assert.equal(tileRecordDomId('cap-1'), 'tile-cap-1-record-ai');
    assert.equal(tileRecordAnchor('cap-1'), 'tile-cap-1-record-ai');
    assert.equal(tileScreenshotDomId('cap-1'), 'tile-cap-1-screenshot');
    assert.equal(tileScreenshotAnchor('cap-1'), 'tile-cap-1-screenshot');
    assert.equal(tileBadgeDomId('cap-1'), 'tile-cap-1-recording-badge');
    assert.equal(tileBadgeAnchor('cap-1'), 'tile-cap-1-recording-badge');
    assert.ok(tileIdSegment('encoded-x').startsWith('encoded-'));
    assert.notEqual(tileIdSegment('encoded-x'), 'encoded-x');
  });

  test('non-canonical surfaces encode deterministically without collisions', () => {
    const samples = ['Cap-01', 'cap 01', 'cap_01', 'CAP', '', 'a/b', 'cap-1',
      'encoded-1', null, undefined, 7];
    const seen = new Map();
    for (const sample of samples) {
      const first = tileIdSegment(sample);
      const second = tileIdSegment(sample);
      assert.equal(first, second, `deterministic for ${JSON.stringify(sample)}`);
      assert.match(first, /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        `kebab-safe segment for ${JSON.stringify(sample)}`);
      for (const other of samples) {
        if (other !== sample) {
          assert.notEqual(tileIdSegment(other), first,
            `no collision between ${JSON.stringify(sample)} and ${JSON.stringify(other)}`);
        }
      }
      seen.set(sample, first);
    }
    assert.equal(seen.size, samples.length);
  });

  test('anchor family is kebab-case, prefixed and unique per snapshot', () => {
    const surfaces = ['cap-1', 'cap-2', 'cap-3', 'cap-4'];
    const anchors = surfaces.flatMap((surface) => [
      tileRecordAnchor(surface),
      tileScreenshotAnchor(surface),
      tileBadgeAnchor(surface),
    ]);
    assert.equal(anchors.length, 12);
    assert.equal(new Set(anchors).size, 12);
    for (const anchor of anchors) {
      assert.match(anchor, /^tile-[a-z0-9]+(?:-[a-z0-9]+)*-(record-ai|screenshot|recording-badge)$/);
    }
  });
});

/** Fail-closed tile-anchor predicate: stable id, tile anchor, named label. */
function assertTileChromeControl(tag) {
  assert.match(tag, /\bid="[^"]+"/, `control keeps a stable id: ${tag}`);
  const anchor = tag.match(/\bdata-semantic-anchor="([^"]+)"/);
  assert.ok(anchor, `control keeps a data-semantic-anchor: ${tag}`);
  assert.match(anchor[1], /^tile-[a-z0-9]+(?:-[a-z0-9]+)*-(record-ai|screenshot|recording-badge)$/,
    `anchor is a deterministic tile anchor: ${anchor[1]}`);
  assert.ok(tag.includes('aria-label=') || tag.includes('aria-labelledby=') || />[^<]+<\//.test(tag),
    `control keeps an accessible name: ${tag}`);
}

describe('tile anchor predicate', () => {
  test('well-formed chrome tags pass', () => {
    assertTileChromeControl('<span id="tile-cap-1-record-ai" data-semantic-anchor="tile-cap-1-record-ai" aria-label="x"></span>');
    assertTileChromeControl('<button id="tile-cap-1-screenshot" data-semantic-anchor="tile-cap-1-screenshot" aria-label="Screenshot cap-1">go</button>');
    assertTileChromeControl('<span id="tile-cap-1-recording-badge" data-semantic-anchor="tile-cap-1-recording-badge" role="status">Idle</span>');
  });

  test('negative control: missing anchor, id or name fails', () => {
    for (const bad of [
      '<button data-semantic-anchor="tile-cap-1-screenshot" aria-label="x">go</button>',
      '<button id="tile-cap-1-screenshot" aria-label="x">go</button>',
      '<button id="tile-cap-1-screenshot" data-semantic-anchor="tile-cap-1-screenshot"></button>',
      '<button id="tile-cap-1-screenshot" data-semantic-anchor="Tile/cap-1/shot" aria-label="x">go</button>',
      '<button id="tile-cap-1-screenshot" data-semantic-anchor="recording/cap-1/screenshot" aria-label="x">go</button>',
      '<button>go</button>',
    ]) {
      assert.throws(() => assertTileChromeControl(bad), assert.AssertionError, bad);
    }
  });
});

describe('tile chrome copy', () => {
  test('labels fall back to the capsule id, never blank', () => {
    assert.equal(tileChromeLabel({ capsuleLabel: ' Research ', capsuleId: 'cap-1' }), 'Research');
    assert.equal(tileChromeLabel({ capsuleLabel: '', capsuleId: 'cap-1' }), 'cap-1');
    assert.equal(tileChromeLabel({ capsuleId: 'cap-1' }), 'cap-1');
    assert.equal(tileChromeLabel(null), 'capsule');
    assert.equal(tileChromeGroupName({ capsuleLabel: '', capsuleId: 'cap-1' }),
      'Tile capture controls for cap-1');
  });

  test('screenshot label tracks capture state; fresh capture reads Captured', () => {
    assert.equal(tileShotLabel({ capturing: false }), 'Screenshot');
    assert.equal(tileShotLabel(null), 'Screenshot');
    assert.equal(tileShotLabel({ capturing: true }), 'Capturing');
    assert.equal(tileShotLabel({ capturing: true, lastShot: { id: 's1' } }), 'Capturing');
    assert.equal(tileShotLabel({ capturing: false, lastShot: { id: 's1' } }), 'Captured');
    assert.equal(tileShotAccessibleName({ capsuleId: 'cap-1', capturing: false }),
      'Screenshot cap-1');
    assert.equal(tileShotAccessibleName({ capsuleId: 'cap-1', capturing: true }),
      'Screenshot capture pending on cap-1');
    assert.equal(tileShotAccessibleName({ capsuleId: 'cap-1', lastShot: { id: 's1' } }),
      'Screenshot captured on cap-1');
  });

  test('elapsed formats MM:SS; unreadable values never fabricate a zero', () => {
    assert.equal(formatTileElapsedMs(0), '00:00');
    assert.equal(formatTileElapsedMs(999), '00:00');
    assert.equal(formatTileElapsedMs(61000), '01:01');
    assert.equal(formatTileElapsedMs(125000), '02:05');
    assert.equal(formatTileElapsedMs(3599999), '59:59');
    assert.equal(formatTileElapsedMs(3600000), '60:00');
    for (const bad of [-1, NaN, Infinity, '61000', null, undefined, {}, [1]]) {
      assert.equal(formatTileElapsedMs(bad), TILE_CAPTURE_ELAPSED_UNKNOWN, JSON.stringify(bad));
    }
    assert.equal(TILE_CAPTURE_ELAPSED_UNKNOWN, '--:--');
  });

  test('badge text carries elapsed only while recording; error renders Idle', () => {
    assert.equal(tileBadgeText({ phase: 'recording', elapsedMs: 125000 }), 'Recording 02:05');
    assert.equal(tileBadgeText({ phase: 'recording' }), 'Recording --:--');
    assert.equal(tileBadgeText({ phase: 'starting' }), 'Starting');
    assert.equal(tileBadgeText({ phase: 'stopping' }), 'Stopping');
    assert.equal(tileBadgeText({ phase: 'sealed' }), 'Sealed');
    assert.equal(tileBadgeText({ phase: 'idle' }), 'Idle');
    assert.equal(tileBadgeText({ phase: 'error' }), 'Idle');
    assert.equal(tileBadgeText(null), 'Idle');
    for (const phase of [...TILE_CAPTURE_PHASES, 'mutant', null]) {
      for (const elapsedMs of [0, 61000, null, 'x']) {
        const text = tileBadgeText({ phase, elapsedMs });
        assert.doesNotMatch(text, /error/i, `no error text for ${String(phase)}`);
        assert.doesNotMatch(text, /ERR_/, `no refusal code for ${String(phase)}`);
        assert.doesNotMatch(text, /undefined/, `no leak for ${String(phase)}`);
      }
    }
  });

  test('badge variant is a closed four-value hook', () => {
    assert.equal(tileBadgeVariant({ phase: 'recording' }), 'recording');
    assert.equal(tileBadgeVariant({ phase: 'starting' }), 'busy');
    assert.equal(tileBadgeVariant({ phase: 'stopping' }), 'busy');
    assert.equal(tileBadgeVariant({ phase: 'sealed' }), 'sealed');
    for (const phase of ['idle', 'error', 'mutant', null]) {
      assert.equal(tileBadgeVariant({ phase }), 'idle', String(phase));
    }
  });
});

describe('capture store reads', () => {
  test('entries read from Map or plain object stores', () => {
    const entry = { phase: 'recording', elapsedMs: 5000 };
    assert.equal(readSurfaceEntry({ bySurface: new Map([['cap-1', entry]]) }, 'cap-1'), entry);
    assert.equal(readSurfaceEntry({ bySurface: { 'cap-1': entry } }, 'cap-1'), entry);
    assert.equal(surfaceEntryPhase(entry), 'recording');
    assert.equal(surfaceEntryPhase(null), 'idle');
    assert.equal(surfaceEntryPhase({ phase: 'mutant' }), 'idle');
  });

  test('missing store, surface or malformed entry yields null, never throws', () => {
    for (const store of [null, undefined, {}, { bySurface: null }, { bySurface: [] },
      { bySurface: 'x' }, { bySurface: new Map() }, { bySurface: {} }]) {
      assert.equal(readSurfaceEntry(store, 'cap-1'), null, JSON.stringify(store));
    }
    for (const entry of ['x', 7, ['recording'], null]) {
      assert.equal(readSurfaceEntry({ bySurface: { 'cap-1': entry } }, 'cap-1'), null);
    }
    assert.equal(readSurfaceEntry({ bySurface: {} }, ''), null);
    assert.equal(readSurfaceEntry({ bySurface: {} }, null), null);
    assert.equal(surfaceEntryPhase('recording'), 'idle');
  });

  test('actions present on both callables only; unavailable covers every gap', () => {
    const toggleRecord = async () => ({ ok: true });
    const screenshot = async () => ({ ok: true });
    assert.equal(hasCaptureActions({ toggleRecord, screenshot }), true);
    for (const store of [null, undefined, {}, { toggleRecord }, { screenshot },
      { toggleRecord: 'x', screenshot }, 7, 'store']) {
      assert.equal(hasCaptureActions(store), false, JSON.stringify(store));
      assert.equal(isCaptureUnavailable(store), true, JSON.stringify(store));
    }
    assert.equal(isCaptureUnavailable({ toggleRecord, screenshot }), false);
    assert.equal(isCaptureUnavailable({ toggleRecord, screenshot, available: true }), false);
    assert.equal(isCaptureUnavailable({ toggleRecord, screenshot, available: false }), true);
    assert.equal(TILE_CAPTURE_UNAVAILABLE_REASON, 'Recording is unavailable');
  });
});

/** Fail-closed source predicate: any inline presentation vector throws. */
function assertNoInlineVector(source, label) {
  assert.doesNotMatch(source, /style\s*=/, `${label}: no style attribute`);
  assert.doesNotMatch(source, /:style\b/, `${label}: no :style binding`);
  assert.doesNotMatch(source, /v-bind:style/, `${label}: no v-bind:style`);
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]/, `${label}: no setAttribute`);
  assert.doesNotMatch(source, /\.style\b/, `${label}: no element style write`);
  assert.doesNotMatch(source, /element\.style/, `${label}: no element style reference`);
}

/** Fail-closed CSS predicate: kit tokens only, no literals or remote loads. */
function assertTokenOnlyCss(css, label) {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${label}: no hex literal`);
  assert.doesNotMatch(css, /rgba?\(/, `${label}: no rgb() literal`);
  assert.doesNotMatch(css, /hsla?\(/, `${label}: no hsl() literal`);
  assert.doesNotMatch(css, /@import/, `${label}: no @import`);
  assert.doesNotMatch(css, /url\(/, `${label}: no url() load`);
  assert.ok(css.includes('var(--cuk-'), `${label}: styles build on kit tokens`);
}

describe('lane T CSP surface', () => {
  test('new and edited lane files carry zero inline vectors', () => {
    for (const [url, label] of [[CHROME_URL, 'TileCaptureChrome.vue'],
      [PANEL_URL, 'SurfacePanel.vue'], [WALL_URL, 'WallWorkspace.vue'],
      [CSS_URL, 'wall.css']]) {
      assertNoInlineVector(readFileSync(url, 'utf8'), label);
    }
    assertNoInlineVector(
      readFileSync(new URL('../src/wall/tileCapture.js', import.meta.url), 'utf8'),
      'tileCapture.js');
  });

  test('chrome CSS builds on kit tokens with compact, overflow-free rules', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    assertTokenOnlyCss(css, 'wall.css');
    const chrome = css.slice(css.indexOf('MVUI9 tile capture chrome'));
    assert.ok(chrome.length > 0, 'chrome section is present');
    for (const selector of ['.mv-tile-chrome', '.mv-tile-chrome__record',
      '.mv-tile-chrome__shot', '.mv-tile-chrome__badge']) {
      assert.ok(chrome.includes(selector), `rule for ${selector}`);
    }
    assert.match(css, /\.mv-tile \{\s*[^}]*display:\s*flex[^}]*flex-direction:\s*column/s,
      'tile stacks the rail above the kit panel');
    assert.ok(chrome.includes('text-overflow: ellipsis'), 'badge absorbs narrowing');
    assert.ok(chrome.includes('.mv-tile-chrome__shot:focus-visible'), 'visible focus');
    assert.ok(chrome.includes('.mv-tile-chrome__shot:disabled'), 'disabled treatment');
    for (const variant of ['recording', 'busy', 'sealed']) {
      assert.ok(chrome.includes(`[data-variant="${variant}"]`), `treatment for ${variant}`);
    }
    assert.doesNotMatch(chrome, /width:\s*\d+px/, 'no fixed pixel widths in the rail');
    assert.doesNotMatch(chrome, /min-width:\s*\d+px/, 'no fixed pixel floors in the rail');
  });

  test('negative control: each planted vector fails its own predicate', () => {
    for (const planted of [
      '<div style="color: red">planted attribute</div>',
      '<div :style="{ color: c }">planted binding</div>',
      'el.setAttribute(\'style\', \'display:none\')',
      'element.style.display = \'none\'',
    ]) {
      assert.throws(() => assertNoInlineVector(planted, 'planted'), assert.AssertionError,
        planted);
    }
    for (const planted of ['.a{color:#fff}', '.a{color:rgb(1,2,3)}',
      '@import url("https://example.invalid/x.css")', '.a{background:url(x.png)}']) {
      assert.throws(() => assertTokenOnlyCss(planted, 'planted'), assert.AssertionError,
        planted);
    }
    assert.throws(() => assertTokenOnlyCss('.a{color:red}', 'planted'), assert.AssertionError,
      'token-free CSS fails the kit-token predicate');
  });
});

describe('TileCaptureChrome static contract (pinned compiler)', async () => {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc');
  const source = readFileSync(CHROME_URL, 'utf8');

  test('SFC parses with setup script and template; no authored TS or lane CSS', () => {
    const { descriptor, errors } = parse(source, { filename: 'TileCaptureChrome.vue' });
    assert.equal(errors.length, 0);
    assert.ok(descriptor.scriptSetup, 'setup script declares props');
    assert.ok(!descriptor.script, 'no separate module script: helpers live in tileCapture.js');
    assert.ok(descriptor.template, 'template renders the rail');
    assert.equal(descriptor.styles.length, 0, 'lane CSS lives in wall.css');
    for (const block of [descriptor.scriptSetup, descriptor.template]) {
      assert.ok(!block.lang || block.lang === 'js', 'JavaScript only, no authored TypeScript');
    }
  });

  test('template and setup compile with zero errors under the pinned compiler', () => {
    const { descriptor } = parse(source, { filename: 'TileCaptureChrome.vue' });
    const template = compileTemplate({
      source: descriptor.template.content,
      filename: 'TileCaptureChrome.vue',
      id: 'tile-chrome-test',
    });
    assert.equal(template.errors.length, 0);
    const script = compileScript(descriptor, { id: 'tile-chrome-test', inlineTemplate: true });
    assert.ok(script.content.length > 0);
  });

  test('imports stay inside vue, the kit record toggle, the kit icon and the lane helpers', () => {
    const specifiers = [...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)]
      .map((m) => m[1]);
    assert.deepEqual([...new Set(specifiers)].sort(), [
      '../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue',
      '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue',
      './tileCapture.js',
      'vue',
    ]);
  });

  test('capture props are optional with null/false defaults', () => {
    assert.match(source, /captureState:\s*\{[\s\S]*?default:\s*null/s);
    assert.match(source, /displayOnly:\s*\{[\s\S]*?default:\s*false/s);
    assert.match(source, /capsuleId:\s*\{\s*type:\s*String,\s*required:\s*true/s);
  });

  test('rail renders the record handle, screenshot control and badge with tile anchors', () => {
    const template = source.slice(source.indexOf('<template>'));
    assert.match(template, /<div v-if="!props\.displayOnly" class="mv-tile-chrome" role="group"/);
    assert.match(template, /<span :id="recordWrapId" class="mv-tile-chrome__record" :data-semantic-anchor="recordAnchor">/);
    assert.match(template, /<SaasRecordButton[\s\S]*?:phase="phase"[\s\S]*?:disabled="recordDisabled"[\s\S]*?:unavailable-reason="recordReason"[\s\S]*?@submit-intent="onRecordIntent"/);
    assert.match(template, /<button[\s\S]*?:id="shotId"[\s\S]*?class="mv-tile-chrome__shot"[\s\S]*?:data-semantic-anchor="shotAnchor"[\s\S]*?:aria-label="shotName"[\s\S]*?:disabled="shotDisabled"[\s\S]*?@click="onShotClick"/);
    assert.ok(template.includes('<SidebarIcon name="box" aria-hidden="true" />'), 'kit-wrapped screenshot icon');
    assert.match(template, /<span[\s\S]*?:id="badgeId"[\s\S]*?class="mv-tile-chrome__badge"[\s\S]*?:data-variant="badgeVariant"[\s\S]*?role="status"[\s\S]*?:data-semantic-anchor="badgeAnchor"/);
    assert.doesNotMatch(template, /@submit-intent="(?!onRecordIntent)/,
      'kit intents are consumed, never re-emitted');
  });

  test('handlers drive the capture store and reset the momentary capture flag', () => {
    const setup = source.slice(source.indexOf('<script setup>'), source.indexOf('</script>'));
    assert.match(setup, /function onRecordIntent\(\) \{[\s\S]*?state\.toggleRecord\(props\.capsuleId\)/);
    assert.match(setup, /function onShotClick\(\) \{[\s\S]*?shotCapturing\.value = true[\s\S]*?state\.screenshot\(props\.capsuleId\)[\s\S]*?result\.then\(done, done\)/);
    assert.doesNotMatch(setup, /window\./, 'no host access outside the store');
    assert.doesNotMatch(setup, /authority\.propose/, 'capture never reaches propose');
  });

  test('negative control: the shared predicates fail fixtures without a template or with TS', () => {
    const { descriptor } = parse(source, { filename: 'TileCaptureChrome.vue' });
    assert.ok(descriptor.template, 'real component carries a template');
    assert.throws(() => assert.match('<script setup>const a = 1;</script>', /<template>/),
      assert.AssertionError);
    assert.throws(() => assert.doesNotMatch('<script lang="ts"></script>', /lang\s*=\s*["']ts["']/),
      assert.AssertionError);
  });
});

describe('kit 0.2.1 tile header actions', () => {
  test('take/release control and fold render under window presentation', () => {
    const kit = readFileSync(KIT_PANEL_URL, 'utf8');
    for (const id of ['domIds.fold', 'domIds.control']) {
      const tags = [...kit.matchAll(new RegExp(`<button[^>]*:id="${id}"[^>]*>`, 'g'))]
        .map((m) => m[0]);
      assert.ok(tags.length >= 1, `kit renders ${id}`);
      for (const tag of tags) {
        assert.ok(!tag.includes('v-if'), `${id} is not gated by presentation: ${tag}`);
      }
    }
  });

  test('pin and popout stay hidden under window presentation (no lane duplicates)', () => {
    const kit = readFileSync(KIT_PANEL_URL, 'utf8');
    for (const id of ['domIds.pin', 'domIds.popout']) {
      const tags = [...kit.matchAll(new RegExp(`<button[^>]*:id="${id}"[^>]*>`, 'g'))]
        .map((m) => m[0]);
      assert.ok(tags.length >= 1, `kit renders ${id} off-presentation`);
      for (const tag of tags) {
        assert.ok(tag.includes('v-if="!windowPresentation"'), `${id} stays off tiles: ${tag}`);
      }
    }
    const chrome = readFileSync(CHROME_URL, 'utf8');
    assert.doesNotMatch(chrome, /pin|popout/i, 'lane adds no pin/popout duplicates');
  });
});

describe('wall capture prop plumbing', () => {
  test('SurfacePanel mounts the chrome above the kit panel with store bindings', () => {
    const panel = readFileSync(PANEL_URL, 'utf8');
    assert.ok(panel.includes("import TileCaptureChrome from './TileCaptureChrome.vue';"));
    assert.match(panel, /captureState:\s*\{\s*type:\s*Object,\s*default:\s*null\s*\}/);
    assert.match(panel, /displayOnly:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/);
    const template = panel.slice(panel.indexOf('<template>'));
    const chromeAt = template.indexOf('<TileCaptureChrome');
    const kitAt = template.indexOf('<CapsulePanel');
    assert.ok(chromeAt > 0 && kitAt > chromeAt, 'chrome renders above the kit panel');
    assert.match(template, /<TileCaptureChrome[\s\S]*?:capture-state="props\.captureState"[\s\S]*?:display-only="props\.displayOnly"/);
    assert.doesNotMatch(template, /<TileCaptureChrome[^>]*v-if/, 'chrome mount is unconditional');
  });

  test('WallWorkspace accepts the store and passes it to every tile', () => {
    const wall = readFileSync(WALL_URL, 'utf8');
    assert.match(wall, /captureState:\s*\{\s*type:\s*Object,\s*default:\s*null\s*\}/);
    assert.match(wall, /displayOnly:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/);
    assert.ok(wall.includes('captureState: props.captureState,'), 'router forwards the store');
    assert.ok(wall.includes('displayOnly: props.displayOnly,'), 'router forwards display-only');
  });
});

test('tile screenshot icon is decorative for assistive technology', () => {
  const source = readFileSync(new URL('../src/wall/TileCaptureChrome.vue', import.meta.url), 'utf8');
  assert.match(source, /<SidebarIcon name="box" aria-hidden="true"\s*\/>/);
});
