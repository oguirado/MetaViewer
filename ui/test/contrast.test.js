/** MetaViewer theme oracle: contract, contrast, CSS parity, fonts, vendor, axes.
 * Light-primary 4-mode system; every text/background pair must reach WCAG AA.
 * @module contrast.test
 */
import { describe, test } from 'node:test';
import { expect } from './assertions.js';
import { readFileSync, readdirSync } from 'node:fs';

/** @typedef {'light.normal'|'light.high'|'dark.normal'|'dark.high'} Mode */
/** @typedef {'color'|'dimension'|'duration'|'number'|'fontFamily'|'fontWeight'|'cubicBezier'} TokenType */
/** @typedef {{ $type: TokenType, $value?: string, modes?: Record<string,string>, density?: Record<string,string>, scale?: Record<string,string>, forcedColors?: {active:string} }} TokenLeaf */
/** @typedef {{foreground:string, background:string}} ContrastPair */
/** @typedef {{mode:string, density:string, textScale:string, forcedColors:string}} ResolveOptions */

const TOKENS_URL = new URL('../src/design/metaviewer.tokens.json', import.meta.url);
const CSS_URL = new URL('../src/design/metaviewer.css', import.meta.url);
const UI_URL = new URL('../', import.meta.url);
/** @type {Record<string, any>} */
const tokens = JSON.parse(readFileSync(TOKENS_URL, 'utf8'));
const cssText = readFileSync(CSS_URL, 'utf8');

const SCHEMA = 'metaviewer.design-tokens/v1';
const CSS_PREFIX = '--mv';
const MIN_RATIO = 4.5;
/** Closed CSS system-color set admitted for forcedColors.active. */
const SYSTEM_COLORS = new Set(['Canvas', 'CanvasText', 'Highlight', 'HighlightText', 'GrayText', 'ButtonFace', 'ButtonText', 'LinkText', 'Field', 'FieldText']);
const VENDOR_NEEDLES = ['--dv-', '--p-', '--px-', '--vscode-', 'dt(', 'colorScheme.highContrast'];
const REMOTE_NEEDLES = ['url(', 'http:', 'https:', '@import', '@font-face'];
const DIMENSION_UNITS = ['px', 'rem', 'em', '%', 'vh', 'vw', 'ch', 'lh'];
const RETAINED_UNWIRED = 'primitive.color.neutral.350';

/** Frozen leaf inventory: any added or removed token fails. */
const REQUIRED_LEAVES = [
  'component.badge.background',
  'component.badge.text',
  'component.control.background',
  'component.control.height',
  'component.control.paddingInline',
  'component.control.text',
  'component.focusRing.color',
  'component.focusRing.offset',
  'component.focusRing.width',
  'component.panel.background',
  'component.separator.size',
  'component.tab.height',
  'component.tab.paddingInline',
  'component.toolbar.background',
  'primitive.color.amber.100',
  'primitive.color.amber.200',
  'primitive.color.amber.300',
  'primitive.color.amber.350',
  'primitive.color.amber.400',
  'primitive.color.amber.50',
  'primitive.color.amber.500',
  'primitive.color.amber.600',
  'primitive.color.amber.700',
  'primitive.color.amber.800',
  'primitive.color.amber.950',
  'primitive.color.blue.100',
  'primitive.color.blue.200',
  'primitive.color.blue.300',
  'primitive.color.blue.400',
  'primitive.color.blue.50',
  'primitive.color.blue.500',
  'primitive.color.blue.600',
  'primitive.color.blue.700',
  'primitive.color.blue.750',
  'primitive.color.blue.800',
  'primitive.color.blue.900',
  'primitive.color.blue.925',
  'primitive.color.blue.950',
  'primitive.color.green.100',
  'primitive.color.green.200',
  'primitive.color.green.300',
  'primitive.color.green.450',
  'primitive.color.green.50',
  'primitive.color.green.500',
  'primitive.color.green.700',
  'primitive.color.green.800',
  'primitive.color.green.950',
  'primitive.color.neutral.0',
  'primitive.color.neutral.100',
  'primitive.color.neutral.1000',
  'primitive.color.neutral.1050',
  'primitive.color.neutral.1100',
  'primitive.color.neutral.250',
  'primitive.color.neutral.300',
  'primitive.color.neutral.350',
  'primitive.color.neutral.400',
  'primitive.color.neutral.450',
  'primitive.color.neutral.50',
  'primitive.color.neutral.500',
  'primitive.color.neutral.550',
  'primitive.color.neutral.600',
  'primitive.color.neutral.700',
  'primitive.color.neutral.800',
  'primitive.color.neutral.850',
  'primitive.color.neutral.900',
  'primitive.color.neutral.950',
  'primitive.color.purple.100',
  'primitive.color.purple.300',
  'primitive.color.purple.500',
  'primitive.color.purple.700',
  'primitive.color.purple.900',
  'primitive.color.red.100',
  'primitive.color.red.200',
  'primitive.color.red.50',
  'primitive.color.red.500',
  'primitive.color.red.600',
  'primitive.color.red.700',
  'primitive.color.red.800',
  'primitive.color.red.950',
  'primitive.color.slate.400',
  'primitive.color.slate.500',
  'primitive.color.slate.600',
  'primitive.color.slate.700',
  'primitive.duration.fast',
  'primitive.duration.none',
  'primitive.duration.normal',
  'primitive.easing.standard',
  'primitive.font.family.mono',
  'primitive.font.family.sans',
  'primitive.fontSize.body',
  'primitive.fontSize.caption',
  'primitive.fontSize.title',
  'primitive.fontWeight.bold',
  'primitive.fontWeight.medium',
  'primitive.fontWeight.regular',
  'primitive.radius.circle',
  'primitive.radius.feature',
  'primitive.radius.full',
  'primitive.radius.lg',
  'primitive.radius.md',
  'primitive.radius.sm',
  'primitive.radius.xl',
  'primitive.radius.xs',
  'primitive.radius.xxl',
  'primitive.radius.xxxl',
  'primitive.space.base',
  'primitive.space.hero',
  'primitive.space.lg',
  'primitive.space.md',
  'primitive.space.section',
  'primitive.space.section-lg',
  'primitive.space.section-sm',
  'primitive.space.sm',
  'primitive.space.xl',
  'primitive.space.xs',
  'primitive.space.xxl',
  'primitive.space.xxs',
  'primitive.space.xxxl',
  'primitive.zIndex.base',
  'primitive.zIndex.modal',
  'primitive.zIndex.overlay',
  'semantic.accent.onSecondaryContainer',
  'semantic.accent.onTertiaryContainer',
  'semantic.accent.primary',
  'semantic.accent.primaryContrast',
  'semantic.accent.secondaryContainer',
  'semantic.accent.tertiaryContainer',
  'semantic.border.default',
  'semantic.border.strong',
  'semantic.border.subtle',
  'semantic.focus.offset',
  'semantic.focus.ring',
  'semantic.focus.width',
  'semantic.motion.duration.fast',
  'semantic.motion.duration.none',
  'semantic.motion.duration.normal',
  'semantic.motion.easing.standard',
  'semantic.radius.full',
  'semantic.radius.lg',
  'semantic.radius.md',
  'semantic.radius.sm',
  'semantic.selection.surface',
  'semantic.selection.text',
  'semantic.space.lg',
  'semantic.space.md',
  'semantic.space.sm',
  'semantic.space.xl',
  'semantic.space.xs',
  'semantic.status.error.border',
  'semantic.status.error.icon',
  'semantic.status.error.surface',
  'semantic.status.error.text',
  'semantic.status.info.border',
  'semantic.status.info.icon',
  'semantic.status.info.surface',
  'semantic.status.info.text',
  'semantic.status.success.border',
  'semantic.status.success.icon',
  'semantic.status.success.surface',
  'semantic.status.success.text',
  'semantic.status.warning.border',
  'semantic.status.warning.icon',
  'semantic.status.warning.surface',
  'semantic.status.warning.text',
  'semantic.surface.canvas',
  'semantic.surface.chrome',
  'semantic.surface.elevated',
  'semantic.surface.interactive',
  'semantic.surface.interactiveActive',
  'semantic.surface.interactiveHover',
  'semantic.surface.inverse',
  'semantic.surface.overlay',
  'semantic.surface.panel',
  'semantic.surface.sunken',
  'semantic.text.accent',
  'semantic.text.disabled',
  'semantic.text.inverse',
  'semantic.text.muted',
  'semantic.text.primary',
  'semantic.typography.fontFamily.mono',
  'semantic.typography.fontFamily.sans',
  'semantic.typography.fontSize.body',
  'semantic.typography.fontSize.caption',
  'semantic.typography.fontSize.title',
  'semantic.typography.lineHeight.body',
  'semantic.typography.lineHeight.title',
  'semantic.zIndex.base',
  'semantic.zIndex.modal',
  'semantic.zIndex.overlay',
];

