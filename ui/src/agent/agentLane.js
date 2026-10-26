/**
 * @file agent_lane/v1 DOM snapshot producer for MetaViewer (lane U5).
 * Builds a closed, frozen snapshot from `[data-semantic-anchor]` elements in
 * document order. Renderer-only: no host calls, no Node/Electron APIs, no
 * network. Anchor-family admission reuses the kit inventory matcher.
 * Plain JavaScript ES module with JSDoc types.
 */

import { matchControlFamily } from '../../.kit/capsule-ui-kit/src/agent/controlRegistry.js';

/** Closed snapshot schema identity. */
export const AGENT_LANE_SCHEMA = 'agent_lane/v1';

/** Global key installed on the renderer host object (`window`). */
export const AGENT_LANE_GLOBAL = '__agentLane';

/** Selector for snapshot candidates. */
export const ANCHORED_SELECTOR = '[data-semantic-anchor]';

/** Selector for the strict id+anchor gate over interactive elements. */
export const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="tab"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="searchbox"]',
  '[tabindex]',
].join(',');

/** Upper bound for collected accessible-name text. */
export const MAX_ACCESSIBLE_NAME_CHARS = 140;

/**
 * @typedef {Object} AgentControlRect
 * @property {number} x - Rounded content-window CSS pixel X.
 * @property {number} y - Rounded content-window CSS pixel Y.
 * @property {number} width - Rounded positive CSS pixel width.
 * @property {number} height - Rounded positive CSS pixel height.
 */

/**
 * @typedef {Object} AgentControl
 * @property {string} id - Stable DOM id.
 * @property {string} anchor - Concrete `data-semantic-anchor` value.
 * @property {string} role - Effective role (explicit or inferred).
 * @property {string} name - Collected accessible name (may be empty).
 * @property {boolean} enabled - False when disabled or aria-disabled.
 * @property {boolean} visible - False when hidden, aria-hidden, or sizeless.
 * @property {AgentControlRect|null} rect - Rounded box, or null when unavailable.
 */

/**
 * @typedef {Object} AgentSkipped
 * @property {string|null} anchor
 * @property {string|null} id
 * @property {string} reason - `missing-id` or `empty-anchor`.
 */

/**
 * @typedef {Object} AgentSnapshotState
 * @property {string} source - Always `dom` for live snapshots.
 * @property {string|null} fixture - Active `?state=` fixture key, if any.
 * @property {number} collected - Number of controls in the snapshot.
 * @property {readonly AgentSkipped[]} skipped - Anchored nodes left out, in order.
 */

/**
 * @typedef {Object} AgentSnapshot
 * @property {string} schema - Always `agent_lane/v1`.
 * @property {readonly AgentControl[]} controls
 * @property {string} screen
 * @property {AgentSnapshotState} state
 */

/**
 * @typedef {Object} AnchorOffender
 * @property {string} tag - Uppercase tag name.
 * @property {string|null} id
 * @property {string|null} anchor
 * @property {string} reason - `missing-id` or `missing-anchor`.
 */

/**
 * @typedef {Object} AnchorAuditRow
 * @property {string} anchor
 * @property {boolean} admitted - True when the kit inventory admits the anchor.
 * @property {string|null} family - Admitting family template, or null.
 * @property {boolean} roleAdmitted - True when the role fits the family.
 */

/**
 * Creates a coded error for deterministic gate assertions.
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function laneError(code, message) {
  const error = /** @type {Error & { code?: string }} */ (new Error(message));
  error.code = code;
  return /** @type {Error & { code: string }} */ (error);
}

/**
 * Reads a string attribute defensively (real DOM or minimal doubles).
 * @param {any} node
 * @param {string} name
 * @returns {string|null}
 */
function readAttr(node, name) {
  if (!node || typeof node.getAttribute !== 'function') return null;
  const value = node.getAttribute(name);
  return typeof value === 'string' ? value : null;
}

/**
 * @param {any} node
 * @param {string} name
 * @returns {boolean}
 */
function hasAttr(node, name) {
  if (!node) return false;
  if (typeof node.hasAttribute === 'function') return node.hasAttribute(name);
  return readAttr(node, name) !== null;
}

