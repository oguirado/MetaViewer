<script>
/**
 * @fileoverview MetaViewer wall workspace: presentation-only composition over
 * the kit DockWorkspace. Exactly one permanent panel per capsuleId; the kit
 * owns the layout host, controller and restore barrier. This module never
 * touches storage, layout bytes or backend verbs: reveal and presentation
 * intents use only the Dockview api handed over by the kit `ready` event,
 * which the kit emits after its cold restore settles.
 */
import { defineComponent, h } from 'vue';
/** [TARGET, unit decision] Presentation-only free drag, Control-held cell snap.
 * Grid counts are per desktop; geometry never dispatches backend intents.
 * @param {any} start @param {any} origin @param {any} pointer
 * @param {number} width @param {number} height @param {{cols:number,rows:number}} grid */
export function floatDragBounds(start, origin, pointer, width, height, grid) {
  if (![grid?.cols,grid?.rows].every(n=>Number.isInteger(n) && n >= 1 && n <= 5) ||
      ![width,height].every(n=>Number.isFinite(n) && n > 0)) throw Error('SNAP_GRID_INVALID');
  if (!pointer.ctrlKey) return {x:Math.max(0,Math.min(width-start.width,start.x+pointer.x-origin.x)),
    y:Math.max(0,Math.min(height-start.height,start.y+pointer.y-origin.y)),width:start.width,height:start.height};
  const col = Math.max(0,Math.min(grid.cols-1,Math.floor(pointer.x*grid.cols/width)));
  const row = Math.max(0,Math.min(grid.rows-1,Math.floor(pointer.y*grid.rows/height)));
  const x = Math.floor(col*width/grid.cols), y = Math.floor(row*height/grid.rows);
  return {x,y,width:Math.floor((col+1)*width/grid.cols)-x,height:Math.floor((row+1)*height/grid.rows)-y};
}

/** [TARGET, unit decision] Row-major placement shares the snap arithmetic.
 * Occupied rectangles reserve every cell they intersect; saved cells are hints.
 * @param {number} width @param {number} height @param {{cols:number,rows:number}} grid
 * @param {any[]} occupied @param {{col:number,row:number}|null} [preferred] */
export function nextFloatingCell(width,height,grid,occupied,preferred = null) {
  floatDragBounds({}, {}, {x:0,y:0,ctrlKey:true},width,height,grid);
  const cells = Array.from({length:grid.cols*grid.rows},(_,index)=>({col:index%grid.cols,row:Math.floor(index/grid.cols)}));
  if (preferred && cells.some(c=>c.col === preferred.col && c.row === preferred.row)) cells.unshift(preferred);
  for (const cell of cells) {
    const rect = floatDragBounds({}, {}, {x:(cell.col+.5)*width/grid.cols,y:(cell.row+.5)*height/grid.rows,ctrlKey:true},width,height,grid);
    if (!occupied.some(o=>o.x < rect.x+rect.width && o.x+o.width > rect.x && o.y < rect.y+rect.height && o.y+o.height > rect.y)) return rect;
  }
  const w = Math.floor(width*.9), h = height;
  return {x:Math.min(24*occupied.length,width-w),y:Math.min(24*occupied.length,height-h),width:w,height:h};
}

/** Keep cell coordinates exact and free windows proportional across wall resizes.
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {{width:number,height:number}} from @param {{width:number,height:number}} to
 * @param {{cols:number,rows:number}} grid */
export function reflowFloatingRect(rect, from, to, grid) {
  const col=Math.round(rect.left*grid.cols/from.width), row=Math.round(rect.top*grid.rows/from.height);
  if(col>=0 && col<grid.cols && row>=0 && row<grid.rows) {
    const old=floatDragBounds({}, {}, {x:(col+.5)*from.width/grid.cols,y:(row+.5)*from.height/grid.rows,ctrlKey:true},from.width,from.height,grid);
    if(rect.left===old.x && rect.top===old.y && rect.width===old.width && rect.height===old.height) {
      const cell=floatDragBounds({}, {}, {x:(col+.5)*to.width/grid.cols,y:(row+.5)*to.height/grid.rows,ctrlKey:true},to.width,to.height,grid);
      return {left:cell.x,top:cell.y,width:cell.width,height:cell.height};
    }
  }
  const left=Math.max(0,Math.min(to.width-1,Math.floor(rect.left*to.width/from.width)));
  const top=Math.max(0,Math.min(to.height-1,Math.floor(rect.top*to.height/from.height)));
  return {left,top,width:Math.max(1,Math.min(to.width-left,Math.floor((rect.left+rect.width)*to.width/from.width)-left)),
    height:Math.max(1,Math.min(to.height-top,Math.floor((rect.top+rect.height)*to.height/from.height)-top))};
}

/** Floating windows need one empty grid home, not the previous preset's dividers.
 * Populated and hidden groups retain their panels and identity.
 * @param {any} api */
export function retainFloatingHome(api) {
  const grids=(api.groups ?? []).filter((/** @type {any} */ group)=>group.api.location.type==='grid');
  let kept=false;
  for (const group of grids) if (group.size===0) {
    if (kept) api.removeGroup(group);
    else kept=true;
  }
  if (!grids.length) api.addGroup({direction:'right',skipSetActive:true});
}

let floatingDragSerial = 0;
/** Capture floating title drags before Dockview can start native docking.
 * Live movement uses a temporary transform; release commits through the public
 * floating-group API, retaining panel instances and the kit persistence gate.
 * @param {any} root @param {any} api @param {()=>{cols:number,rows:number}} grid
 * @param {()=>void} custom @param {()=>void} complete */
export function installFloatingDrag(root, api, grid, custom, complete) {
  const doc = root.ownerDocument;
  let cancel = () => {};
  const down = (/** @type {any} */ event) => {
    if (event.button !== 0 || event.target.closest('button,input,select,textarea,a,[role="button"],dialog,[aria-modal="true"],.xterm,[contenteditable="true"]')) return;
    const header = event.target.closest('.dv-floating-titlebar,.dv-tabs-and-actions-container,.cuk-capsule-panel__header');
    // Dockview renders panel content in a sibling overlay, outside the group's
    // resize container. Resolve that header through the public panel model.
    const panel = header && api.panels?.find((/** @type {any} */ p)=>p.view?.content?.element?.contains(header));
    const overlay = header?.closest('.dv-resize-container') ?? panel?.group?.element?.closest('.dv-resize-container');
    if (!overlay || !root.contains(overlay)) return;
    const group = api.groups.find((/** @type {any} */ g)=>g.api.location.type === 'floating' && overlay.contains(g.element));
    if (!group) return;
    cancel();
    event.preventDefault(); event.stopPropagation();
    const nonce = doc.querySelector('meta[name$="-style-nonce"]')?.getAttribute('content');
    // Refuse the gesture if the authenticated stylesheet channel is unavailable.
    if (!nonce) return;
    group.api.setActive();
    const sheet = doc.createElement('style'); sheet.setAttribute('nonce',nonce);
    doc.head.appendChild(sheet);
    const token = String(++floatingDragSerial);
    overlay.setAttribute('data-wall-drag',token);
    const content = (panel ?? group.activePanel)?.view?.content?.element?.closest('.dv-render-overlay');
    content?.setAttribute('data-wall-drag',token);
    const wall = overlay.parentElement.getBoundingClientRect(), box = overlay.getBoundingClientRect();
    const start = {x:box.left-wall.left,y:box.top-wall.top,width:box.width,height:box.height};
    const origin = {x:event.clientX-wall.left,y:event.clientY-wall.top};
    let control = event.ctrlKey;
    let moved = false;
    const preview = doc.createElement('div');
    preview.className = 'wall-snap-preview'; preview.setAttribute('aria-hidden','true');
    preview.hidden = true;
    preview.setAttribute('data-wall-snap',token);
    overlay.parentElement.appendChild(preview);
    const bounds = (/** @type {any} */ e) => floatDragBounds(start,origin,{x:e.clientX-wall.left,y:e.clientY-wall.top,ctrlKey:control},wall.width,wall.height,grid());
    const paint = (/** @type {any} */ e) => {
      const rect = bounds(e);
      preview.hidden = !control;
      sheet.textContent = `[data-wall-snap="${token}"]{left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px}
[data-wall-drag="${token}"]{transform:translate(${e.clientX-event.clientX}px,${e.clientY-event.clientY}px)}`;
    };
    const preventSelection = (/** @type {any} */ e) => e.preventDefault();
    doc.addEventListener('selectstart',preventSelection,true);
    const move = (/** @type {any} */ e) => {
      if (e.pointerId !== event.pointerId) return;
      e.preventDefault();
      if (!moved && Math.abs(e.clientX-event.clientX)+Math.abs(e.clientY-event.clientY) > 3) {moved = true; custom();}
      if (moved) paint(e);
    };
    const key = (/** @type {any} */ e) => {
      if (e.key !== 'Control') return;
      control = e.type === 'keydown';
      if (moved) paint({clientX:point.x,clientY:point.y});
    };
    let point = {x:event.clientX,y:event.clientY};
    const track = (/** @type {any} */ e) => {if(e.pointerId === event.pointerId) {control=e.ctrlKey; point={x:e.clientX,y:e.clientY}; move(e);}};
    const cleanup = () => {
      doc.removeEventListener('selectstart',preventSelection,true);
      overlay.removeAttribute('data-wall-drag'); content?.removeAttribute('data-wall-drag'); preview.remove(); sheet.remove();
      for (const [name,fn] of /** @type {Array<[string,EventListener]>} */ ([['pointermove',track],['pointerup',up],['pointercancel',abort],['keydown',key],['keyup',key],['visibilitychange',abort]])) doc.removeEventListener(name,fn,true);
      doc.defaultView?.removeEventListener('blur',abort);
      cancel = () => {};
    };
    const abort = () => cleanup();
    const up = (/** @type {any} */ e) => {
      if (e.pointerId !== event.pointerId) return;
      control = e.ctrlKey;
      const rect = bounds(e); cleanup();
      if (moved) {api.addFloatingGroup(group,{position:{left:rect.x,top:rect.y},width:rect.width,height:rect.height,disableSmartGuides:true}); complete();}
      else group.api.setActive();
    };
    cancel = cleanup;
    for (const [name,fn] of /** @type {Array<[string,EventListener]>} */ ([['pointermove',track],['pointerup',up],['pointercancel',abort],['keydown',key],['keyup',key],['visibilitychange',abort]])) doc.addEventListener(name,fn,true);
    doc.defaultView?.addEventListener('blur',abort);
  };
  // Dockview installs its own overlay handlers. Capture on the document before
  // those handlers, while keeping ownership restricted to this wall's floats.
  doc.addEventListener('pointerdown',down,true);
  return () => {cancel(); doc.removeEventListener('pointerdown',down,true);};
}

