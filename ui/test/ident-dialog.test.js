import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import { identityErrorText, normalizeDomains, validDomains, validLabel } from '../src/identities/identityForm.js';
import { assertOperatorCall } from '../electron/preload.js';

const tick = async () => { await new Promise(r => setImmediate(r)); await vue.nextTick(); };
const Button = vue.defineComponent({ props: ['label', 'disabled'], emits: ['click'], setup: (p, { emit }) => () => vue.h('button', { disabled: p.disabled, onClick: () => emit('click') }, p.label) });
const Input = vue.defineComponent({ props: ['label', 'modelValue'], emits: ['update:modelValue'], setup: (p, { emit }) => () => vue.h('input', { 'aria-label': p.label, value: p.modelValue, onInput: e => emit('update:modelValue', e.target.value) }) });
const Dialog = vue.defineComponent({ props: ['open', 'title', 'confirmLabel', 'backLabel', 'busy', 'confirmDisabled'], emits: ['confirm', 'back'], setup: (p, { emit, slots }) => () => p.open ? vue.h('section', { 'aria-label': p.title }, [...(slots.default?.() ?? []), vue.h('button', { disabled: p.busy || p.confirmDisabled, onClick: () => emit('confirm') }, p.confirmLabel)]) : null });
let serial = 0;
async function component() {
  const url = new URL('../src/identities/IdentitiesDialog.vue', import.meta.url), { descriptor } = parse(readFileSync(url, 'utf8'));
  const built = compileScript(descriptor, { id: 'identdlg', inlineTemplate: true });
  globalThis.__identDialog = { UiButton: Button, UiTextInput: Input, Dialog };
  const require = createRequire(import.meta.url);
  const code = built.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
    if (spec === 'capsule-ui-kit/ui') return `const ${binding}=globalThis.__identDialog;`;
    if (spec.endsWith('.vue')) return `const ${binding}=globalThis.__identDialog.Dialog;`;
    return `import ${binding} from ${JSON.stringify(spec === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(spec, url).href)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
}
function mount(Component, props) {
  const renderer = vue.createRenderer({ createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
    insert(child, parent, anchor) { if (child.parent) this.remove(child); child.parent = parent; const at = parent.children.indexOf(anchor); parent.children.splice(at < 0 ? parent.children.length : at, 0, child); },
    remove(child) { const list = child.parent?.children; if (list) list.splice(list.indexOf(child), 1); },
    setText(n, text) { n.text = text; }, setElementText(n, text) { n.text = text; n.children = []; }, patchProp(n, k, _o, value) { n.props[k] = value; },
    parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, setScopeId() {} });
  const root = { children: [] }, app = renderer.createApp(Component, props); app.mount(root); return { root, close: () => app.unmount() };
}
const nodes = n => [n, ...(n.children ?? []).flatMap(nodes)];
const text = n => (n.text ?? '') + (n.children ?? []).map(text).join(' ');
const field = (root, label) => nodes(root).find(n => n.props?.['aria-label'] === label);
const createButton = root => nodes(root).find(n => n.tag === 'button' && n.text === 'Create identity');
const fill = (root, id, label, domains) => { for (const [name, value] of [['Identity id', id], ['Account label', label], ['Domains (comma separated)', domains]]) field(root, name).props.onInput({ target: { value } }); };

test('IDENT-FORM: domains are trimmed, lower-cased, deduplicated and emptied of stray commas', () => {
  assert.deepEqual(normalizeDomains('a.com, '), ['a.com']);
  assert.deepEqual(normalizeDomains(' A.com ,b.org,,a.com'), ['a.com', 'b.org']);
  assert.deepEqual(normalizeDomains(' , '), []);
  assert.equal(validDomains([]), false);
  for (const bad of ['-a.com', 'a.com-', 'a b.com', 'a_b.com', '*.a.com', 'x'.repeat(254)]) assert.equal(validDomains([bad]), false, bad);
  assert.equal(validDomains(Array(257).fill('a.com')), false);
  assert.equal(validDomains(['a.com', 'b-c.org']), true);
  for (const bad of ['', ' x', 'x ', 'a;b', 'a`b', 'a$b', 'a|b', 'a&b', 'a<b', 'a\\b', 'a\nb', 'x'.repeat(129)]) assert.equal(validLabel(bad), false, JSON.stringify(bad));
  assert.equal(validLabel('Perplexity main'), true);
});

