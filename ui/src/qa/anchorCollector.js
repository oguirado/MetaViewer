/** @typedef {{anchor:string, role:string, name:string, rect:{x:number,y:number,w:number,h:number}}} AnchorRow */
/** @typedef {{schema:'qa_anchors/v1', seq:number, rows:AnchorRow[]}} AnchorSnapshot */
/** @typedef {Pick<Window, 'innerWidth'|'innerHeight'|'getComputedStyle'>} CollectorWindow */
/** @typedef {{reportAnchors:(snapshot:AnchorSnapshot)=>unknown}} QaFacade */
/** @typedef {{now:()=>number, setTimeout:(callback:()=>void, delay:number)=>number, clearTimeout:(id:number)=>void}} Scheduler */
/** @typedef {CollectorWindow & Pick<Window, 'addEventListener'|'removeEventListener'|'setTimeout'|'clearTimeout'|'performance'> & {MutationObserver:typeof MutationObserver, ResizeObserver?:typeof ResizeObserver}} ReporterWindow */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Hierarchical anchor grammar v2: 1..6 segments joined by '/', each an
 * alnum-led token of at most 64 chars, 200 chars total, no empty/'.'/'..'
 * segment and no leading or trailing '/'.
 * @param {string} anchor @returns {boolean}
 */
function isAnchor(anchor) {
  if (typeof anchor !== 'string' || anchor.length === 0 || anchor.length > 200) return false;
  const segments = anchor.split('/');
  if (segments.length > 6) return false;
  return segments.every(segment => segment !== '.' && segment !== '..' && SEGMENT.test(segment));
}
const INTERACTIVE = new Set(['button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'treeitem']);
// Do not descend into application payloads, even when referenced by aria-labelledby.
const PRIVATE = 'canvas,iframe,object,embed,script,style,.xterm,.mv-terminal,.mv-terminal-host,.mv-surface__canvas,.mv-surface-host,.mv-creative__frames,[contenteditable]:not([contenteditable="false"])';
const VALUE_CONTROL = 'input,textarea,select';

/** @param {Element} element @param {CollectorWindow} window */
function visible(element, window) {
  for (let node = element; node; node = /** @type {Element} */ (node.parentElement)) {
    if (node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || style.opacity === '0') return false;
  }
  return true;
}

/** Read label text without ever accessing form values or private subtree textContent.
 * @param {Node} node @param {CollectorWindow} window @param {boolean} [referenced=false] @returns {string}
 */
function labelText(node, window, referenced = false) {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType !== 1) return '';
  const element = /** @type {Element} */ (node);
  if (element.closest(PRIVATE) || element.matches(VALUE_CONTROL) || (!referenced && !visible(element, window))) return '';
  return Array.from(element.childNodes, child => labelText(child, window, referenced)).join('');
}

/** @param {Element} element @returns {string} */
function roleOf(element) {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit.trim().split(/\s+/).find(role => INTERACTIVE.has(role)) ?? '';
  switch (element.localName) {
    case 'button': case 'summary': return 'button';
    case 'a': case 'area': return element.hasAttribute('href') ? 'link' : '';
    case 'textarea': return 'textbox';
    case 'select': return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
    case 'option': return 'option';
    case 'input': {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image', 'file', 'color'].includes(type)) return 'button';
      if (type === 'hidden') return '';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return type === 'search' ? 'searchbox' : 'textbox';
    }
    default: return '';
  }
}

/** Normalize labels and truncate only at code point boundaries within the wire's UTF-16 limit.
 * @param {string} text
 */
function boundedName(text) {
  let name = '';
  for (let point of text.trim().replace(/\s+/g, ' ')) {
    if (point.length === 1 && point >= '\uD800' && point <= '\uDFFF') point = '\uFFFD';
    if (name.length + point.length > 128) break;
    name += point;
  }
  return name;
}

/** @param {Element} element @param {CollectorWindow} window */
function accessibleName(element, window) {
  const refs = element.getAttribute('aria-labelledby')?.trim().split(/\s+/) ?? [];
  const referenced = refs.map(id => element.ownerDocument.getElementById(id))
    .filter(node => node && !node.closest(PRIVATE))
    .map(node => labelText(/** @type {Element} */ (node), window, true)).join(' ').trim();
  if (referenced) return boundedName(referenced);
  const aria = element.getAttribute('aria-label');
  if (aria?.trim()) return boundedName(aria);
  if (element.localName === 'option') return boundedName(element.getAttribute('label') ?? labelText(element, window));
  const labels = /** @type {HTMLInputElement} */ (element).labels;
  const text = labels?.length ? Array.from(labels, label => labelText(label, window)).join(' ') : '';
  if (text.trim()) return boundedName(text);
  if (element.localName === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    // Action values are static labels. Never read the live value property.
    if (['button', 'submit', 'reset'].includes(type)) return boundedName(element.getAttribute('value') ?? '');
    if (type === 'image') return boundedName(element.getAttribute('alt') ?? '');
  }
  return boundedName(labelText(element, window));
}

/** Collect a closed, bounded snapshot without installing observers or changing the DOM.
 * @param {Document|Element} root @param {CollectorWindow} window @param {number} [seq=1]
 * @returns {AnchorSnapshot}
 */
export function collectQaAnchors(root, window, seq = 1) {
  /** @type {AnchorRow[]} */
  const rows = [];
  const elements = Array.from(root.querySelectorAll('[data-semantic-anchor]'));
  if (root.nodeType === 1 && /** @type {Element} */ (root).hasAttribute('data-semantic-anchor')) elements.unshift(/** @type {Element} */ (root));
  for (const element of elements) {
    const anchor = element.getAttribute('data-semantic-anchor') ?? '';
    const role = roleOf(element);
    const valueAncestor = element.parentElement?.closest(VALUE_CONTROL);
    const optionInSelect = element.localName === 'option' && valueAncestor?.localName === 'select';
    if (!isAnchor(anchor) || !role || element.closest(PRIVATE) || (valueAncestor && !optionInSelect) || !visible(element, window)) continue;
    const box = element.getBoundingClientRect();
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0 || box.right <= 0 || box.bottom <= 0 || box.left >= window.innerWidth || box.top >= window.innerHeight) continue;
    const rect = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
    if (rect.w <= 0 || rect.h <= 0) continue;
    rows.push({ anchor, role, name: accessibleName(element, window), rect });
  }
  rows.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0));
  rows.length = Math.min(rows.length, 512);
  /** @type {AnchorSnapshot} */
  const snapshot = { schema: 'qa_anchors/v1', seq, rows };
  const encoder = new TextEncoder();
  const rowBytes = rows.map(row => encoder.encode(JSON.stringify(row)).byteLength);
  let bytes = encoder.encode(JSON.stringify({ ...snapshot, rows: [] })).byteLength
    + rowBytes.reduce((sum, size) => sum + size, 0) + Math.max(0, rows.length - 1);
  while (bytes > 64 * 1024 && rows.length) {
    bytes -= rowBytes[rows.length - 1] + (rows.length > 1 ? 1 : 0);
    rows.pop();
  }
  return snapshot;
}

