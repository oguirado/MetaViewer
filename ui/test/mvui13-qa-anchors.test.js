import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectQaAnchors, installQaAnchorReporter } from '../src/qa/anchorCollector.js';

// A small DOM double: labels are text nodes; values deliberately throw if read.
function dom() {
  const listeners = new Map();
  const observers = [];
  const document = {
    nodeType: 9,
    addEventListener(type, fn) { listeners.set(`document:${type}`, fn); },
    removeEventListener(type, fn) { assert.equal(listeners.get(`document:${type}`), fn); listeners.delete(`document:${type}`); },
    getElementById(id) { return all().find(el => el.getAttribute('id') === id) ?? null; },
    querySelectorAll() { return all().filter(el => el.hasAttribute('data-semantic-anchor')); },
  };
  const all = () => {
    const out = [];
    const visit = el => { out.push(el); for (const child of el.childNodes) if (child.nodeType === 1) visit(child); };
    visit(document.documentElement);
    return out;
  };
  function element(tag = 'button', attrs = {}, text = '', parent = document.documentElement) {
    const node = {
      nodeType: 1, localName: tag, parentElement: parent ?? null, ownerDocument: document,
      childNodes: [], style: {}, box: { x: 10, y: 20, width: 80, height: 30 },
      getAttribute(name) { return attrs[name] ?? null; },
      hasAttribute(name) { return Object.hasOwn(attrs, name); },
      setAttribute(name, value) { attrs[name] = value; },
      matches(selector) {
        return selector.split(',').some(part => {
          if (part.startsWith('.')) return (attrs.class ?? '').split(' ').includes(part.slice(1));
          if (part.startsWith('[contenteditable]')) return Object.hasOwn(attrs, 'contenteditable') && attrs.contenteditable !== 'false';
          return tag === part;
        });
      },
      closest(selector) { for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el; return null; },
      querySelectorAll() { return all().filter(el => el !== this && el.hasAttribute('data-semantic-anchor') && isChild(el, this)); },
      getBoundingClientRect() { const b = this.box; return { ...b, left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height }; },
    };
    Object.defineProperty(node, 'value', { get() { throw new Error('VALUE LEAK'); } });
    Object.defineProperty(node, 'textContent', { get() { throw new Error('UNFILTERED TEXT LEAK'); } });
    if (text) node.childNodes.push({ nodeType: 3, nodeValue: text });
    parent?.childNodes.push(node);
    return node;
  }
  function isChild(el, ancestor) { for (let p = el.parentElement; p; p = p.parentElement) if (p === ancestor) return true; return false; }
  document.documentElement = element('html', {}, '', null);
  const window = {
    innerWidth: 1000, innerHeight: 800,
    getComputedStyle(el) { return { display: 'block', visibility: 'visible', opacity: '1', ...el.style }; },
    addEventListener(type, fn) { listeners.set(`window:${type}`, fn); },
    removeEventListener(type, fn) { if (listeners.has(`window:${type}`)) assert.equal(listeners.get(`window:${type}`), fn); listeners.delete(`window:${type}`); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
  };
  return { document, window, element, listeners, observers };
}

function clock() {
  let now = 0;
  let next = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++next; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pending,
    tick(ms) {
      const end = now + ms;
      for (let steps = 0; steps < 10000; steps++) {
        const job = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
        if (!job || job[1].at > end) { now = end; return; }
        pending.delete(job[0]); now = job[1].at; job[1].fn();
      }
      throw new Error('unbounded timer loop');
    },
  };
}

const anchor = value => ({ 'data-semantic-anchor': value });

test('absent or malformed facade performs zero DOM, clock, observer or listener operations', () => {
  const forbidden = new Proxy({}, { get() { throw new Error('SIDE EFFECT'); } });
  for (const facade of [undefined, null, {}, { reportAnchors: true }]) {
    const dispose = installQaAnchorReporter({ window: forbidden, document: forbidden, scheduler: forbidden, facade });
    dispose(); dispose();
  }
});

