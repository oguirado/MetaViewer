import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
import { createSSRApp } from 'vue';
import { parse } from 'vue/compiler-sfc';
import { renderToString } from '@vue/server-renderer';
import { FIXTURE_KEYS } from '../src/fixtures/states.js';
import { resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import { createWallLayout, SCOPE } from '../src/wall/layout.js';

function assertNoInlineStyles(html) {
  const tags = html.match(/<[^>]*\sstyle\s*=[^>]*>/gi) ?? [];
  assert.deepEqual(tags, [], 'inline style tags');
}
function assertControls(html) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate DOM ids');
  const controls = (html.match(/<[a-z][^>]*>/gi) ?? []).filter(tag =>
    /^<(?:button|input|select|textarea|a)\b/i.test(tag)
    || /\s(?:tabindex="(?:0|-1)"|role="(?:button|switch|checkbox|radio|combobox|menuitem|option|tab|separator)")/.test(tag));
  for (const tag of controls) {
    assert.match(tag, /\sid="[^"\s]+"/, tag);
    assert.doesNotMatch(tag, /\sid="pv_id_/, 'generated control id: ' + tag);
    assert.match(tag, /\sdata-semantic-anchor="[^"\s]+"/, tag);
  }
}
function assertHtmlContract(html) { assertNoInlineStyles(html); assertControls(html); }

// Instrument native template elements only; owned slots retain their own source.
// Library-generated descendants inherit the nearest marked template element.
function originPlugin() {
  return {
    name: 'mvui-render-origin', enforce: 'pre',
    transform(source, id) {
      if (!id.endsWith('.vue')) return;
      const origin = id.includes('/.kit/') ? '.kit/' + id.split('/.kit/')[1]
        : id.includes('/src/') ? 'src/' + id.split('/src/')[1] : null;
      if (!origin) return;
      const { descriptor } = parse(source);
      const template = descriptor.template;
      if (!template?.ast) return;
      const offsets = [];
      function visit(node) {
        if (node.type === 1 && node.tagType === 0) offsets.push(node.loc.start.offset + 1 + node.tag.length);
        for (const child of node.children ?? []) visit(child);
      }
      visit(template.ast);
      for (const offset of offsets.sort((a, b) => b - a)) source = source.slice(0, offset) + ` data-mvui-origin="${origin}"` + source.slice(offset);
      return source;
    },
  };
}

function renderedElements(html) {
  const elements = [], stack = [];
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi)) {
    const raw = match[0];
    if (raw.startsWith('<!--')) continue;
    const name = raw.match(/^<\/?([a-z][\w-]*)/i)[1].toLowerCase();
    if (raw.startsWith('</')) {
      const index = stack.findLastIndex(entry => entry.name === name);
      if (index >= 0) stack.length = index;
      continue;
    }
    const origin = raw.match(/ data-mvui-origin="([^"]+)"/)?.[1] ?? stack.at(-1)?.origin ?? 'AUSENTE';
    const tag = raw.replace(/ data-mvui-origin="[^"]+"/g, '');
    const element = { name, origin, tag };
    elements.push(element);
    if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name) && !/\/>$/.test(raw)) stack.push(element);
  }
  return elements;
}

