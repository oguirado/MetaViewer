import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';

let serial = 0;
async function component(file, apply = () => {}) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'g3-mounted', inlineTemplate: true });
  globalThis.__g3Theme = { setKitScheme: apply };
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'capsule-ui-kit/theme') return `const ${binding} = globalThis.__g3Theme;`;
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default; }
  finally { delete globalThis.__g3Theme; }
}
function mount(Component, input) {
  const props = vue.reactive(input);
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: () => ({ text: '' }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
    },
    remove(child) { const list = child.parent?.children; if (list) list.splice(list.indexOf(child), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
    patchProp(node, key, _old, value) { node.props[key] = value; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    setScopeId() {},
  });
  const root = { children: [] };
  const app = renderer.createApp({ render: () => vue.h(Component, props) });
  app.mount(root);
  return { props, root, close: () => app.unmount() };
}
const nodes = node => [node, ...(node.children ?? []).flatMap(nodes)];
const text = node => [node.text ?? '', ...(node.children ?? []).map(text)].join(' ');
const byId = (mounted, id) => nodes(mounted.root).find(node => node.props?.id === id);

const flush = async () => { await vue.nextTick(); };

test('resolved row names match visible IDs and never expose raw host labels', async () => {
  const Panel = await component('recording/MvRecordingPanel.vue');
  const events = [];
  const mounted = mount(Panel, { capsuleId: 'cap', exportDestination: 'picker', recordings: [
    { id: '   ', phase: 'sealed', capsuleLabel: 'ERR_PRIVATE host path' },
    { id: 'dup', phase: 'sealed' }, { id: 'dup', phase: 'sealed' }, { id: ' rec-1 ', phase: 'sealed' },
    { id: 'good', capsuleLabel: 'ERR_PRIVATE host path', phase: 'sealed' },
  ], onSubmitIntent: event => events.push(event) });
  try {
    const selects = nodes(mounted.root).filter(n => n.props?.class === 'mv4-select');
    const exports = nodes(mounted.root).filter(n => n.props?.class === 'mv4-btn mv4-export');
    selects.forEach((node, index) => {
      const id = text(node).trim();
      assert.equal(node.props['aria-label'], `Select ${id}`);
      assert.equal(node.props.title, `Select ${id}`);
      assert.equal(exports[index].props['aria-label'], `Export ${id} to host destination`);
      assert.equal(exports[index].props.title, `Export ${id} to host destination`);
      if (index < 4) { assert.ok(node.props.disabled); node.props.onClick(); exports[index].props.onClick(); }
    });
    assert.deepEqual(events, []);
    assert.equal(new Set(selects.map(n => n.props['aria-label'])).size, selects.length);
    assert.doesNotMatch(nodes(mounted.root).map(n => `${n.props?.title ?? ''} ${n.props?.['aria-label'] ?? ''}`).join(' '), /ERR_PRIVATE|host path/);
    selects.at(-1).props.onClick();
    assert.equal(events.length, 1, 'valid recording still dispatches');
  } finally { mounted.close(); }
});

test('invalid fallback rows remain unselected across selectedId updates', async () => {
  const Panel = await component('recording/MvRecordingPanel.vue');
  const mounted = mount(Panel, { capsuleId: 'cap', selectedId: 'unknown-0', recordings: [{}, { id: 'good' }] });
  try {
    const rows = () => nodes(mounted.root).filter(n => n.tag === 'tr' && n.props?.id);
    assert.equal(rows()[0].props['aria-selected'], undefined);
    assert.doesNotMatch(rows()[0].props.class, /mv4-row-selected/);
    mounted.props.selectedId = 'good'; await flush();
    assert.equal(rows()[1].props['aria-selected'], 'true');
    mounted.props.selectedId = 'unknown-0'; await flush();
    assert.equal(rows()[0].props['aria-selected'], undefined);
  } finally { mounted.close(); }
});

test('mounted unsafe capsule and recording IDs produce safe unique anchors and disabled invalid rows', async () => {
  const Panel = await component('recording/MvRecordingPanel.vue');
  const events = [];
  const mounted = mount(Panel, { capsuleId: 'Cap 1/foo', capsuleLabel: 'ERR_HOST secret\npath', exportDestination: 'picker', recordings: [
    { id: 'rec 1/foo', phase: 'sealed' }, { id: 'UPPER', phase: 'sealed' },
    { id: 'rec-1', capsuleId: 'cap', phase: 'sealed' }, { id: 'rec/1', phase: 'sealed' },
  ], onSubmitIntent: event => events.push(event) });
  try {
    const rendered = nodes(mounted.root).filter(n => n.props?.id);
    assert.equal(new Set(rendered.map(n => n.props.id)).size, rendered.length);
    for (const node of rendered) {
      assert.match(node.props.id, /^[a-z0-9-]+$/);
      assert.match(node.props['data-semantic-anchor'], /^[a-z0-9]+(?:\/[a-z0-9-]+)+$/);
      assert.equal(node.props.style, undefined);
    }
    assert.doesNotMatch(nodes(mounted.root).map(n => `${n.props?.title ?? ''} ${n.props?.['aria-label'] ?? ''}`).join(' '), /ERR_HOST|secret|\n/);
    const selects = nodes(mounted.root).filter(n => n.props?.class === 'mv4-select');
    for (const index of [0, 1, 3]) { assert.ok(selects[index].props.disabled); selects[index].props.onClick(); }
    assert.deepEqual(events, []);
    selects[2].props.onClick(); assert.equal(events.length, 1);
  } finally { mounted.close(); }
});

test('ID encoding is deterministic and collision safe across unsafe and reserved values', async () => {
  const model = await import('../src/recording/recordingModel.js');
  const ids = ['', ' ', '/', 'a b', 'a/b', 'A', 'a', 'encoded-0020-end', 'cap-7', '\ud800', '🖥'];
  const helpers = ['mvRecordingPanelDomId', 'mvDiskRefusalDomId', 'mvRecordingPanelAnchor', 'mvDiskRefusalAnchor',
    'mvRecordToggleDomId', 'mvScreenshotDomId', 'mvPhaseDomId', 'mvStoreChipDomId',
    'mvRecordToggleAnchor', 'mvScreenshotAnchor', 'mvPhaseAnchor', 'mvStoreChipAnchor',
    'mvManifestRowDomId', 'mvManifestSelectDomId', 'mvExportDomId', 'mvExportGateDomId',
    'mvManifestRowAnchor', 'mvManifestSelectAnchor', 'mvExportAnchor', 'mvExportGateAnchor'];
  for (const name of helpers) {
    const values = ids.map(id => model[name](id));
    assert.equal(new Set(values).size, ids.length, `${name} collisions`);
    values.forEach((value, index) => {
      assert.equal(value, model[name](ids[index]));
      assert.match(value, name.endsWith('Anchor') ? /^[a-z0-9]+(?:\/[a-z0-9-]+)+$/ : /^[a-z0-9-]+$/);
    });
  }
});

test('recording CSS rejects functional and named colors as well as hex', () => {
  const assertTokenColors = source => {
    for (const match of source.matchAll(/(?:^|(?<=[;{]))\s*(color|background(?:-color)?|border(?:-(?:top|right|bottom|left|color))?|outline(?:-color)?|fill|stroke|box-shadow)\s*:\s*([^;{}]+)(?=[;}])/gim)) {
      const remainder = match[2].replace(/var\(--cuk-[a-z0-9-]+\)/g, '').replace(/\b(?:transparent|currentColor|solid|none)\b/g, '');
      assert.match(remainder, /^[\s0-9.,%()-]*$/, `${match[1]} must use kit color tokens`);
    }
  };
  assertTokenColors(readFileSync(new URL('../src/recording/recording.css', import.meta.url), 'utf8'));
  for (const color of ['#fff', 'rgb(0 0 0)', 'rgba(0,0,0,1)', 'hsl(0 0% 0%)', 'oklch(0 0 0)', 'red', 'rebeccapurple']) {
    assert.throws(() => assertTokenColors(`.x { color: ${color}; }`), /must use kit color tokens/);
    assert.throws(() => assertTokenColors(`.x { color: var(--cuk-semantic-text-primary); background: ${color}; }`), /must use kit color tokens/);
  }
});
