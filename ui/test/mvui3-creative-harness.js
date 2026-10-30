import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';

let serial = 0;
const modules = new Map();
globalThis.__creativeModules = modules;
export async function loadSfc(path, deps) {
  const key = ++serial;
  modules.set(key, {
    './demo/DemoDialog.vue': vue.defineComponent({render:()=>null}),
    '../../.kit/capsule-ui-kit/src/ui/UiPage.vue': ui.UiPage,
    '../../.kit/capsule-ui-kit/src/ui/UiToolbar.vue': ui.UiToolbar,
    ...deps,
  });
  const { descriptor } = parse(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'));
  const compiled = compileScript(descriptor, { id: `creative-${key}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__creativeModules.get(${key})[${JSON.stringify(spec)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#creative-${key}`)).default;
}
export const slotStub = vue.defineComponent({ setup: (_p, ctx) => () => vue.h('section', ctx.attrs,
  Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
export const ui = {
  UiPage: slotStub, UiToolbar: slotStub,
  UiButton: vue.defineComponent({ props: ['label'], setup: (p, ctx) => () => vue.h('button', ctx.attrs, p.label) }),
};
export function mount(Component, props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: () => ({ text: '' }),
    insert(child, parent, anchor) { if (child.parent) this.remove(child); child.parent = parent; const i = parent.children.indexOf(anchor); parent.children.splice(i < 0 ? parent.children.length : i, 0, child); },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, _old, value) { node.props[key] = value; }, querySelector: () => null, setScopeId() {},
  });
  const app = renderer.createApp(Component, props);
  app.mount(root);
  return { root, close: () => app.unmount() };
}
export const nodes = node => [node, ...(node.children ?? []).flatMap(nodes)];
export const text = node => [node.text ?? '', ...(node.children ?? []).map(text)].join(' ');
export const byId = (root, id) => nodes(root).find(n => n.props?.id === id);
export { vue };