/**
 * Normalizes a client-rect-like value to rounded CSS pixels.
 * DOMRect (`x`/`y`) and legacy (`left`/`top`) shapes are accepted.
 * @param {unknown} value
 * @returns {AgentControlRect|null}
 */
export function roundRect(value) {
  if (!value || typeof value !== 'object') return null;
  const box = /** @type {Record<string, unknown>} */ (value);
  const x = box.x ?? box.left;
  const y = box.y ?? box.top;
  const { width, height } = box;
  if (![x, y, width, height].every((part) => typeof part === 'number' && Number.isFinite(part))) {
    return null;
  }
  const rect = {
    x: Math.round(/** @type {number} */ (x)),
    y: Math.round(/** @type {number} */ (y)),
    width: Math.round(/** @type {number} */ (width)),
    height: Math.round(/** @type {number} */ (height)),
  };
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

/**
 * Reads the rendered box of a node; never throws, never fabricates.
 * @param {any} node
 * @returns {AgentControlRect|null}
 */
function readRect(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return null;
  try {
    return roundRect(node.getBoundingClientRect());
  } catch {
    return null;
  }
}

/**
 * @param {any} node
 * @returns {string}
 */
function tagOf(node) {
  const tag = node?.tagName;
  return typeof tag === 'string' ? tag.toUpperCase() : '';
}

/**
 * Infers the effective role: explicit `role` first, then the host tag.
 * @param {any} node
 * @returns {string}
 */
export function inferRole(node) {
  const explicit = readAttr(node, 'role');
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const tag = tagOf(node);
  if (tag === 'BUTTON') return 'button';
  if (tag === 'A') return 'link';
  if (tag === 'SELECT') return 'combobox';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'INPUT') {
    const type = (readAttr(node, 'type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  return 'generic';
}

/**
 * Collapses whitespace and bounds name text deterministically.
 * @param {string} text
 * @returns {string}
 */
function cleanName(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ACCESSIBLE_NAME_CHARS);
}

/**
 * Collects the accessible name: `aria-label`, then rendered text, then
 * `value`/`placeholder`/`title`. Deterministic; never localizes ids.
 * @param {any} node
 * @returns {string}
 */
export function readName(node) {
  const labelled = readAttr(node, 'aria-label');
  if (labelled && labelled.trim().length > 0) return cleanName(labelled);
  const text = node?.textContent;
  if (typeof text === 'string' && text.trim().length > 0) return cleanName(text);
  for (const attr of ['value', 'placeholder', 'title']) {
    const candidate = readAttr(node, attr);
    if (candidate && candidate.trim().length > 0) return cleanName(candidate);
  }
  const direct = node?.value;
  if (typeof direct === 'string' && direct.trim().length > 0) return cleanName(direct);
  return '';
}

/**
 * @param {any} node
 * @returns {boolean}
 */
export function isEnabled(node) {
  if (!node) return false;
  if (node.disabled === true || hasAttr(node, 'disabled')) return false;
  return readAttr(node, 'aria-disabled') !== 'true';
}

/**
 * @param {any} node
 * @param {AgentControlRect|null} rect
 * @returns {boolean}
 */
export function isVisible(node, rect) {
  if (!node || rect === null) return false;
  if (hasAttr(node, 'hidden')) return false;
  return readAttr(node, 'aria-hidden') !== 'true';
}

/**
 * Collects snapshot controls from anchored descendants in document order.
 * Ids and anchors are trimmed; whitespace-only identities are skipped and
 * reported; collection itself never throws on node data.
 * @param {any} root - Object exposing `querySelectorAll`.
 * @returns {{ controls: readonly AgentControl[], skipped: readonly AgentSkipped[] }}
 */
export function collectAgentControls(root) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    throw laneError('ERR_AGENT_LANE_NO_ROOT', 'Agent lane collection needs a queryable root');
  }
  /** @type {AgentControl[]} */
  const controls = [];
  /** @type {AgentSkipped[]} */
  const skipped = [];
  const nodes = root.querySelectorAll(ANCHORED_SELECTOR);
  const list = typeof nodes[Symbol.iterator] === 'function' ? Array.from(nodes) : [];
  for (const node of list) {
    const anchor = readAttr(node, 'data-semantic-anchor')?.trim() ?? null;
    const id = typeof node?.id === 'string' ? node.id.trim() : '';
    if (!anchor || anchor.length === 0) {
      skipped.push(Object.freeze({ anchor, id: id || null, reason: 'empty-anchor' }));
      continue;
    }
    if (!id || id.length === 0) {
      skipped.push(Object.freeze({ anchor, id: null, reason: 'missing-id' }));
      continue;
    }
    const rect = readRect(node);
    controls.push(
      Object.freeze({
        id,
        anchor,
        role: inferRole(node),
        name: readName(node),
        enabled: isEnabled(node),
        visible: isVisible(node, rect),
        rect: rect ? Object.freeze(rect) : null,
      }),
    );
  }
  return { controls: Object.freeze(controls), skipped: Object.freeze(skipped) };
}

