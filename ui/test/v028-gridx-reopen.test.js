import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dockviewPkg from '../node_modules/dockview-core/dist/dockview-core.js';
import { createWindowPresentation } from '../.kit/capsule-ui-kit/src/workspace/windowPresentation.js';

const { createDockview, registerModules, FloatingGroupModule } = dockviewPkg;
registerModules([FloatingGroupModule]);

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...tokens) { for (const t of tokens) if (t) this.set.add(t); }
  remove(...tokens) { for (const t of tokens) this.set.delete(t); }
  toggle(token, force) {
    if (force === true) { this.set.add(token); return true; }
    if (force === false) { this.set.delete(token); return false; }
    if (this.set.has(token)) { this.set.delete(token); return false; }
    this.set.add(token); return true;
  }
  contains(token) { return this.set.has(token); }
}

class FakeElement {
  constructor(tagName = 'div', ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.children.item = (i) => this.children[i] ?? null;
    this.parentElement = null;
    this.parentNode = null;
    this.style = {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
      getPropertyValue(k) { return this[k] || ''; },
    };
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.clientWidth = 1200;
    this.clientHeight = 600;
    this.offsetWidth = 1200;
    this.offsetHeight = 600;
  }
  getRootNode() { return this.ownerDocument || this; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx >= 0 ? (this.parentElement.children[idx + 1] ?? null) : null;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx > 0 ? (this.parentElement.children[idx - 1] ?? null) : null;
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  appendChild(child) {
    if (!child) return child;
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) { for (const n of nodes) if (typeof n === 'object' && n) this.appendChild(n); }
  prepend(...nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (typeof n === 'object' && n) this.insertBefore(n, this.children[0] || null);
    }
  }
  replaceChildren(...nodes) { this.children.length = 0; this.append(...nodes); }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) { this.children.splice(idx, 1); child.parentElement = null; child.parentNode = null; }
    return child;
  }
  insertBefore(child, ref) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    child.parentNode = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx >= 0) this.children.splice(idx, 0, child);
    else this.children.push(child);
    return child;
  }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  contains(node) {
    let cur = node;
    while (cur) { if (cur === this) return true; cur = cur.parentElement; }
    return false;
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  setAttributeNS(_ns, k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent() { return true; }
  getBoundingClientRect() {
    const parsePx = (v, fallback) => (typeof v === 'string' && v.endsWith('px') ? Number.parseFloat(v) : fallback);
    const left = parsePx(this.style.left, 0);
    const top = parsePx(this.style.top, 0);
    const width = parsePx(this.style.width, this.clientWidth || 0);
    const height = parsePx(this.style.height, this.clientHeight || 0);
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
}

function installDomShim() {
  const doc = new FakeElement('#document', null);
  doc.createElement = (tag) => new FakeElement(tag, doc);
  doc.createElementNS = (_ns, tag) => new FakeElement(tag, doc);
  doc.createTextNode = (text) => ({ nodeValue: text, parentElement: null, remove() {} });
  doc.body = new FakeElement('body', doc);
  doc.head = new FakeElement('head', doc);
  doc.documentElement = new FakeElement('html', doc);
  doc.defaultView = globalThis;
  doc.activeElement = doc.body;
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.HTMLElement = FakeElement;
  globalThis.Element = FakeElement;
  globalThis.Node = FakeElement;
  globalThis.Document = FakeElement;
  globalThis.ShadowRoot = FakeElement;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (cb) => { cb(0); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  return doc;
}

installDomShim();

const source = readFileSync(new URL('../src/wall/WallWorkspace.vue', import.meta.url), 'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const wall = await import(
  `data:text/javascript;base64,${Buffer.from(
    script.replace(/import .* from 'vue';/, 'const defineComponent = value => value; const h = () => {};'),
  ).toString('base64')}`
);

function createRealDockviewSession({ cols, rows: gridRows, preset = 'floating', initialCells = {}, initialRows = [] }) {
  const doc = installDomShim();
  const hostEl = doc.createElement('div');
  doc.body.appendChild(hostEl);
  const api = createDockview(hostEl, {
    createComponent: () => ({ element: doc.createElement('div'), init() {}, update() {}, dispose() {} }),
  });
  api.layout(1200, 600);
  const windows = createWindowPresentation(api);
  const rows = [...initialRows];
  const savedCells = JSON.parse(JSON.stringify(initialCells));
  const grid = { cols, rows: gridRows };

  const syncSavedCellsFromLayout = () => {
    const layout = api.toJSON();
    for (const group of layout.floatingGroups ?? []) {
      const p = group.position;
      if (!p || !(p.width > 0) || !(p.height > 0)) continue;
      const col = Math.min(grid.cols - 1, Math.max(0, Math.floor(((p.left ?? 0) + p.width / 2) * grid.cols / api.width)));
      const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(((p.top ?? 0) + p.height / 2) * grid.rows / api.height)));
      for (const panelId of group.data?.views ?? []) {
        const surfaceId = String(panelId).replace(/^panel-/, '');
        const r = rows.find((item) => item.id === surfaceId);
        if (r?.profile_id) savedCells[r.profile_id] = { col, row };
      }
    }
  };

  const controller = wall.createWallWorkspaceController({
    floatingGrid: () => grid,
    savedCells: () => savedCells,
    projectionView: {
      getProjection: () => ({ rows }),
      getSnapshot: () => ({ status: 'live', stale: false, envelope: {} }),
    },
    host: {
      completeUserGesture: () => {
        syncSavedCellsFromLayout();
      },
    },
  });
  assert.equal(controller.handleReady({ api, windows, host: { completeUserGesture: syncSavedCellsFromLayout } }).ok, true);
  if (preset !== null) {
    assert.equal(controller.setPreset(preset).ok, true);
  }

  const open = (id, profileId, title = profileId) => {
    rows.push({ id, surfaceId: id, profile_id: profileId, title, backendLifecycle: 'active', visibility: 'unfolded', control: 'human', generation: 1 });
    assert.deepEqual(controller.revealSurface(id, 'split'), { ok: true, value: { panelId: `panel-${id}` } });
    controller.refreshPreset();
    syncSavedCellsFromLayout();
    return getFloatingEntry(id);
  };

  const snapToCell = (id, col, row) => {
    const panelId = `panel-${id}`;
    const panel = api.getPanel(panelId);
    assert.ok(panel, `panel ${panelId} must exist`);
    const rect = wall.floatDragBounds(
      { x: 0, y: 0, width: 300, height: 200 },
      { x: 0, y: 0 },
      { x: (col + 0.5) * (api.width / grid.cols), y: (row + 0.5) * (api.height / grid.rows), ctrlKey: true },
      api.width,
      api.height,
      grid,
    );
    controller.beginFloatingDrag();
    panel.group.api?.setConstraints?.({ minimumWidth: Math.min(240, rect.width), minimumHeight: Math.min(200, rect.height) });
    panel.api?.setConstraints?.({ minimumWidth: Math.min(240, rect.width), minimumHeight: Math.min(200, rect.height) });
    if (panel.group.api?.location?.type !== 'floating') {
      api.addFloatingGroup(panel, { position: { left: rect.x, top: rect.y }, width: rect.width, height: rect.height, disableSmartGuides: true });
    }
    api.addFloatingGroup(panel.group, { position: { left: rect.x, top: rect.y }, width: rect.width, height: rect.height, disableSmartGuides: true });
    wall.retainFloatingHome(api);
    syncSavedCellsFromLayout();
    controller.refreshPreset();
    return getFloatingEntry(id);
  };

  const close = (id) => {
    assert.equal(controller.applyPresentationIntent({ type: 'close', capsuleId: id }).ok, true);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx >= 0) rows.splice(idx, 1);
    controller.refreshPreset();
    syncSavedCellsFromLayout();
  };

  const getFloatingEntry = (id) => {
    const panelId = `panel-${id}`;
    const fg = (api.toJSON().floatingGroups ?? []).find((g) => g.data?.views?.includes(panelId));
    return fg ? { groupId: fg.data.id, views: [...fg.data.views], position: { ...fg.position } } : null;
  };

  return { api, windows, controller, rows, savedCells, open, snapToCell, close, getFloatingEntry, syncSavedCellsFromLayout };
}