const kitSource = file => `.kit/capsule-ui-kit/src/${file}.vue`;
function attribute(tag, name) {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}
function knownSplitter(tag) {
  return /^<div\b/.test(tag) && attribute(tag, 'class') === 'ai-splitter ai-splitter--horizontal'
    && attribute(tag, 'role') === 'separator' && attribute(tag, 'id') === undefined
    && attribute(tag, 'data-semantic-anchor') === 'workspace/separator/multislot-main';
}
function knownStyle({ origin, tag }) {
  const style = attribute(tag, 'style'), id = attribute(tag, 'id'), classes = attribute(tag, 'class');
  if (origin === kitSource('side-terminal/SideTerminalPanel')) {
    return (id === 'side-terminal' && classes === 'cui-side-terminal'
      && ['top:0px;bottom:0px;width:auto;', 'top:0px;bottom:0px;width:640px;'].includes(style))
      || (classes === 'cui-side-terminal__body' && id === undefined && ['', 'display:none;'].includes(style))
      || (id === 'side-terminal-real-shell-disclosure' && classes === 'cui-side-terminal__disclosure' && style === '')
      || (id === 'side-terminal-edge-tab' && classes === 'cui-side-terminal__edge' && ['', 'display:none;'].includes(style));
  }
  if (origin === kitSource('shell/Sidebar')) return style === '' && /^<li\b/.test(tag)
    && /^pv_id_\d+_0_[0-9]$/.test(id ?? '') && classes === 'p-menu-item' && attribute(tag, 'role') === 'menuitem';
  if (origin === kitSource('workspace/DockWorkspace')) return id === 'workspace-restore-veil' && classes === 'mv-dock-workspace__veil' && style === '';
  if (origin === kitSource('multislot/AiMultiSlot')) return style === ''
    && ((id === 'cuk-ai-slot-cap-01' && classes === 'ai-slot ai-slot--side-bottom')
      || (id === 'cuk-ai-slot-cap-01-body' && classes === 'ai-slot__body'));
  if (origin === kitSource('multislot/AiSurfacePane')) return id === 'cuk-ai-surface-cap-01-multislot-main'
    && classes === 'ai-surface-pane' && style === 'min-height:200px;';
  if (origin === kitSource('multislot/AiTerminalPane')) return id === 'cuk-ai-terminal-cap-01'
    && classes === 'ai-terminal-pane' && style === 'height:360px;min-height:100px;';
  if (origin === kitSource('multislot/AiSlotSplitter')) return knownSplitter(tag) && style === '';
  if (origin === kitSource('saas/SaasFoldedRail')) return id === 'cuk-ai-slot-cap-01-rail'
    && classes === 'saas-rail' && style === 'display:none;';
  return false;
}
function knownControl({ origin, tag }) {
  let repaired;
  if (origin === kitSource('shell/Sidebar') && /^pv_id_\d+(?:_list|_0_[0-9])$/.test(attribute(tag, 'id') ?? '')) {
    if (!(/^<ul\b/.test(tag) && attribute(tag, 'class') === 'p-menu-list cuk-sidebar__menulist' && attribute(tag, 'role') === 'menu')
      && !(/^<li\b/.test(tag) && attribute(tag, 'class') === 'p-menu-item' && attribute(tag, 'role') === 'menuitem')) return false;
    repaired = tag.replace(/\sid="pv_id_[^"]+"/, ' id="known-sidebar-control"').replace(/>$/, ' data-semantic-anchor="known-sidebar-control">');
  } else if (origin === kitSource('multislot/AiSlotSplitter') && knownSplitter(tag)) {
    repaired = tag.replace(/>$/, ' id="known-splitter">');
  } else if (origin === kitSource('saas/SaasFoldedRail') && /^<button\b/.test(tag)
    && attribute(tag, 'data-semantic-anchor') === undefined
    && ['unfold', 'dock'].some(action => attribute(tag, 'id') === `cuk-saas-folded-${action}` && attribute(tag, 'class') === `saas-rail-${action}`)) {
    repaired = tag.replace(/>$/, ' data-semantic-anchor="known-folded-rail-control">');
  } else return false;
  try { assertControls(repaired); return true; } catch { return false; }
}
function assertKnown(offenders, predicate) {
  assert.deepEqual(offenders.filter(element => !predicate(element)), [], 'NEW external offenders');
}
async function attributedChecks(t, html, kind) {
  const elements = renderedElements(html);
  assert.equal(elements.some(element => element.origin === 'AUSENTE'), false, 'all rendered elements have a source owner');
  const offenders = elements.filter(({ tag }) => {
    if (kind === 'CSP') return /\sstyle\s*=/.test(tag);
    try { assertControls(tag); return false; } catch { return true; }
  });
  const owned = offenders.filter(({ origin }) => origin.startsWith('src/'));
  await t.test(`${kind}: MetaViewer-owned`, () => assert.deepEqual(owned, []));
  if (kind === 'control identities') {
    const ids = elements.map(({ tag }) => tag.match(/\sid="([^"]+)"/)?.[1]).filter(Boolean);
    await t.test('duplicate DOM ids remain hard', () => assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []));
  }
  for (const [group, todo] of [['kit', 'capsule-ui-kit 0.2.1 CSP audit']]) {
    const external = offenders.filter(({ origin }) => origin.startsWith('.kit/'));
    await t.test(`${kind}: ${group} known-offender subset`, () => assertKnown(external, kind === 'CSP' ? knownStyle : knownControl));
    await t.test(`${kind}: ${group}`, { todo: external.length ? todo : undefined }, subtest => {
      subtest.diagnostic(JSON.stringify(external));
      assert.deepEqual(external, []);
    });
  }
}