/**
 * Resolves the screen label from a fixed string or a reader function.
 * A throwing custom reader falls back to the wall screen.
 * @param {string|((root: any) => unknown)|undefined} screen
 * @param {any} root
 * @returns {string}
 */
function resolveScreen(screen, root) {
  if (typeof screen === 'function') {
    try {
      const value = screen(root);
      return typeof value === 'string' && value.length > 0 ? value : 'wall';
    } catch {
      return 'wall';
    }
  }
  return typeof screen === 'string' && screen.length > 0 ? screen : 'wall';
}

/**
 * Creates an agent_lane/v1 snapshot producer over a DOM root.
 * @param {{ root: any, screen?: string|((root: any) => unknown), fixture?: string|null }} options
 * @returns {{ snapshot: () => Promise<AgentSnapshot> }}
 */
export function createAgentLane(options) {
  const root = options?.root ?? null;
  if (!root || typeof root.querySelectorAll !== 'function') {
    throw laneError('ERR_AGENT_LANE_NO_ROOT', 'createAgentLane needs options.root with querySelectorAll');
  }
  const screen = options.screen;
  const fixture = typeof options.fixture === 'string' ? options.fixture : null;
  return {
    snapshot: async () => {
      const collected = collectAgentControls(root);
      return Object.freeze({
        schema: AGENT_LANE_SCHEMA,
        controls: collected.controls,
        screen: resolveScreen(screen, root),
        state: Object.freeze({
          source: 'dom',
          fixture,
          collected: collected.controls.length,
          skipped: collected.skipped,
        }),
      });
    },
  };
}

/**
 * Installs `__agentLane` on a host object (the renderer `window`).
 * Double installation is a typed error; the returned callback uninstalls.
 * @param {any} target
 * @param {{ root: any, screen?: string|((root: any) => unknown), fixture?: string|null }} options
 * @returns {() => void}
 */
export function installAgentLane(target, options) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    throw laneError('ERR_AGENT_LANE_NO_TARGET', 'installAgentLane needs a host object');
  }
  if (target[AGENT_LANE_GLOBAL] !== undefined) {
    throw laneError('ERR_AGENT_LANE_MOUNTED', 'The __agentLane host key is already installed');
  }
  const lane = createAgentLane(options);
  target[AGENT_LANE_GLOBAL] = Object.freeze({ snapshot: lane.snapshot });
  return () => {
    if (target[AGENT_LANE_GLOBAL]?.snapshot === lane.snapshot) {
      delete target[AGENT_LANE_GLOBAL];
    }
  };
}

/**
 * Reports interactive elements missing a stable id or a semantic anchor.
 * Accepts a plain array so gates and tests share one predicate.
 * @param {readonly any[]} elements
 * @returns {readonly AnchorOffender[]}
 */
