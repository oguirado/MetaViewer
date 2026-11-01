// Presentation state only. Shared by the renderer and packaged layout gate.
export const DESKTOP_SCHEMA = 'metaviewer.desktops/v1';
export const VIEWS = Object.freeze(['human', 'agent']);
export const PRESETS = Object.freeze(['single', 'side-by-side', 'grid', 'focus-strip']);

/** @typedef {{id:number,preset:string|null,layout:any}} Desktop */
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
        !Array.isArray(group.desktops) || !group.desktops.length) return false;
    const ids = new Set();
    for (const desktop of group.desktops) {
      if (!keys(desktop,['id','preset','layout']) || !number(desktop.id) || ids.has(desktop.id) ||
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
  if (!number(id + 1)) throw Error('DESKTOP_LIMIT');
  group.next++; group.desktops.push({id,preset:null,layout:null}); group.active = id;
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
  return true;
}
// Retire ended or moved panel references without reallocating surviving groups.
/** @param {any} layout @param {(id:string)=>boolean} keep */
export function pruneDesktopLayout(layout, keep) {
  if (!layout) return null;
  const result = JSON.parse(JSON.stringify(layout)), groups = new Set();
  const panels = result.dockview.panels;
  for (const [id,panel] of Object.entries(panels)) if (!keep(panel.params?.capsuleId)) delete panels[id];
  /** @param {any} data */
  const group = data => {
    data.views = data.views.filter((/** @type {string} */ id) => Object.hasOwn(panels,id));
    if (!data.views.length) return false;
    if (!data.views.includes(data.activeView)) data.activeView = data.views[0];
    groups.add(data.id); return true;
  };
  /** @param {any} value @returns {boolean} */
  const node = value => {
    if (value.type === 'leaf') return group(value.data);
    value.data = value.data.filter(node); return value.data.length > 0;
  };
  const hasRoot = node(result.dockview.grid.root);
  for (const key of ['floatingGroups','popoutGroups']) if (result.dockview[key]) {
    result.dockview[key] = result.dockview[key].filter((/** @type {any} */ item) => item.grid ? node(item.grid.root) : group(item.data));
  }
  if (!hasRoot) {
    let id = 'desktop-empty';
    while (groups.has(id)) id += '-';
    result.dockview.grid.root = {type:'leaf',data:{id,views:[]}};
    groups.add(id);
  }
  if (!groups.has(result.dockview.activeGroup)) delete result.dockview.activeGroup;
  if (result.savedWallPlacements) result.savedWallPlacements = Object.fromEntries(Object.entries(result.savedWallPlacements).filter(([id]) => Object.hasOwn(panels,id)));
  return result;
}