test('HTML gate rejects inline style and unanchored/duplicate controls', () => {
  for (const html of ['<div style="display:none"></div>', '<button>Bad</button>', '<div role="button">Bad</div>', '<button id="a" data-semantic-anchor="x"></button><input id="a" data-semantic-anchor="y">']) {
    assert.throws(() => assertHtmlContract(html));
  }
});

test('origin attribution preserves owned slots and rejects new external offenders', () => {
  const elements = renderedElements('<aside data-mvui-origin=".kit/capsule-ui-kit/src/shell/Sidebar.vue"><ul id="pv_id_1_list" class="p-menu-list cuk-sidebar__menulist" role="menu" tabindex="0"></ul><button data-mvui-origin="src/App.vue">Bad owned slot</button></aside>');
  assert.equal(knownControl(elements[1]), true);
  assert.equal(elements[2].origin, 'src/App.vue');
  assert.throws(() => assertControls(elements[2].tag));
  for (const element of [
    { origin: kitSource('side-terminal/SideTerminalPanel'), tag: '<div class="new-kit-element" style="display:none;">' },
    { origin: 'src/App.vue', tag: '<div class="cui-side-terminal__body" style="display:none;">' },
    { origin: 'src/surfaces/SurfaceCanvas.vue', tag: '<canvas class="mv-surface__canvas" style="color:red;">' },
    { origin: 'src/surfaces/SurfaceCanvas.vue', tag: '<canvas class="mv-surface__canvas" style="display:none;">' },
  ]) assert.throws(() => assertKnown([element], knownStyle));
  assert.throws(() => assertKnown([{ origin: kitSource('shell/Sidebar'), tag: '<button id="pv_id_new">' }], knownControl));
});

