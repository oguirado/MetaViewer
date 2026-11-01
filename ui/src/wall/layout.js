/** [TARGET, unit decision] Only admitted capsule panels survive restore.
 * Foreign/demo panel identities migrate to the product's empty wall. */
import { createDefaultLayoutProfile, decodeAndMigrateLayoutProfile } from '../../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';

export const SCOPE = Object.freeze({ product: 'metaviewer', profileId: 'default', workspaceId: 'main-wall' });
/** Default capsule browser dimensions (1280x900, never hard-coded 16:9). */
export const DEFAULT_CAPSULE_WIDTH = 1280;
export const DEFAULT_CAPSULE_HEIGHT = 900;
/** Reserved footer strip height inside each live capsule tile. */
export const DEFAULT_TILE_STRIP_HEIGHT = 23;

/**
 * Resolve capsule surface dimensions and aspect ratio from a surface record
 * (`Width`/`Height`, `width`/`height`, `frameWidth`/`frameHeight`, or
 * `geometry.{w,h,width,height,Width,Height}`), defaulting to 1280x900.
 * @param {unknown} [surface]
 * @returns {Readonly<{ width: number, height: number, aspect: number, aspectRatio: string }>}
 */
export function resolveCapsuleDimensions(surface = {}) {
  const rec = surface !== null && typeof surface === 'object'
    ? /** @type {Record<string, any>} */ (surface)
    : {};
  const geom = rec.geometry !== null && typeof rec.geometry === 'object'
    ? /** @type {Record<string, any>} */ (rec.geometry)
    : {};
  const rawW = rec.Width ?? rec.width ?? rec.frameWidth ?? geom.Width ?? geom.width ?? geom.w;
  const rawH = rec.Height ?? rec.height ?? rec.frameHeight ?? geom.Height ?? geom.height ?? geom.h;
  const validW = typeof rawW === 'number' && Number.isFinite(rawW) && Math.round(rawW) > 0
    ? Math.round(rawW)
    : 0;
  const validH = typeof rawH === 'number' && Number.isFinite(rawH) && Math.round(rawH) > 0
    ? Math.round(rawH)
    : 0;
  const width = validW > 0 && validH > 0 ? validW : DEFAULT_CAPSULE_WIDTH;
  const height = validW > 0 && validH > 0 ? validH : DEFAULT_CAPSULE_HEIGHT;
  return Object.freeze({
    width,
    height,
    aspect: width / height,
    aspectRatio: `${width} / ${height}`,
  });
}

/**
 * Compute the aspect-constrained tile content box for 1–4+ capsules on a wall
 * of `(wallWidth, wallHeight)`, keeping the footer strip visible.
 * @param {{ wallWidth?: unknown, wallHeight?: unknown, count?: unknown, capsuleCount?: unknown, stripHeight?: unknown, showStrip?: unknown, surface?: unknown, Width?: unknown, Height?: unknown, width?: unknown, height?: unknown, frameWidth?: unknown, frameHeight?: unknown, geometry?: unknown }} [options={}]
 * @returns {Readonly<{ width: number, height: number, aspect: number, aspectRatio: string, surfaceWidth: number, surfaceHeight: number, cellWidth: number, cellHeight: number, stripHeight: number, stripVisible: boolean, columns: number, rows: number }>}
 */
export function resolveWallTileBox(options = {}) {
  const rec = options !== null && typeof options === 'object'
    ? /** @type {Record<string, any>} */ (options)
    : {};
  const dims = resolveCapsuleDimensions(rec.surface ?? rec);
  const wallWidth = typeof rec.wallWidth === 'number' && Number.isFinite(rec.wallWidth) && rec.wallWidth > 0
    ? rec.wallWidth
    : dims.width;
  const wallHeight = typeof rec.wallHeight === 'number' && Number.isFinite(rec.wallHeight) && rec.wallHeight > 0
    ? rec.wallHeight
    : dims.height;
  const rawCount = rec.capsuleCount ?? rec.count;
  const count = typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount > 0
    ? rawCount
    : 1;
  const columns = count <= 2 ? count : (count <= 4 ? 2 : 3);
  const rows = count <= 2 ? 1 : Math.ceil(count / columns);
  const cellWidth = wallWidth / columns;
  const cellHeight = wallHeight / rows;
  const showStrip = rec.showStrip !== false;
  const stripHeight = !showStrip
    ? 0
    : (typeof rec.stripHeight === 'number' && Number.isFinite(rec.stripHeight) && rec.stripHeight >= 0
      ? rec.stripHeight
      : DEFAULT_TILE_STRIP_HEIGHT);
  const availableHeight = Math.max(1, cellHeight - stripHeight);
  const width = Math.min(cellWidth, availableHeight * dims.aspect);
  const height = width / dims.aspect;
  return Object.freeze({
    width,
    height,
    aspect: width / height,
    aspectRatio: dims.aspectRatio,
    surfaceWidth: dims.width,
    surfaceHeight: dims.height,
    cellWidth,
    cellHeight,
    stripHeight,
    stripVisible: stripHeight <= cellHeight && height + stripHeight <= cellHeight + 1e-6,
    columns,
    rows,
  });
}