test('closed snapshot uses accessible names and implicit/explicit roles, sorted integer viewport rectangles', () => {
  const d = dom();
  const input = d.element('input', { ...anchor('field'), 'aria-label': '  Search  ' });
  input.box = { x: 20.4, y: 20.1, width: 40.2, height: 29.6 };
  d.element('span', { id: 'caption', hidden: '' }, ' Open   workspace ');
  d.element('div', { ...anchor('open'), role: 'button', 'aria-labelledby': 'caption', 'aria-label': 'ignored' }, 'fallback');
  d.element('a', { ...anchor('a'), href: '#' }, 'Link');
  d.element('input', { ...anchor('check'), type: 'checkbox' }).labels = [d.element('label', {}, 'Allow')];
  d.element('textarea', anchor('textarea'), 'PRIVATE INITIAL VALUE');
  d.element('div', anchor('noninteractive'), 'Not a control');
  const result = collectQaAnchors(d.document, d.window, 7);
  assert.deepEqual(Object.keys(result), ['schema', 'seq', 'rows']);
  assert.equal(result.schema, 'qa_anchors/v1'); assert.equal(result.seq, 7);
  assert.deepEqual(result.rows.map(row => [row.anchor, row.role, row.name]), [
    ['a', 'link', 'Link'], ['check', 'checkbox', 'Allow'], ['open', 'button', 'Open workspace'],
    ['textarea', 'textbox', ''], ['field', 'textbox', 'Search'],
  ]);
  assert.deepEqual(result.rows.at(-1).rect, { x: 20, y: 20, w: 40, h: 30 });
  assert.deepEqual(Object.keys(result.rows[0]), ['anchor', 'role', 'name', 'rect']);
  assert.deepEqual(collectQaAnchors(input, d.window).rows.map(row => row.anchor), ['field']);
});

test('values, terminal, canvas, embedded capsule and editable text cannot become names', () => {
  const d = dom();
  const control = d.element('button', anchor('safe'), 'Safe ');
  for (const [tag, attrs] of [ ['input', {}], ['textarea', {}], ['canvas', {}], ['iframe', {}], ['div', { class: 'xterm' }], ['div', { class: 'mv-terminal-host' }], ['div', { class: 'mv-surface-host' }], ['div', { class: 'mv-creative__frames' }], ['div', { contenteditable: 'true' }] ]) {
    const secret = d.element(tag, { id: `secret-${tag}`, ...attrs }, 'SECRET PAYLOAD', control);
    d.element('button', anchor(`private-${tag}`), 'SECRET BUTTON', secret);
  }
  d.element('button', { ...anchor('reference'), 'aria-labelledby': 'secret-div' });
  const terminal = d.element('div', { class: 'xterm' });
  const labelled = d.element('input', anchor('labelled'));
  labelled.labels = [d.element('label', {}, 'SECRET LABEL', terminal)];
  d.element('input', anchor('password')).setAttribute('type', 'password');
  const rows = collectQaAnchors(d.document, d.window).rows;
  assert.deepEqual(rows.map(row => row.anchor), ['labelled', 'password', 'reference', 'safe']);
  assert.equal(rows.find(row => row.anchor === 'safe').name, 'Safe');
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
});

test('invalid anchors, hidden ancestors, inert controls and offscreen/empty boxes are excluded', () => {
  const d = dom();
  for (const invalid of ['', '/legacy/slash', ' space', '.prefix', 'x'.repeat(129), 'ümlaut', 'x'.repeat(65), 'a//b', 'a/b/', 'a/./b', 'a/../b', 'a/b/c/d/e/f/g', 'has space/ok']) d.element('button', anchor(invalid), 'invalid');
  for (const attrs of [{ hidden: '' }, { inert: '' }, { 'aria-hidden': 'true' }]) {
    d.element('button', anchor('hidden'), 'hidden', d.element('div', attrs));
  }
  for (const style of [{ display: 'none' }, { visibility: 'hidden' }, { contentVisibility: 'hidden' }, { opacity: '0' }]) {
    const parent = d.element('div'); parent.style = style; d.element('button', anchor('css-hidden'), 'hidden', parent);
  }
  for (const box of [{ x: -80 }, { x: 1000 }, { y: -30 }, { y: 800 }, { width: 0 }, { height: 0 }, { x: NaN }]) {
    const el = d.element('button', anchor('offscreen')); Object.assign(el.box, box);
  }
  d.element('button', anchor('visible'), 'Visible');
  const clipped = d.element('button', anchor('clipped'), 'Clipped'); clipped.box.x = -10;
  assert.deepEqual(collectQaAnchors(d.document, d.window).rows.map(row => row.anchor), ['clipped', 'visible']);
});

test('row limit, UTF-8 byte ceiling and name length hold with deterministic truncation from the end', () => {
  const d = dom();
  for (let i = 599; i >= 0; i--) d.element('button', anchor(`a${String(i).padStart(3, '0')}`), 'short');
  const capped = collectQaAnchors(d.document, d.window);
  assert.equal(capped.rows.length, 512); assert.equal(capped.rows.at(-1).anchor, 'a511');
  for (const el of d.document.querySelectorAll()) el.setAttribute('aria-label', '界'.repeat(200));
  const bytes = collectQaAnchors(d.document, d.window);
  assert.ok(bytes.rows.length > 0 && bytes.rows.length < 512);
  assert.ok(Buffer.byteLength(JSON.stringify(bytes)) <= 64 * 1024);
  assert.equal(bytes.rows[0].name.length, 128);
  const next = { ...bytes, rows: [...bytes.rows, { ...bytes.rows[0], anchor: `a${String(bytes.rows.length).padStart(3, '0')}` }] };
  assert.ok(Buffer.byteLength(JSON.stringify(next)) > 64 * 1024, 'only trailing rows removed to fit');
});