/** Rule-based pair inventory, independent of the token file content. */
const GENERAL_TEXT = ['semantic.text.primary', 'semantic.text.muted', 'semantic.text.disabled', 'semantic.text.accent'];
const GENERAL_BG = ['semantic.surface.canvas', 'semantic.surface.panel', 'semantic.surface.chrome', 'semantic.surface.elevated', 'semantic.surface.sunken', 'semantic.surface.interactive', 'semantic.surface.interactiveHover', 'semantic.surface.interactiveActive'];
const STATUS_KINDS = ['info', 'success', 'warning', 'error'];

/** Expand the pair rules to the full expected inventory (64 pairs).
 * @returns {ContrastPair[]}
 */
function expandExpectedPairs() {
  /** @type {ContrastPair[]} */
  const out = [];
  for (const fg of GENERAL_TEXT) for (const bg of GENERAL_BG) out.push({ foreground: fg, background: bg });
  out.push({ foreground: 'semantic.text.inverse', background: 'semantic.surface.inverse' });
  out.push({ foreground: 'semantic.selection.text', background: 'semantic.selection.surface' });
  out.push({ foreground: 'semantic.accent.primaryContrast', background: 'semantic.accent.primary' });
  out.push({ foreground: 'semantic.accent.onSecondaryContainer', background: 'semantic.accent.secondaryContainer' });
  out.push({ foreground: 'semantic.accent.onTertiaryContainer', background: 'semantic.accent.tertiaryContainer' });
  out.push({ foreground: 'semantic.accent.primary', background: 'semantic.surface.canvas' });
  out.push({ foreground: 'semantic.accent.primary', background: 'semantic.surface.panel' });
  for (const k of STATUS_KINDS) {
    out.push({ foreground: `semantic.status.${k}.text`, background: `semantic.status.${k}.surface` });
    out.push({ foreground: `semantic.status.${k}.icon`, background: `semantic.status.${k}.surface` });
    out.push({ foreground: `semantic.status.${k}.text`, background: 'semantic.surface.canvas' });
    out.push({ foreground: `semantic.status.${k}.text`, background: 'semantic.surface.panel' });
    out.push({ foreground: `semantic.status.${k}.icon`, background: 'semantic.surface.canvas' });
    out.push({ foreground: `semantic.status.${k}.icon`, background: 'semantic.surface.panel' });
  }
  out.push({ foreground: 'component.badge.text', background: 'component.badge.background' });
  return out;
}

/** Hand-pinned goldens: light canon plus frozen derived dark/high values. */
/** @type {Record<string, Record<string,string>>} */
const GOLDENS = {
  'light.normal': {
    'semantic.surface.canvas': '#ffffff',
    'semantic.surface.panel': '#ffffff',
    'semantic.surface.chrome': '#f1f4f7',
    'semantic.surface.sunken': '#e6eaef',
    'semantic.surface.interactiveActive': '#c9dbf9',
    'semantic.text.primary': '#1c1e21',
    'semantic.text.muted': '#4b4c4f',
    'semantic.text.disabled': '#525b66',
    'semantic.text.accent': '#0457cb',
    'semantic.accent.primary': '#0064e0',
    'semantic.accent.primaryContrast': '#ffffff',
    'semantic.selection.surface': '#0457cb',
    'semantic.focus.ring': '#0064e0',
    'semantic.status.info.text': '#03408f',
    'semantic.status.error.text': '#a50e2d',
    'semantic.status.warning.surface': '#fdf3dd',
    'semantic.status.success.surface': '#e7f4ea',
    'component.badge.background': '#0064e0',
    'component.badge.text': '#ffffff',
  },
  'dark.normal': {
    'semantic.surface.canvas': '#0a1317',
    'semantic.surface.panel': '#12181d',
    'semantic.surface.chrome': '#1b232c',
    'semantic.surface.sunken': '#05090c',
    'semantic.surface.interactiveActive': '#2e3943',
    'semantic.text.primary': '#f1f4f7',
    'semantic.text.muted': '#a9b2bc',
    'semantic.text.disabled': '#9aa3ad',
    'semantic.text.accent': '#7fb0f5',
    'semantic.accent.primary': '#7fb0f5',
    'semantic.accent.primaryContrast': '#05090c',
    'semantic.selection.surface': '#7fb0f5',
    'semantic.selection.text': '#05090c',
    'semantic.status.error.surface': '#48060f',
    'semantic.status.error.text': '#f9d2cd',
    'component.badge.background': '#7fb0f5',
    'component.badge.text': '#05090c',
  },
  'light.high': {
    'semantic.surface.canvas': '#ffffff',
    'semantic.text.primary': '#000000',
    'semantic.text.muted': '#1c1e21',
    'semantic.text.accent': '#03215c',
    'semantic.accent.primary': '#03215c',
  },
  'dark.high': {
    'semantic.surface.canvas': '#000000',
    'semantic.text.primary': '#ffffff',
    'semantic.text.muted': '#f1f4f7',
    'semantic.text.accent': '#dce8fd',
    'semantic.accent.primary': '#dce8fd',
  },
};

/** @param {string} path @returns {string} single reference target or '' */
function singleRef(value) {
  const m = /^\{([A-Za-z0-9_.]+)\}$/.exec(value);
  return m ? /** @type {string} */ (m[1]) : '';
}

/** @param {Record<string, any>} contract @param {string} path @returns {TokenLeaf} */
function leafAt(contract, path) {
  /** @type {any} */
  let node = contract;
  for (const key of path.split('.')) node = node?.[key];
  if (!node || typeof node !== 'object' || typeof node.$type !== 'string') throw new Error('Unknown token: ' + path);
  return /** @type {TokenLeaf} */ (node);
}

