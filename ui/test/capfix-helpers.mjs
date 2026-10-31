// CAP-FIX test helpers: source mutants, Rust contract scraping and a stub
// renderer. Portable: every path derives from import.meta.url (no host paths).
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';

export const UI_ROOT = new URL('../', import.meta.url);
export const REPO_ROOT = new URL('../../', import.meta.url);

/** @param {string} rel Repo-relative path. @returns {string} UTF-8 source. */
export function repoSource(rel) {
  return readFileSync(fileURLToPath(new URL(rel, REPO_ROOT)), 'utf8');
}

/**
 * Apply literal source mutations; each `from` must occur, so a refactor that
 * moves the guarded text fails the test instead of silently skipping it.
 * @param {string} source
 * @param {ReadonlyArray<readonly [string,string]>} edits
 */
export function applyMutation(source, edits) {
  let out = source;
  for (const [from, to] of edits) {
    assert.ok(out.includes(from), `mutation target not found: ${from.slice(0, 80)}`);
    out = out.replace(from, to);
  }
  return out;
}

let serial = 0;
/**
 * Import a mutated copy of a ui module. Relative and bare specifiers are
 * rewritten to absolute file URLs so the copy can live in a temp directory.
 * @param {string} relFromUi Path below ui/ (for example electron/captureBridge.js).
 * @param {ReadonlyArray<readonly [string,string]>} edits Literal mutations ([] = faithful copy).
 */
export async function importMutant(relFromUi, edits) {
  const url = new URL(relFromUi, UI_ROOT);
  const source = applyMutation(readFileSync(fileURLToPath(url), 'utf8'), edits);
  const rewritten = source.replace(/(\bfrom\s+|\bimport\s+)(['"])([^'"]+)\2/g, (all, lead, quote, spec) => {
    const target = spec.startsWith('.') ? new URL(spec, url).href : import.meta.resolve(spec);
    return `${lead}${quote}${target}${quote}`;
  });
  const dir = mkdtempSync(join(tmpdir(), 'capfix-mutant-'));
  try {
    const file = join(dir, `mutant-${serial++}.mjs`);
    writeFileSync(file, rewritten);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Codes the Rust core can put in a capture refusal, scraped from source. */
export function coreRefusalCodes() {
  const record = repoSource('core/src/record/capture.rs');
  const exportRs = repoSource('core/src/record/capture/export.rs');
  const serve = repoSource('core/src/serve/capture.rs');
  const codes = new Set();
  for (const m of record.matchAll(/refusal\("([A-Z_]+)"\)/g)) codes.add(m[1]);
  for (const m of record.matchAll(/=> "([A-Z_]+)",/g)) codes.add(m[1]);
  for (const m of exportRs.matchAll(/(?:Err|ok_or)\("([A-Z_]+)"\)/g)) codes.add(m[1]);
  for (const m of serve.matchAll(/ok_or\("([A-Z_]+)"\)/g)) codes.add(m[1]);
  return [...codes].sort();
}

/** Keys of the sealed `recording` object the core builds on ram_stop. */
export function coreStopRecordingKeys() {
  const record = repoSource('core/src/record/capture.rs');
  const m = record.match(/json!\(\{"ok":true,"recording":\{([^}]*)\}\}\)/);
  assert.ok(m, 'core ram_stop reply literal not found');
  return [...m[1].matchAll(/"([a-z0-9_]+)":/g)].map((k) => k[1]).sort();
}

/**
 * Stub renderer mount (no DOM), as the other panel tests do.
 * @param {any} Component
 * @param {Record<string,any>} input
 */
export function mount(Component, input) {
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
    remove(child) { const list = child.parent?.children; if (list) list.splice(list.indexOf(child), 1); },
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
export const nodes = (node) => [node, ...(node.children ?? []).flatMap(nodes)];
export const textOf = (node) => [node.text ?? '', ...(node.children ?? []).map(textOf)].join(' ');
export const byId = (mounted, id) => nodes(mounted.root).find((node) => node.props?.id === id);
export const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); await vue.nextTick(); };

/**
 * Compile the recording panel SFC, optionally with literal source mutations.
 * @param {ReadonlyArray<readonly [string,string]>} [edits]
 */
export async function panelComponent(edits = []) {
  const url = new URL('src/recording/MvRecordingPanel.vue', UI_ROOT);
  const source = applyMutation(readFileSync(fileURLToPath(url), 'utf8'), edits);
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: `capfix-panel-${serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue') {
      const helper = new URL('./mvui2-terminal-mount.mjs', import.meta.url).href;
      return `import { SidebarIcon as ${binding.trim()} } from ${JSON.stringify(helper)};`;
    }
    const resolved = specifier === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(specifier, url).href;
    return `import ${binding} from ${JSON.stringify(resolved)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
}