// Presentation only: no capsule geometry, ownership, or lifecycle operations.
const WORKLOAD_PANEL_PREFIX='workload-panel:';
export const TILE_PRESETS = Object.freeze(['single','side-by-side','grid','grid-3x2','focus-strip','floating']);

/** Exact cell geometry; equal rectangles denote tabs in the same cell.
 * Floating presentation is included so switching presets also docks floats.
 * @param {string} preset @param {Array<{id:string,hidden?:boolean,floating?:boolean,maximized?:boolean}>} tiles @param {number} width @param {number} height */
export function presetRectangles(preset, tiles, width, height) {
  if (!TILE_PRESETS.includes(preset) || ![width,height].every(n => Number.isFinite(n) && n > 0)) throw Error('LAYOUT_PRESET_INVALID');
  const visible = tiles.filter(tile => !tile.hidden);
  if (visible.some(tile => tile.maximized)) return [];
  if (new Set(visible.map(tile => tile.id)).size !== visible.length) throw Error('LAYOUT_PRESET_DUPLICATE');
  const count = visible.length;
  return visible.map((tile, index) => {
    if (preset === 'floating') {
      // [TARGET, unit decision] Preserve the full available height for chrome
      // and the frame; avoid fixed pixel caps on large and short workspaces.
      const w = Math.floor(width * .9), h = height;
      return {id:tile.id,x:Math.min(24 * index, Math.max(0,width-w)),y:Math.min(24 * index,Math.max(0,height-h)),width:w,height:h};
    }
    if (preset === 'single') return {id:tile.id,x:0,y:0,width,height};
    if (preset === 'focus-strip' && count > 1) {
      const focusWidth = Math.floor(width * .7);
      if (index === 0) return {id:tile.id,x:0,y:0,width:focusWidth,height};
      const top = Math.floor((index - 1) * height / (count - 1));
      return {id:tile.id,x:focusWidth,y:top,width:width-focusWidth,height:Math.floor(index * height / (count - 1)) - top};
    }
    if (preset === 'focus-strip' || preset === 'side-by-side' && count === 1) return {id:tile.id,x:0,y:0,width,height};
    const columns = preset === 'grid-3x2' ? 3 : 2;
    const rows = ['grid','grid-3x2'].includes(preset) ? 2 : 1;
    const cell = Math.min(index,columns * rows - 1);
    const column = cell % columns, row = Math.floor(cell / columns);
    const x = Math.floor(column * width / columns), y = Math.floor(row * height / rows);
    return {id:tile.id,x,y,width:Math.floor((column + 1) * width / columns) - x,height:Math.floor((row + 1) * height / rows) - y};
  });
}

/** Serialized sizes omit each split's gap deduction. Restore that share
 * before calling setSize, so opposite clicks are exact inverses.
 * @param {any} layout @param {string} id @param {'width'|'height'} dimension */
export function panelAllocation(layout,id,dimension) {
  let allocation = /** @type {number|undefined} */ (undefined);
  const visit = (/** @type {any} */ node, /** @type {string} */ axis, /** @type {number} */ width, /** @type {number} */ height) => {
    if (!node) return false;
    if (node.type === 'leaf') return node.data.views.includes(id);
    const visible = node.data.filter((/** @type {any} */ child)=>child.visible !== false);
    const total = visible.reduce((/** @type {number} */ sum,/** @type {any} */ child)=>sum+child.size,0);
    const gapShare = Math.max(0,(axis === 'width' ? width : height)-total)/Math.max(1,visible.length);
    for (const child of node.data) if (visit(child,axis === 'width' ? 'height' : 'width',axis === 'width' ? child.size : width,axis === 'height' ? child.size : height)) {
      if (axis === dimension && allocation === undefined && Number.isFinite(child.size)) allocation = child.size + gapShare;
      return true;
    }
    return false;
  };
  visit(layout?.grid?.root,layout?.grid?.orientation === 'VERTICAL' ? 'height' : 'width',layout?.grid?.width,layout?.grid?.height);
  return allocation;
}

/** Rebuild presentation using Dockview's panel-reuse contract. Empty grid cells
 * contain no placeholder capsule. Hidden records retain their presentation home.
 * @param {any} layout @param {string} preset @param {Array<any>} tiles @param {number} width @param {number} height */
export function arrangePreset(layout, preset, tiles, width, height) {
  const rectangles = presetRectangles(preset,tiles,width,height);
  if (!rectangles.length) return null;
  const result = structuredClone(layout);
  const shown = new Set(rectangles.map(r=>r.id));
  const hiddenLeaves = /** @type {any[]} */ ([]);
  const hiddenGroupIds = new Set();
  const retain = (/** @type {any} */ node) => {
    if (node.type === 'branch') { node.data.forEach(retain); return; }
    const views = node.data.views.filter((/** @type {string} */ id)=>!shown.has(id));
    if (!views.length) return;
    hiddenGroupIds.add(node.data.id);
    hiddenLeaves.push({...node,size:0,visible:false,data:{...node.data,views,activeView:views.includes(node.data.activeView) ? node.data.activeView : views[0]}});
  };
  retain(result.grid.root);
  result.floatingGroups = (result.floatingGroups || []).filter((/** @type {any} */ item)=> {
    item.data.views = item.data.views.filter((/** @type {string} */ id)=>!shown.has(id));
    if (!item.data.views.length) return false;
    if (!item.data.views.includes(item.data.activeView)) item.data.activeView = item.data.views[0];
    hiddenGroupIds.add(item.data.id); return true;
  });
  let serial = 0;
  const groupId = () => { let id; do { id = 'p18f-cell-' + serial++; } while(hiddenGroupIds.has(id)); return id; };
  for (const id of shown) {
    const panel = result.panels[id];
    if (panel?.params?.viewMode?.startsWith('window-floating:')) panel.params.viewMode = null;
  }
  const cells = new Map();
  for (const rect of rectangles) {
    const key = [rect.x,rect.y].join(':');
    if (!cells.has(key)) cells.set(key,{...rect,views:[]});
    cells.get(key).views.push(rect.id);
  }
  if (['grid','grid-3x2'].includes(preset)) {
    const columns=preset === 'grid-3x2' ? 3 : 2;
    for (let row=0;row<2;row++) for(let column=0;column<columns;column++) {
      const x=Math.floor(column*width/columns),y=Math.floor(row*height/2),key=[x,y].join(':');
      if (!cells.has(key)) cells.set(key,{x,y,width:Math.floor((column+1)*width/columns)-x,height:Math.floor((row+1)*height/2)-y,views:[]});
    }
  }
  const leaf = (/** @type {any} */ cell, /** @type {number} */ size) => ({type:'leaf',size,data:{id:groupId(),views:cell.views,...(cell.views.length ? {activeView:cell.views[0]} : {})}});
  let data = /** @type {any[]} */ ([]);
  if (preset === 'floating') {
    // One independent window per tile, even when the prior preset used tabs.
    for (const rect of rectangles) result.floatingGroups.push({data:{id:groupId(),views:[rect.id],activeView:rect.id},position:{left:rect.x,top:rect.y,width:rect.width,height:rect.height}});
    data = [leaf({views:[]},width)];
  } else {
    const ordered = [...cells.values()].sort((a,b)=>a.x-b.x || a.y-b.y);
    data = [...new Set(ordered.map(cell=>cell.x))].map(x => {
      const column = ordered.filter(cell=>cell.x === x);
      return column.length === 1 ? leaf(column[0],column[0].width) : {type:'branch',size:column[0].width,data:column.map(cell=>leaf(cell,cell.height))};
    });
  }
  data.push(...hiddenLeaves);
  result.grid = {width,height,orientation:'HORIZONTAL',root:{type:'branch',size:width,data}};
  result.activeGroup = preset === 'floating' ? result.floatingGroups.find((/** @type {any} */ g)=>g.data.views.includes(rectangles[0].id)).data.id : data[0].type === 'leaf' ? data[0].data.id : data[0].data[0].data.id;
  return result;
}

/** Panel id namespace: deterministic, reversible, never a bare numeric index. */
export const WALL_PANEL_ID_PREFIX = 'panel-';
/** How long a restored panel may lack a projection row before it is closed. */
/** Maximum remembered identity placements [TARGET]; active panels are retained. */
export const MAX_IDENTITY_SLOT_HISTORY = 256;
export const ORPHAN_GRACE_MS = 5000;
/** Minimum live tile size, shared with the Holdings grid exemplar. */
export const WALL_PANEL_MIN_WIDTH = 240;
export const WALL_PANEL_MIN_HEIGHT = 200;
/** Initial viewport seed; the kit remeasures the outer stage after restore. */
export const WALL_INITIAL_VIEWPORT_WIDTH = 1280;
export const WALL_INITIAL_VIEWPORT_HEIGHT = 720;
/** Closed reveal placements. Popout stays unavailable by design (R2). */
export const WALL_PLACEMENTS = Object.freeze(['tab', 'split', 'floating']);
/** Closed local presentation verbs. None of them ends a backend surface. */
export const WALL_PRESENTATION_VERBS = Object.freeze(['close', 'hide', 'show', 'float', 'dock-back']);

/** @typedef {Readonly<{ code: string, message: string }>} WallAdmissionError */

/**
 * @template T
 * @typedef {Readonly<{ ok: true, value: T }> | Readonly<{ ok: false, error: WallAdmissionError }>} WallAdmissionResult
 */

/**
 * Authoritative surface row. The workspace reads id, surfaceId, lifecycle
 * and title; the remaining fields keep the view opaque-compatible with the
 * sibling panel contract.
 * @typedef {Object} WallSurfaceRow
 * @property {string} id
 * @property {string} surfaceId
 * @property {string} backendLifecycle
 * @property {string} [attachmentState]
 * @property {number} generation
 * @property {string} visibility
 * @property {string} control
 * @property {string} [title]
 * @property {WallAdmissionError | null} [refusal]
 */

/**
 * The controller still refuses rowless answers at runtime; the row type stays
 * required here so the shared view keeps matching the sibling panel prop.
 * @typedef {Object} WallProjectionView
 * @property {() => ({ rows: ReadonlyArray<WallSurfaceRow> } | null)} getProjection
 * @property {() => WallSnapshotLike | null} [getSnapshot]
 */

/** @typedef {Object} WallDockviewApi
 * @property {(id: string) => WallDockviewPanel | undefined} getPanel
 * @property {Array<{id:string,size:number}>} [groups]
 * @property {Array<{id:string, api:{close:() => void}}>} [panels]
 * @property {(group:{id:string,size:number}) => void} [removeGroup]
 * @property {(id:string) => unknown} [getGroup]
 * @property {(options:{id:string,referencePanel:string,direction:string}) => unknown} [addGroup]
 * @property {(options: WallAddPanelOptions) => WallDockviewPanel} addPanel
 * @property {Function} [toJSON]
 * @property {Function} [fromJSON]
 * @property {number} [width]
 * @property {number} [height]
 */

/**
 * @typedef {Object} WallDockviewPanel
 * @property {string} id
 * @property {WallDockviewPanelApi} api
 */