/** @param {Record<string, any>} contract @returns {string[]} derived scheme.contrast modes */
function derivedModes(contract) {
  const schemes = contract.axes.scheme.resolvedModes;
  const contrasts = contract.axes.contrast.values;
  /** @type {string[]} */
  const modes = [];
  for (const s of schemes) for (const c of contrasts) modes.push(`${s}.${c}`);
  return modes;
}

/** @param {string[]} a @param {string[]} b @returns {boolean} */
function sameStrings(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** @param {string} value @param {TokenType} type @param {string} path @returns {void} */
function checkLiteral(value, type, path) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid token value: ${path}`);
  for (const n of [...VENDOR_NEEDLES, ...REMOTE_NEEDLES]) {
    if (value.includes(n)) throw new Error(`Forbidden reference in token value: ${path}`);
  }
  if (value.includes('{') || value.includes('}')) {
    if (!singleRef(value)) throw new Error(`Invalid token reference: ${path}`);
    return;
  }
  if (type === 'color' && !/^#[0-9a-f]{6}$/.test(value)) throw new Error(`Invalid color literal: ${path}`);
  if (type === 'dimension' && value !== '0' && !new RegExp(`^\\d+(\\.\\d+)?(${DIMENSION_UNITS.join('|')})$`).test(value)) {
    throw new Error(`Invalid dimension literal: ${path}`);
  }
  if (type === 'duration' && !/^\d+(\.\d+)?ms$/.test(value)) throw new Error(`Invalid duration literal: ${path}`);
  if (type === 'number' && !/^\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid number literal: ${path}`);
  if (type === 'fontWeight' && !/^(100|200|300|400|500|600|700|800|900)$/.test(value)) throw new Error(`Invalid fontWeight literal: ${path}`);
  if (type === 'cubicBezier' && !/^cubic-bezier\((\d+(\.\d+)?, ?){3}\d+(\.\d+)?\)$/.test(value)) throw new Error(`Invalid cubicBezier literal: ${path}`);
}

/** Validate namespaces, typed leaves, tiers, units and the full reference graph.
 * @param {Record<string, any>} contract
 * @returns {{leaves:number}}
 */
export function validateTokenContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw new Error('Invalid contract');
  const top = Object.keys(contract).sort();
  const wantTop = ['authority', 'axes', 'component', 'contrastPairs', 'primitive', 'schema', 'semantic'].sort();
  if (!sameStrings(top, wantTop)) throw new Error('Unknown top-level key: ' + top.filter((k) => !wantTop.includes(k)).join(','));
  if (contract.schema !== SCHEMA) throw new Error('Unknown schema: ' + String(contract.schema));
  const auth = contract.authority;
  if (!auth || auth.owner !== 'ui/src/design/metaviewer.tokens.json' || auth.direction !== 'primitive -> semantic -> component' ||
    auth.vendorVariableReferenceAllowed !== false || auth.deterministicOfflineGeneration !== true || auth.cssVariablePrefix !== CSS_PREFIX) {
    throw new Error('Invalid authority block');
  }
  const axes = contract.axes;
  const axisKeys = Object.keys(axes).sort();
  if (!sameStrings(axisKeys, ['contrast', 'density', 'forcedColors', 'reducedMotion', 'scheme', 'textScale'])) throw new Error('Invalid axes');
  if (!sameStrings(axes.scheme.preferences, ['system', 'light', 'dark']) || !sameStrings(axes.scheme.resolvedModes, ['light', 'dark']) ||
    axes.scheme.defaultPreference !== 'light' || axes.scheme.rootAttribute !== 'data-theme-scheme') throw new Error('Invalid scheme axis');
  if (!sameStrings(axes.contrast.values, ['normal', 'high']) || axes.contrast.default !== 'normal' || axes.contrast.rootAttribute !== 'data-theme-contrast') {
    throw new Error('Invalid contrast axis');
  }
  if (!sameStrings(axes.density.values, ['compact', 'regular', 'comfortable']) || axes.density.default !== 'regular' || axes.density.rootAttribute !== 'data-theme-density') {
    throw new Error('Invalid density axis');
  }
  if (!sameStrings(axes.textScale.values, ['0.875', '1', '1.125', '1.25']) || axes.textScale.default !== '1' ||
    axes.textScale.independentOfDensity !== true || axes.textScale.rootAttribute !== 'data-theme-text-scale') throw new Error('Invalid textScale axis');
  if (!sameStrings(axes.forcedColors.values, ['none', 'active']) || axes.forcedColors.default !== 'none' ||
    axes.forcedColors.mediaQuery !== '(forced-colors: active)' || axes.forcedColors.rootAttribute !== 'data-theme-forced-colors') {
    throw new Error('Invalid forcedColors axis');
  }
  if (!sameStrings(axes.reducedMotion.values, ['no-preference', 'reduce']) || axes.reducedMotion.default !== 'no-preference' ||
    axes.reducedMotion.mediaQuery !== '(prefers-reduced-motion: reduce)' || axes.reducedMotion.rootAttribute !== 'data-theme-motion') {
    throw new Error('Invalid reducedMotion axis');
  }
  const modes = derivedModes(contract);
  /** @type {Map<string, TokenLeaf>} */
  const leaves = new Map();
  /** @param {any} node @param {string} path @returns {void} */
  function walk(node, path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid token node: ' + path);
    if ('$type' in node) {
      const leaf = /** @type {TokenLeaf} */ (node);
      if (!['color', 'dimension', 'duration', 'number', 'fontFamily', 'fontWeight', 'cubicBezier'].includes(leaf.$type)) {
        throw new Error('Unknown token type: ' + path);
      }
      for (const k of Object.keys(leaf)) {
        if (!['$type', '$value', 'modes', 'density', 'scale', 'forcedColors'].includes(k)) throw new Error(`Unknown token key: ${path}.${k}`);
      }
      const holders = ['$value' in leaf, 'modes' in leaf, 'density' in leaf, 'scale' in leaf].filter(Boolean).length;
      if (holders !== 1) throw new Error('Ambiguous token value: ' + path);
      const tier = path.split('.')[0];
      if (tier === 'primitive' && ('modes' in leaf || 'density' in leaf || 'scale' in leaf)) throw new Error('Primitive token must use $value: ' + path);
      if (tier === 'primitive' && typeof leaf.$value === 'string' && singleRef(leaf.$value)) {
        throw new Error('Primitive token must not reference (reverse tier): ' + path);
      }
      if ('modes' in leaf) {
        if (tier !== 'semantic' || leaf.$type !== 'color') throw new Error('Misplaced modes map: ' + path);
        if (!sameStrings(Object.keys(leaf.modes ?? {}).sort(), [...modes].sort())) throw new Error('Missing mode: ' + path);
      }
      if ('density' in leaf) {
        if (leaf.$type !== 'dimension' || !sameStrings(Object.keys(leaf.density ?? {}).sort(), [...axes.density.values].sort())) {
          throw new Error('Invalid density map: ' + path);
        }
      }
      if ('scale' in leaf) {
        if (leaf.$type !== 'dimension' || !sameStrings(Object.keys(leaf.scale ?? {}).sort(), [...axes.textScale.values].sort())) {
          throw new Error('Invalid scale map: ' + path);
        }
      }
      if ('forcedColors' in leaf) {
        if (leaf.$type !== 'color' || typeof leaf.forcedColors?.active !== 'string' || !SYSTEM_COLORS.has(leaf.forcedColors.active)) {
          throw new Error('Invalid forcedColors mapping: ' + path);
        }
      }
      if (leaf.$type === 'color' && tier !== 'primitive' && !('forcedColors' in leaf)) throw new Error('Missing forcedColors mapping: ' + path);
      if (leaf.$type === 'color' && tier === 'primitive' && 'forcedColors' in leaf) throw new Error('Misplaced forcedColors mapping: ' + path);
      const values = [...('$value' in leaf ? [leaf.$value] : []), ...Object.values(leaf.modes ?? {}), ...Object.values(leaf.density ?? {}), ...Object.values(leaf.scale ?? {})];
      for (const v of values) checkLiteral(/** @type {string} */ (v), leaf.$type, path);
      leaves.set(path, leaf);
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  }
  for (const ns of ['primitive', 'semantic', 'component']) {
    if (!contract[ns]) throw new Error('Missing namespace: ' + ns);
    walk(contract[ns], ns);
  }
  /** @type {Map<string, string[]>} */
  const edges = new Map();
  for (const [path, leaf] of leaves) {
    const values = [...('$value' in leaf ? [leaf.$value] : []), ...Object.values(leaf.modes ?? {}), ...Object.values(leaf.density ?? {}), ...Object.values(leaf.scale ?? {})];
    /** @type {string[]} */
    const refs = [];
    for (const v of values) {
      const ref = singleRef(/** @type {string} */ (v));
      if (!ref) continue;
      refs.push(ref);
      const tier = path.split('.')[0];
      const target = leaves.get(ref);
      if (!target) throw new Error('Unknown token: ' + ref);
      if (tier === 'primitive') throw new Error('Reverse tier reference: ' + path);
      if (tier === 'semantic' && !ref.startsWith('primitive.')) throw new Error('Reverse tier reference: ' + path);
      if (tier === 'component' && !ref.startsWith('semantic.') && !ref.startsWith('primitive.')) throw new Error('Reverse tier reference: ' + path);
      if (target.$type !== leaf.$type) throw new Error(`Token type mismatch: ${path} -> ${ref}`);
      if (ref === RETAINED_UNWIRED) throw new Error('Retained reference wired: ' + ref);
    }
    edges.set(path, refs);
  }
  /** @param {string} path @param {Set<string>} [stack] @returns {void} */
  function visit(path, stack = new Set()) {
    if (stack.has(path)) throw new Error('Token cycle: ' + path);
    for (const ref of edges.get(path) ?? []) visit(ref, new Set([...stack, path]));
  }
  for (const path of leaves.keys()) visit(path);
  /** @type {Map<string, string>} */
  const vars = new Map();
  for (const path of leaves.keys()) {
    const v = varName(path);
    if (vars.has(v)) throw new Error(`CSS variable collision: ${v}`);
    vars.set(v, path);
  }
  for (const f of ['semantic.focus.ring', 'semantic.focus.width', 'semantic.focus.offset']) {
    if (!leaves.has(f)) throw new Error('Missing focus token: ' + f);
  }
  for (const p of REQUIRED_LEAVES) {
    if (!leaves.has(p)) throw new Error('Missing token: ' + p);
  }
  for (const p of leaves.keys()) {
    if (!REQUIRED_LEAVES.includes(p)) throw new Error('Unknown token: ' + p);
  }
  if (!Array.isArray(contract.contrastPairs)) throw new Error('Invalid contrastPairs');
  for (const pair of contract.contrastPairs) {
    const keys = Object.keys(pair).sort();
    if (!sameStrings(keys, ['background', 'foreground'])) throw new Error('Invalid contrast pair shape');
    for (const side of [pair.foreground, pair.background]) {
      const target = leaves.get(side);
      if (!target || target.$type !== 'color') throw new Error('Unknown token: ' + side);
    }
  }
  const expected = new Set(expandExpectedPairs().map((p) => `${p.foreground}\n${p.background}`));
  const actual = new Set(contract.contrastPairs.map((/** @type {ContrastPair} */ p) => `${p.foreground}\n${p.background}`));
  if (expected.size !== actual.size || [...expected].some((k) => !actual.has(k))) throw new Error('Contrast pair inventory mismatch');
  return { leaves: leaves.size };
}