export function findAnchorOffenders(elements) {
  /** @type {AnchorOffender[]} */
  const offenders = [];
  for (const node of elements ?? []) {
    const anchor = readAttr(node, 'data-semantic-anchor')?.trim() ?? null;
    const id = typeof node?.id === 'string' ? node.id.trim() : '';
    if (!id) {
      offenders.push(Object.freeze({ tag: tagOf(node), id: null, anchor, reason: 'missing-id' }));
    } else if (!anchor) {
      offenders.push(Object.freeze({ tag: tagOf(node), id, anchor: null, reason: 'missing-anchor' }));
    }
  }
  return Object.freeze(offenders);
}

/**
 * Strict gate: throws a typed error listing interactive elements that
 * violate the id+anchor rule. Pass elements queried with INTERACTIVE_SELECTOR.
 * @param {readonly any[]} elements
 */
export function assertAnchoredControls(elements) {
  const offenders = findAnchorOffenders(elements);
  if (offenders.length > 0) {
    const detail = offenders
      .map((offender) => `${offender.tag || '?'}#${offender.id ?? '?'}:${offender.reason}`)
      .join(',');
    throw laneError('ERR_AGENT_LANE_ANCHOR', `Interactive controls violate the id+anchor rule: ${detail}`);
  }
}

/**
 * Audits collected controls against the kit §9 inventory. The snapshot
 * itself never filters on admission (the DOM is truth); this helper backs
 * gates and fixture tables.
 * @param {readonly Pick<AgentControl, 'anchor'|'role'>[]} controls
 * @returns {readonly AnchorAuditRow[]}
 */
export function auditAnchors(controls) {
  /** @type {AnchorAuditRow[]} */
  const rows = [];
  for (const control of controls ?? []) {
    const rule = matchControlFamily(control?.anchor ?? '');
    rows.push(
      Object.freeze({
        anchor: control?.anchor ?? '',
        admitted: rule !== null,
        family: rule ? rule.template : null,
        roleAdmitted: rule ? rule.allowedRoles.includes(control?.role ?? '') : false,
      }),
    );
  }
  return Object.freeze(rows);
}

/**
 * Validates a snapshot value against the closed agent_lane/v1 shape.
 * Total function: data problems become typed results, never throws.
 * @param {unknown} value
 * @returns {{ ok: true }|{ ok: false, error: { code: string, message: string } }}
 */
export function validateSnapshotShape(value) {
  const fail = (/** @type {string} */ message) => ({
    ok: /** @type {const} */ (false),
    error: { code: 'ERR_AGENT_LANE_SHAPE', message },
  });
  if (!value || typeof value !== 'object') return fail('Snapshot must be an object');
  const snapshot = /** @type {Record<string, unknown>} */ (value);
  if (snapshot.schema !== AGENT_LANE_SCHEMA) return fail(`Unknown schema ${String(snapshot.schema)}`);
  if (typeof snapshot.screen !== 'string' || snapshot.screen.length === 0) {
    return fail('Snapshot screen must be a non-empty string');
  }
  if (!Array.isArray(snapshot.controls)) return fail('Snapshot controls must be an array');
  for (const control of snapshot.controls) {
    if (!control || typeof control !== 'object') return fail('Snapshot control must be an object');
    const keys = Object.keys(control).sort();
    if (keys.join(',') !== 'anchor,enabled,id,name,rect,role,visible') {
      return fail(`Snapshot control has non-closed keys [${keys.join(',')}]`);
    }
    const row = /** @type {Record<string, unknown>} */ (control);
    if (typeof row.id !== 'string' || row.id.trim().length === 0) return fail('Control id must be non-empty');
    if (typeof row.anchor !== 'string' || row.anchor.trim().length === 0) {
      return fail('Control anchor must be non-empty');
    }
    if (typeof row.role !== 'string' || typeof row.name !== 'string') {
      return fail('Control role/name must be strings');
    }
    if (typeof row.enabled !== 'boolean' || typeof row.visible !== 'boolean') {
      return fail('Control enabled/visible must be booleans');
    }
    if (row.rect !== null) {
      if (roundRect(row.rect) === null) return fail('Control rect must be null or a positive box');
    }
  }
  const state = snapshot.state;
  if (!state || typeof state !== 'object') return fail('Snapshot state must be an object');
  return { ok: /** @type {const} */ (true) };
}