test('IDENT-FORM: every typed host code has its own explanation and keeps the raw code', () => {
  const texts = ['IDENTITY_UNAVAILABLE', 'IDENTITY_REFUSED', 'OPERATOR_PAYLOAD'].map(identityErrorText);
  assert.equal(new Set(texts).size, 3);
  texts.forEach((value, i) => assert.ok(value.includes(['IDENTITY_UNAVAILABLE', 'IDENTITY_REFUSED', 'OPERATOR_PAYLOAD'][i])));
  assert.match(identityErrorText('IDENTITY_UNAVAILABLE'), /^The identity tool could not run: IDENTITY_UNAVAILABLE/);
  assert.match(identityErrorText('OPERATOR_REPLY'), /^The identity tool could not run: OPERATOR_REPLY$/);
  assert.match(identityErrorText(''), /AUSENTE — no reason supplied/);
});

test('IDENT-DIALOG: trailing comma, spaces and upper case reach the host as a clean request the host admits', async t => {
  const calls = [];
  const host = { identity: { list: async () => ({ ok: true, rows: [] }), create: async v => { calls.push(v); return { ok: true, rows: [] }; } } };
  const view = mount(await component(), { open: true, host }); t.after(view.close); await tick();
  fill(view.root, 'account-a', '  Account A  ', ' Example.COM , ');
  await tick();
  assert.equal(createButton(view.root).props.disabled, false);
  createButton(view.root).props.onClick(); await tick();
  assert.deepEqual(calls, [{ id: 'account-a', label: 'Account A', domains: ['example.com'] }]);
  assert.doesNotThrow(() => assertOperatorCall('identity.create', [calls[0]]));
});

test('IDENT-DIALOG: input the host would refuse never leaves the dialog', async t => {
  let creates = 0;
  const host = { identity: { list: async () => ({ ok: true, rows: [] }), create: async () => { creates++; return { ok: true, rows: [] }; } } };
  const view = mount(await component(), { open: true, host }); t.after(view.close); await tick();
  for (const [label, domains] of [['A;b', 'a.com'], ['A', ' , '], ['A', 'bad_host.com'], ['A', '*.a.com'], ['   ', 'a.com']]) {
    fill(view.root, 'account-a', label, domains); await tick();
    assert.equal(createButton(view.root).props.disabled, true, `${label}|${domains}`);
    createButton(view.root).props.onClick(); await tick();
  }
  assert.equal(creates, 0);
});

test('IDENT-DIALOG: the operator sees which typed failure happened', async t => {
  for (const [code, expected] of [['IDENTITY_UNAVAILABLE', /could not run: IDENTITY_UNAVAILABLE.*MV_SRF_BIN_DIR/], ['IDENTITY_REFUSED', /refused the request: IDENTITY_REFUSED/], ['OPERATOR_PAYLOAD', /before it reached the tool: OPERATOR_PAYLOAD/]]) {
    const view = mount(await component(), { open: true, host: { identity: { list: async () => ({ ok: false, code }) } } }); t.after(view.close); await tick();
    assert.match(text(view.root), expected, code);
  }
  const rejecting = mount(await component(), { open: true, host: { identity: { list: async () => { throw new Error('OPERATOR_PAYLOAD'); } } } }); t.after(rejecting.close); await tick();
  assert.match(text(rejecting.root), /before it reached the tool: OPERATOR_PAYLOAD/);
});
