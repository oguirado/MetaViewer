// MetaViewer catalog model contract (AC-03): closed kind set, typed error
// rows for unknown kinds, create-intent builder, invoker focus return.
// Runs under plain Node (`node --test`): no DOM, no Electron, no kit Vue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_INVALID_ENTRY,
  CATALOG_INVALID_INTENT,
  CATALOG_KIND_IDS,
  CATALOG_KINDS,
  CATALOG_UNKNOWN_KIND,
  buildCreateIntent,
  createInvokerFocus,
  isKnownCatalogKind,
  normalizeCatalogEntries,
  resolveCatalogKind,
  resolveCatalogPlacement,
  slugifyCatalogKey,
} from '../src/catalog/catalogModel.js';
import {
  capsuleCategories,
  normalizeCapsuleCatalog,
} from '../.kit/capsule-ui-kit/src/shell/NewCapsuleModel.js';

test('closed kind set carries the four roadmap kinds in display order', () => {
  assert.deepEqual([...CATALOG_KIND_IDS],
    ['identity-browser', 'program']);
  assert.deepEqual(CATALOG_KINDS.map((entry) => entry.label),
    ['Identity browser', 'Program']);
  // Negative control: a third or reordered id breaks the contract.
  assert.throws(() => assert.deepEqual([...CATALOG_KIND_IDS, 'extra'], [...CATALOG_KIND_IDS]),
    assert.AssertionError);
});

test('kind set and descriptors are frozen; mutation throws', () => {
  assert.ok(Object.isFrozen(CATALOG_KINDS));
  assert.ok(Object.isFrozen(CATALOG_KIND_IDS));
  for (const entry of CATALOG_KINDS) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.keywords));
  }
  assert.throws(() => { CATALOG_KIND_IDS.push('extra'); }, TypeError);
});

test('known-kind check is exact and case-sensitive', () => {
  for (const id of CATALOG_KIND_IDS) assert.equal(isKnownCatalogKind(id), true);
  // Negative controls: unknown, empty, non-string and wrong-case inputs.
  for (const value of ['unknown-kind', '', ' ', null, 42, {}, 'Identity-Browser', 'PROGRAM']) {
    assert.equal(isKnownCatalogKind(value), false);
  }
});

test('resolve returns a frozen kit-shaped type for known kinds', () => {
  const result = resolveCatalogKind('program');
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.type, keywords: [...result.type.keywords] }, {
    id: 'program',
    label: 'Program',
    category: 'Programs',
    description: 'Run a program in its own capsule.',
    opensAs: 'tab',
    footprint: '',
    keywords: ['program', 'run', 'app'],
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.type));
  // Negative control: mutating the resolved type throws.
  assert.throws(() => { result.type.label = 'Mutated'; }, TypeError);
});

test('resolve maps an unknown kind to a typed error row, never a throw', () => {
  const result = resolveCatalogKind('teleport');
  assert.equal(result.ok, false);
  assert.deepEqual({ ...result.error }, {
    code: CATALOG_UNKNOWN_KIND,
    kind: 'teleport',
    message: 'Unknown capsule kind: "teleport".',
    key: 'unknown-kind-teleport',
  });
  assert.equal(result.error.code, 'ERR_CATALOG_UNKNOWN_KIND');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.error));
  // Negative control: resolving null is an invalid entry, not unknown kind.
  const invalid = resolveCatalogKind(null);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, CATALOG_INVALID_ENTRY);
});

test('normalize splits mixed entries into types plus typed error rows', () => {
  const normalized = normalizeCatalogEntries(
    ['program', 'teleport', { kind: 'identity-browser' }, null, 42, 'program', { kind: 'teleport' }]);
  assert.deepEqual(normalized.types.map((type) => type.id), ['program', 'identity-browser']);
  assert.deepEqual(normalized.errors.map((row) => row.key),
    ['unknown-kind-teleport', 'invalid-entry-unknown']);
  assert.deepEqual(normalized.errors.map((row) => row.code),
    [CATALOG_UNKNOWN_KIND, CATALOG_INVALID_ENTRY]);
  assert.ok(Object.isFrozen(normalized));
  // Negative control: duplicates collapse (first wins), so ids stay unique.
  assert.equal(normalized.types.length, 2);
  assert.equal(normalized.errors.length, 2);
});

test('normalize tolerates non-array catalogs without crashing', () => {
  for (const value of [null, 'program', 42, {}]) {
    assert.deepEqual(normalizeCatalogEntries(value), { types: [], errors: [] });
  }
  // Negative control: an unknown-only catalog yields zero types, one row.
  const only = normalizeCatalogEntries(['teleport']);
  assert.deepEqual(only.types, []);
  assert.equal(only.errors.length, 1);
});

test('normalized types survive kit normalization unchanged', () => {
  const normalized = normalizeCatalogEntries([...CATALOG_KIND_IDS]);
  const roundTrip = normalizeCapsuleCatalog(JSON.parse(JSON.stringify(normalized.types)));
  assert.deepEqual(roundTrip, JSON.parse(JSON.stringify(normalized.types)));
  // Negative control: kit drops entries without id/label, ours never emit those.
  assert.deepEqual(normalizeCapsuleCatalog([{ id: '', label: '' }]), []);
});

test('intent builder emits a frozen kind-plus-placement payload', () => {
  const result = buildCreateIntent({ kind: 'identity-browser', placement: 'floating' });
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.intent },
    { type: 'create-capsule', kind: 'identity-browser', placement: 'floating' });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.intent));
  // Negative control: mutating the intent throws.
  assert.throws(() => { result.intent.kind = 'program'; }, TypeError);
});