test('native select options retain their own labels without reading selected values', () => {
  const d = dom();
  const select = d.element('select', { ...anchor('select'), value: 'PRIVATE SELECT VALUE' });
  d.element('option', anchor('first'), 'First choice', select);
  d.element('option', { ...anchor('second'), label: 'Second label' }, 'Second text', select);
  d.element('input', { ...anchor('typed'), value: 'PRIVATE INPUT VALUE' });
  d.element('textarea', anchor('multiline'), 'PRIVATE TEXTAREA VALUE');
  assert.deepEqual(collectQaAnchors(d.document, d.window).rows.map(({ anchor, role, name }) => [anchor, role, name]), [
    ['first', 'option', 'First choice'], ['multiline', 'textbox', ''], ['second', 'option', 'Second label'],
    ['select', 'combobox', ''], ['typed', 'textbox', ''],
  ]);
});

test('all accessible name sources truncate without splitting supplementary code points', () => {
  const d = dom();
  const label = 'a'.repeat(127) + '😀tail';
  d.element('button', { ...anchor('aria'), 'aria-label': label });
  d.element('span', { id: 'long-label' }, label);
  d.element('button', { ...anchor('reference'), 'aria-labelledby': 'long-label' });
  d.element('button', anchor('text'), label);
  d.element('button', anchor('pairs'), '😀'.repeat(65));
  d.element('input', anchor('labelled')).labels = [d.element('label', {}, label)];
  d.element('button', anchor('malformed'), '\uD800');
  const rows = collectQaAnchors(d.document, d.window).rows;
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.ok(row.name.isWellFormed(), row.anchor);
    assert.ok(row.name.length <= 128);
    const expected = row.anchor === 'pairs' ? '😀'.repeat(64) : row.anchor === 'malformed' ? '\uFFFD' : 'a'.repeat(127);
    assert.equal(row.name, expected);
  }
});

test('input action labels use value attributes or image alt while typed values remain private', () => {
  const d = dom();
  for (const type of ['button', 'submit', 'reset']) {
    d.element('input', { ...anchor(type), type, value: ` ${type} action ` });
  }
  d.element('input', { ...anchor('image'), type: 'image', alt: ' Upload image ', value: 'PRIVATE IMAGE VALUE' });
  d.element('input', { ...anchor('override'), type: 'submit', value: 'Fallback', 'aria-label': 'Explicit' });
  for (const type of ['text', 'password', 'search', 'number', 'email', 'file', 'color']) {
    d.element('input', { ...anchor(type), type, value: 'PRIVATE TYPED VALUE' });
  }
  const rows = collectQaAnchors(d.document, d.window).rows;
  for (const type of ['button', 'submit', 'reset']) assert.equal(rows.find(row => row.anchor === type).name, `${type} action`);
  assert.equal(rows.find(row => row.anchor === 'image').name, 'Upload image');
  assert.equal(rows.find(row => row.anchor === 'override').name, 'Explicit');
  assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
});

test('byte fitting matches trailing-row removal with linear encoding work', () => {
  const d = dom();
  const rows = [];
  for (let i = 0; i < 512; i++) {
    const id = `a${String(i).padStart(3, '0')}`;
    const name = `${i % 2 ? '😀' : '界'}`.repeat(64);
    d.element('button', anchor(id), name);
    rows.push({ anchor: id, role: 'button', name, rect: { x: 10, y: 20, w: 80, h: 30 } });
  }
  const expected = { schema: 'qa_anchors/v1', seq: 12345, rows: [...rows] };
  const fullBytes = Buffer.byteLength(JSON.stringify(expected));
  while (Buffer.byteLength(JSON.stringify(expected)) > 64 * 1024) expected.rows.pop();
  const OriginalEncoder = globalThis.TextEncoder;
  let encodedBytes = 0;
  globalThis.TextEncoder = class extends OriginalEncoder {
    encode(input) { const bytes = super.encode(input); encodedBytes += bytes.byteLength; return bytes; }
  };
  let actual;
  try { actual = collectQaAnchors(d.document, d.window, 12345); }
  finally { globalThis.TextEncoder = OriginalEncoder; }
  assert.deepEqual(actual, expected);
  assert.ok(encodedBytes <= fullBytes * 2, `encoding work exceeded linear budget: ${encodedBytes}`);
});

