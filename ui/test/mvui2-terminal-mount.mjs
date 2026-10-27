// Minimal SFC mount harness for the mvui2 terminal suites (node:test, no DOM).
// Mirrors the compile + custom-renderer approach of mvui-f1-lifecycle.test.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import OpenVueButton from 'openvue/button';
import { parse, compileScript } from '@vue/compiler-sfc';

let serial = 0;

export const flush = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await vue.nextTick(); } };

export const text = (n) => [n.text ?? '', ...(n.children ?? []).map(text)].join(' ');
export const nodes = (n) => [n, ...(n.children ?? []).flatMap(nodes)];

/** @param {string} file @param {Record<string, unknown>} deps */
export async function compileSfc(file, deps) {
  const { descriptor } = parse(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'));
  let code = compileScript(descriptor, { id: 'mvui2v1', inlineTemplate: true }).content;
  code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') {
      return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('vue')).href));
    }
    if (file === 'multislot/MultislotHost.vue' && spec === 'capsule-ui-kit/ui') deps[spec] = { UiButton };
    assert.ok(spec in deps, `Unmapped SFC dependency: ${spec}`);
    return `const ${bindings.trim()} = globalThis.__mvui2v1Deps[${JSON.stringify(spec)}];`;
  });
  globalThis.__mvui2v1Deps = deps;
  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
  } finally {
    delete globalThis.__mvui2v1Deps;
  }
}

// Compile the real kit icon once for the closed dependency maps below.
export const SidebarIcon = await compileSfc('../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue', {});

// Real kit button and underlying library component for placement controls.
export const UiButton = await compileSfc('../.kit/capsule-ui-kit/src/ui/UiButton.vue', { 'openvue/button': OpenVueButton });

/** @param {string} name @param {Record<string, any>} children */
export function childStub(name, children) {
  return vue.defineComponent({
    inheritAttrs: false,
    setup(_, ctx) {
      children[name] = ctx;
      return () => vue.h('section', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? []));
    },
  });
}

/** DOM attribute surface used by the real kit button directives. */
export function rendererElement(tag) {
  return { tag, children:[], props:{},
    setAttribute(key,value) { this.props[key]=value; },
    removeAttribute(key) { delete this.props[key]; },
    getAttribute(key) { return this.props[key] ?? null; },
    hasAttribute(key) { return key in this.props; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

/** @param {any} component @param {Record<string, any>} initial */
export function mountComponent(component, initial = {}) {
  const props = vue.reactive(initial);
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: rendererElement,
    createText: (t) => ({ text: t }),
    createComment: (t) => ({ text: t }),
    insert(node, parent) { node.parent = parent; parent.children.push(node); },
    remove(node) { const a = node.parent?.children; if (a) a.splice(a.indexOf(node), 1); },
    setText(n, t) { n.text = t; },
    setElementText(n, t) { n.text = t; },
    patchProp(n, k, _old, v) { n.props[k] = v; },
    parentNode: (n) => n.parent,
    nextSibling: () => null,
    setScopeId() {},
  });
  const app = renderer.createApp({ setup: () => () => vue.h(component, props) });
  app.mount(root);
  return { app, props, root };
}
