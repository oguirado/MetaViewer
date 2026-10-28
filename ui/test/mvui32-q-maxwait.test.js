import test from 'node:test';
import assert from 'node:assert/strict';
import { installQaAnchorReporter } from '../src/qa/anchorCollector.js';

// Minimal DOM double in the mvui13-qa-anchors style: labels are text nodes.
function dom() {
  const listeners = new Map();
  const observers = [];
  const document = {
    nodeType: 9,
    addEventListener(type, fn) { listeners.set(`document:${type}`, fn); },
    removeEventListener(type, fn) { listeners.delete(`document:${type}`); },
    getElementById(id) { return all().find(el => el.getAttribute('id') === id) ?? null; },
    querySelectorAll() { return all().filter(el => el.hasAttribute('data-semantic-anchor')); },
  };
  const all = () => {
    const out = [];
    const visit = el => { out.push(el); for (const child of el.childNodes) if (child.nodeType === 1) visit(child); };
    visit(document.documentElement);
    return out;
  };
  function element(tag = 'button', attrs = {}, text = '', parent = document.documentElement) {
    const node = {
      nodeType: 1, localName: tag, parentElement: parent ?? null, ownerDocument: document,
      childNodes: [], style: {}, box: { x: 10, y: 20, width: 80, height: 30 },
      getAttribute(name) { return attrs[name] ?? null; },
      hasAttribute(name) { return Object.hasOwn(attrs, name); },
      setAttribute(name, value) { attrs[name] = value; },
      matches(selector) {
        return selector.split(',').some(part => {
          if (part.startsWith('.')) return (attrs.class ?? '').split(' ').includes(part.slice(1));
          if (part.startsWith('[contenteditable]')) return Object.hasOwn(attrs, 'contenteditable') && attrs.contenteditable !== 'false';
          return tag === part;
        });
      },
      closest(selector) { for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el; return null; },
      querySelectorAll() { return all().filter(el => el !== this && el.hasAttribute('data-semantic-anchor') && isChild(el, this)); },
      getBoundingClientRect() { const b = this.box; return { ...b, left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height }; },
    };
    if (text) node.childNodes.push({ nodeType: 3, nodeValue: text });
    parent?.childNodes.push(node);
    return node;
  }
  function isChild(el, ancestor) { for (let p = el.parentElement; p; p = p.parentElement) if (p === ancestor) return true; return false; }
  document.documentElement = element('html', {}, '', null);
  const window = {
    innerWidth: 1000, innerHeight: 800,
    getComputedStyle(el) { return { display: 'block', visibility: 'visible', opacity: '1', ...el.style }; },
    addEventListener(type, fn) { listeners.set(`window:${type}`, fn); },
    removeEventListener(type, fn) { listeners.delete(`window:${type}`); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
  };
  return { document, window, element, listeners, observers };
}

function clock() {
  let now = 0;
  let next = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++next; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pending,
    tick(ms) {
      const end = now + ms;
      for (let steps = 0; steps < 10000; steps++) {
        const job = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
        if (!job || job[1].at > end) { now = end; return; }
        pending.delete(job[0]); now = job[1].at; job[1].fn();
      }
      throw new Error('unbounded timer loop');
    },
  };
}

const anchor = value => ({ 'data-semantic-anchor': value });

test('max-wait ceiling reports under 100 ms churn within 1000 ms of each change', { timeout: 10000 }, () => {
  const d = dom();
  const gen = d.element('button', anchor('gen'), 'gen-0');
  const status = d.element('button', anchor('status'), 'idle');
  status.box = { x: 10, y: 100, width: 80, height: 30 };
  const scheduler = clock();
  const reports = [];
  const dispose = installQaAnchorReporter({
    window: d.window, document: d.document, scheduler,
    facade: { reportAnchors(snapshot) { reports.push({ at: scheduler.now(), snapshot }); } },
  });
  const fire = () => d.observers[0].callback();
  let relabelled = false;
  for (let step = 0; step < 100; step++) {
    if (!relabelled && scheduler.now() >= 1000) { status.childNodes[0].nodeValue = 'ready'; relabelled = true; }
    gen.childNodes[0].nodeValue = `gen-${step}`;
    fire();
    scheduler.tick(100);
  }
  try {
    assert.ok(relabelled, 'label change never applied');
    assert.ok(reports.length > 0, 'starved: zero reports under churn');
    assert.ok(reports[0].at <= 1000, `initial report late: ${reports[0].at}`);
    assert.deepEqual(reports[0].snapshot.rows.map(row => row.anchor).sort(), ['gen', 'status']);
    const updated = reports.find(r => r.snapshot.rows.some(row => row.anchor === 'status' && row.name === 'ready'));
    assert.ok(updated, 'updated label never reported');
    assert.ok(updated.at <= 2000, `updated label late: ${updated.at}`);
    assert.ok(reports.length >= 5, `churn starved mid-burst: ${reports.length} reports`);
    assert.ok(reports.at(-1).at >= 9000, `burst tail starved: last at ${reports.at(-1).at}`);
    reports.forEach((r, i) => {
      if (i > 0) assert.ok(r.at - reports[i - 1].at >= 500, `spacing violated: ${reports[i - 1].at} -> ${r.at}`);
    });
    assert.ok(!JSON.stringify(reports).includes('SECRET'));
  } finally {
    dispose();
  }
});