/** Opt-in only: a missing facade returns before touching window, document or scheduler.
 * @param {{window:ReporterWindow, document:Document, facade?:QaFacade|null, scheduler?:Scheduler}} options
 * @returns {()=>void}
 */
export function installQaAnchorReporter({ window, document, facade, scheduler }) {
  if (typeof facade?.reportAnchors !== 'function') return () => {};
  const clock = scheduler ?? { now: () => window.performance.now(), setTimeout: (/** @type {()=>void} */ fn, /** @type {number} */ ms) => window.setTimeout(fn, ms), clearTimeout: (/** @type {number} */ id) => window.clearTimeout(id) };
  let disposed = false;
  let seq = 0;
  let lastReport = -Infinity;
  let lastRows = '';
  // Injected-clock time of the first settle in the current unreported burst,
  // or null when idle. Pins the maximum-wait deadline; see settle/report.
  /** @type {number|null} */
  let firstPendingAt = null;
  /** @type {number|undefined} */
  let timer;
  const settle = () => {
    if (disposed) return;
    if (timer !== undefined) clock.clearTimeout(timer);
    const now = clock.now();
    // Pin the deadline to the FIRST settle of the burst: later settles may
    // reschedule the timer but must never move the deadline, else continuous
    // churn postpones reporting indefinitely.
    if (firstPendingAt === null) firstPendingAt = now;
    const spacing = Math.max(250, lastReport + 500 - now);
    const ceiling = Math.max(0, firstPendingAt + 1000 - now);
    timer = clock.setTimeout(report, Math.min(spacing, ceiling));
  };
  const report = () => {
    timer = undefined;
    if (disposed) return;
    // The ceiling may fire before minimum spacing elapsed when the clock
    // jumps; defer to the spacing bound without dropping the pending burst.
    if (clock.now() < lastReport + 500) {
      timer = clock.setTimeout(report, lastReport + 500 - clock.now());
      return;
    }
    const snapshot = collectQaAnchors(document, window, seq + 1);
    const rows = JSON.stringify(snapshot.rows);
    if (rows === lastRows) { firstPendingAt = null; return; }
    lastRows = rows;
    lastReport = clock.now();
    firstPendingAt = null;
    seq += 1;
    // QA transport errors must not disturb the renderer or leave a rejected promise.
    try { Promise.resolve(facade.reportAnchors(snapshot)).catch(() => {}); } catch { /* Host may be closing. */ }
  };
  const mutations = new window.MutationObserver(settle);
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const resize = window.ResizeObserver ? new window.ResizeObserver(settle) : null;
  resize?.observe(document.documentElement);
  window.addEventListener('resize', settle);
  window.addEventListener('scroll', settle, true);
  // Transition/animation completion may move controls without a DOM mutation.
  document.addEventListener('transitionend', settle, true);
  document.addEventListener('animationend', settle, true);
  settle();
  return () => {
    if (disposed) return;
    disposed = true;
    firstPendingAt = null;
    if (timer !== undefined) clock.clearTimeout(timer);
    mutations.disconnect();
    resize?.disconnect();
    window.removeEventListener('resize', settle);
    window.removeEventListener('scroll', settle, true);
    document.removeEventListener('transitionend', settle, true);
    document.removeEventListener('animationend', settle, true);
  };
}
