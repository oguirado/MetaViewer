// W2-MI-UI suite: CreativeCapsule storyboard capsule contracts.
//
// Runs under plain Node (`node --test`): no Electron, no display, no child
// spawn, no network. The dependency-free <script> module block loads through
// a data: URL, so every behavioral assertion runs against the shipped code,
// never a copy. Every negative fixture refuses with an exact code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSfc, mount, ui, nodes, text } from './mvui3-creative-harness.js';
import { expect } from './assertions.js';

const SOURCE_URL = new URL('../src/creative/CreativeCapsule.vue', import.meta.url);
const source = readFileSync(SOURCE_URL, 'utf8');

/** Extract the dependency-free <script> module block (the one without setup). */
function extractPureModule(text) {
  const blocks = [...text.matchAll(/<script(\s+setup)?>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 2);
  const plain = blocks.filter((match) => !match[1]);
  const setup = blocks.filter((match) => match[1]);
  assert.equal(plain.length, 1);
  assert.equal(setup.length, 1);
  return { pure: plain[0][2], setup: setup[0][2] };
}

/** Run the shared static predicates; fixtures missing a block must throw. */
function assertSfcContract(text, name) {
  assert.ok(text.includes('<script'), `${name} carries a script block`);
  assert.ok(text.includes('<template>'), `${name} carries a template block`);
  assert.ok(text.includes('</template>'), `${name} closes its template block`);
  assert.doesNotMatch(text, /lang\s*=\s*["']ts["']/, `${name} stays JavaScript-only`);
}

const { pure, setup } = extractPureModule(source);
const template = source.slice(source.indexOf('<template>'));

const pureModule = await import(`data:text/javascript;base64,${Buffer.from(pure).toString('base64')}`);
const {
  MAX_STORYBOARD_FRAMES,
  MAX_PROMPT_LENGTH,
  MAX_IMAGE_BYTES,
  STORYBOARD_FRAME_KEYS,
  CAPSULE_ID_ERROR_CODES,
  IMAGE_SOURCE_ERROR_CODES,
  STORYBOARD_ERROR_CODES,
  STORYBOARD_INTENT_TYPES,
  validateCapsuleId,
  validateImageSource,
  validateStoryboardFrame,
  validateStoryboard,
  deriveCreativeStatus,
  buildStoryboardIntent,
} = pureModule;

// 1x1 transparent PNG fixture: valid magic, tiny payload.
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SHA_A = 'a'.repeat(64);

/** Build a valid storyboard frame carrying the given overrides. */
function storyboardFrame(overrides = {}) {
  return {
    frame_id: 'frame-1',
    prompt: 'A capsule wall at dawn',
    data_url: PNG_1X1,
    sha256: SHA_A,
    width: 64,
    height: 64,
    ...overrides,
  };
}

/** Build N distinct valid frames. */
function storyboardFrames(count) {
  return Array.from({ length: count }, (_, index) => storyboardFrame({
    frame_id: `frame-${index + 1}`,
  }));
}

describe('pure module loads faithfully', () => {
  it('pure block carries zero imports, so the data-URL load is exact', () => {
    assert.doesNotMatch(pure, /^\s*import\s/m);
    assert.doesNotMatch(pure, /from\s+['"]/m);
    assert.ok(Object.keys(pureModule).length > 0);
  });

  it('closed sets match the ratified contract and are frozen', () => {
    assert.deepEqual([...STORYBOARD_FRAME_KEYS],
      ['frame_id', 'prompt', 'data_url', 'sha256', 'width', 'height']);
    assert.deepEqual([...CAPSULE_ID_ERROR_CODES], ['ERR_INVENTED_CAPSULE_ID',
      'ERR_INVALID_IDENTITY', 'ERR_NUMERIC_INDEX_ID', 'ERR_DISPLAY_CREDENTIAL_ID']);
    assert.deepEqual([...IMAGE_SOURCE_ERROR_CODES], ['ERR_REMOTE_IMAGE_SOURCE',
      'ERR_UNSUPPORTED_IMAGE_TYPE', 'ERR_IMAGE_SOURCE_TOO_LARGE',
      'ERR_MALFORMED_IMAGE_SOURCE']);
    assert.deepEqual([...STORYBOARD_ERROR_CODES], ['ERR_STORYBOARD_EMPTY',
      'ERR_STORYBOARD_TOO_LARGE', 'ERR_MALFORMED_STORYBOARD_FRAME']);
    assert.deepEqual([...STORYBOARD_INTENT_TYPES],
      ['creative/select-frame', 'creative/regenerate', 'creative/close']);
    expect(MAX_STORYBOARD_FRAMES).toBe(8);
    expect(MAX_PROMPT_LENGTH).toBe(2000);
    expect(MAX_IMAGE_BYTES).toBe(2097152);
    for (const set of [STORYBOARD_FRAME_KEYS, CAPSULE_ID_ERROR_CODES,
      IMAGE_SOURCE_ERROR_CODES, STORYBOARD_ERROR_CODES, STORYBOARD_INTENT_TYPES]) {
      assert.equal(Object.isFrozen(set), true);
      assert.throws(() => set.push('mutant'), TypeError);
    }
  });
});

describe('capsuleId validation carries the four kit refusal codes', () => {
  it('admits a host-issued slug', () => {
    assert.deepEqual(validateCapsuleId('creative-storyboard-1'),
      { ok: true, id: 'creative-storyboard-1' });
  });

  it('refuses missing or non-string ids without inventing one', () => {
    for (const value of [undefined, null, 123, '', '   ', '\t\n']) {
      const result = validateCapsuleId(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_INVENTED_CAPSULE_ID');
    }
  });

  it('refuses surrounding or internal whitespace', () => {
    for (const value of [' creative-1', 'creative-1 ', 'crea tive-1', 'a\tb', 'a\nb']) {
      const result = validateCapsuleId(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_INVALID_IDENTITY');
    }
  });

  it('refuses bare numeric indexes (negative control: never an identity)', () => {
    for (const value of ['123', '0', '007']) {
      const result = validateCapsuleId(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_NUMERIC_INDEX_ID');
    }
  });

  it('refuses display-number credentials', () => {
    for (const value of [':0', ':12', 'display=1', 'DISPLAY=x', 'Display=:0']) {
      const result = validateCapsuleId(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_DISPLAY_CREDENTIAL_ID');
    }
  });
});

describe('image source CSP gate admits data: PNG and self paths only', () => {
  it('admits a PNG data: URL within the byte cap', () => {
    const result = validateImageSource(PNG_1X1);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'data');
    assert.equal(result.src, PNG_1X1);
  });

  it('admits relative self asset paths', () => {
    for (const value of ['art/frame-1.png', './art/frame-1.png', 'a/b_c-d~e/f.png']) {
      const result = validateImageSource(value);
      assert.equal(result.ok, true);
      assert.equal(result.kind, 'self');
      assert.equal(result.src, value);
    }
  });

  it('refuses remote schemes without a request (negative control)', () => {
    for (const value of ['http://host/x.png', 'https://host/x.png', '//host/x.png',
      'HTTP://host/x.png', 'javascript:alert(1)', 'blob:https://host/u',
      'ftp://host/x.png', 'Data:image/png;base64,iVBORw0KGgo=']) {
      const result = validateImageSource(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_REMOTE_IMAGE_SOURCE');
    }
  });

  it('refuses data: URLs that are not PNG base64', () => {
    for (const value of ['data:text/html,<img>', 'data:image/jpeg;base64,/9j/4AA=',
      'data:,payload', 'data:image/png,iVBORw0KGgo=']) {
      const result = validateImageSource(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_UNSUPPORTED_IMAGE_TYPE');
    }
  });

  it('refuses oversize payloads at the ceilings', () => {
    const overChars = `data:image/png;base64,${'A'.repeat(2800000)}`;
    assert.equal(validateImageSource(overChars).error.code, 'ERR_IMAGE_SOURCE_TOO_LARGE');
    // Passes the character ceiling but decodes past 2 MiB.
    const overBytes = `data:image/png;base64,${'A'.repeat(2799976)}`;
    assert.equal(validateImageSource(overBytes).error.code, 'ERR_IMAGE_SOURCE_TOO_LARGE');
  });

  it('refuses malformed payloads and paths', () => {
    const badMagic = `data:image/png;base64,${'QUJD'.repeat(23)}`;
    for (const value of [badMagic, 'data:image/png;base64,!!!',
      'data:image/png;base64,ABC', 'data:image/png;base64,', '', null, 42,
      '/abs/x.png', '../esc.png', 'art//x.png', 'art/x.jpg', 'art/x.png ',
      `${'a'.repeat(509)}.png`, 'art/x.PNG']) {
      const result = validateImageSource(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_MALFORMED_IMAGE_SOURCE');
    }
  });
});

describe('storyboard validation is closed and atomic', () => {
  it('refuses missing or empty storyboards with an honest waiting code', () => {
    for (const value of [undefined, null, {}, 'frames', []]) {
      const result = validateStoryboard(value);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_STORYBOARD_EMPTY');
    }
  });

  it('enforces the 8-frame ceiling on both sides', () => {
    assert.equal(validateStoryboard(storyboardFrames(8)).ok, true);
    const result = validateStoryboard(storyboardFrames(9));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_STORYBOARD_TOO_LARGE');
  });

  it('admits valid frames as frozen artifacts', () => {
    const result = validateStoryboard(storyboardFrames(2));
    assert.equal(result.ok, true);
    assert.equal(result.frames.length, 2);
    assert.equal(Object.isFrozen(result.frames), true);
    assert.equal(Object.isFrozen(result.frames[0]), true);
    assert.throws(() => result.frames.push(storyboardFrame()), TypeError);
  });

  it('rejects the whole board when one frame fails (negative control)', () => {
    const mixed = [storyboardFrame({ frame_id: 'frame-1' }),
      storyboardFrame({ frame_id: 'frame-2', width: 0 })];
    const result = validateStoryboard(mixed);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_MALFORMED_STORYBOARD_FRAME');
    assert.match(result.error.message, /frame\[1\]/);
  });

  it('rejects non-objects and open key sets', () => {
    for (const value of [null, [], 'frame', 7]) {
      assert.equal(validateStoryboardFrame(value).error.code,
        'ERR_MALFORMED_STORYBOARD_FRAME');
    }
    const extra = storyboardFrame({ injected: true });
    assert.equal(validateStoryboardFrame(extra).error.code,
      'ERR_MALFORMED_STORYBOARD_FRAME');
    const { sha256, ...missing } = storyboardFrame();
    void sha256;
    assert.equal(validateStoryboardFrame(missing).error.code,
      'ERR_MALFORMED_STORYBOARD_FRAME');
  });

  it('rejects bad frame ids, prompts, digests and dimensions', () => {
    const bad = [
      { frame_id: '' }, { frame_id: 'has space' }, { frame_id: 'a/b' },
      { frame_id: 'x'.repeat(129) }, { prompt: '' }, { prompt: 'x'.repeat(2001) },
      { prompt: 42 }, { sha256: 'A'.repeat(64) }, { sha256: 'a'.repeat(63) },
      { sha256: 'zz'.padEnd(64, '0') }, { width: 0 }, { width: -1 }, { width: 1.5 },
      { width: '64' }, { width: 8193 }, { height: 0 }, { height: NaN },
    ];
    for (const override of bad) {
      const result = validateStoryboardFrame(storyboardFrame(override));
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_MALFORMED_STORYBOARD_FRAME');
    }
  });

  it('accepts field boundaries exactly', () => {
    assert.equal(validateStoryboardFrame(
      storyboardFrame({ prompt: 'x', width: 1, height: 8192 })).ok, true);
    assert.equal(validateStoryboardFrame(storyboardFrame(
      { prompt: 'x'.repeat(2000), frame_id: 'y'.repeat(128) })).ok, true);
  });

  it('propagates the image-source code for a bad data_url', () => {
    const remote = validateStoryboardFrame(
      storyboardFrame({ data_url: 'https://host/x.png' }));
    assert.equal(remote.ok, false);
    assert.equal(remote.error.code, 'ERR_REMOTE_IMAGE_SOURCE');
    assert.match(remote.error.message, /frame\.data_url refused/);
  });

  it('never mutates its input', () => {
    const frame = storyboardFrame();
    Object.freeze(frame);
    assert.equal(validateStoryboardFrame(frame).ok, true);
    const board = storyboardFrames(2);
    const snapshot = JSON.parse(JSON.stringify(board));
    assert.equal(validateStoryboard(board).ok, true);
    assert.deepEqual(board, snapshot);
  });
});

describe('status derivation stays Live Waiting or coded Refused', () => {
  it('reports Live for admitted frames', () => {
    const status = deriveCreativeStatus({ id: validateCapsuleId('creative-1'),
      board: validateStoryboard(storyboardFrames(1)) });
    expect(status).toBe('Live');
  });

  it('reports Waiting for storyboard when empty', () => {
    const status = deriveCreativeStatus({ id: validateCapsuleId('creative-1'),
      board: validateStoryboard([]) });
    expect(status).toBe('Waiting for storyboard');
  });

  it('reports a coded refusal for bad ids or bad boards', () => {
    const badId = deriveCreativeStatus({ id: validateCapsuleId('123'),
      board: validateStoryboard(storyboardFrames(1)) });
    expect(badId).toBe('Refused: ERR_NUMERIC_INDEX_ID');
    const badBoard = deriveCreativeStatus({ id: validateCapsuleId('creative-1'),
      board: validateStoryboard(storyboardFrames(9)) });
    expect(badBoard).toBe('Refused: ERR_STORYBOARD_TOO_LARGE');
  });
});

describe('storyboard intents are frozen and closed', () => {
  it('builds frozen payloads carrying type and capsuleId', () => {
    const select = buildStoryboardIntent('creative/select-frame', 'creative-1',
      { frameId: 'frame-2' });
    assert.deepEqual(select,
      { type: 'creative/select-frame', capsuleId: 'creative-1', frameId: 'frame-2' });
    const regen = buildStoryboardIntent('creative/regenerate', 'creative-1');
    assert.deepEqual(regen, { type: 'creative/regenerate', capsuleId: 'creative-1' });
    const close = buildStoryboardIntent('creative/close', 'creative-1');
    assert.deepEqual(close, { type: 'creative/close', capsuleId: 'creative-1' });
    for (const payload of [select, regen, close]) {
      assert.equal(Object.isFrozen(payload), true);
    }
    assert.throws(() => { select.type = 'mutant'; }, TypeError);
    assert.notEqual(buildStoryboardIntent('creative/close', 'creative-1'), close);
  });

  it('throws coded errors for unknown types and bad identities', () => {
    for (const type of ['creative/nuke', '', null, 42]) {
      assert.throws(() => buildStoryboardIntent(type, 'creative-1'),
        /ERR_UNKNOWN_INTENT_TYPE/);
    }
    assert.throws(() => buildStoryboardIntent('creative/close', '123'),
      /ERR_NUMERIC_INDEX_ID/);
    assert.throws(() => buildStoryboardIntent('creative/close', ''),
      /ERR_INVENTED_CAPSULE_ID/);
  });

  it('throws for malformed intent detail', () => {
    assert.throws(() => buildStoryboardIntent('creative/select-frame', 'creative-1'),
      /ERR_MALFORMED_INTENT_DETAIL/);
    assert.throws(() => buildStoryboardIntent('creative/select-frame', 'creative-1',
      { frameId: 'has space' }), /ERR_MALFORMED_INTENT_DETAIL/);
    assert.throws(() => buildStoryboardIntent('creative/select-frame', 'creative-1',
      'frame-2'), /ERR_MALFORMED_INTENT_DETAIL/);
    assert.throws(() => buildStoryboardIntent('creative/regenerate', 'creative-1',
      { prompt: 'extra' }), /ERR_MALFORMED_INTENT_DETAIL/);
    assert.throws(() => buildStoryboardIntent('creative/close', 'creative-1', {}),
      /ERR_MALFORMED_INTENT_DETAIL/);
  });
});

describe('SFC static contract: renderer isolation and kit wiring', () => {
  it('SFC parses as module script plus setup plus template, JS only', () => {
    assertSfcContract(source, 'CreativeCapsule.vue');
  });

  it('negative control: the shared predicates fail a fixture without a template', () => {
    assert.throws(() => assertSfcContract(
      '<script setup>const a = 1;</script>', 'fixture'), /template block/);
    expect(() => assertSfcContract(source, 'CreativeCapsule.vue')).not.toThrow();
  });

  it('imports only vue and mapped kit UI components', () => {
    const specifiers = [...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    assert.deepEqual([...new Set(specifiers)].sort(),
      ['../../.kit/capsule-ui-kit/src/ui/UiPage.vue', '../../.kit/capsule-ui-kit/src/ui/UiToolbar.vue', 'capsule-ui-kit/ui', 'vue']);
  });

  it('emits submit-intent only', () => {
    const emits = source.match(/\bdefineEmits\(\[([\s\S]*?)\]\)/)[1]
      .split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
    assert.deepEqual(emits, ['submit-intent']);
  });

  it('performs zero network or host calls in renderer code', () => {
    for (const token of ['fetch(', 'XMLHttpRequest', 'http://', 'https://',
      'WebSocket(', 'window.', 'document.', 'localStorage', 'require(']) {
      assert.ok(!source.includes(token), `renderer source must not contain ${token}`);
    }
  });

  it('keeps styles CSP-clean: no inline or runtime style writes', () => {
    assert.doesNotMatch(source, /(?:^|[\s"'`:=])style\s*=/m);
    assert.doesNotMatch(source, /v-bind:style/);
    assert.doesNotMatch(source, /:style=/);
    assert.doesNotMatch(source, /v-show/);
    assert.doesNotMatch(source, /\.style\.[a-zA-Z]/);
  });

  it('creates no subscriptions, so unmount disposes cleanly', () => {
    for (const token of ['addEventListener', 'removeEventListener', 'setInterval',
      'setTimeout', 'requestAnimationFrame', 'MutationObserver', 'IntersectionObserver']) {
      assert.ok(!source.includes(token), `capsule must not contain ${token}`);
    }
  });

  it('uses kit page and toolbar without CSP-unsafe panel chrome', () => {
    for (const tag of ['<UiPage', '<UiToolbar', '<UiButton']) assert.ok(source.includes(tag), tag);
    assert.doesNotMatch(source, /CapsulePanel/);
  });

  it('renders admitted pixels only, leaving non-admitted content blank', () => {
    assert.ok(template.includes('v-if="isAdmitted"'), 'pixels render only when admitted');
    assert.ok(template.includes('<img'), 'admitted frames render an image');
    assert.ok(template.includes(':src="frame.data_url"'), 'image source is the admitted URL');
    assert.doesNotMatch(template, /(?<!:)src="/);
    assert.doesNotMatch(template, /refusalText|role="alert"|Waiting|unavailable|ERR_/);
  });

  it('anchors every control with a stable id and semantic anchor', () => {
    const tags = template.match(/<UiButton\b[\s\S]*?>/g) ?? [];
    assert.ok(tags.length >= 3, 'close, select and regenerate controls exist');
    for (const tag of tags) {
      assert.ok(/(?:^|\s):?id=/.test(tag), `control without id: ${tag.slice(0, 80)}`);
      assert.ok(/(?:^|\s):?data-semantic-anchor=/.test(tag),
        `control without data-semantic-anchor: ${tag.slice(0, 80)}`);
    }
    assert.ok(template.includes('`${anchorRoot}/regenerate`'));
    assert.ok(template.includes('`${anchorRoot}/frame/${frame.frame_id}/select`'));
    assert.ok(template.includes('`${anchorRoot}/close`'));
  });
});

describe('fold updates preserve admitted storyboard state', () => {
  it('revalidating the same props yields identical frozen state', () => {
    const frames = storyboardFrames(3);
    const first = validateStoryboard(frames);
    const second = validateStoryboard(frames);
    assert.equal(first.ok, true);
    assert.deepEqual(first, second);
  });

  it('fold is display-only: validation never reads presentation props', () => {
    assert.ok(template.includes('props.folded'), 'fold drives display only');
    assert.doesNotMatch(pure, /folded/);
    assert.doesNotMatch(pure, /presentationInstance/);
  });
});


describe('mounted CreativeCapsule SFC behavior', () => {
  it('renders admitted frames and emits exact frozen renderer intents from controls', async () => {
    const Capsule = await loadSfc('creative/CreativeCapsule.vue', { 'capsule-ui-kit/ui': ui });
    const intents = [];
    const view = mount(Capsule, { capsuleId: 'cap-01', frames: storyboardFrames(2), onSubmitIntent: value => intents.push(value) });
    try {
      const images = nodes(view.root).filter(n => n.tag === 'img');
      assert.equal(images.length, 2);
      assert.equal(images[0].props.src, PNG_1X1);
      const buttons = nodes(view.root).filter(n => n.tag === 'button');
      assert.equal(buttons.length, 4);
      assert.equal(new Set(buttons.map(n => n.props.id)).size, 4);
      assert.equal(new Set(buttons.map(n => n.props['data-semantic-anchor'])).size, 4);
      buttons.find(n => n.props.id.endsWith('/frame/frame-2/select')).props.onClick();
      buttons.find(n => n.props.id.endsWith('/regenerate')).props.onClick();
      buttons.find(n => n.props.id.endsWith('/close')).props.onClick();
      assert.deepEqual(intents, [
        { type: 'creative/select-frame', capsuleId: 'cap-01', frameId: 'frame-2' },
        { type: 'creative/regenerate', capsuleId: 'cap-01' },
        { type: 'creative/close', capsuleId: 'cap-01' },
      ]);
      assert.ok(intents.every(Object.isFrozen));
    } finally { view.close(); }
  });

  it('empty, refused, invalid identity and folded states expose no error or fake pixels', async () => {
    const Capsule = await loadSfc('creative/CreativeCapsule.vue', { 'capsule-ui-kit/ui': ui });
    for (const props of [
      { capsuleId: 'cap-01', frames: [] },
      { capsuleId: 'cap-01', frames: [storyboardFrame({ data_url: 'https://remote/image.png' })] },
      { capsuleId: '', frames: storyboardFrames(1) },
      { capsuleId: 'cap-01', frames: storyboardFrames(1), folded: true },
    ]) {
      const view = mount(Capsule, props);
      try {
        assert.equal(nodes(view.root).filter(n => n.tag === 'img').length, 0);
        assert.doesNotMatch(text(view.root), /ERR_|unavailable|refused|waiting|no storyboard|placeholder/i);
        if (!props.capsuleId) assert.equal(nodes(view.root).filter(n => n.tag === 'button').length, 0);
      } finally { view.close(); }
    }
    assert.equal(validateStoryboard([storyboardFrame(), storyboardFrame()]).ok, false);
  });
});