test('authorized kit exceptions reject new selectors, values, origins and identity defects', () => {
  const styles = [
    ['multislot/AiMultiSlot', '<div id="cuk-ai-slot-cap-01" class="ai-slot ai-slot--side-bottom" style="">'],
    ['multislot/AiMultiSlot', '<div id="cuk-ai-slot-cap-01-body" class="ai-slot__body" style="">'],
    ['multislot/AiSurfacePane', '<div id="cuk-ai-surface-cap-01-multislot-main" class="ai-surface-pane" style="min-height:200px;">'],
    ['multislot/AiTerminalPane', '<section id="cuk-ai-terminal-cap-01" class="ai-terminal-pane" style="height:360px;min-height:100px;">'],
    ['multislot/AiSlotSplitter', '<div class="ai-splitter ai-splitter--horizontal" role="separator" data-semantic-anchor="workspace/separator/multislot-main" style="">'],
    ['saas/SaasFoldedRail', '<aside id="cuk-ai-slot-cap-01-rail" class="saas-rail" style="display:none;">'],
  ];
  for (const [file, tag] of styles) {
    const origin = kitSource(file);
    assert.equal(knownStyle({ origin, tag }), true);
    for (const mutant of [
      { origin, tag: tag.replace(/style="[^"]*"/, 'style="color:red;"') },
      { origin, tag: tag.replace('class="', 'class="new-element ') },
      { origin: 'src/App.vue', tag },
    ]) assert.throws(() => assertKnown([mutant], knownStyle));
  }
  const controls = [
    ['multislot/AiSlotSplitter', '<div class="ai-splitter ai-splitter--horizontal" role="separator" tabindex="0" data-semantic-anchor="workspace/separator/multislot-main">'],
    ...['unfold', 'dock'].map(action => ['saas/SaasFoldedRail', `<button id="cuk-saas-folded-${action}" class="saas-rail-${action}">`]),
  ];
  for (const [file, tag] of controls) {
    const origin = kitSource(file);
    assert.equal(knownControl({ origin, tag }), true);
    for (const mutant of [
      { origin, tag: tag.replace('class="', 'class="new-control ') },
      { origin, tag: tag.replace(/>$/, ' id="pv_id_new">') },
      { origin: 'src/App.vue', tag },
    ]) assert.throws(() => assertKnown([mutant], knownControl));
  }
  assert.throws(() => assertKnown([{ origin: kitSource('multislot/AiSlotSplitter'),
    tag: controls[0][1].replace(/ data-semantic-anchor="[^"]+"/, '') }], knownControl));
});

test('every fixture renders its real screen and stable controls without live core', { timeout: 60000 }, async t => {
  globalThis.__mvuiXterm = require('@xterm/xterm');
  globalThis.__mvuiFit = require('@xterm/addon-fit');
  const cacheDir = await mkdtemp(join(tmpdir(), 'mvui-int-vite-'));
  const server = await createServer({ cacheDir, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom', ssr: { noExternal: ['@xterm/xterm', '@xterm/addon-fit'] }, plugins: [originPlugin(), {
    name: 'ssr-commonjs-exports',
    resolveId(id) { if (id === '@xterm/xterm' || id === '@xterm/addon-fit') return '\0' + id; },
    load(id) {
      if (id === '\0@xterm/xterm') return 'export const Terminal = globalThis.__mvuiXterm.Terminal;';
      if (id === '\0@xterm/addon-fit') return 'export const FitAddon = globalThis.__mvuiFit.FitAddon;';
    },
  }] });
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.vue');
    for (const key of FIXTURE_KEYS) await t.test(key, async fixtureTest => {
      const resolved = resolveFixture(key);
      assert.equal(resolved.ok, true);
      const { fixture } = resolved;
      const result = createFixtureRuntime(fixture);
      assert.equal(result.ok, true);
      const html = await renderToString(createSSRApp(App, {
        ...result.mount, layout: createWallLayout(SCOPE, [...fixture.capsules]), scope: SCOPE,
        storage: { readRaw: async () => null, writeAtomic: async () => {} },
      }));
      await fixtureTest.test(`${key}: screen content`, () => {
        const visibleText = html.replace(/<[^>]*>/g, ' ');
        assert.equal(/Panel unavailable|Missing capsule|cannot start|ERR_|placeholder text|Core not connected/.test(visibleText), false, visibleText.slice(-2500));
        if (key === 'empty') assert.match(html, /empty-wall-add/);
        if (key === 'multislot' || key === 'recording') assert.match(html, /Recording/);
        if (key === 'settings-dark') assert.match(html, /mv-settings-panel/);
        if (key === 'nested') { assert.match(html, /mv-nested-wall/); assert.doesNotMatch(html, /<button\b/i); }
      });
      await fixtureTest.test(`${key}: CSP`, t => attributedChecks(t, html, 'CSP'));
      await fixtureTest.test(`${key}: control identities`, t => attributedChecks(t, html, 'control identities'));
    });
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
    delete globalThis.__mvuiXterm; delete globalThis.__mvuiFit;
    globalThis.document = oldDocument; globalThis.window = oldWindow;
  }
});