test('GRIDX real Dockview: reopened capsule returns to its remembered cell as its own group across 3 cycles at 2x2 and 3x2 without disturbing host group', () => {
  for (const [cols, gridRows, hostCell, browserCell, expectedHostPos, expectedBrowserPos] of [
    [2, 2, { col: 1, row: 0 }, { col: 1, row: 1 }, { left: 600, top: 0, width: 600, height: 300 }, { left: 600, top: 300, width: 600, height: 300 }],
    [3, 2, { col: 1, row: 0 }, { col: 2, row: 1 }, { left: 400, top: 0, width: 400, height: 300 }, { left: 800, top: 300, width: 400, height: 300 }],
  ]) {
    // Case A: Floating preset with Control snap
    const session = createRealDockviewSession({ cols, rows: gridRows, preset: 'floating' });
    session.open('browser-0', 'judge', 'Judge Browser');
    session.open('gedit-0', 'gedit', 'Host gedit');
    session.snapToCell('gedit-0', hostCell.col, hostCell.row);
    session.snapToCell('browser-0', browserCell.col, browserCell.row);

    const hostBefore = session.getFloatingEntry('gedit-0');
    assert.deepEqual(hostBefore.views, ['panel-gedit-0']);
    assert.deepEqual(hostBefore.position, expectedHostPos);
    assert.deepEqual(session.getFloatingEntry('browser-0').position, expectedBrowserPos);

    let prevBrowserId = 'browser-0';
    for (let cycle = 1; cycle <= 3; cycle++) {
      session.close(prevBrowserId);
      assert.deepEqual(session.getFloatingEntry('gedit-0').views, ['panel-gedit-0']);
      assert.deepEqual(session.getFloatingEntry('gedit-0').position, expectedHostPos);
      assert.deepEqual(session.savedCells.judge, browserCell);

      const nextBrowserId = `browser-${cycle}`;
      const reopened = session.open(nextBrowserId, 'judge', 'Judge Browser');
      assert.ok(reopened, `cycle ${cycle} (${cols}x${gridRows}): reopened browser must be in a floating group`);
      assert.deepEqual(reopened.views, [`panel-${nextBrowserId}`], `cycle ${cycle} (${cols}x${gridRows}): reopened browser must be its own group, never a tab beside gedit`);
      assert.deepEqual(reopened.position, expectedBrowserPos, `cycle ${cycle} (${cols}x${gridRows}): reopened browser must return to its remembered cell`);

      const hostAfter = session.getFloatingEntry('gedit-0');
      assert.deepEqual(hostAfter.views, ['panel-gedit-0'], `cycle ${cycle} (${cols}x${gridRows}): host group views must not be disturbed`);
      assert.deepEqual(hostAfter.position, expectedHostPos, `cycle ${cycle} (${cols}x${gridRows}): host group geometry must not be disturbed`);
      assert.notEqual(reopened.groupId, hostAfter.groupId);
      prevBrowserId = nextBrowserId;
    }

    // Restart with savedCells preserved and live host group reopened first
    const persistedCells = JSON.parse(JSON.stringify(session.savedCells));
    session.controller.dispose();
    session.api.dispose();

    const restarted = createRealDockviewSession({ cols, rows: gridRows, preset: 'floating', initialCells: persistedCells });
    const hostRestarted = restarted.open('gedit-restart', 'gedit', 'Host gedit');
    assert.deepEqual(hostRestarted.views, ['panel-gedit-restart']);
    assert.deepEqual(hostRestarted.position, expectedHostPos);

    const browserRestarted = restarted.open('browser-restart', 'judge', 'Judge Browser');
    assert.deepEqual(browserRestarted.views, ['panel-browser-restart']);
    assert.deepEqual(browserRestarted.position, expectedBrowserPos);
    assert.deepEqual(restarted.getFloatingEntry('gedit-restart').position, expectedHostPos);
    restarted.controller.dispose();
    restarted.api.dispose();
  }
});