test('unchanged snapshots are not re-emitted as duplicates', { timeout: 10000 }, () => {
  const d = dom();
  const el = d.element('button', anchor('control'), 'Control');
  const scheduler = clock();
  const reports = [];
  const dispose = installQaAnchorReporter({
    window: d.window, document: d.document, scheduler,
    facade: { reportAnchors(snapshot) { reports.push({ at: scheduler.now(), snapshot }); } },
  });
  try {
    const fire = () => d.observers[0].callback();
    scheduler.tick(250);
    assert.equal(reports.length, 1);
    fire(); scheduler.tick(500);
    assert.equal(reports.length, 1);
    fire(); fire(); scheduler.tick(1000);
    assert.equal(reports.length, 1);
    el.box.x++;
    fire(); scheduler.tick(250);
    assert.equal(reports.length, 2);
  } finally {
    dispose();
  }
});

test('reported snapshots never carry private payload text', { timeout: 10000 }, () => {
  const d = dom();
  const control = d.element('button', anchor('safe'), 'Safe ');
  d.element('canvas', {}, 'SECRET CANVAS', control);
  d.element('div', { class: 'xterm' }, 'SECRET TERMINAL', control);
  d.element('input', { ...anchor('typed'), type: 'text', value: 'SECRET VALUE' });
  const scheduler = clock();
  const reports = [];
  const dispose = installQaAnchorReporter({
    window: d.window, document: d.document, scheduler,
    facade: { reportAnchors(snapshot) { reports.push(snapshot); } },
  });
  try {
    scheduler.tick(250);
    assert.equal(reports.length, 1);
    assert.ok(!JSON.stringify(reports).includes('SECRET'));
  } finally {
    dispose();
  }
});

test('dispose clears the pending timer and emits zero reports after disposal', { timeout: 10000 }, () => {
  const d = dom();
  const el = d.element('button', anchor('control'), 'Control');
  const scheduler = clock();
  const reports = [];
  const dispose = installQaAnchorReporter({
    window: d.window, document: d.document, scheduler,
    facade: { reportAnchors(snapshot) { reports.push(snapshot); } },
  });
  scheduler.tick(250);
  assert.equal(reports.length, 1);
  el.box.x++;
  d.observers[0].callback();
  assert.equal(scheduler.pending.size, 1);
  dispose(); dispose();
  assert.equal(scheduler.pending.size, 0);
  d.observers[0].callback();
  scheduler.tick(2000);
  assert.equal(reports.length, 1);
  assert.equal(scheduler.pending.size, 0);
});

test('trailing debounce still delays a lone mutation by 250 ms', { timeout: 10000 }, () => {
  const d = dom();
  const el = d.element('button', anchor('control'), 'Control');
  const scheduler = clock();
  const reports = [];
  const dispose = installQaAnchorReporter({
    window: d.window, document: d.document, scheduler,
    facade: { reportAnchors(snapshot) { reports.push({ at: scheduler.now(), snapshot }); } },
  });
  try {
    scheduler.tick(250);
    assert.deepEqual(reports.map(r => r.at), [250]);
    scheduler.tick(500);
    el.box.x++;
    d.observers[0].callback();
    scheduler.tick(249);
    assert.equal(reports.length, 1);
    scheduler.tick(1);
    assert.deepEqual(reports.map(r => r.at), [250, 1000]);
  } finally {
    dispose();
  }
});