/** Resolve one token with explicit options; absence never acquires a default.
 * @param {Record<string, any>} contract
 * @param {string} path
 * @param {ResolveOptions} options
 * @param {Set<string>} [seen]
 * @returns {string}
 */
export function resolveToken(contract, path, options, seen = new Set()) {
  const keys = Object.keys(options).sort();
  if (!sameStrings(keys, ['density', 'forcedColors', 'mode', 'textScale'])) throw new Error('Invalid resolve options: ' + keys.join(','));
  if (!derivedModes(contract).includes(options.mode)) throw new Error('Invalid resolve options: mode');
  if (!contract.axes.density.values.includes(options.density)) throw new Error('Invalid resolve options: density');
  if (!contract.axes.textScale.values.includes(options.textScale)) throw new Error('Invalid resolve options: textScale');
  if (!contract.axes.forcedColors.values.includes(options.forcedColors)) throw new Error('Invalid resolve options: forcedColors');
  if (seen.has(path)) throw new Error('Token cycle: ' + path);
  const leaf = leafAt(contract, path);
  if (options.forcedColors === 'active' && leaf.forcedColors) return leaf.forcedColors.active;
  /** @type {any} */
  const raw = leaf.modes?.[options.mode] ?? leaf.density?.[options.density] ?? leaf.scale?.[options.textScale] ?? leaf.$value;
  if (typeof raw !== 'string') throw new Error('Unresolved token: ' + path);
  const ref = singleRef(raw);
  if (!ref) {
    if (leaf.$type === 'color' && !/^#[0-9a-f]{6}$/.test(raw)) throw new Error('Unresolved token: ' + path);
    return raw;
  }
  const resolved = resolveToken(contract, ref, options, new Set([...seen, path]));
  const target = leafAt(contract, ref);
  const tier = path.split('.')[0];
  if (tier === 'primitive') throw new Error('Reverse tier reference: ' + path);
  if (tier === 'semantic' && !ref.startsWith('primitive.')) throw new Error('Reverse tier reference: ' + path);
  if (tier !== 'primitive' && tier !== 'semantic' && tier !== 'component') throw new Error('Unknown token: ' + path);
  if (tier === 'component' && !ref.startsWith('semantic.') && !ref.startsWith('primitive.')) throw new Error('Reverse tier reference: ' + path);
  if (target.$type !== leaf.$type) throw new Error(`Token type mismatch: ${path} -> ${ref}`);
  return resolved;
}

/** WCAG 2.x relative luminance; only opaque six-digit hex is accepted.
 * @param {string} hex
 * @returns {number}
 */
export function luminance(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error('Invalid hex color: ' + String(hex));
  const m = hex.slice(1).match(/../g);
  if (!m) throw new Error('Invalid hex color: ' + hex);
  const a = m.map((x) => parseInt(x, 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

/** WCAG 2.x contrast ratio between two opaque colors.
 * @param {string} foreground
 * @param {string} background
 * @returns {number}
 */
export function contrast(foreground, background) {
  const x = luminance(foreground);
  const y = luminance(background);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Map a token path to its CSS custom property: sorted, kebab-cased, prefixed.
 * @param {string} path
 * @returns {string}
 */
function varName(path) {
  return CSS_PREFIX + '-' + path.split('.').map((seg) => seg.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()).join('-');
}

/** @param {Record<string, any>} contract @returns {Map<string, TokenLeaf>} every leaf by path */
function allLeaves(contract) {
  /** @type {Map<string, TokenLeaf>} */
  const leaves = new Map();
  /** @param {any} node @param {string} path @returns {void} */
  function walk(node, path) {
    if (node && typeof node === 'object' && '$type' in node) {
      leaves.set(path, /** @type {TokenLeaf} */ (node));
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  }
  for (const ns of ['primitive', 'semantic', 'component']) walk(contract[ns], ns);
  return leaves;
}

/** Every declared pair must reach 4.5:1 in every admitted mode.
 * @param {Record<string, any>} contract
 * @returns {void}
 */
export function validateContrast(contract) {
  validateTokenContract(contract);
  const modes = derivedModes(contract);
  const pairs = expandExpectedPairs();
  for (const mode of modes) {
    const options = { mode, density: contract.axes.density.default, textScale: contract.axes.textScale.default, forcedColors: 'none' };
    for (const pair of pairs) {
      const fg = resolveToken(contract, pair.foreground, options);
      const bg = resolveToken(contract, pair.background, options);
      const ratio = contrast(fg, bg);
      if (ratio < MIN_RATIO) {
        throw new Error(`Contrast below 4.5:1: ${mode}/${pair.foreground}/${pair.background} ${fg}/${bg} ratio=${ratio.toFixed(3)}`);
      }
    }
    for (const border of ['default', 'strong', 'subtle']) {
      for (const background of GENERAL_BG) {
        const ratio = contrast(resolveToken(contract, `semantic.border.${border}`, options), resolveToken(contract, background, options));
        if (ratio < 3) throw new Error(`UI border contrast below 3:1: ${mode}/${border}/${background} ratio=${ratio.toFixed(3)}`);
      }
    }
  }
}

/** Follow mode refs textually to the backing primitive variable.
 * @param {Record<string, any>} contract
 * @param {string} path
 * @param {string} mode
 * @returns {string} primitive variable name
 */
function primitiveVarFor(contract, path, mode) {
  let current = path;
  for (let hop = 0; hop < 16; hop++) {
    const leaf = leafAt(contract, current);
    const raw = leaf.modes?.[mode] ?? leaf.$value;
    if (typeof raw !== 'string') throw new Error('Unresolved token: ' + current);
    const ref = singleRef(raw);
    if (!ref) {
      if (!current.startsWith('primitive.')) throw new Error('Unresolved token: ' + current);
      return varName(current);
    }
    current = ref;
  }
  throw new Error('Token cycle: ' + path);
}

/** Deterministic offline CSS export: pure function of the contract, no timestamps.
 * @param {Record<string, any>} contract
 * @returns {string}
 */
export function renderCss(contract) {
  validateTokenContract(contract);
  const modes = derivedModes(contract);
  const leaves = [...allLeaves(contract).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const primaries = leaves.filter(([p]) => p.startsWith('primitive.'));
  const derived = leaves.filter(([p]) => !p.startsWith('primitive.'));
  const colors = derived.filter(([, leaf]) => leaf.$type === 'color');
  const densityLeaves = derived.filter(([, leaf]) => leaf.density).map(([p]) => p);
  const scaleLeaves = derived.filter(([, leaf]) => leaf.scale).map(([p]) => p);
  const motionLeaves = derived.filter(([p, leaf]) => p.startsWith('semantic.motion.duration.') && leaf.$type === 'duration').map(([p]) => p);
  /** @type {string[]} */
  const lines = ['/* Generated from metaviewer.tokens.json; no independent values. */', ':root {', '  color-scheme: light;'];
  for (const [path, leaf] of primaries) lines.push(`  ${varName(path)}: ${leaf.$value};`);
  for (const [path, leaf] of derived) {
    if (leaf.$type === 'color') {
      lines.push(`  ${varName(path)}: var(${primitiveVarFor(contract, path, 'light.normal')});`);
    } else if (leaf.density) {
      lines.push(`  ${varName(path)}: ${leaf.density[contract.axes.density.default]};`);
    } else if (leaf.scale) {
      lines.push(`  ${varName(path)}: ${leaf.scale[contract.axes.textScale.default]};`);
    } else if (leaf.$value && singleRef(leaf.$value)) {
      lines.push(`  ${varName(path)}: var(${varName(singleRef(/** @type {string} */ (leaf.$value)))});`);
    } else {
      lines.push(`  ${varName(path)}: ${leaf.$value};`);
    }
  }
  lines.push('  font-family: var(--mv-semantic-typography-font-family-sans);', '}');
  for (const mode of modes) {
    const [scheme, level] = mode.split('.');
    lines.push('', `:root[data-theme-scheme="${scheme}"][data-theme-contrast="${level}"] {`, `  color-scheme: ${scheme};`);
    for (const [path] of colors) lines.push(`  ${varName(path)}: var(${primitiveVarFor(contract, path, mode)});`);
    lines.push('}');
  }
  for (const d of contract.axes.density.values) {
    lines.push('', `:root[data-theme-density="${d}"] {`);
    for (const path of densityLeaves) {
      const leaf = leafAt(contract, path);
      lines.push(`  ${varName(path)}: ${leaf.density?.[d]};`);
    }
    lines.push('}');
  }
  for (const s of contract.axes.textScale.values) {
    lines.push('', `:root[data-theme-text-scale="${s}"] {`);
    for (const path of scaleLeaves) {
      const leaf = leafAt(contract, path);
      lines.push(`  ${varName(path)}: ${leaf.scale?.[s]};`);
    }
    lines.push('}');
  }
  const reduceDecls = motionLeaves.map((p) => `  ${varName(p)}: var(--mv-primitive-duration-none);`);
  lines.push('', ':root[data-theme-motion="reduce"] {', ...reduceDecls, '}');
  lines.push('', '@media (prefers-reduced-motion: reduce) {', '  :root {', ...reduceDecls.map((d) => '  ' + d), '  }', '}');
  const fcDecls = colors.map(([path]) => {
    const leaf = leafAt(contract, path);
    return `  ${varName(path)}: ${leaf.forcedColors?.active};`;
  });
  lines.push('', ':root[data-theme-forced-colors="active"] {', ...fcDecls, '}');
  lines.push('', '@media (forced-colors: active) {', '  :root {', ...fcDecls.map((d) => '  ' + d), '  }', '}');
  lines.push('', ':focus-visible {', '  outline: var(--mv-semantic-focus-width) solid var(--mv-semantic-focus-ring);',
    '  outline-offset: var(--mv-semantic-focus-offset);', '}');
  return lines.join('\n') + '\n';
}

/** @param {string} cssText @param {string} what @returns {void} shared text guards */
function scanTextGuards(cssText, what) {
  for (const n of [...VENDOR_NEEDLES, ...REMOTE_NEEDLES]) {
    if (cssText.includes(n)) throw new Error(`Forbidden token in ${what}: ${n}`);
  }
  if (/var\(--mv-[^)]*,\s*#[0-9a-fA-F]/.test(cssText)) throw new Error('Hardcoded fallback in ' + what);
}

/** Byte parity with the canonical render plus independent structural checks.
 * @param {Record<string, any>} contract
 * @param {string} cssText
 * @returns {void}
 */
export function validateCss(contract, cssText) {
  validateTokenContract(contract);
  const canonical = renderCss(contract);
  if (canonical !== cssText) {
    let i = 0;
    while (i < canonical.length && i < cssText.length && canonical[i] === cssText[i]) i++;
    throw new Error(`CSS parity mismatch at byte ${i}`);
  }
  const first = cssText.split('\n')[0];
  if (first !== '/* Generated from metaviewer.tokens.json; no independent values. */') throw new Error('Missing CSS provenance header');
  if (/\b20\d{2}[-/]\d{2}[-/]\d{2}\b/.test(cssText) || cssText.includes('undefined') || cssText.includes('NaN')) {
    throw new Error('Non-deterministic CSS content');
  }
  for (const path of REQUIRED_LEAVES) {
    if (!cssText.includes(varName(path))) throw new Error('Missing CSS variable: ' + varName(path));
  }
  for (const mode of derivedModes(contract)) {
    const [scheme, level] = mode.split('.');
    const selector = `:root[data-theme-scheme="${scheme}"][data-theme-contrast="${level}"] {`;
    const start = cssText.indexOf(selector);
    if (start < 0) throw new Error('Missing CSS mode block: ' + mode);
    const body = cssText.slice(start, cssText.indexOf('}', start));
    if (!body.includes(`color-scheme: ${scheme};`)) throw new Error('Contradictory color-scheme: ' + mode);
    if (/#[0-9a-fA-F]{3,8}\b/.test(body)) throw new Error('Literal color in mode block: ' + mode);
  }
  for (const d of contract.axes.density.values) {
    if (!cssText.includes(`:root[data-theme-density="${d}"]`)) throw new Error('Missing density block: ' + d);
  }
  for (const s of contract.axes.textScale.values) {
    if (!cssText.includes(`:root[data-theme-text-scale="${s}"]`)) throw new Error('Missing text-scale block: ' + s);
  }
  for (const sel of [':root[data-theme-motion="reduce"]', '@media (prefers-reduced-motion: reduce)',
    ':root[data-theme-forced-colors="active"]', '@media (forced-colors: active)', ':focus-visible']) {
    if (!cssText.includes(sel)) throw new Error('Missing CSS block: ' + sel);
  }
  const focusAt = cssText.indexOf(':focus-visible');
  const focusBody = cssText.slice(focusAt, cssText.indexOf('}', focusAt));
  for (const v of ['--mv-semantic-focus-width', '--mv-semantic-focus-ring', '--mv-semantic-focus-offset']) {
    if (!focusBody.includes(`var(${v})`)) throw new Error('Focus rule must reference ' + v);
  }
  scanTextGuards(cssText, 'metaviewer.css');
}

/** System font stack, no bundled or remote fonts, no packaged font assets.
 * @param {Record<string, any>} contract
 * @param {string} cssText
 * @param {string[]} assetPaths
 * @returns {void}
 */
export function validateFonts(contract, cssText, assetPaths) {
  validateTokenContract(contract);
  const options = { mode: 'light.normal', density: contract.axes.density.default, textScale: contract.axes.textScale.default, forcedColors: 'none' };
  const sans = resolveToken(contract, 'primitive.font.family.sans', options);
  const mono = resolveToken(contract, 'primitive.font.family.mono', options);
  if (!sans.startsWith('system-ui')) throw new Error('Non-system sans stack: ' + sans);
  if (!mono.startsWith('ui-monospace')) throw new Error('Non-system mono stack: ' + mono);
  for (const stack of [sans, mono]) {
    if (stack.includes('Inter') || stack.includes('Optimistic')) throw new Error('Bundled-font stack: ' + stack);
  }
  if (cssText.includes('@font-face')) throw new Error('Forbidden @font-face in metaviewer.css');
  if (/@import\s+url\(/.test(cssText) || /@import\s+['"]https?:/.test(cssText)) throw new Error('Forbidden remote @import in metaviewer.css');
  for (const p of assetPaths) {
    if (/\.(woff2?|ttf|otf|eot)$/i.test(p)) throw new Error('Bundled font asset: ' + p);
  }
  scanTextGuards(cssText, 'metaviewer.css');
}
/** @returns {Record<string, any>} deep clone of the committed contract */
function cloneTokens() {
  return /** @type {Record<string, any>} */ (JSON.parse(JSON.stringify(tokens)));
}

/** @param {Record<string, any>} contract @param {string} mode @returns {ResolveOptions} */
function defaultOptions(contract, mode) {
  return { mode, density: contract.axes.density.default, textScale: contract.axes.textScale.default, forcedColors: 'none' };
}

/** Collect repo-relative asset paths under ui/, excluding development toolchains.
 * @param {URL} dir
 * @param {string} prefix
 * @returns {string[]}
 */
function collectAssets(dir, prefix) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...collectAssets(new URL(entry.name + '/', dir), rel + '/'));
    else out.push(rel);
  }
  return out;
}

describe('T3 fail-closed resolver and contract validator', () => {
  test('committed contract validates with the frozen leaf count', () => {
    expect(validateTokenContract(tokens)).toEqual({ leaves: 189 });
  });
  test('unknown token path throws', () => {
    expect(() => resolveToken(tokens, 'semantic.text.nope', defaultOptions(tokens, 'light.normal'))).toThrow(/Unknown token/);
  });
  test('reference cycle throws before any tier rule', () => {
    const bad = cloneTokens();
    bad.primitive.color.red['500'].$value = '{primitive.color.red.600}';
    bad.primitive.color.red['600'].$value = '{primitive.color.red.500}';
    expect(() => resolveToken(bad, 'primitive.color.red.500', defaultOptions(bad, 'light.normal'))).toThrow(/Token cycle/);
    expect(() => validateTokenContract(bad)).toThrow(/Primitive token must not reference/);
  });
  test('dangling reference throws', () => {
    const bad = cloneTokens();
    bad.semantic.text.primary.modes['light.normal'] = '{semantic.text.nope}';
    expect(() => resolveToken(bad, 'semantic.text.primary', defaultOptions(bad, 'light.normal'))).toThrow(/Unknown token/);
    expect(() => validateTokenContract(bad)).toThrow(/Unknown token/);
  });
  test('primitive referencing semantic throws tier error', () => {
    const bad = cloneTokens();
    bad.primitive.color.red['500'].$value = '{semantic.text.primary}';
    expect(() => validateTokenContract(bad)).toThrow(/tier/i);
  });
  test('semantic aliasing component throws tier error', () => {
    const bad = cloneTokens();
    bad.semantic.text.primary.modes['light.normal'] = '{component.badge.text}';
    expect(() => validateTokenContract(bad)).toThrow(/tier/i);
  });
  test('color resolving to a dimension throws type error', () => {
    const bad = cloneTokens();
    bad.semantic.text.primary.modes['light.normal'] = '{primitive.space.md}';
    expect(() => validateTokenContract(bad)).toThrow(/type mismatch/i);
  });
  test('missing focus slot throws', () => {
    const bad = cloneTokens();
    delete bad.semantic.focus.ring;
    expect(() => validateTokenContract(bad)).toThrow(/focus/i);
  });
  test('missing mode throws', () => {
    const bad = cloneTokens();
    delete bad.semantic.text.primary.modes['dark.high'];
    expect(() => validateTokenContract(bad)).toThrow(/mode/i);
  });
  test('deleted contrast value throws', () => {
    const bad = cloneTokens();
    bad.axes.contrast.values = ['normal'];
    expect(() => validateTokenContract(bad)).toThrow(/contrast axis|Missing mode/);
  });
  test('unknown top-level key throws', () => {
    const bad = cloneTokens();
    bad.extra = {};
    expect(() => validateTokenContract(bad)).toThrow(/top-level/);
  });
  test('unknown leaf key throws', () => {
    const bad = cloneTokens();
    bad.semantic.text.primary.$note = ' stray';
    expect(() => validateTokenContract(bad)).toThrow(/Unknown token key/);
  });
  test('ambiguous $value plus modes throws', () => {
    const bad = cloneTokens();
    bad.semantic.text.primary.$value = '#000000';
    expect(() => validateTokenContract(bad)).toThrow(/Ambiguous/);
  });
  test('unitless dimension throws', () => {
    const bad = cloneTokens();
    bad.semantic.focus.width.$value = '2';
    expect(() => validateTokenContract(bad)).toThrow(/dimension/i);
  });
  test('negative dimension throws', () => {
    const bad = cloneTokens();
    bad.semantic.focus.width.$value = '-2px';
    expect(() => validateTokenContract(bad)).toThrow(/dimension/i);
  });
  test('colliding variable name throws', () => {
    const bad = cloneTokens();
    bad.semantic.surface['interactive-hover'] = {
      $type: 'color',
      modes: {
        'light.normal': '{primitive.color.blue.100}',
        'light.high': '{primitive.color.neutral.0}',
        'dark.normal': '{primitive.color.slate.600}',
        'dark.high': '{primitive.color.neutral.1100}',
      },
      forcedColors: { active: 'ButtonFace' },
    };
    expect(() => validateTokenContract(bad)).toThrow(/collision/);
  });
  test('malformed hex literal throws', () => {
    const bad = cloneTokens();
    bad.primitive.color.red['500'].$value = '#gggggg';
    expect(() => validateTokenContract(bad)).toThrow(/color/i);
  });
  test('external resource in a value throws', () => {
    const bad = cloneTokens();
    bad.primitive.font.family.sans.$value = 'system-ui, url(https://example.invalid/x.woff2)';
    expect(() => validateTokenContract(bad)).toThrow(/Forbidden/);
  });
  test('vendor reference in a value throws', () => {
    const bad = cloneTokens();
    bad.primitive.font.family.mono.$value = 'ui-monospace, dt(foo)';
    expect(() => validateTokenContract(bad)).toThrow(/Forbidden/);
  });
  test('wiring the retained reference throws', () => {
    const bad = cloneTokens();
    bad.semantic.text.disabled.modes['light.normal'] = '{primitive.color.neutral.350}';
    expect(() => validateTokenContract(bad)).toThrow(/Retained/);
  });
});

describe('T1 exhaustive WCAG AA pair matrix', () => {
  test('rule inventory holds 64 pairs', () => {
    expect(expandExpectedPairs()).toHaveLength(64);
  });
  test('committed contract passes every mode', () => {
    expect(() => validateContrast(tokens)).not.toThrow();
  });
  test('planted low-contrast pair is rejected with mode, pair and ratio', () => {
    const bad = cloneTokens();
    bad.semantic.text.primary.modes['light.normal'] = '#777777';
    bad.semantic.surface.canvas.modes['light.normal'] = '#888888';
    expect(() => validateContrast(bad)).toThrow(/light\.normal\/semantic\.text\.primary\/semantic\.surface\.canvas.*ratio=1\.2\d\d/);
  });
  test('low-contrast UI border is rejected independently of the text matrix', () => {
    const bad = cloneTokens();
    bad.semantic.border.default.modes['light.normal'] = '{primitive.color.neutral.0}';
    expect(() => validateContrast(bad)).toThrow(/UI border contrast below 3:1/);
  });
  test('deleted pair is rejected', () => {
    const bad = cloneTokens();
    bad.contrastPairs.pop();
    expect(() => validateContrast(bad)).toThrow(/inventory mismatch/);
  });
  test('contrast math matches known fixtures', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 10);
    expect(luminance('#ffffff')).toBeCloseTo(1, 10);
    expect(luminance('#000000')).toBeCloseTo(0, 10);
    expect(contrast('#777777', '#888888')).toBeCloseTo(1.26, 2);
    expect(contrast('#123456', '#123456')).toBeCloseTo(1, 10);
  });
  test('malformed color input is rejected first', () => {
    for (const bad of ['red', '#fff', '#ffffff00', '#gggggg', '', '  #ffffff']) {
      expect(() => luminance(bad)).toThrow(/hex/i);
    }
    for (const bad of [null, undefined, 123, {}, []]) {
      expect(() => luminance(/** @type {any} */ (bad))).toThrow(/hex/i);
    }
  });
});

describe('T2 exact goldens', () => {
  for (const mode of Object.keys(GOLDENS)) {
    test(`goldens hold for ${mode}`, () => {
      for (const [path, hex] of Object.entries(GOLDENS[mode])) {
        expect(resolveToken(tokens, path, defaultOptions(tokens, mode))).toBe(hex);
      }
    });
  }
  test('light canvas is the reference white', () => {
    expect(resolveToken(tokens, 'semantic.surface.canvas', defaultOptions(tokens, 'light.normal'))).toBe('#ffffff');
  });
});
describe('T4 CSS parity, indirection and offline determinism', () => {
  test('render is deterministic across repeated runs', () => {
    expect(renderCss(cloneTokens())).toBe(renderCss(tokens));
  });
  test('committed CSS equals the canonical render byte for byte', () => {
    expect(renderCss(tokens)).toBe(cssText);
  });
  test('render carries no undefined, NaN or timestamp text', () => {
    const out = renderCss(tokens);
    expect(out).not.toMatch(/undefined|NaN|\b20\d{2}[-/]\d{2}[-/]\d{2}\b/);
    expect(out.split('\n')[0]).toBe('/* Generated from metaviewer.tokens.json; no independent values. */');
    expect(out.endsWith('\n')).toBe(true);
  });
  test('every leaf variable is present in the committed CSS', () => {
    expect(() => validateCss(tokens, cssText)).not.toThrow();
  });
  test('mode blocks declare matching color-scheme with zero hex literals', () => {
    for (const scheme of ['light', 'dark']) {
      for (const level of ['normal', 'high']) {
        const selector = `:root[data-theme-scheme="${scheme}"][data-theme-contrast="${level}"] {`;
        const start = cssText.indexOf(selector);
        expect(start).toBeGreaterThanOrEqual(0);
        const body = cssText.slice(start, cssText.indexOf('}', start));
        expect(body).toContain(`color-scheme: ${scheme};`);
        expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      }
    }
  });
  test('contradictory color-scheme fails validation', () => {
    const darkSelector = ':root[data-theme-scheme="dark"][data-theme-contrast="normal"] {';
    const at = cssText.indexOf(darkSelector);
    const mutant = cssText.slice(0, at) + cssText.slice(at).replace('color-scheme: dark;', 'color-scheme: light;');
    expect(() => validateCss(tokens, mutant)).toThrow(/mismatch|color-scheme/);
  });
  test('changed semantic mapping fails parity', () => {
    const bad = cloneTokens();
    bad.semantic.surface.panel.modes['dark.normal'] = '{primitive.color.neutral.1000}';
    expect(() => validateCss(bad, cssText)).toThrow(/parity mismatch/);
  });
  test('appended overriding literal fails parity', () => {
    expect(() => validateCss(tokens, cssText + ':root{--mv-semantic-surface-canvas:#fff;}\n')).toThrow(/parity mismatch/);
  });
});

describe('T5 system font stack and no-bundled-font guard', () => {
  test('system stacks validate with no font assets', () => {
    expect(() => validateFonts(tokens, cssText, [])).not.toThrow();
  });
  test('committed CSS carries no font-source rules', () => {
    expect(cssText).not.toContain('@font-face');
    expect(cssText).not.toMatch(/@import\s+url\(|@import\s+['"]https?:/);
  });
  test('no font files exist under ui/', () => {
    const assets = collectAssets(UI_URL, 'ui/');
    expect(assets.filter((p) => /\.(woff2?|ttf|otf|eot)$/i.test(p))).toEqual([]);
    expect(() => validateFonts(tokens, cssText, assets)).not.toThrow();
  });
  test('planted @font-face is rejected', () => {
    expect(() => validateFonts(tokens, cssText + '@font-face { src: url("planted.woff2"); }\n', [])).toThrow(/font-face|Forbidden/);
  });
  test('remote @import is rejected', () => {
    expect(() => validateFonts(tokens, cssText + '@import url("https://example.invalid/x.css");\n', [])).toThrow(/import|Forbidden/);
  });
  test('bundled-font stack is rejected', () => {
    const bad = cloneTokens();
    bad.primitive.font.family.sans.$value = '"Optimistic VF", system-ui, sans-serif';
    expect(() => validateFonts(bad, cssText, [])).toThrow(/stack/);
  });
  test('planted font asset path is rejected', () => {
    expect(() => validateFonts(tokens, cssText, ['ui/src/design/planted.woff2'])).toThrow(/font asset/);
  });
});

describe('T6 vendor-leak and unexplained-fallback guard', () => {
  test('tokens and CSS carry zero vendor references', () => {
    const raw = readFileSync(TOKENS_URL, 'utf8');
    for (const n of ['--dv-', '--p-', '--px-', '--vscode-', 'dt(', 'colorScheme.highContrast']) {
      expect(raw).not.toContain(n);
      expect(cssText).not.toContain(n);
    }
  });
  test('no var() call hides a hardcoded hex fallback', () => {
    expect(cssText).not.toMatch(/var\(--mv-[^)]*,\s*#[0-9a-fA-F]/);
  });
  test('planted vendor variable fails CSS validation', () => {
    expect(() => validateCss(tokens, cssText + ':root{--vscode-x:1;}\n')).toThrow(/mismatch|Forbidden/);
  });
  test('planted vendor call in tokens fails contract validation', () => {
    const bad = cloneTokens();
    bad.primitive.easing.standard.$value = 'dt(motion)';
    expect(() => validateTokenContract(bad)).toThrow(/Forbidden/);
  });
});

describe('T7 forced-colors, reduced-motion, density and scale coverage', () => {
  test('every derived color maps a closed-system forced color', () => {
    for (const path of REQUIRED_LEAVES) {
      if (path.startsWith('primitive.')) continue;
      const leaf = tokens;
      const node = path.split('.').reduce((/** @type {any} */ v, k) => v?.[k], leaf);
      if (node.$type !== 'color') continue;
      expect(['Canvas', 'CanvasText', 'Highlight', 'HighlightText', 'GrayText', 'ButtonFace', 'ButtonText', 'LinkText', 'Field', 'FieldText']).toContain(node.forcedColors.active);
    }
  });
  test('every semantic color resolves a keyword under forced colors', () => {
    for (const path of REQUIRED_LEAVES) {
      if (!path.startsWith('semantic.') && !path.startsWith('component.')) continue;
      const node = path.split('.').reduce((/** @type {any} */ v, k) => v?.[k], /** @type {any} */ (tokens));
      if (node.$type !== 'color') continue;
      const keyword = resolveToken(tokens, path, { mode: 'light.normal', density: 'regular', textScale: '1', forcedColors: 'active' });
      expect([...['Canvas', 'CanvasText', 'Highlight', 'HighlightText', 'GrayText', 'ButtonFace', 'ButtonText', 'LinkText', 'Field', 'FieldText']]).toContain(keyword);
    }
  });
  test('CSS covers motion, forced colors, density and scale blocks', () => {
    for (const sel of [':root[data-theme-motion="reduce"]', '@media (prefers-reduced-motion: reduce)',
      ':root[data-theme-forced-colors="active"]', '@media (forced-colors: active)']) {
      expect(cssText).toContain(sel);
    }
    for (const d of ['compact', 'regular', 'comfortable']) expect(cssText).toContain(`:root[data-theme-density="${d}"]`);
    for (const s of ['0.875', '1', '1.125', '1.25']) expect(cssText).toContain(`:root[data-theme-text-scale="${s}"]`);
    expect(cssText.indexOf('@media (prefers-reduced-motion: reduce)')).toBeGreaterThan(cssText.indexOf(':root[data-theme-motion="reduce"]'));
    expect(cssText.indexOf('@media (forced-colors: active)')).toBeGreaterThan(cssText.indexOf(':root[data-theme-forced-colors="active"]'));
  });
  test('removed forced-colors mapping fails contract validation', () => {
    const bad = cloneTokens();
    delete bad.semantic.text.primary.forcedColors;
    expect(() => validateTokenContract(bad)).toThrow(/forcedColors/);
  });
  test('removed forced-colors media fails CSS validation', () => {
    expect(() => validateCss(tokens, cssText.replace('@media (forced-colors: active)', '@media (x)'))).toThrow(/parity mismatch|Missing CSS block/);
  });
  test('removed focus rule fails CSS validation', () => {
    expect(() => validateCss(tokens, cssText.replace(':focus-visible', ':hover'))).toThrow(/parity mismatch|Missing CSS block/);
  });
});

describe('non-vacuity', () => {
  test('a permissive stub cannot catch the planted mutant the oracle rejects', () => {
    const bad = cloneTokens();
    bad.semantic.text.primary.modes['light.normal'] = '#777777';
    bad.semantic.surface.canvas.modes['light.normal'] = '#888888';
    const permissive = () => {};
    expect(() => permissive()).not.toThrow();
    expect(() => validateContrast(bad)).toThrow(/Contrast below/);
  });
});