test('GRIDX real Dockview: custom layout after Control snap from a grid preset reopens in remembered cell as its own group across 3 cycles and when cell is occupied uses next free cell', () => {
  const session = createRealDockviewSession({ cols: 3, rows: 2, preset: 'grid-3x2' });
  session.open('browser-0', 'judge', 'Judge Browser');
  session.open('gedit-0', 'gedit', 'Host gedit');
  // Control-snap both from grid-3x2 -> preset becomes null (custom layout)
  session.snapToCell('gedit-0', 1, 0);
  session.snapToCell('browser-0', 2, 1);

  let prevBrowserId = 'browser-0';
  for (let cycle = 1; cycle <= 3; cycle++) {
    session.close(prevBrowserId);
    const nextBrowserId = `browser-${cycle}`;
    const reopened = session.open(nextBrowserId, 'judge', 'Judge Browser');
    assert.ok(reopened, `custom cycle ${cycle}: reopened browser must be floating`);
    assert.deepEqual(reopened.views, [`panel-${nextBrowserId}`]);
    assert.deepEqual(reopened.position, { left: 800, top: 300, width: 400, height: 300 });
    assert.deepEqual(session.getFloatingEntry('gedit-0').views, ['panel-gedit-0']);
    assert.deepEqual(session.getFloatingEntry('gedit-0').position, { left: 400, top: 0, width: 400, height: 300 });
    prevBrowserId = nextBrowserId;
  }

  // Now close browser, move gedit into browser's remembered cell (2, 1), and reopen browser:
  // browser must take the next free cell (0, 0), never become a tab beside gedit or move gedit.
  session.close(prevBrowserId);
  session.snapToCell('gedit-0', 2, 1);
  session.savedCells.judge = { col: 2, row: 1 };

  const displaced = session.open('browser-displaced', 'judge', 'Judge Browser');
  assert.ok(displaced);
  assert.deepEqual(displaced.views, ['panel-browser-displaced']);
  assert.deepEqual(displaced.position, { left: 0, top: 0, width: 400, height: 300 });
  assert.deepEqual(session.getFloatingEntry('gedit-0').views, ['panel-gedit-0']);
  assert.deepEqual(session.getFloatingEntry('gedit-0').position, { left: 800, top: 300, width: 400, height: 300 });

  session.controller.dispose();
  session.api.dispose();
});

