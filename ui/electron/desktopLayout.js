// Presentation state only. Shared by the renderer and packaged layout gate.
export const DESKTOP_SCHEMA = 'metaviewer.desktops/v1';
/** Maximum persistent walls per view [TARGET]. */
export const MAX_DESKTOPS_PER_VIEW = 16;
export const VIEWS = Object.freeze(['human', 'agent']);
export const PRESETS = Object.freeze(['single', 'side-by-side', 'grid', 'focus-strip', 'floating']);

/** @typedef {{id:number,preset:string|null,layout:any,snapGrid?:{cols:number,rows:number},identityCells?:Record<string,{col:number,row:number}>}} Desktop */
/** @typedef {{schema:string,activeView:string,views:Record<string,{active:number,next:number,desktops:Desktop[]}>,assignments:Record<string,{view:string,desktop:number}>}} DesktopState */
/** @returns {DesktopState} */
export function createDesktopState() {
  return {schema:DESKTOP_SCHEMA, activeView:'human', views:Object.fromEntries(VIEWS.map(view =>
    [view, {active:1, next:2, desktops:[{id:1, preset:null, layout:null}]}])), assignments:{}};
}
/** @param {any} value */
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {any} value @param {readonly string[]} allowed */
const keys = (value, allowed) => plain(value) && Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value,key));
/** @param {any} value */
const number = value => Number.isSafeInteger(value) && value > 0;
/** @param {any} state @param {(layout:any)=>boolean} validateLayout */
export function validateDesktopState(state, validateLayout = (_layout) => false) {
  if (!keys(state,['schema','activeView','views','assignments']) || state.schema !== DESKTOP_SCHEMA ||
      !VIEWS.includes(state.activeView) || !keys(state.views,VIEWS) || !plain(state.assignments)) return false;
  for (const view of VIEWS) {
    const group = state.views[view];
    if (!keys(group,['active','next','desktops']) || !number(group.active) || !number(group.next) ||
        !Array.isArray(group.desktops) || !group.desktops.length || group.desktops.length > MAX_DESKTOPS_PER_VIEW) return false;
    const ids = new Set();
    for (const desktop of group.desktops) {
      // [TARGET, unit decision] Optional per-desktop snap grid; legacy profiles remain valid.
      const grid = plain(desktop) ? desktop.snapGrid : undefined;
      if (grid !== undefined && (!keys(grid,['cols','rows']) ||
          ![grid.cols,grid.rows].every(n => Number.isInteger(n) && n >= 1 && n <= 5))) return false;
      const cells = desktop?.identityCells;
      if (cells !== undefined && (!plain(cells) || Object.keys(cells).length > 256 || Object.entries(cells).some(([id,cell]) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || ['__proto__','constructor','prototype'].includes(id) || !keys(cell,['col','row']) || ![cell.col,cell.row].every(n=>Number.isInteger(n) && n >= 0 && n < 5)))) return false;
      if (!keys(desktop,['id','preset','layout',...(grid === undefined ? [] : ['snapGrid']),...(cells === undefined ? [] : ['identityCells'])]) || !number(desktop.id) || ids.has(desktop.id) ||
          desktop.id >= group.next || (desktop.preset !== null && !PRESETS.includes(desktop.preset)) ||
          (desktop.layout !== null && (!plain(desktop.layout) || !validateLayout(desktop.layout)))) return false;
      ids.add(desktop.id);
    }
    if (!ids.has(1) || !ids.has(group.active)) return false;
  }
  for (const [id, home] of Object.entries(state.assignments)) {
    if (!id || /\s/.test(id) || ['__proto__','constructor','prototype'].includes(id) ||
        !keys(home,['view','desktop']) || !VIEWS.includes(home.view) ||
        !state.views[home.view].desktops.some((/** @type {Desktop} */ d) => d.id === home.desktop)) return false;
  }
  // A saved panel must belong to this desktop, and can occur only once.
  const panels = new Set();
  for (const view of VIEWS) for (const desktop of state.views[view].desktops) {
    for (const panel of Object.values(desktop.layout?.dockview?.panels || {})) {
      const id = panel.params?.capsuleId;
      if (typeof id !== 'string' || panels.has(id) || state.assignments[id]?.view !== view ||
          state.assignments[id]?.desktop !== desktop.id) return false;
      panels.add(id);
    }
  }
  return true;
}
/** @param {DesktopState} state @param {string} view */
export function addDesktop(state, view = state.activeView) {
  const group = state.views[view], id = group.next;
  if (group.desktops.length >= MAX_DESKTOPS_PER_VIEW || !number(id + 1)) throw Error('DESKTOP_LIMIT');
  group.next = id + 1; group.desktops.push({id,preset:null,layout:null}); group.active = id;
  return id;
}
/** @param {DesktopState} state @param {string} id @param {string} view */
export function assignSurface(state, id, view) {
  if (!VIEWS.includes(view)) throw Error('CAPSULE_ROLE_UNPROVEN');
  const home = state.assignments[id];
  if (!home || home.view !== view) state.assignments[id] = {view,desktop:state.views[view].active};
  return state.assignments[id];
}
/** @template {{id:string}} T @param {DesktopState} state @param {readonly T[]} rows @param {string} view @param {number} desktop @returns {T[]} */
export function desktopRows(state, rows, view, desktop) {
  return rows.filter(row => state.assignments[row.id]?.view === view && state.assignments[row.id]?.desktop === desktop);
}
/** @param {DesktopState} state @param {string} view @param {number} id */
export function removeDesktop(state, view, id) {
  const group = state.views[view];
  if (id === 1 || !group.desktops.some(d => d.id === id) || Object.values(state.assignments).some(home => home.view === view && home.desktop === id)) return false;
  group.desktops = group.desktops.filter(d => d.id !== id);
  if (group.active === id) group.active = 1;
  renumberDesktops(state,view);
  return true;
}
/** Compact identities and remap ownership atomically, retaining desktop objects/layouts.
 * @param {DesktopState} state @param {string} view */
