/** [TARGET, unit decision] Only admitted capsule panels survive restore.
 * Foreign/demo panel identities migrate to the product's empty wall. */
import { createDefaultLayoutProfile, decodeAndMigrateLayoutProfile } from '../../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';

export const SCOPE = Object.freeze({ product: 'metaviewer', profileId: 'default', workspaceId: 'main-wall' });
/**
 * Arrange tile leaves into a 2D grid under the HORIZONTAL root: one or two
 * tiles stay flat; three or more split into two (3-4 tiles) or three (5 or
 * more tiles) column branches, filled row-major so reading order matches
 * reveal order. Dockview alternates orientation per depth, so each column
 * branch stacks its leaves vertically into a real grid.
 * @param {any[]} rootData
 * @param {any[]} leaves
 */
function arrangeTileGrid(rootData, leaves) {
  if (leaves.length <= 2) {
    rootData.push(...leaves);
    return;
  }
  const columns = leaves.length <= 4 ? 2 : 3;
  for (let column = 0; column < columns; column += 1) {
    const stacked = leaves.filter((leaf, index) => index % columns === column);
    if (!stacked.length) continue;
    rootData.push({ type: 'branch', size: Math.floor(1280 / columns), data: stacked });
  }
}
/** @param {import('../../.kit/capsule-ui-kit/src/workspace/layoutProfile.js').LayoutProfileScope} scope
 * @param {Array<{id:string,title?:string}>} [surfaces] */
export function createWallLayout(scope = SCOPE, surfaces = []) {
  const base = structuredClone(createDefaultLayoutProfile(scope));
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
    leaves.push({ type: 'leaf', size: 640, visible: true, data: { id: groupId, views: [id], activeView: id } });
    if (!base.savedWallPlacements) throw new Error('Layout placements absent');
    base.savedWallPlacements[id] = { groupId, index: 0 };
    if (index === 0) base.dockview.activeGroup = groupId;
  });
  if (!surfaces.length) base.dockview.grid.root = { type: 'branch', size: 1280, data: [{ type: 'leaf', size: 1280, data: { id: 'wall-empty', views: [] } }] };
  else {
    /** @type {any[]} */
    const rootData = [];
    arrangeTileGrid(rootData, leaves);
    base.dockview.grid.root = { type: 'branch', size: 1280, data: rootData };
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
