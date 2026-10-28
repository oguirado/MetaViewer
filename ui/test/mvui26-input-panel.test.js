/**
 * MVUI26 lane I: recording-panel regression test for input RV10-04.
 *
 * Invalid screenshot rows must not share one export-status key: the key
 * falls back to the disambiguated display id. The key never reaches the
 * DOM (invalid rows are force-disabled and render the display id), so the
 * regression check is a source audit in the established panel-test style,
 * paired with a mount control proving invalid rows stay force-disabled
 * with distinct display ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';

const sfcUrl = new URL('../src/recording/MvRecordingPanel.vue', import.meta.url);
const sfc = readFileSync(sfcUrl, 'utf8');

const FIXED_STATUS_KEY = /const statusKey = validId \? `shot:\$\{sourceId\}` : `shot-invalid:\$\{id\}`;/;
const BASE_STATUS_KEY = /const statusKey = `shot:\$\{sourceId\}`;/;

test('mvui26 panel: invalid shot rows get distinct export-status keys', () => {
  assert.match(sfc, FIXED_STATUS_KEY, 'fixed statusKey line present');
  assert.doesNotMatch(sfc, BASE_STATUS_KEY, 'base statusKey line gone');
});

test('mvui26 panel negative: the status-key audit detects both spellings', () => {
  assert.match(
    'const statusKey = validId ? `shot:${sourceId}` : `shot-invalid:${id}`;',
    FIXED_STATUS_KEY,
    'fixed fixture matches',
  );
  assert.doesNotMatch(
    'const statusKey = validId ? `shot:${sourceId}` : `shot-invalid:${id}`;',
    BASE_STATUS_KEY,
    'fixed fixture is not the base spelling',
  );
  assert.match('const statusKey = `shot:${sourceId}`;', BASE_STATUS_KEY, 'base fixture matches');
  assert.doesNotMatch(
    'const statusKey = `shot:${sourceId}`;',
    FIXED_STATUS_KEY,
    'base fixture is not the fixed spelling',
  );
});

let serial = 0;
async function component(file) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'));
  const compiled = compileScript(descriptor, { id: 'mvui26-panel', inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^\s*import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm,
    (all, binding, _q, specifier) => {
      if (specifier === '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue') {
        const helper = new URL('./mvui2-terminal-mount.mjs', import.meta.url).href;
        return `import { SidebarIcon as ${binding.trim()} } from ${JSON.stringify(helper)};`;
      }
      const resolved = specifier === 'vue'
        ? pathToFileURL(require.resolve('vue')).href
        : new URL(specifier, url).href;
      return `import ${binding} from ${JSON.stringify(resolved)};`;
    });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`))
    .default;
}

function mount(Component, input) {
  const props = vue.reactive(input);
  const renderer = vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }),
    createComment: () => ({ text: '' }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
    },
    remove(child) {
      const list = child.parent?.children;
      if (list) list.splice(list.indexOf(child), 1);
    },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; node.children = []; },
    patchProp(node, key, _old, value) { node.props[key] = value; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    setScopeId() {},
  });
  const root = { children: [] };
  const app = renderer.createApp({ render: () => vue.h(Component, props) });
  app.mount(root);
  return { props, root, close: () => app.unmount() };
}

const nodes = (node) => [node, ...(node.children ?? []).flatMap(nodes)];

test('mvui26 panel control: duplicate-id shots stay disabled with distinct display ids', async () => {
  const Panel = await component('recording/MvRecordingPanel.vue');
  const shot = (id) => ({
    id, kind: 'shot', surface_id: 'cap-01', phase: 'sealed', frames: 1,
    duration_ms: 0, sealed: true, created_ms: 1,
  });
  const store = vue.reactive({ bySurface: {}, rows: [shot('dup'), shot('dup')] });
  const mounted = mount(Panel, { capsuleId: 'cap-01', captureState: store });
  try {
    await vue.nextTick();
    const buttons = nodes(mounted.root).filter(
      (node) => node.tag === 'button'
        && typeof node.props?.id === 'string'
        && node.props.id.startsWith('mv-recordings-export-'),
    );
    assert.equal(buttons.length, 2, 'both invalid shot rows render an export button');
    const ids = buttons.map((node) => node.props.id);
    assert.notEqual(ids[0], ids[1], 'display ids stay distinct');
    for (const node of buttons) {
      assert.equal(node.props.disabled, true, 'invalid rows stay force-disabled');
    }
  } finally {
    mounted.close();
  }
});