test('intent builder falls back to tab placement and refuses bad input', () => {
  assert.equal(buildCreateIntent({ kind: 'program', placement: 'sideways', binary: 'gedit' }).intent.placement, 'tab');
  assert.equal(buildCreateIntent({ kind: 'program', binary: 'gedit' }).intent.placement, 'tab');
  assert.equal(buildCreateIntent({ kind: 'program', placement: 'split', binary: 'gedit' }).intent.placement, 'split');
  assert.equal(buildCreateIntent({ kind: 'program', binary: '  gedit  ' }).intent.binary, 'gedit');
  assert.equal(resolveCatalogPlacement('floating'), 'floating');
  assert.equal(resolveCatalogPlacement(null), 'tab');
  // Negative controls: unknown kind and malformed inputs (including program without binary) refuse typed.
  const unknown = buildCreateIntent({ kind: 'teleport', placement: 'tab' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, CATALOG_UNKNOWN_KIND);
  for (const value of [null, 42, 'program', {}, { kind: null }, { kind: 7 }, { kind: 'program' }, { kind: 'program', binary: '' }, { kind: 'program', binary: '   ' }]) {
    const refused = buildCreateIntent(value);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, CATALOG_INVALID_INTENT);
    assert.equal(refused.error.code, 'ERR_CATALOG_INVALID_INTENT');
  }
});

test('slugifier is kebab-case, deterministic and total', () => {
  assert.equal(slugifyCatalogKey('Foo Bar!'), 'foo-bar');
  assert.equal(slugifyCatalogKey('desktop'), 'desktop');
  // Negative controls: empty and non-string inputs collapse to unknown.
  for (const value of ['', '   ', '!!!', null, 42, {}]) {
    assert.equal(slugifyCatalogKey(value), 'unknown');
  }
});

test('invoker focus restores the captured element exactly once', () => {
  const focus = createInvokerFocus();
  let calls = 0;
  const node = { isConnected: true, focus() { calls += 1; } };
  focus.capture(node);
  assert.equal(focus.restore(), true);
  assert.equal(calls, 1);
  // Negative control: second restore is a no-op.
  assert.equal(focus.restore(), false);
  assert.equal(calls, 1);
});

test('invoker focus never touches disconnected or unfocusable nodes', () => {
  const focus = createInvokerFocus();
  let calls = 0;
  focus.capture({ isConnected: false, focus() { calls += 1; } });
  assert.equal(focus.restore(), false);
  focus.capture({ isConnected: true });
  assert.equal(focus.restore(), false);
  focus.capture(null);
  assert.equal(focus.restore(), false);
  focus.capture('not-a-node');
  assert.equal(focus.restore(), false);
  assert.equal(calls, 0);
  // Negative control: restore without capture reports false.
  assert.equal(createInvokerFocus().restore(), false);
});

test('catalog lists exactly the two kinds and kills mutants that re-add removed kinds', async () => {
  function assertExactTwoKindCatalog(mod) {
    assert.deepEqual([...mod.CATALOG_KIND_IDS], ['identity-browser', 'program']);
    assert.deepEqual(mod.CATALOG_KINDS.map((entry) => entry.kind), ['identity-browser', 'program']);
    const normalized = mod.normalizeCatalogEntries(mod.CATALOG_KIND_IDS);
    assert.deepEqual(
      capsuleCategories([...normalized.types]),
      [
        { id: 'browse', label: 'Browse', count: 1 },
        { id: 'programs', label: 'Programs', count: 1 },
      ],
    );
    for (const removed of ['holdings-app', 'desktop']) {
      assert.equal(mod.isKnownCatalogKind(removed), false);
      const resolved = mod.resolveCatalogKind(removed);
      assert.equal(resolved.ok, false);
      assert.equal(resolved.error.code, CATALOG_UNKNOWN_KIND);
      const intent = mod.buildCreateIntent({ kind: removed, placement: 'tab' });
      assert.equal(intent.ok, false);
      assert.equal(intent.error.code, CATALOG_UNKNOWN_KIND);
    }
  }

  assertExactTwoKindCatalog({
    CATALOG_KIND_IDS,
    CATALOG_KINDS,
    normalizeCatalogEntries,
    isKnownCatalogKind,
    resolveCatalogKind,
    buildCreateIntent,
  });

  const source = readFileSync(
    fileURLToPath(new URL('../src/catalog/catalogModel.js', import.meta.url)),
    'utf8',
  );
  const readdedHoldings = source.replace(
    "kind: 'program',",
    "kind: 'holdings-app', label: 'Holdings app', category: 'Programs', description: 'x', opensAs: 'tab', footprint: '', keywords: Object.freeze(['holdings']), }), Object.freeze({ kind: 'program',",
  );
  assert.notEqual(readdedHoldings, source);
  const mutantHoldings = await import(
    `data:text/javascript;base64,${Buffer.from(readdedHoldings).toString('base64')}#mutant-holdings`
  );
  assert.throws(() => assertExactTwoKindCatalog(mutantHoldings), assert.AssertionError);

  const readdedDesktop = source.replace(
    "kind: 'program',",
    "kind: 'desktop', label: 'Desktop', category: 'Desktops', description: 'x', opensAs: 'tab', footprint: '', keywords: Object.freeze(['desktop']), }), Object.freeze({ kind: 'program',",
  );
  assert.notEqual(readdedDesktop, source);
  const mutantDesktop = await import(
    `data:text/javascript;base64,${Buffer.from(readdedDesktop).toString('base64')}#mutant-desktop`
  );
  assert.throws(() => assertExactTwoKindCatalog(mutantDesktop), assert.AssertionError);
});