test('settles, spaces reports by 500 ms, suppresses duplicates and disposes all resources', () => {
  const d = dom(); const scheduler = clock(); const reports = [];
  const el = d.element('button', anchor('control'), 'Control');
  const dispose = installQaAnchorReporter({ ...d, scheduler, facade: { reportAnchors(snapshot) { reports.push({ at: scheduler.now(), snapshot }); } } });
  scheduler.tick(200); d.observers[0].callback(); scheduler.tick(249); assert.equal(reports.length, 0);
  scheduler.tick(1); assert.deepEqual(reports.map(r => r.at), [450]);
  el.box.x++; d.observers[0].callback(); scheduler.tick(250); assert.equal(reports.length, 1);
  scheduler.tick(250); assert.deepEqual(reports.map(r => r.at), [450, 950]);
  d.listeners.get('window:scroll')(); scheduler.tick(500); assert.equal(reports.length, 2, 'same rows never repeat even though seq would change');
  el.box.x++; d.observers[1].callback(); scheduler.tick(250);
  assert.deepEqual(reports.map(r => r.snapshot.seq), [1, 2, 3]);
  assert.ok(reports.every((r, i) => i === 0 || r.at - reports[i - 1].at >= 500));
  d.observers[0].callback(); assert.equal(scheduler.pending.size, 1);
  dispose(); dispose(); assert.equal(scheduler.pending.size, 0); assert.equal(d.listeners.size, 0);
  assert.ok(d.observers.every(observer => !observer.active));
  d.observers[0].callback(); scheduler.tick(1000); assert.equal(reports.length, 3);
});

test('entry boot enables QA only on live facade, skips fixtures/nested mode and tears down on pagehide/unmount', async () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const code = source
    .replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
      (_all, binding, _quote, specifier) => `const ${binding.trim()} = modules[${JSON.stringify(specifier)}];`)
    .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '')
    .replaceAll("import('./qa/anchorCollector.js')", 'loadQa()')
    .replace('void bootstrap()', 'await bootstrap()');
  const execute = new Function('window', 'document', 'modules', 'loadQa', `return (async () => {${code}})()`);
  for (const mode of ['absent', 'live', 'nested', 'fixture', 'closing']) {
    const d = dom(); const scheduler = clock();
    let imports = 0, mounted = 0, reports = 0, unmount;
    const target = { textContent: '', dataset: {} };
    d.document.documentElement.dataset = {};
    d.document.querySelector = () => target;
    d.window.location = { search: mode === 'fixture' ? '?state=one' : '' };
    d.window.metaviewer = { load() {}, save() {}, nestedDepth: async () => mode === 'nested' ? 1 : 0 };
    if (mode !== 'absent') d.window.metaviewer.qa = { reportAnchors() { reports++; } };
    const modules = {
      vue: { createApp: () => ({ mount() { mounted++; }, onUnmount(fn) { unmount = fn; } }) },
      './App.vue': {},
      './core/hostAdapters.js': { createAuthorityAdapter: () => null, createAuthorityRuntime: () => null, createTerminalBroker: () => null },
      './settings/settingsHost.js': { createSettingsHost: () => ({}) },
      './fixtures/resolveState.js': {
        parseStateQuery: () => mode === 'fixture' ? { ok: true, key: 'one' } : { ok: false, error: { code: 'ERR_MISSING_STATE_PARAM' } },
        resolveFixture: () => ({ ok: true, fixture: { key: 'one', scheme: 'mv-light', capsules: [] } }),
      },
      './fixtures/fixtureRuntime.js': { createFixtureRuntime: () => ({ ok: true, mount: {} }) },
      './wall/layout.js': { createWallLayout: () => ({}) },
      'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
    };
    await execute(d.window, d.document, modules, async () => {
      imports++;
      if (mode === 'closing') d.listeners.get('window:pagehide')();
      return { installQaAnchorReporter: options => installQaAnchorReporter({ ...options, scheduler }) };
    });
    assert.equal(target.textContent, '', mode);
    assert.equal(mounted, 1, mode);
    assert.equal(imports, ['live', 'closing'].includes(mode) ? 1 : 0, mode);
    assert.equal(d.observers.length, mode === 'live' ? 2 : 0, mode);
    scheduler.tick(250);
    assert.equal(reports, mode === 'live' ? 1 : 0, mode);
    if (mode === 'live') d.listeners.get('window:pagehide')();
    unmount();
    assert.ok(d.observers.every(observer => !observer.active), mode);
    assert.equal(d.listeners.size, 0, mode);
    assert.equal(scheduler.pending.size, 0, mode);
  }
});