test('GRIDX real Dockview: Floating preset occupied remembered cell falls back to next free cell and 6-capsule 3x2 wall reopens in place without disturbing peers', () => {
  // Occupied cell in Floating preset + panelOrder[0] reopened while panelOrder[1] occupies (0,0)
  const session = createRealDockviewSession({ cols: 2, rows: 2, preset: 'floating' });
  session.open('browser-0', 'judge', 'Judge Browser');
  session.open('gedit-0', 'gedit', 'Host gedit');
  session.snapToCell('browser-0', 0, 0);
  session.snapToCell('gedit-0', 1, 0);

  // Stop browser-0, move gedit-0 into (0, 0), and reopen browser with hint still (0, 0)
  session.close('browser-0');
  session.snapToCell('gedit-0', 0, 0);
  session.savedCells.judge = { col: 0, row: 0 };

  const reopened = session.open('browser-1', 'judge', 'Judge Browser');
  assert.deepEqual(reopened.views, ['panel-browser-1']);
  assert.deepEqual(reopened.position, { left: 600, top: 0, width: 600, height: 300 });
  assert.deepEqual(session.getFloatingEntry('gedit-0').views, ['panel-gedit-0']);
  assert.deepEqual(session.getFloatingEntry('gedit-0').position, { left: 0, top: 0, width: 600, height: 300 });

  // Also verify un-hinted panelOrder[0] reopen does not collide with settled panelOrder[1] at (0, 0)
  session.close('browser-1');
  delete session.savedCells.judge;
  const reopenedUnhinted = session.open('browser-2', 'judge', 'Judge Browser');
  assert.deepEqual(reopenedUnhinted.views, ['panel-browser-2']);
  assert.deepEqual(reopenedUnhinted.position, { left: 600, top: 0, width: 600, height: 300 });
  assert.deepEqual(session.getFloatingEntry('gedit-0').position, { left: 0, top: 0, width: 600, height: 300 });
  session.controller.dispose();
  session.api.dispose();

  // 6-capsule 3x2 wall stop/reopen
  const wall6 = createRealDockviewSession({ cols: 3, rows: 2, preset: 'floating' });
  for (let i = 0; i < 6; i++) {
    const entry = wall6.open(`cap-${i}`, `profile-${i}`, `Capsule ${i}`);
    assert.deepEqual(entry.views, [`panel-cap-${i}`]);
    assert.deepEqual(entry.position, { left: (i % 3) * 400, top: Math.floor(i / 3) * 300, width: 400, height: 300 });
  }
  wall6.close('cap-2');
  const reopenedCap2 = wall6.open('cap-2-reopened', 'profile-2', 'Capsule 2');
  assert.deepEqual(reopenedCap2.views, ['panel-cap-2-reopened']);
  assert.deepEqual(reopenedCap2.position, { left: 800, top: 0, width: 400, height: 300 });
  for (const i of [0, 1, 3, 4, 5]) {
    assert.deepEqual(wall6.getFloatingEntry(`cap-${i}`).views, [`panel-cap-${i}`]);
    assert.deepEqual(wall6.getFloatingEntry(`cap-${i}`).position, { left: (i % 3) * 400, top: Math.floor(i / 3) * 300, width: 400, height: 300 });
  }
  wall6.controller.dispose();
  wall6.api.dispose();
});