export function renumberDesktops(state,view) {
  const group = state.views[view], ids = new Map(group.desktops.map((d,index)=>[d.id,index+1]));
  group.active = ids.get(group.active) ?? 1;
  for (const home of Object.values(state.assignments)) if (home.view === view) home.desktop = ids.get(home.desktop) ?? home.desktop;
  group.desktops.forEach((desktop,index)=>{desktop.id = index+1;});
  group.next = group.desktops.length+1;
}
/** Move within the existing view; role and backend identity are immutable.
 * @param {DesktopState} state @param {string} id @param {number} desktop @param {boolean} [follow] */
export function moveSurface(state,id,desktop,follow = false) {
  const home = state.assignments[id];
  if (!home || !state.views[home.view].desktops.some(d=>d.id === desktop)) return false;
  home.desktop = desktop;
  if (follow) {state.activeView = home.view;state.views[home.view].active = desktop;}
  return true;
}
// Older desktop envelopes admitted leaf roots through the kit decoder, but
// Dockview's runtime requires a branch root. Preserve the group and geometry.
/** @param {any} layout */
export function normalizeDesktopLayout(layout) {
  if (!layout) return null;
  const result = JSON.parse(JSON.stringify(layout));
  const root = result.dockview.grid.root;
  if (root.type === 'leaf') result.dockview.grid.root = {
    type:'branch',size:result.dockview.grid.width,data:[root],
  };
  return result;
}
// Retire ended or moved panel references without reallocating surviving groups.
/** @param {any} layout @param {(id:string)=>boolean} keep */
export function pruneDesktopLayout(layout, keep, preserveEmpty = false) {
  if (!layout) return null;
  const result = normalizeDesktopLayout(layout), groups = new Set();
  const panels = result.dockview.panels;
  for (const [id,panel] of Object.entries(panels)) if (!keep(panel.params?.capsuleId)) delete panels[id];
  /** @param {any} data @param {boolean} keepEmpty */
  const group = (data,keepEmpty) => {
    data.views = data.views.filter((/** @type {string} */ id) => Object.hasOwn(panels,id));
    if (!data.views.length) {
      if (!keepEmpty) return false;
      delete data.activeView; groups.add(data.id); return true;
    }
    if (!data.views.includes(data.activeView)) data.activeView = data.views[0];
    groups.add(data.id); return true;
  };
  /** @param {any} value @param {boolean} keepEmpty @returns {boolean} */
  const node = (value,keepEmpty) => {
    if (value.type === 'leaf') return group(value.data,keepEmpty);
    value.data = value.data.filter((/** @type {any} */ child)=>node(child,keepEmpty)); return value.data.length > 0;
  };
  const hasRoot = node(result.dockview.grid.root,preserveEmpty);
  for (const key of ['floatingGroups','popoutGroups']) if (result.dockview[key]) {
    result.dockview[key] = result.dockview[key].filter((/** @type {any} */ item) => item.grid ? node(item.grid.root,false) : group(item.data,false));
  }
  if (!hasRoot) {
    let id = 'desktop-empty';
    while (groups.has(id)) id += '-';
    const size = result.dockview.grid.width;
    result.dockview.grid.root = {type:'branch',size,data:[{type:'leaf',size,data:{id,views:[]}}]};
    groups.add(id);
  }
  if (!groups.has(result.dockview.activeGroup)) delete result.dockview.activeGroup;
  if (result.savedWallPlacements) result.savedWallPlacements = Object.fromEntries(Object.entries(result.savedWallPlacements).filter(([id]) => Object.hasOwn(panels,id)));
  return result;
}