/**
 * @typedef {Object} WallDockviewPanelApi
 * @property {(options:{group:unknown,position:string,index:number}) => void} [moveTo]
 * @property {() => void} close
 * @property {() => void} setActive
 * @property {string} [title]
 * @property {(title:string) => void} [setTitle]
 */

/**
 * @typedef {Object} WallAddPanelOptions
 * @property {string} id
 * @property {string} component
 * @property {string} [title]
 * @property {{ capsuleId: string } | { sessionId: string }} params
 * @property {'always'} renderer
 * @property {number} minimumWidth
 * @property {number} minimumHeight
 * @property {{ direction: 'right' } | { referencePanel?: string, direction: string }} [position]
 */

/**
 * Committed float geometry in wall pixels. The kit `float` accepts it as an
 * optional second argument (MVUI16 lane P, ARG-pmui-4); older kit builds
 * ignore the extra argument and keep their fixed defaults.
 * @typedef {Object} WallFloatBounds
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} WallWindowPresentation
 * @property {(id: string) => { hidden: boolean, floating?: boolean, maximized?: boolean }} state
 * @property {(id: string) => void} show
 * @property {(id: string) => void} hide
 * @property {(id: string, bounds?: WallFloatBounds) => void} float
 * @property {(id: string) => void} dock
 */

/**
 * @typedef {Object} WallWorkspaceControllerOptions
 * @property {()=>{cols:number,rows:number}} [floatingGrid]
 * @property {()=>Record<string,{col:number,row:number}>} [savedCells]
 * @property {boolean} [allowLostSurface] - Diagnostic fixture presentation only.
 * @property {(error:WallAdmissionError)=>void} [onLayoutError]
 * @property {() => Array<any>} [workloadTiles]
 * @property {(value:any)=>boolean} [validateWorkloadTile]
 * @property {WallProjectionView | null} [projectionView]
 */

/** @typedef {'submit-intent' | 'activate-surface' | 'panel-closed'} WallForwardedEmit */

/** @typedef {(name: WallForwardedEmit, payload: unknown) => void} WallEmitFn */

/**
 * @typedef {Object} WallPanelCallbacks
 * @property {(body: unknown) => void} onSubmitIntent
 * @property {(payload: unknown) => void} onActivateSurface
 * @property {(intent: unknown) => WallAdmissionResult<Readonly<{ panelId: string, type: string }>>} onPresentationIntent
 */

/**
 * @typedef {Object} WallWorkspaceController
 * @property {(payload: unknown) => WallAdmissionResult<Readonly<{ ready: boolean }>>} handleReady
 * @property {() => void} dispose
 * @property {(action:string) => WallAdmissionResult<unknown>} resizeFocused
 * @property {(id:string,action:string) => WallAdmissionResult<unknown>} resizeTile
 * @property {()=>string|null} beginFloatingDrag
 * @property {(preset:string|null) => WallAdmissionResult<unknown>} setPreset
 * @property {() => void} refreshPreset
 * @property {(id:string) => boolean} hasSurfacePanel
 * @property {(capsuleId:string,body:any) => WallAdmissionResult<unknown>} applyLayoutEcho
 * @property {(id:string) => WallAdmissionResult<Readonly<{panelId:string}>>} revealWorkload
 * @property {(capsuleId: unknown, placement: unknown) => WallAdmissionResult<Readonly<{ panelId: string }>>} revealSurface
 * @property {(intent: unknown) => WallAdmissionResult<Readonly<{ panelId: string, type: string }>>} applyPresentationIntent
 * @property {(emit: WallEmitFn) => WallPanelCallbacks} createPanelCallbacks
 */

/**
 * Snapshot mirror of the sibling panel view. Field-for-field compatible so
 * the shared projection object passes through without a cast.
 * @typedef {Object} WallSnapshotLike
 * @property {string} status
 * @property {boolean} stale
 * @property {WallEnvelopeLike | null} envelope
 * @property {WallAdmissionError | null} error
 */

/**
 * @typedef {Object} WallEnvelopeLike
 * @property {string} schema
 * @property {number} epoch
 * @property {number} revision
 * @property {string} query
 * @property {{ rows: ReadonlyArray<WallSurfaceRow> }} projection
 */

/**
 * Shared projection view: the controller reads getProjection, the sibling
 * panel reads getSnapshot and subscribe. Both ride on one object.
 * @typedef {Object} WallSharedProjectionView
 * @property {() => ({ rows: ReadonlyArray<WallSurfaceRow> } | null)} getProjection
 * @property {() => WallSnapshotLike | null} getSnapshot
 * @property {(listener: (snapshot: WallSnapshotLike | null) => void) => () => void} subscribe
 */

/**
 * Shared intent builders, mirroring the sibling intent inputs exactly.
 * @typedef {Object} WallSharedIntentBuilders
 * @property {(input: { capsuleId: string, verb: string, pinned?: boolean }) => unknown} visibility
 * @property {(input: { capsuleId: string, verb: string }) => unknown} control
 * @property {(input: { capsuleId: string, verb: string }) => unknown} presentation
 */

/** @typedef {import('capsule-ui-kit/layout').LayoutProfileScope} KitLayoutScope */

/** @typedef {import('capsule-ui-kit/layout').LayoutProfileEnvelope} KitLayoutProfile */

/**
 * Storage mirror of the kit `LayoutStorage` declaration: raw bytes in,
 * atomic payload plus owner metadata out. Never implemented here.
 * @typedef {Object} KitLayoutStorage
 * @property {() => Promise<string | null>} readRaw
 * @property {(payload: string, meta: { ownerWindowId: string, scope: KitLayoutScope }) => Promise<void>} writeAtomic
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null) return {};
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {WallAdmissionError}
 */
export function wallError(code, message) {
  return Object.freeze({ code, message });
}

/**
 * Capsule ids arrive from layout params and panel intents, never invented
 * here: blank or whitespace-bearing values refuse before any admission work.
 * @param {unknown} value
 * @returns {WallAdmissionResult<string>}
 */
export function validateWallCapsuleId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    /** @type {WallAdmissionResult<string>} */
    const result = { ok: false, error: wallError('ERR_INVALID_CAPSULE_ID', 'capsuleId must be a non-empty string') };
    return Object.freeze(result);
  }
  if (value !== value.trim() || /\s/.test(value)) {
    /** @type {WallAdmissionResult<string>} */
    const result = { ok: false, error: wallError('ERR_INVALID_CAPSULE_ID', `capsuleId must not contain whitespace: "${value}"`) };
    return Object.freeze(result);
  }
  /** @type {WallAdmissionResult<string>} */
  const result = { ok: true, value };
  return Object.freeze(result);
}

/**
 * Reads the capsule id from dockview panel props (`{ params: { capsuleId },
 * api }`). Anything else renders the missing-id alert, never a guessed panel.
 * @param {unknown} params
 * @returns {string | null}
 */
export function resolveRouterCapsuleId(params) {
  const id = asNonEmptyString(asRecord(asRecord(params).params).capsuleId);
  if (id === null || id !== id.trim() || /\s/.test(id)) return null;
  return id;
}

/** Dock tab control id namespace: deterministic per capsule, never a bare numeric index. */
export const DOCK_TAB_ID_PREFIX = 'wall-tab-';
/** Tab title fallback when the panel carries no usable title or capsule id. */
export const DOCK_TAB_FALLBACK_TITLE = 'Capsule';

/** @typedef {Readonly<{ capsuleId: (string | null), id: (string | null), anchor: (string | null), title: string }>} DockTabDescription */

/**
 * Reads the capsule id behind a dockview tab component invocation. Tab
 * components receive `{ params, api, containerApi, tabLocation }`: the panel
 * params carry the authoritative capsuleId, and the panel id re-derives it
 * through the reversible panel prefix when params are absent.
 * @param {unknown} tabProps
 * @returns {string | null}
 */
export function resolveDockTabCapsuleId(tabProps) {
  const fromParams = resolveRouterCapsuleId(tabProps);
  if (fromParams !== null) return fromParams;
  const panelId = asNonEmptyString(asRecord(asRecord(tabProps).api).id);
  if (panelId !== null && panelId.startsWith(WALL_PANEL_ID_PREFIX)) {
    const candidate = panelId.slice(WALL_PANEL_ID_PREFIX.length);
    const checked = validateWallCapsuleId(candidate);
    if (checked.ok) return checked.value;
  }
  return null;
}

/**
 * Resolves the rendered tab title: the panel title verbatim when it carries
 * non-blank text, otherwise the capsule id, otherwise the Capsule fallback.
 * @param {unknown} tabProps
 * @param {string | null} capsuleId
 * @returns {string}
 */
export function resolveDockTabTitle(tabProps, capsuleId) {
  const title = asNonEmptyString(asRecord(asRecord(tabProps).api).title);
  if (title !== null && title.trim().length > 0) return title;
  return capsuleId ?? DOCK_TAB_FALLBACK_TITLE;
}

/**
 * Describes one dock tab for the agent lane: a stable control id plus a
 * capsule-scoped semantic anchor when a capsule id resolves, title only
 * otherwise (retired or foreign panels keep legacy unanchored rendering and
 * never receive an invented identity).
 * @param {unknown} tabProps
 * @returns {DockTabDescription}
 */
export function describeDockTab(tabProps) {
  const capsuleId = resolveDockTabCapsuleId(tabProps);
  const title = resolveDockTabTitle(tabProps, capsuleId);
  if (capsuleId === null) {
    return Object.freeze({ capsuleId: null, id: null, anchor: null, title });
  }
  return Object.freeze({
    capsuleId,
    id: `${DOCK_TAB_ID_PREFIX}${capsuleId}`,
    anchor: `workspace/tab/${capsuleId}`,
    title,
  });
}

/**
 * Dependency-injected wall controller. Pure except for the kit-owned api
 * object it is given: fully unit-testable without a DOM.
 * @param {WallWorkspaceControllerOptions} [options]
 * @returns {WallWorkspaceController}
 */