/**
 * Arrange tile leaves into a 2D grid under the HORIZONTAL root: one or two
 * tiles stay flat; three or more split into two (3-4 tiles) or three (5 or
 * more tiles) column branches, filled row-major so reading order matches
 * reveal order. Dockview alternates orientation per depth, so each column
 * branch stacks its leaves vertically into a real grid.
 * @param {any[]} rootData
 * @param {any[]} leaves
 * @param {number} [gridWidth]
 * @param {number} [gridHeight]
 */
function arrangeTileGrid(rootData, leaves, gridWidth = DEFAULT_CAPSULE_WIDTH, gridHeight = DEFAULT_CAPSULE_HEIGHT) {
  if (leaves.length <= 2) {
    const leafWidth = Math.floor(gridWidth / Math.max(1, leaves.length));
    for (const leaf of leaves) leaf.size = leafWidth;
    rootData.push(...leaves);
    return;
  }
  const columns = leaves.length <= 4 ? 2 : 3;
  for (let column = 0; column < columns; column += 1) {
    const stacked = leaves.filter((leaf, index) => index % columns === column);
    if (!stacked.length) continue;
    const leafHeight = Math.floor(gridHeight / stacked.length);
    for (const leaf of stacked) leaf.size = leafHeight;
    rootData.push({ type: 'branch', size: Math.floor(gridWidth / columns), data: stacked });
  }
}
/** @param {import('../../.kit/capsule-ui-kit/src/workspace/layoutProfile.js').LayoutProfileScope} scope
 * @param {Array<{id:string,title?:string,Width?:number,Height?:number,width?:number,height?:number,frameWidth?:number,frameHeight?:number,geometry?:{w?:number,h?:number,width?:number,height?:number,Width?:number,Height?:number}}>} [surfaces] */
export function createWallLayout(scope = SCOPE, surfaces = []) {
  const base = structuredClone(createDefaultLayoutProfile(scope));
  const dims = resolveCapsuleDimensions(surfaces[0]);
  base.dockview.grid.width = dims.width;
  base.dockview.grid.height = dims.height;
  base.dockview.panels = {};
  base.savedWallPlacements = {};
  delete base.dockview.activeGroup;
  /** @type {any[]} */
  const leaves = [];
  surfaces.forEach((surface, index) => {
    if (!surface.id || /\s/.test(surface.id)) throw new Error('Invalid capsule identity');
    const id = `panel-${surface.id}`;
    if (base.dockview.panels[id]) throw new Error('Duplicate capsule identity');
    base.dockview.panels[id] = { id, contentComponent: 'CapsulePanel', title: surface.title || surface.id, renderer: 'always', params: { capsuleId: surface.id } };
    const groupId = `wall-group-${index}`;
    leaves.push({ type: 'leaf', size: Math.floor(dims.width / 2), visible: true, data: { id: groupId, views: [id], activeView: id } });
    if (!base.savedWallPlacements) throw new Error('Layout placements absent');
    base.savedWallPlacements[id] = { groupId, index: 0 };
    if (index === 0) base.dockview.activeGroup = groupId;
  });
  if (!surfaces.length) base.dockview.grid.root = { type: 'branch', size: dims.width, data: [{ type: 'leaf', size: dims.width, data: { id: 'wall-empty', views: [] } }] };
  else {
    /** @type {any[]} */
    const rootData = [];
    arrangeTileGrid(rootData, leaves, dims.width, dims.height);
    base.dockview.grid.root = { type: 'branch', size: dims.width, data: rootData };
  }
  const checked = decodeAndMigrateLayoutProfile(base, { expectedScope: scope });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.profile;
}
/** @param {string|null} raw @param {typeof SCOPE} [scope] */
export function migrateWallLayout(raw, scope = SCOPE) {
  if (raw === null) return null;
  let candidate;
  try { candidate = JSON.parse(raw); } catch { return raw; } // Kit retains corruption quarantine.
  const checked = decodeAndMigrateLayoutProfile(candidate, { expectedScope: scope });
  if (!checked.ok) return raw; // Future schemas and wrong scopes remain quarantined.
  const panels = candidate?.dockview?.panels;
  if (!panels || typeof panels !== 'object') return raw;
  if (Object.entries(panels).some(([id, panel]) => {
    const p = /** @type {any} */ (panel);
    return p?.contentComponent !== 'CapsulePanel' || typeof p.params?.capsuleId !== 'string' ||
      !p.params.capsuleId || /\s/.test(p.params.capsuleId) || id !== `panel-${p.params.capsuleId}`;
  })) return JSON.stringify(createWallLayout(scope));
  return raw;
}