export function createWallWorkspaceController(options = {}) {
  const projectionView = options.projectionView ?? null;
  const floatingGrid = options.floatingGrid, savedCells = options.savedCells;
  /** @type {WallDockviewApi | null} */
  let api = null;
  /** @type {WallWindowPresentation | null} */
  let windows = null;
  let preset = /** @type {string|null} */ (null), layoutSignature = '', focusTile = '';
  let floatingViewport = /** @type {{width:number,height:number}|null} */ (null);
  const floatingLayout = new Map();
  /** Grid allocations may be narrower than a free window's default minimum.
   * Keep the minimum inside the actual cell instead of overlapping its neighbor.
   * @param {any} target @param {number} width @param {number} height */
  function fitAllocation(target,width,height) {
    // DockviewPanel inherits setConstraints but does not consume its event.
    // The group owns the nested grid's effective minimum, including floats.
    (target.group ?? target).api?.setConstraints?.({
      minimumWidth:Math.min(WALL_PANEL_MIN_WIDTH,width),
      minimumHeight:Math.min(WALL_PANEL_MIN_HEIGHT,height),
    });
    for (const panel of target.panels ?? [target]) panel.api?.setConstraints?.({
      minimumWidth:Math.min(WALL_PANEL_MIN_WIDTH,width),
      minimumHeight:Math.min(WALL_PANEL_MIN_HEIGHT,height),
    });
  }
  function rememberFloatingBounds() {
    if (!api?.width || !api.height || typeof api.toJSON !== 'function') return;
    const viewport={width:api.width,height:api.height};
    const live=new Set();
    for (const group of /** @type {any} */ (api).toJSON().floatingGroups ?? []) {
      const id=group.data.id, position=group.position;
      live.add(id);
      const previous=floatingLayout.get(id);
      if (!previous || JSON.stringify(previous.last)!==JSON.stringify(position)) {
        floatingLayout.set(id,{position:{...position},viewport,last:{...position}});
      }
    }
    for (const id of floatingLayout.keys()) if(!live.has(id)) floatingLayout.delete(id);
    floatingViewport=viewport;
  }
  function reflowFloatingBounds() {
    if (!api?.width || !api.height || !floatingViewport ||
        api.width===floatingViewport.width && api.height===floatingViewport.height) return;
    const viewport={width:api.width,height:api.height}, grid=floatingGrid?.() ?? {cols:2,rows:2};
    for (const [id,saved] of floatingLayout) {
      const group=/** @type {any} */ (api).groups?.find((/** @type {any} */ candidate)=>candidate.id===id && candidate.api.location.type==='floating');
      if (!group) continue;
      const rect=reflowFloatingRect(saved.position,saved.viewport,viewport,grid);
      fitAllocation(group,rect.width,rect.height);
      /** @type {any} */ (api).addFloatingGroup(group,{position:{left:rect.left,top:rect.top},width:rect.width,height:rect.height,disableSmartGuides:true});
      saved.last={...rect};
    }
    floatingViewport=viewport;
    void host?.completeUserGesture?.();
  }
  let host = /** @type {any} */ (null);
  /** @type {Map<string, string>} */
  const panelIdentities = new Map();
  /** @type {Map<string, {panelId:string, groupId:string|null, index:number, referencePanel:string|null, direction:string, orderIndex:number}>} */
  const identitySlots = new Map();
  /** @type {string[]} */
  const panelOrder = [];
  /** @param {string} profileId @param {any} slot */
  function rememberSlot(profileId,slot) {
    identitySlots.delete(profileId); identitySlots.set(profileId,slot);
  }
  function trimHistory() {
    // Without a panel list the live set is unknown: never prune on a guess.
    if (!Array.isArray(api?.panels)) return;
    const active = new Set(api.panels.map(panel=>panel.id));
    for (const [profileId,slot] of identitySlots) {
      if (identitySlots.size <= MAX_IDENTITY_SLOT_HISTORY) break;
      if (!active.has(slot.panelId)) identitySlots.delete(profileId);
    }
    const retained = new Set([...active,...[...identitySlots.values()].map(slot=>slot.panelId)]);
    for (const panelId of panelIdentities.keys()) if (!retained.has(panelId)) panelIdentities.delete(panelId);
    for (let i=panelOrder.length-1;i>=0;i--) if (!retained.has(panelOrder[i])) panelOrder.splice(i,1);
  }

  /** @param {string} panelId */
  function captureSlot(panelId) {
    if (!api) return;
    const capsuleId = panelId.startsWith(WALL_PANEL_ID_PREFIX) ? panelId.slice(WALL_PANEL_ID_PREFIX.length) : panelId;
    const rows = projectionView?.getProjection()?.rows || [];
    const row = rows.find((/** @type {any} */ candidate) => candidate?.id === capsuleId || candidate?.surfaceId === capsuleId);
    const profileId = panelIdentities.get(panelId) ?? asNonEmptyString(/** @type {any} */ (row)?.profile_id);
    if (!profileId) return;
    const panel = /** @type {any} */ (api.getPanel(panelId));
    const prev = identitySlots.get(profileId);
    const orderIndex = panelOrder.indexOf(panelId) >= 0 ? panelOrder.indexOf(panelId) : (prev?.orderIndex ?? 0);
    if (!panel) return;
    const group = panel.group ?? null;
    if (windows?.state(panelId).floating || group?.api?.location?.type === 'floating') {
      rememberSlot(profileId, {panelId, groupId: null, index: 0, referencePanel: null, direction: 'left', orderIndex});
      return;
    }
    const groupId = asNonEmptyString(group?.id);
    const groupPanels = Array.isArray(group?.panels) ? group.panels : [];
    const index = groupPanels.indexOf(panel);
    const sibling = groupPanels.find((/** @type {any} */ candidate) => candidate && candidate.id !== panelId && api?.getPanel(candidate.id));
    if (sibling?.id) {
      rememberSlot(profileId, {panelId, groupId, index: index >= 0 ? index : 0, referencePanel: sibling.id, direction: 'within', orderIndex});
      return;
    }
    let referencePanel = /** @type {string|null} */ (null);
    let direction = 'left';
    const candidates = [...new Set([...panelOrder, ...rows.map((/** @type {any} */ r) => `${WALL_PANEL_ID_PREFIX}${r.id}`)])]
      .filter(id => id !== panelId && api?.getPanel(id) && !windows?.state(id).floating && /** @type {any} */ (api?.getPanel(id))?.group?.api?.location?.type !== 'floating');
    if (candidates.length > 0) {
      referencePanel = candidates[0];
      const refPanelObj = /** @type {any} */ (api.getPanel(referencePanel));
      const refGroup = refPanelObj?.group ?? null;
      const groups = Array.isArray(api.groups) ? api.groups : [];
      const myGroupIdx = group ? groups.indexOf(group) : -1;
      const refGroupIdx = refGroup ? groups.indexOf(refGroup) : -1;
      const myRect = group?.element?.getBoundingClientRect?.();
      const refRect = refGroup?.element?.getBoundingClientRect?.();
      if (myRect && refRect && (myRect.width > 0 || refRect.width > 0 || myRect.height > 0 || refRect.height > 0)) {
        const dx = (myRect.x ?? myRect.left ?? 0) - (refRect.x ?? refRect.left ?? 0);
        const dy = (myRect.y ?? myRect.top ?? 0) - (refRect.y ?? refRect.top ?? 0);
        if (Math.abs(dx) >= Math.abs(dy)) direction = dx <= 0 ? 'left' : 'right';
        else direction = dy <= 0 ? 'above' : 'below';
      } else if (myGroupIdx >= 0 && refGroupIdx >= 0 && myGroupIdx !== refGroupIdx) {
        direction = myGroupIdx < refGroupIdx ? 'left' : 'right';
      } else {
        const refOrder = panelOrder.indexOf(referencePanel);
        if (orderIndex >= 0 && refOrder >= 0 && orderIndex !== refOrder) direction = orderIndex < refOrder ? 'left' : 'right';
      }
    }
    rememberSlot(profileId, {panelId, groupId, index: index >= 0 ? index : 0, referencePanel, direction, orderIndex});
  }
  const workloadRows = () => {
    const rows=options.workloadTiles?.() ?? [];
    return Array.isArray(rows)&&typeof options.validateWorkloadTile==='function'?rows.filter(options.validateWorkloadTile):[];
  };
  /** Presentation only; the consumer owns row validation and slot contents. @param {string} id */
  function revealWorkload(id) {
    const row=workloadRows().find(row=>row.id===id);
    if(!row)return fail('ERR_UNKNOWN_WORKLOAD','The workload panel is unavailable.');
    if(!api||!windows)return fail('ERR_NOT_READY','The wall is not ready.');
    const panelId=WORKLOAD_PANEL_PREFIX+id;
    try {
      const existing=api.getPanel(panelId);
      if(existing){if(windows.state(panelId).hidden)windows.show(panelId);else existing.api.setActive();}
      else {api.addPanel({id:panelId,component:'CapsulePanel',title:row.title,params:{sessionId:id},renderer:'always',minimumWidth:320,minimumHeight:240});collapseEmptyGroups();}
      return succeed(Object.freeze({panelId}));
    }catch{return fail('ERR_PRESENTATION_FAILED','The workload panel could not be shown.');}
  }
  const presentationRows = () => {
    if (!api || !windows) return [];
    const list = (projectionView?.getProjection()?.rows || []).flatMap(row => {
      if (row?.backendLifecycle === 'destroyed') return [];
      const panelId = WALL_PANEL_ID_PREFIX + row.id;
      if (!api?.getPanel(panelId)) return [];
      return [{id:panelId,...windows?.state(panelId)}];
    });
    for(const row of workloadRows()){
      const panelId=WORKLOAD_PANEL_PREFIX+row.id;
      if(api?.getPanel(panelId))list.push({id:panelId,...windows?.state(panelId)});
    }
    if (panelOrder.length > 1) {
      list.sort((a, b) => {
        const ia = panelOrder.indexOf(a.id), ib = panelOrder.indexOf(b.id);
        if (ia < 0 || ib < 0) return 0;
        return ia - ib;
      });
    }
    return list;
  };
  // A restored layout can hold panels of surfaces from an earlier run. Close a
  // wall panel only after its surface has been absent from a loaded projection
  // for ORPHAN_GRACE_MS, so a projection that is still filling never drops a
  // live tile.
  const orphanSince = new Map();
  function pruneOrphanPanels(now = Date.now()) {
    const snapshot = projectionView?.getSnapshot?.();
    if (!snapshot?.envelope || snapshot.stale !== false || snapshot.status !== 'live') {orphanSince.clear(); return;}
    const rows = projectionView?.getProjection()?.rows;
    if (!api || !Array.isArray(rows) || !Array.isArray(api.panels)) return;
    const live = new Set(rows.filter(row => row?.backendLifecycle !== 'destroyed').map(row => WALL_PANEL_ID_PREFIX + row.id));
    for (const panel of [...api.panels]) {
      const id = panel?.id;
      if (typeof id !== 'string' || !id.startsWith(WALL_PANEL_ID_PREFIX) || live.has(id)) { orphanSince.delete(id); continue; }
      const since = orphanSince.get(id) ?? now;
      orphanSince.set(id, since);
      if (now - since < ORPHAN_GRACE_MS) continue;
      orphanSince.delete(id);
      captureSlot(id); panel.api.close(); collapseEmptyGroups();
    }
  }
  function refreshPreset(now = Date.now()) {
    try {trimHistory(); reflowFloatingBounds(); const result=applyPreset(now); rememberFloatingBounds(); return result; }
    catch {
      preset = null; layoutSignature = '';
      const error = wallError('LAYOUT_PRESET_FAILED','Tile layout is unavailable.');
      options.onLayoutError?.(error);
      return fail(error.code,error.message);
    }
  }
  function applyPreset(now = Date.now()) {
    const activePanelId = /** @type {any} */ (api)?.activePanel?.id;
    if (api) {
      for (const row of projectionView?.getProjection()?.rows || []) {
        if (row?.backendLifecycle === 'destroyed') {
          const deadId = WALL_PANEL_ID_PREFIX + row.id;
          const deadPanel = api.getPanel(deadId);
          if (deadPanel) { captureSlot(deadId); deadPanel.api.close(); collapseEmptyGroups(); }
        } else if (row?.id === row?.surfaceId) {
          // Native window metadata can arrive after the provisional core row.
          const panel = api.getPanel(WALL_PANEL_ID_PREFIX + row.id);
          const title = panelTitle(row);
          if (panel?.api.setTitle && panel.api.title !== title) panel.api.setTitle(title);
        }
      }
      pruneOrphanPanels(now);
    }
    if (!preset || !api?.width || !api.height) return;
    const tiles = presentationRows();
    const signature = JSON.stringify([preset,api.width,api.height,tiles.map(({id,hidden})=>({id,hidden}))]);
    if (signature === layoutSignature || tiles.some(tile => tile.maximized)) return;
    if (focusTile && (preset === 'single' || preset === 'focus-strip')) tiles.sort((a,b)=>Number(b.id === focusTile)-Number(a.id === focusTile));
    if (preset === 'floating' && floatingGrid) {
      // Modal scrollbars can temporarily shrink the overlay host. Place only
      // after the creator closes, so snap and insertion use the same desktop.
      const doc = /** @type {any} */ (api.panels?.[0])?.group?.element?.ownerDocument;
      if ([...(doc?.querySelectorAll('[aria-modal="true"]') ?? [])].some(e=>e.getBoundingClientRect().width > 0)) return;
      const floatingGroups = /** @type {any} */ (api).toJSON?.().floatingGroups ?? [];
      const occupied = [], inserted = [], settled = new Set();
      for (const tile of tiles) {
        if (!windows?.state(tile.id).floating) continue;
        const panel = /** @type {any} */ (api.getPanel(tile.id));
        const fg = floatingGroups.find((/** @type {any} */ g)=>g.data?.views?.includes(tile.id));
        const shared = (panel?.group?.panels?.length ?? 0) > 1 || (fg?.data?.views?.length ?? 0) > 1;
        const profile = panelIdentities.get(tile.id), hint = profile ? savedCells?.()[profile] : null;
        if (!shared && !(hint && !floatingLayout.has(panel?.group?.id))) {
          settled.add(tile.id);
          if (fg?.position) occupied.push({x:fg.position.left,y:fg.position.top,width:fg.position.width,height:fg.position.height});
        }
      }
      for (const tile of tiles) {
        if (settled.has(tile.id)) continue;
        const panel = /** @type {any} */ (api.getPanel(tile.id));
        const fg = floatingGroups.find((/** @type {any} */ g)=>g.data?.views?.includes(tile.id));
        const shared = (panel?.group?.panels?.length ?? 0) > 1 || (fg?.data?.views?.length ?? 0) > 1;
        if (windows?.state(tile.id).floating && !shared) {
          const profile=panelIdentities.get(tile.id), hint=profile ? savedCells?.()[profile] : null;
          if (hint && !floatingLayout.has(panel?.group?.id)) {
            const rect=nextFloatingCell(api.width,api.height,floatingGrid(),occupied,hint);
            fitAllocation(panel.group,rect.width,rect.height);
            /** @type {any} */ (api).addFloatingGroup(panel.group,{position:{left:rect.x,top:rect.y},width:rect.width,height:rect.height,disableSmartGuides:true});
            occupied.push(rect); continue;
          }
          continue;
        }
        const profile = panelIdentities.get(tile.id);
        const rect = nextFloatingCell(api.width,api.height,floatingGrid(),occupied,profile ? savedCells?.()[profile] : null);
        fitAllocation(panel,rect.width,rect.height);
        /** @type {any} */ (api).addFloatingGroup(panel,{position:{left:rect.x,top:rect.y},width:rect.width,height:rect.height,disableSmartGuides:true});
        fitAllocation(panel.group,rect.width,rect.height);
        occupied.push(rect); inserted.push({id:tile.id,rect});
      }
      retainFloatingHome(api);
      // Removing the last grid panel can transiently expose a scrollbar and
      // clamp a right-edge float. Reapply only insertions after the empty grid
      // home exists; existing/manual windows never participate in this pass.
      for (const {id,rect} of inserted) {
        const group = /** @type {any} */ (api.getPanel(id))?.group;
        if (group) /** @type {any} */ (api).addFloatingGroup(group,{position:{left:rect.x,top:rect.y},width:rect.width,height:rect.height,disableSmartGuides:true});
      }
      layoutSignature = signature;
      void host?.completeUserGesture?.(); return;
    }
    const rectangles = presetRectangles(preset,tiles,api.width,api.height);
    if (!rectangles.length) return;
    if (rectangles.some(rect=>typeof api?.getPanel(rect.id)?.api?.moveTo !== 'function')) throw Error('LAYOUT_PRESET_FAILED');
    // Move existing panels; the kit remains the only layout-restore owner.
    for (const rect of rectangles) if (windows?.state(rect.id).floating) {
      let grid = (api.groups || []).find((/** @type {any} */ group)=>group.api.location.type === 'grid');
      if (!grid) grid = /** @type {any} */ (api).addGroup({direction:'right',skipSetActive:true});
      const panel = /** @type {any} */ (api.getPanel(rect.id));
      panel.api.moveTo({group:grid,position:'center'});
      if (panel.params?.viewMode?.startsWith('window-floating:')) panel.api.updateParameters({viewMode:null});
    }
    const first = /** @type {any} */ (api.getPanel(rectangles[0].id));
    for (const rect of rectangles.slice(1)) {
      const panel = /** @type {any} */ (api.getPanel(rect.id));
      if (panel.group !== first.group) panel.api.moveTo({group:first.group,position:'center'});
    }
    collapseEmptyGroups();
    if (preset === 'floating') {
      for (const rect of rectangles) /** @type {any} */ (api).addFloatingGroup(api.getPanel(rect.id),{position:{left:rect.x,top:rect.y},width:rect.width,height:rect.height});
      // The kit decoder requires a branch root with an empty grid home.
      retainFloatingHome(api);
    } else {
      const cells = new Map();
      for (const rect of rectangles) {
        const key = [rect.x,rect.y].join(':');
        if (!cells.has(key)) cells.set(key,{...rect,ids:[]});
        cells.get(key).ids.push(rect.id);
      }
      if (['grid','grid-3x2'].includes(preset)) {
        const columns = preset === 'grid-3x2' ? 3 : 2;
        for (let row=0;row<2;row++) for (let column=0;column<columns;column++) {
          const x=Math.floor(column*api.width/columns), y=Math.floor(row*api.height/2);
          const key=[x,y].join(':');
          if (!cells.has(key)) cells.set(key,{x,y,width:Math.floor((column+1)*api.width/columns)-x,height:Math.floor((row+1)*api.height/2)-y,ids:[]});
        }
      }
      const placed = /** @type {any[]} */ ([]);
      for (const cell of [...cells.values()].sort((a,b)=>a.y-b.y || a.x-b.x)) {
        let group = first.group;
        if (placed.length) {
          const column = placed.filter(other=>other.x === cell.x);
          const anchor = column.at(-1) || placed.at(-1);
          const position = column.length ? 'bottom' : 'right';
          if (cell.ids.length) {
            const panel = /** @type {any} */ (api.getPanel(cell.ids[0]));
            panel.api.moveTo({group:anchor.group,position}); group = panel.group;
          } else group = /** @type {any} */ (api).addGroup({referenceGroup:anchor.group,direction:column.length ? 'below' : 'right'});
        }
        for (const id of cell.ids.slice(1)) /** @type {any} */ (api.getPanel(id)).api.moveTo({group,position:'center'});
        placed.push({...cell,group});
      }
      for (const cell of placed) {
        fitAllocation(cell.group,cell.width,cell.height);
        cell.group.api.setSize({width:cell.width,height:cell.height});
      }
      const priorActive = activePanelId ? api.getPanel(activePanelId) : null;
      (priorActive || first).api.setActive();
    }
    layoutSignature = JSON.stringify([preset,api.width,api.height,presentationRows().map(({id,hidden})=>({id,hidden}))]);
    void host?.completeUserGesture?.();
  }

  function setPreset(/** @type {string|null} */ next) {
    if (next !== null && !TILE_PRESETS.includes(next)) return fail('LAYOUT_PRESET_INVALID','Unknown tile preset.');
    if (!api || !windows) return fail('ERR_NOT_READY','Wall is not ready.');
    preset = next; layoutSignature = ''; focusTile = /** @type {any} */ (api).activePanel?.id || '';
    try {
      const result = refreshPreset();
      if (result?.ok === false) return result;
      // The kit owns validated persistence and its settled/read-only gates.
      void host?.completeUserGesture?.();
      return succeed({preset});
    } catch { return fail('LAYOUT_PRESET_FAILED','Tile layout is unavailable.'); }
  }

  function beginFloatingDrag() {
    if (preset !== 'floating') preset = null;
    layoutSignature = '';
    return preset;
  }

  function resizeFocused(/** @type {string} */ action) {
    const id = /** @type {any} */ (api)?.activePanel?.id;
    return typeof id === 'string' && id.startsWith(WALL_PANEL_ID_PREFIX) ? resizeTile(id.slice(WALL_PANEL_ID_PREFIX.length),action) : fail('ERR_NOT_READY','No focused tile.');
  }
  function resizeTile(/** @type {string} */ capsuleId, /** @type {string} */ action) {
    if (!api || !windows || !api.width || !api.height) return fail('ERR_NOT_READY','Wall is not ready.');
    const wallWidth = api.width, wallHeight = api.height;
    const panel = /** @type {any} */ (api.getPanel(WALL_PANEL_ID_PREFIX + capsuleId));
    if (!panel || !['wider','narrower','taller','shorter','fit'].includes(action)) return fail('LAYOUT_SIZE_INVALID','Unknown tile or size action.');
    try {
      panel.api.setActive();
      const group = panel.group, box = group.api.boundingBox || group.element.getBoundingClientRect();
      if (action === 'fit') {
        if (windows.state(panel.id).floating) {
          const titleHeight = group.element?.closest?.('.dv-resize-container')?.querySelector('.dv-floating-titlebar')?.offsetHeight || 0;
          group.api.setSize({width:Math.min(640,wallWidth),height:Math.min(480,wallHeight)-titleHeight});
        }
        else {
          const peers = (api.groups || []).filter((/** @type {any} */ candidate)=>candidate.size > 0 && candidate.api.location.type === 'grid' && candidate.api.isVisible !== false);
          const boxes = peers.map((/** @type {any} */ candidate)=>candidate.api.boundingBox || candidate.element.getBoundingClientRect());
          const columns = new Set(boxes.map((/** @type {any} */ rect)=>Math.round(rect.left ?? rect.x)));
          const rows = boxes.filter((/** @type {any} */ rect)=>Math.abs((rect.left ?? rect.x)-(box.left ?? box.x)) < 2).length;
          group.api.setSize({width:wallWidth/Math.max(1,columns.size),height:wallHeight/Math.max(1,rows)});
        }
      } else {
        const horizontal = action === 'wider' || action === 'narrower';
        const dimension = horizontal ? 'width' : 'height';
        const step = Math.round((horizontal ? wallWidth : wallHeight) * .1);
        // Dockview sizes grid allocations; floats use outer width and
        // content height. Gap shares and titlebars must not accumulate drift.
        const outer = windows.state(panel.id).floating ? group.element?.closest?.('.dv-resize-container')?.getBoundingClientRect() : null;
        const allocated = outer ? undefined : panelAllocation(/** @type {any} */ (api).toJSON?.(),panel.id,dimension);
        const current = outer?.[dimension] ?? allocated ?? (Number.isFinite(group.api[dimension]) && group.api[dimension] > 0 ? group.api[dimension] : box[dimension]);
        const minimum = horizontal ? WALL_PANEL_MIN_WIDTH : WALL_PANEL_MIN_HEIGHT;
        const maximum = horizontal ? wallWidth : wallHeight;
        const value = Math.max(minimum,Math.min(maximum,current + (action === 'wider' || action === 'taller' ? step : -step)));
        const titleHeight = !horizontal && outer ? group.element.closest('.dv-resize-container').querySelector('.dv-floating-titlebar')?.offsetHeight || 0 : 0;
        group.api.setSize({[dimension]:value-titleHeight});
      }
      // Manual sizing becomes a custom layout. Dockview preserves its ratios
      // across viewport changes; a preset refresh must not replace them.
      preset = null; layoutSignature = '';
      void host?.completeUserGesture?.();
      return succeed({action});
    } catch { return fail('LAYOUT_SIZE_FAILED','Tile size is unavailable.'); }
  }

  /**
   * @template T
   * @param {T} value
   * @returns {WallAdmissionResult<T>}
   */
  function succeed(value) {
    /** @type {WallAdmissionResult<T>} */
    const result = { ok: true, value };
    return Object.freeze(result);
  }

  /**
   * @param {string} code
   * @param {string} message
   * @returns {WallAdmissionResult<never>}
   */
  function fail(code, message) {
    /** @type {WallAdmissionResult<never>} */
    const result = { ok: false, error: wallError(code, message) };
    return Object.freeze(result);
  }

  function collapseEmptyGroups() {
    if (!api || !Array.isArray(api.groups) || typeof api.removeGroup !== 'function') return;
    // Keep the initial empty restore target until a real panel exists. Snapshot
    // the group list because Dockview mutates it while removing empty groups.
    const groups = [...api.groups];
    if (!groups.some(group => group.size > 0)) return;
    for (const group of groups) if (group.size === 0) api.removeGroup(group);
  }

  /**
   * @param {unknown} payload
   * @returns {WallAdmissionResult<Readonly<{ ready: boolean }>>}
   */
  function handleReady(payload) {
    const record = asRecord(payload);
    const candidateApi = asRecord(record.api);
    const candidateWindows = asRecord(record.windows);
    const apiOk = typeof candidateApi.getPanel === 'function' && typeof candidateApi.addPanel === 'function';
    const windowsOk = ['state', 'show', 'hide', 'float', 'dock']
      .every((key) => typeof candidateWindows[key] === 'function');
    if (!apiOk || !windowsOk) {
      return fail('ERR_INVALID_READY', 'ready payload must carry a Dockview api and window presentation');
    }
    api = /** @type {WallDockviewApi} */ (/** @type {unknown} */ (record.api));
    windows = /** @type {WallWindowPresentation} */ (/** @type {unknown} */ (record.windows));
    host = record.host;
    collapseEmptyGroups();
    return succeed(Object.freeze({ ready: true }));
  }

  function dispose() {
    api = null;
    windows = null;
  }

  /**
   * Exact identity only: the row must exist, its id must equal its surface id
   * and the requested id, and its backend lifecycle must still be present.
   * @param {string} capsuleId
   * @returns {WallAdmissionResult<WallSurfaceRow>}
   */
  function findRow(capsuleId) {
    if (!projectionView || typeof projectionView.getProjection !== 'function') {
      return fail('ERR_PROJECTION_UNAVAILABLE', 'projection view is unavailable');
    }
    const projection = projectionView.getProjection();
    const rows = projection && Array.isArray(projection.rows) ? projection.rows : null;
    if (!rows) {
      return fail('ERR_PROJECTION_UNAVAILABLE', 'projection carries no surface rows');
    }
    const row = rows.find((candidate) => candidate?.surfaceId === capsuleId);
    if (!row) {
      return fail('ERR_UNKNOWN_SURFACE', `unknown surface "${capsuleId}"`);
    }
    if (row.id !== capsuleId) {
      return fail('ERR_ROW_IDENTITY_MISMATCH', `row identity mismatch for "${capsuleId}"`);
    }
    if (row.backendLifecycle === 'lost' && options.allowLostSurface === true) return succeed(row);
    if (row.backendLifecycle === 'lost' || row.backendLifecycle === 'destroyed') {
      return fail('ERR_SURFACE_GONE', `surface "${capsuleId}" is ${row.backendLifecycle}`);
    }
    if (row.backendLifecycle !== 'active' && row.backendLifecycle !== 'standby' && row.backendLifecycle !== 'ceded') {
      return fail('ERR_UNKNOWN_LIFECYCLE', `unknown lifecycle for "${capsuleId}"`);
    }
    return succeed(row);
  }

  /**
   * @param {WallSurfaceRow} row
   * @returns {string}
   */
  function panelTitle(row) {
    return typeof row.title === 'string' && row.title.trim().length > 0 ? row.title : row.surfaceId;
  }

  /**
   * Reveals the single permanent panel for a capsule id, creating its
   * presentation when absent. Backend state is only read, never written.
   * @param {unknown} capsuleId
   * @param {unknown} placement
   * @returns {WallAdmissionResult<Readonly<{ panelId: string }>>}
   */
  function revealSurface(capsuleId, placement) {
    const idCheck = validateWallCapsuleId(capsuleId);
    if (!idCheck.ok) return idCheck;
    if (typeof placement !== 'string' || !WALL_PLACEMENTS.includes(placement)) {
      return fail('ERR_INVALID_PLACEMENT', `unknown placement "${String(placement)}"`);
    }
    if (api === null || windows === null) {
      return fail('ERR_NOT_READY', 'wall is not ready: cold restore has not settled');
    }
    const rowCheck = findRow(idCheck.value);
    if (!rowCheck.ok) return rowCheck;
    const panelId = `${WALL_PANEL_ID_PREFIX}${idCheck.value}`;
    try {
      const existing = api.getPanel(panelId);
      if (existing) {
        if (placement === 'floating') windows.float(panelId);
        else if (windows.state(panelId).hidden) windows.show(panelId);
        else existing.api.setActive();
        return succeed(Object.freeze({ panelId }));
      }
      /** @type {WallAddPanelOptions} */
      const options = {
        id: panelId,
        component: 'CapsulePanel',
        title: panelTitle(rowCheck.value),
        params: { capsuleId: idCheck.value },
        renderer: 'always',
        minimumWidth: WALL_PANEL_MIN_WIDTH,
        minimumHeight: WALL_PANEL_MIN_HEIGHT,
      };
      if (placement === 'split') options.position = { direction: 'right' };
      const profileId = asNonEmptyString(/** @type {any} */ (rowCheck.value).profile_id);
      const hint = profileId ? savedCells?.()[profileId] : null;
      const grid = floatingGrid?.();
      const hasCellHint = Boolean(
        (preset === null || preset === 'floating') &&
        hint && grid && api.width && api.height &&
        Number.isInteger(hint.col) && Number.isInteger(hint.row) &&
        hint.col >= 0 && hint.col < grid.cols && hint.row >= 0 && hint.row < grid.rows
      );
      const prior = profileId ? identitySlots.get(profileId) : null;
      if (prior && prior.panelId !== panelId) {
        const stalePanel = api.getPanel(prior.panelId);
        if (stalePanel) { captureSlot(prior.panelId); stalePanel.api.close(); collapseEmptyGroups(); }
      }
      const slot = profileId ? identitySlots.get(profileId) : null;
      if (slot && slot.panelId !== panelId && preset !== 'floating' && !hasCellHint) {
        const refPanel = slot.referencePanel ? /** @type {any} */ (api.getPanel(slot.referencePanel)) : null;
        const refFloating = Boolean(slot.referencePanel && (windows?.state(slot.referencePanel).floating || refPanel?.group?.api?.location?.type === 'floating'));
        const groupObj = slot.groupId && typeof api.getGroup === 'function' ? /** @type {any} */ (api.getGroup(slot.groupId)) : null;
        const groupFloating = groupObj?.api?.location?.type === 'floating';
        if (groupObj && !groupFloating) {
          if (slot.referencePanel && refPanel && !refFloating) {
            options.position = { referencePanel: slot.referencePanel, direction: /** @type {any} */ ('within') };
          }
        } else if (slot.referencePanel && refPanel && !refFloating) {
          options.position = { referencePanel: slot.referencePanel, direction: /** @type {any} */ (slot.direction) };
        }
      }
      if (!options.position && (/** @type {any} */ (api).activeGroup?.api?.location?.type === 'floating' || /** @type {any} */ (api).activePanel?.group?.api?.location?.type === 'floating')) {
        options.position = { direction: 'right' };
      }
      const panel = api.addPanel(options);
      if (slot && slot.panelId !== panelId && preset !== 'floating' && !hasCellHint && slot.groupId && typeof api.getGroup === 'function') {
        const targetGroup = /** @type {any} */ (api.getGroup(slot.groupId));
        if (targetGroup && targetGroup.api?.location?.type !== 'floating' && typeof /** @type {any} */ (panel)?.api?.moveTo === 'function') {
          /** @type {any} */ (panel).api.moveTo({ group: targetGroup, position: 'center', ...(Number.isInteger(slot.index) && slot.index >= 0 ? { index: slot.index } : {}) });
        }
      }
      if (profileId) {
        panelIdentities.set(panelId, profileId);
        if (slot && slot.panelId !== panelId) {
          const oldIdx = panelOrder.indexOf(slot.panelId);
          if (oldIdx >= 0) panelOrder.splice(oldIdx, 1, panelId);
          else if (!panelOrder.includes(panelId)) panelOrder.splice(Math.min(slot.orderIndex, panelOrder.length), 0, panelId);
        } else if (!panelOrder.includes(panelId)) {
          panelOrder.push(panelId);
        }
        rememberSlot(profileId, {
          panelId,
          groupId: hasCellHint || preset === 'floating' ? null : (asNonEmptyString(/** @type {any} */ (panel)?.group?.id) ?? slot?.groupId ?? null),
          index: hasCellHint || preset === 'floating' ? 0 : (slot?.index ?? 0),
          referencePanel: hasCellHint || preset === 'floating' ? null : (slot?.referencePanel ?? null),
          direction: hasCellHint || preset === 'floating' ? 'left' : (slot?.direction ?? 'left'),
          orderIndex: panelOrder.indexOf(panelId),
        });
      }
      collapseEmptyGroups(); trimHistory();
      if (placement === 'floating') windows.float(panelId);
      else panel.api.setActive();
      // A float dragged from a grid preset or in Floating preset retains its
      // saved identity cell after the surface ends. Restore only the new panel
      // as its own floating group; existing groups stay in place.
      if (hasCellHint && grid && api.width && api.height) {
        // Cold restore retains ended surfaces during the orphan grace period.
        // They are not live occupants of the reopened identity's cell.
        const livePanels = new Set(presentationRows().map(tile=>tile.id));
        const occupied = (/** @type {any} */ (api).toJSON().floatingGroups ?? [])
          .filter((/** @type {any} */ group)=>group.data?.views?.some((/** @type {string} */ id)=>id !== panelId && livePanels.has(id)))
          .map((/** @type {any} */ group)=>({x:group.position.left,y:group.position.top,width:group.position.width,height:group.position.height}));
        const rect = nextFloatingCell(api.width,api.height,grid,occupied,hint);
        fitAllocation(panel,rect.width,rect.height);
        // Detach this panel from any remembered tab group before positioning
        // its new group; Dockview may clamp the panel's initial float bounds.
        /** @type {any} */ (api).addFloatingGroup(panel,{position:{left:rect.x,top:rect.y},width:rect.width,height:rect.height,disableSmartGuides:true});
        fitAllocation(/** @type {any} */ (panel).group,rect.width,rect.height);
        /** @type {any} */ (api).addFloatingGroup(/** @type {any} */ (panel).group,{position:{left:rect.x,top:rect.y},width:rect.width,height:rect.height,disableSmartGuides:true});
        retainFloatingHome(api);
        rememberFloatingBounds();
        void host?.completeUserGesture?.();
      }
      return succeed(Object.freeze({ panelId }));
    } catch (error) {
      return fail('ERR_REVEAL_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Applies a local presentation intent. Unknown verbs, unknown panels and
   * missing readiness refuse; nothing here creates or ends a surface.
   * @param {unknown} intent
   * @returns {WallAdmissionResult<Readonly<{ panelId: string, type: string }>>}
   */
  function applyPresentationIntent(intent) {
    if (!isPlainObject(intent) || typeof intent.type !== 'string' || !WALL_PRESENTATION_VERBS.includes(intent.type)) {
      return fail('ERR_UNKNOWN_PRESENTATION', 'unknown local presentation intent');
    }
    const idCheck = validateWallCapsuleId(intent.capsuleId);
    if (!idCheck.ok) return idCheck;
    if (api === null || windows === null) {
      return fail('ERR_NOT_READY', 'wall is not ready: cold restore has not settled');
    }
    const panelId = `${WALL_PANEL_ID_PREFIX}${idCheck.value}`;
    try {
      const panel = api.getPanel(panelId);
      if (!panel) {
        return fail('ERR_UNKNOWN_PANEL', `unknown panel "${panelId}"`);
      }
      if (intent.type === 'close') { captureSlot(panelId); panel.api.close(); collapseEmptyGroups(); }
      else if (intent.type === 'hide') windows.hide(panelId);
      else if (intent.type === 'show') windows.show(panelId);
      else if (intent.type === 'float') windows.float(panelId);
      else windows.dock(panelId);
      return succeed(Object.freeze({ panelId, type: intent.type }));
    } catch (error) {
      return fail('ERR_PRESENTATION_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  /** Apply a committed float to the existing panel (MVUI16 lane P,
   * ARG-pmui-4; MVUI16E lane E contract fix). Params mirror the
   * ui_intent/v0.2 float bounds; anything else refuses without touching
   * presentation. Geometry rides the kit windows.float bounds argument;
   * the kit ignores bounds today (kit queue item 15 adds bounds) and the
   * wall contract forbids any renderer layout round trip, so no geometry
   * is applied or asserted here.
   * @param {string} capsuleId @param {any} body @returns {WallAdmissionResult<unknown>} */
  function applyFloatEcho(capsuleId, body) {
    const row = findRow(capsuleId);
    if (!row.ok) return row;
    if (!api || !windows) return fail('ERR_NOT_READY', 'Placement is not ready.');
    const p = body?.params;
    const inRange = (/** @type {any} */ v, /** @type {number} */ min, /** @type {number} */ max) =>
      Number.isInteger(v) && v >= min && v <= max;
    if (!p || ![capsuleId, `cuk-ai-slot-${capsuleId}`].includes(p.slot_id)
        || !inRange(p.x_px, 0, 16383) || !inRange(p.y_px, 0, 16383)
        || !inRange(p.width_px, 1, 16384) || !inRange(p.height_px, 1, 16384)) {
      return fail('ERR_INVALID_PLACEMENT', 'Placement is unavailable.');
    }
    const panelId = `${WALL_PANEL_ID_PREFIX}${capsuleId}`;
    const panel = api.getPanel(panelId);
    if (!panel) return fail('ERR_UNKNOWN_PANEL', `unknown panel "${panelId}"`);
    try {
      windows.float(panelId, { x: p.x_px, y: p.y_px, width: p.width_px, height: p.height_px });
      return succeed(Object.freeze({ panelId }));
    } catch { return fail('ERR_PRESENTATION_FAILED', 'Placement is unavailable.'); }
  }

  /** Apply a committed move/tab to the existing panel, keeping its live renderer.
   * The caller owns correlation and waits for the authority echo first.
   * @param {string} capsuleId @param {any} body @returns {WallAdmissionResult<unknown>} */
  function applyLayoutEcho(capsuleId, body) {
    const row = findRow(capsuleId);
    if (!row.ok) return row;
    if (!api || !windows) return fail('ERR_NOT_READY', 'Placement is not ready.');
    if (body?.op === 'float') return applyFloatEcho(capsuleId, body);
    if (!['move','tab'].includes(body?.op)) return applyPresentationIntent({ type:body?.op, capsuleId });
    const p = body.params;
    if (!p || ![capsuleId, `cuk-ai-slot-${capsuleId}`].includes(p.slot_id)
        || typeof p.group_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.group_id)
        || !Number.isInteger(p.index) || p.index < 0 || p.index > 255) return fail('ERR_INVALID_PLACEMENT', 'Placement is unavailable.');
    const panelId = `${WALL_PANEL_ID_PREFIX}${capsuleId}`;
    const panel = api.getPanel(panelId);
    if (!panel?.api.moveTo || !api.getGroup || !api.addGroup) return fail('ERR_NOT_READY', 'Placement is not ready.');
    try {
      const group = api.getGroup(p.group_id) ?? api.addGroup({ id:p.group_id, referencePanel:panelId, direction:'right' });
      windows.dock(panelId);
      panel.api.moveTo({ group, position:'center', index:p.index });
      panel.api.setActive();
      return succeed(Object.freeze({ panelId }));
    } catch { return fail('ERR_PRESENTATION_FAILED', 'Placement is unavailable.'); }
  }

  /**
   * @param {WallEmitFn} emit
   * @returns {WallPanelCallbacks}
   */
  function createPanelCallbacks(emit) {
    return Object.freeze({
      onSubmitIntent: (/** @type {unknown} */ body) => { emit('submit-intent', body); },
      onActivateSurface: (/** @type {unknown} */ payload) => { emit('activate-surface', payload); },
      onPresentationIntent: (/** @type {unknown} */ intent) => {
        const result = applyPresentationIntent(intent);
        // The close (x) removes only the dock panel; the shell must learn it to offer the way back.
        if (result.ok && result.value.type === 'close') emit('panel-closed', Object.freeze({ capsuleId: /** @type {any} */ (intent).capsuleId }));
        return result;
      },
    });
  }

  const hasSurfacePanel = (/** @type {string} */ id) => Boolean(api?.getPanel(WALL_PANEL_ID_PREFIX+id));
  return Object.freeze({ hasSurfacePanel, handleReady, dispose, revealWorkload, revealSurface, applyPresentationIntent, applyLayoutEcho, setPreset, beginFloatingDrag, resizeTile, resizeFocused, refreshPreset, createPanelCallbacks });
}

/**
 * Fallback for retired panel types. The kit routes unknown component names
 * here with their ids and params preserved; the message stays honest about
 * the retired type instead of rendering a live-looking tile.
 */
export const WallMissingPanel = defineComponent({
  name: 'WallMissingPanel',
  props: {
    params: { type: Object, required: true },
  },
  setup(routerProps) {
    return () => {
      const outer = asRecord(routerProps.params);
      const inner = asRecord(outer.params);
      const panelId = asNonEmptyString(asRecord(outer.api).id)
        ?? asNonEmptyString(inner.capsuleId)
        ?? 'unknown panel';
      const reason = asNonEmptyString(inner.unavailableReason)
        ?? 'Panel type retired. Reset the workspace layout.';
      return h('div', { role: 'alert', class: 'wall-missing-panel', 'data-panel-id': panelId }, [
        h('p', { class: 'wall-missing-panel-title' }, `Panel unavailable: ${panelId}.`),
        h('p', { class: 'wall-missing-panel-reason' }, reason),
      ]);
    };
  },
});
</script>
<script setup>
import { inject, provide, markRaw, onBeforeUnmount, ref, useSlots, watch } from 'vue';
import DockWorkspace from 'capsule-ui-kit/DockWorkspace';
import SurfacePanel from './SurfacePanel.vue';
import {createCapsulePanelRouter} from './workloadPanelParams.js';

const props = defineProps({
  workloadTiles:{type:/** @type {import('vue').PropType<Array<any>>} */ (Array),default:()=>[]},
  validateWorkloadTile:{type:Function,default:null},
  identityCells: {type:Object,default:()=>({})},
  snapGrid: {type: /** @type {import('vue').PropType<{cols:number,rows:number}>} */ (Object), default:()=>({cols:2,rows:2})},
  workspaceComponent: { type: Object, default: () => DockWorkspace },
  scope: {
    type: /** @type {import('vue').PropType<KitLayoutScope>} */ (Object),
    required: true,
  },
  storage: {
    type: /** @type {import('vue').PropType<KitLayoutStorage>} */ (Object),
    required: true,
  },
  ownerWindowId: { type: String, required: true },
  allowLostSurface: { type: Boolean, default: false },
  projectionView: {
    type: /** @type {import('vue').PropType<WallSharedProjectionView>} */ (Object),
    required: true,
  },
  intentBuilders: {
    type: /** @type {import('vue').PropType<WallSharedIntentBuilders>} */ (Object),
    required: true,
  },
  controlRegistry: { type: Object, required: true },
  scheduler: { type: Object, required: true },
  tileScheduler: { type: Object, required: true },
  colorScheme: {
    type: String,
    default: 'light',
    validator: (/** @type {unknown} */ value) => value === 'light' || value === 'dark',
  },
  density: {
    type: String,
    default: 'regular',
    validator: (/** @type {unknown} */ value) => value === 'compact' || value === 'regular' || value === 'comfortable',
  },
  defaultProfile: {
    type: /** @type {import('vue').PropType<KitLayoutProfile | null>} */ (Object),
    default: null,
  },
  captureState: { type: Object, default: null },
  displayOnly: { type: Boolean, default: false },
  // Optional host clipboard ({ writeText }) for the tile Copy ID for AI action; null falls back to the ambient clipboard.
  clipboard: { type: /** @type {import('vue').PropType<import('./capsuleId.js').CapsuleClipboardLike | null>} */ (Object), default: null },
});

const emit = defineEmits([
  'custom-layout',
  'snap-grid-change',
  'ready',
  'wall-settled',
  'layout-saved',
  'quarantine-detected',
  'popout-blocked',
  'active-panel-change',
  'submit-intent',
  'activate-surface',
  'panel-closed',
  'layout-error',
]);

const controller = createWallWorkspaceController({workloadTiles:()=>props.workloadTiles,validateWorkloadTile:value=>typeof props.validateWorkloadTile==='function'&&props.validateWorkloadTile(value), floatingGrid:()=>props.snapGrid, savedCells:()=>props.identityCells, projectionView: props.projectionView, allowLostSurface: props.allowLostSurface, onLayoutError:error=>emit('layout-error',error) });
const callbacks = controller.createPanelCallbacks(emit);

const wallRoot = ref(null);
let releaseDrag = () => {};
function changeGrid(/** @type {'cols'|'rows'} */ axis, /** @type {Event} */ event) {
  const value = Number(/** @type {HTMLSelectElement} */ (event.target).value);
  emit('snap-grid-change',{...props.snapGrid,[axis]:value});
}
const slots = useSlots();
const surfaceSlot = slots.surface ?? null;
const workloadSlot=slots.workload??null;
const validWorkload=(/** @type {any} */ row)=>typeof props.validateWorkloadTile==='function'&&props.validateWorkloadTile(row);
const revealedWorkloads=new Set();
function revealWorkloads(){for(const row of props.workloadTiles){if(validWorkload(row)&&!revealedWorkloads.has(row.id)){const result=controller.revealWorkload(row.id);if(result.ok)revealedWorkloads.add(row.id);}}}
watch(()=>props.workloadTiles.map(row=>row?.id).join('|'),revealWorkloads);
// Dockview mounts router components in isolated roots. Carry the scoped
// capability into that root instead of relying on App's ancestor provides.
const capsuleTerminal = inject('capsuleTerminal', null);

const viewportWidth = WALL_INITIAL_VIEWPORT_WIDTH;
const viewportHeight = WALL_INITIAL_VIEWPORT_HEIGHT;

/**
 * @param {unknown} payload
 */
function onReady(payload) {
  const accepted = controller.handleReady(payload);
  releaseDrag();
  if (accepted.ok && /** @type {any} */ (wallRoot.value)?.ownerDocument && /** @type {any} */ (payload)?.api) releaseDrag = installFloatingDrag(wallRoot.value,/** @type {any} */ (payload).api,
    ()=>props.snapGrid,()=>{emit('custom-layout',controller.beginFloatingDrag());},()=>{void /** @type {any} */ (payload).host?.completeUserGesture?.();});
  revealWorkloads();
  emit('ready', payload);
}

/**
 * @param {unknown} payload
 */
function onWallSettled(payload) {
  emit('wall-settled', payload);
}

/**
 * @param {unknown} payload
 */
function onLayoutSaved(payload) {
  emit('layout-saved', payload);
}

/**
 * @param {unknown} payload
 */
function onQuarantineDetected(payload) {
  emit('quarantine-detected', payload);
}

/**
 * @param {unknown} payload
 */
function onPopoutBlocked(payload) {
  emit('popout-blocked', payload);
}

/**
 * @param {unknown} payload
 */
function onActivePanelChange(payload) {
  emit('active-panel-change', payload);
}

const WallSurfaceRouter = markRaw(defineComponent({
  name: 'WallSurfaceRouter',
  props: {
    params: { type: Object, required: true },
  },
  setup(routerProps) {
    provide('capsuleTerminal', capsuleTerminal);
    return () => {
      const capsuleId = resolveRouterCapsuleId(routerProps.params);
      if (capsuleId === null) {
        return h('p', { role: 'alert', class: 'wall-missing-id' }, 'Missing capsule id. Reset the workspace layout.');
      }
      const api = asRecord(asRecord(routerProps.params).api);
      const instance = asNonEmptyString(api.id) ?? capsuleId;
      return h(SurfacePanel, {
        capsuleId,
        title: typeof api.title === 'string' ? api.title : capsuleId,
        projectionView: props.projectionView,
        intentBuilders: props.intentBuilders,
        controlRegistry: props.controlRegistry,
        scheduler: props.scheduler,
        tileScheduler: props.tileScheduler,
        captureState: props.captureState,
        displayOnly: props.displayOnly,
        clipboard: props.clipboard,
        presentationInstance: instance,
        onSubmitIntent: callbacks.onSubmitIntent,
        onPresentationIntent: callbacks.onPresentationIntent,
        onActivateSurface: callbacks.onActivateSurface,
      }, {
        surface: (/** @type {unknown} */ slotProps) => (surfaceSlot ? surfaceSlot(slotProps) : []),
      });
    };
  },
}));

const SurfaceTab = defineComponent({
  name: 'SurfaceTab',
  props: { params: { type: Object, required: true } },
  setup(tabProps) {
    return () => {
      const tab = describeDockTab(tabProps.params);
      if (tab.id === null || tab.anchor === null) {
        return h('span', { class: 'mv-surface-tab' }, tab.title);
      }
      return h('span', { class: 'mv-surface-tab', id: tab.id, 'data-semantic-anchor': tab.anchor }, tab.title);
    };
  },
});
const tabComponents = markRaw({ SurfaceTab });

const CapsuleContentRouter=createCapsulePanelRouter({defineComponent,h,markRaw,graphical:WallSurfaceRouter,
 rows:()=>props.workloadTiles,validate:validWorkload,slot:workloadSlot});
const panelComponents = markRaw({
  CapsulePanel: CapsuleContentRouter,

});

/**
 * @param {unknown} capsuleId
 * @param {unknown} placement
 */
function revealSurface(capsuleId, placement) {
  return controller.revealSurface(capsuleId, placement);
}

/** @param {string} capsuleId @param {unknown} body */
function applyLayoutEcho(capsuleId, body) { return controller.applyLayoutEcho(capsuleId, body); }
function setPreset(/** @type {string|null} */ preset) { return controller.setPreset(preset); }
function resizeTile(/** @type {string} */ id, /** @type {string} */ action) { return controller.resizeTile(id,action); }
function resizeFocused(/** @type {string} */ action) { return controller.resizeFocused(action); }
/** Presentation only: used after an acknowledged capsule stop. @param {unknown} intent */
function applyPresentationIntent(intent) { return controller.applyPresentationIntent(intent); }
function hasSurfacePanel(/** @type {string} */ id) { return controller.hasSurfacePanel(id); }
const presetTimer = setInterval(() => { controller.refreshPreset(); },150);
presetTimer.unref?.();
defineExpose({ hasSurfacePanel, revealWorkload:(/** @type {string} */ id)=>controller.revealWorkload(id), revealSurface, applyLayoutEcho, setPreset, resizeTile, resizeFocused, applyPresentationIntent });

onBeforeUnmount(() => {
  releaseDrag();
  clearInterval(presetTimer);
  controller.dispose();
});
</script>
<template>
  <div ref="wallRoot" class="wall-workspace" data-testid="wall-workspace">
    <div class="wall-grid-controls" aria-label="Workspace snap grid">
      <label>Columns <select :id="`${ownerWindowId}-snap-columns`" :data-semantic-anchor="`workspace/${ownerWindowId}/snap-columns`" aria-label="Workspace snap columns" :value="snapGrid.cols" @change="changeGrid('cols',$event)"><option v-for="n in 5" :key="n" :value="n">{{n}}</option></select></label>
      <label>Rows <select :id="`${ownerWindowId}-snap-rows`" :data-semantic-anchor="`workspace/${ownerWindowId}/snap-rows`" aria-label="Workspace snap rows" :value="snapGrid.rows" @change="changeGrid('rows',$event)"><option v-for="n in 5" :key="n" :value="n">{{n}}</option></select></label>
      <span>Hold Control while dragging to snap</span>
    </div>
    <component :is="props.workspaceComponent"
      :scope="props.scope"
      :storage="props.storage"
      :default-profile="props.defaultProfile ?? undefined"
      :owner-window-id="props.ownerWindowId"
      :panel-components="panelComponents"
      :tab-components="tabComponents"
      default-tab-component="SurfaceTab"
      :color-scheme="props.colorScheme"
      :density="props.density"
      workspace-title="MetaViewer"
      :initial-viewport-width="viewportWidth"
      :initial-viewport-height="viewportHeight"
      @ready="onReady"
      @wall-settled="onWallSettled"
      @layout-saved="onLayoutSaved"
      @quarantine-detected="onQuarantineDetected"
      @popout-blocked="onPopoutBlocked"
      @active-panel-change="onActivePanelChange"
    />
  </div>
</template>
<style>
.wall-grid-controls { display:flex; gap:12px; align-items:center; padding:4px 8px; font-size:12px; }
.wall-grid-controls select { color:inherit; background:var(--mv-panel-bg,Canvas); }
.wall-workspace .dv-floating-titlebar { display:none; }
.wall-workspace .dv-floating-titlebar, .wall-workspace .dv-tabs-and-actions-container,
.wall-workspace .cuk-capsule-panel__header, .wall-workspace .mv-tile-rail,
.wall-workspace .mv-role-actions { user-select:none; }
.wall-snap-preview { position:absolute; pointer-events:none; z-index:9999; box-sizing:border-box; border:2px solid Highlight; background:color-mix(in srgb,Highlight 20%,transparent); }
.wall-workspace > .mv-dock-workspace { flex:1; height:0; min-height:0; }
.wall-workspace { display:flex; flex-direction:column;
  /* Contain Dockview sashes below sibling full-screen app panels. */
  position: relative;
  z-index: 0;
  height: 100%;
  min-height: 0;
  min-width: 0;
}
.wall-missing-panel,
.wall-missing-id {
  font: inherit;
  padding: 12px 16px;
}
.wall-missing-panel-title {
  font-weight: 600;
  margin: 0 0 4px;
}
.wall-missing-panel-reason {
  margin: 0;
}
</style>
