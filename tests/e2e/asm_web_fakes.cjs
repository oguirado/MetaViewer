'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PAGES_DIR = path.join(__dirname, 'asm_web_pages');
const AGENTS_ROOT = path.join(REPO_ROOT, 'agents');

const VIEWPORT_WIDTH = 640;
const VIEWPORT_HEIGHT = 360;
const DEFAULT_CAPSULE_ID = 'capsule-web-1';
const DEFAULT_SURFACE_ID = 'surface-web-1';
const DEFAULT_IDENTITY = 'mv-web-hosted-1';

// [TARGET, unit decision] Task step budgets from asm_web acceptance table.
const STEP_BUDGETS = Object.freeze({
  T1_FORM_FILL: 8,
  T2_TWO_PAGE_FLOW: 12,
  T3_READ_TABLE: 0,
});

const PAGE_FILES = Object.freeze({
  form: 'form.html',
  flow_a: 'flow_a.html',
  flow_b: 'flow_b.html',
  table: 'table.html',
});

function sha256Hex(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function parseBboxAttr(raw) {
  const parts = String(raw || '')
    .split(',')
    .map((v) => Number.parseInt(v.trim(), 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`invalid data-bbox attribute: ${raw}`);
  }
  const [x, y, w, h] = parts;
  return { x, y, w, h };
}

function extractAttributes(tagSource) {
  const attrs = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = attrRe.exec(tagSource)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateDeterministicPageSource(fileName, html) {
  if (fileName !== fileName.toLowerCase()) {
    throw new Error(`page filename must be lowercase: ${fileName}`);
  }
  if (!html.includes('http-equiv="Content-Security-Policy"')) {
    throw new Error(`missing Content-Security-Policy meta tag in ${fileName}`);
  }
  if (!html.includes("default-src 'none'")) {
    throw new Error(`CSP must lock default-src 'none' in ${fileName}`);
  }
  const forbiddenPatterns = [
    { re: /\bMath\.random\b/, reason: 'Math.random is forbidden' },
    { re: /\bDate\s*\(|\bnew\s+Date\b|\bDate\.now\b/, reason: 'Date API is forbidden' },
    { re: /\bperformance\.now\b/, reason: 'performance.now is forbidden' },
    { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, reason: 'network APIs are forbidden' },
    { re: /https?:\/\//i, reason: 'external URLs are forbidden' },
  ];
  for (const item of forbiddenPatterns) {
    if (item.re.test(html)) {
      throw new Error(`${fileName}: ${item.reason}`);
    }
  }
  return true;
}

function loadPageSpec(pageKey) {
  const fileName = PAGE_FILES[pageKey] || pageKey;
  const filePath = path.join(PAGES_DIR, fileName);
  const html = fs.readFileSync(filePath, 'utf8');
  validateDeterministicPageSource(fileName, html);

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  const elements = [];
  const tagRe = /<(input|button|output|a|p|th|td)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?>/g;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[1] || match[4];
    const attrStr = match[2] || match[5] || '';
    const inner = match[3] || '';
    const attrs = extractAttributes(attrStr);
    if (!attrs.id || !attrs['data-bbox']) {
      continue;
    }
    const bbox = parseBboxAttr(attrs['data-bbox']);
    const text = stripTags(inner);
    elements.push({
      id: attrs.id,
      tag,
      role: attrs['data-role'] || (tag === 'th' ? 'columnheader' : tag === 'td' ? 'cell' : tag),
      name: attrs['aria-label'] || text || attrs.id,
      text,
      value: attrs.value || '',
      tabindex: attrs.tabindex ? Number.parseInt(attrs.tabindex, 10) : null,
      targetPage: attrs['data-target-page'] || null,
      row: attrs['data-row'] !== undefined ? Number.parseInt(attrs['data-row'], 10) : null,
      col: attrs['data-col'] !== undefined ? Number.parseInt(attrs['data-col'], 10) : null,
      bbox,
    });
  }

  return {
    pageKey: fileName.replace(/\.html$/, ''),
    fileName,
    filePath,
    html,
    dataUrl,
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    elements,
  };
}

function renderDeterministicRgb24(width, height, pageState) {
  const buf = Buffer.alloc(width * height * 3, 0x10);
  const seedHex = sha256Hex(JSON.stringify({
    pageKey: pageState.pageKey,
    inputValue: pageState.inputValue,
    resultText: pageState.resultText,
    focusedId: pageState.focusedId,
    elements: pageState.elements.map((e) => ({
      id: e.id,
      text: e.text,
      value: e.value,
      bbox: e.bbox,
    })),
  }));
  const seedBytes = Buffer.from(seedHex, 'hex');

  // Paint a deterministic background signature across the first scanline.
  for (let i = 0; i < Math.min(width * 3, seedBytes.length * 6); i += 1) {
    buf[i] = seedBytes[i % seedBytes.length];
  }

  // Paint each element's bounding box with a deterministic color derived from its id and text.
  for (let idx = 0; idx < pageState.elements.length; idx += 1) {
    const el = pageState.elements[idx];
    const elDigest = Buffer.from(
      sha256Hex(`${el.id}:${el.text || ''}:${el.value || ''}:${idx}`),
      'hex',
    );
    const r = 48 + (elDigest[0] % 180);
    const g = 48 + (elDigest[1] % 180);
    const b = 48 + (elDigest[2] % 180);
    const x0 = Math.max(0, Math.min(width - 1, el.bbox.x));
    const y0 = Math.max(0, Math.min(height - 1, el.bbox.y));
    const x1 = Math.max(x0, Math.min(width, el.bbox.x + el.bbox.w));
    const y1 = Math.max(y0, Math.min(height, el.bbox.y + el.bbox.h));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const off = (y * width + x) * 3;
        buf[off] = r;
        buf[off + 1] = g;
        buf[off + 2] = b;
      }
    }
  }
  return buf;
}

class HostedWebCapsuleFake {
  constructor(options = {}) {
    this.capsuleId = options.capsuleId || DEFAULT_CAPSULE_ID;
    this.surfaceId = options.surfaceId || DEFAULT_SURFACE_ID;
    this.identity = options.identity || DEFAULT_IDENTITY;
    this.windowNumber = options.windowNumber || 1;
    this.netPolicy = 'down';
    this.shmDir = options.shmDir || fs.mkdtempSync(
      path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'mv-asm-web-'),
    );
    this.shmFiles = [];
    this.frameSeq = 0;
    this.generation = 0;
    this.monoNs = 1_000_000_000;
    this.lastFrame = null;
    this.geometryChangedSinceFrame = false;
    this.inputLog = [];
    this.wrongGreetingMutation = Boolean(options.wrongGreetingMutation);
    this.loadPage(options.initialPage || 'form');
  }

  loadPage(pageKey) {
    const spec = loadPageSpec(pageKey);
    this.pageState = {
      pageKey: spec.pageKey,
      fileName: spec.fileName,
      dataUrl: spec.dataUrl,
      width: spec.width,
      height: spec.height,
      focusedId: null,
      inputValue: '',
      resultText: 'EMPTY',
      submitted: false,
      elements: spec.elements.map((el) => ({ ...el, bbox: { ...el.bbox } })),
    };
    return this.pageState;
  }

  cleanup() {
    for (const f of this.shmFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (_) {
        // Ignore cleanup errors.
      }
    }
    try {
      if (fs.existsSync(this.shmDir)) fs.rmdirSync(this.shmDir);
    } catch (_) {
      // Ignore cleanup errors.
    }
  }

  captureFrame() {
    this.frameSeq += 1;
    this.generation += 1;
    this.monoNs += 10_000_000;
    const pixels = renderDeterministicRgb24(
      this.pageState.width,
      this.pageState.height,
      this.pageState,
    );
    const sha256 = sha256Hex(pixels);
    const shmPath = path.join(this.shmDir, `frame_${this.generation}_${sha256.slice(0, 12)}.rgb24`);
    fs.writeFileSync(shmPath, pixels);
    this.shmFiles.push(shmPath);
    this.geometryChangedSinceFrame = false;

    const frameRef = {
      schema: 'frame_ref/v0.2',
      capsule_id: this.capsuleId,
      surface_id: this.surfaceId,
      fd_id: `shm:${path.basename(shmPath)}`,
      shm_path: shmPath,
      width: this.pageState.width,
      height: this.pageState.height,
      stride: this.pageState.width * 3,
      format: 'RGB24',
      sha256,
      generation: this.generation,
      seq: this.frameSeq,
      mono_ns: this.monoNs,
    };
    this.lastFrame = { frameRef, pixels };
    return frameRef;
  }

  readAxTextContainer(options = {}) {
    const requestedSurface = options.surfaceId || this.surfaceId;
    if (requestedSurface !== this.surfaceId) {
      throw new Error(`SURFACE_MISMATCH: expected ${this.surfaceId}, got ${requestedSurface}`);
    }
    if (!this.lastFrame || this.frameSeq < 1) {
      throw new Error('AX_PRIOR_FRAME_REQUIRED: seq must be >= 1');
    }
    if (this.geometryChangedSinceFrame) {
      throw new Error('AX_GEOMETRY_CHANGED: fresh frame required before ax readback');
    }
    const nodes = this.pageState.elements.map((el) => ({
      id: el.id,
      role: el.role,
      name: el.name,
      text: el.id === 'result-text' ? this.pageState.resultText : (el.value || el.text),
      bbox: { ...el.bbox },
      focused: this.pageState.focusedId === el.id,
    }));
    const visibleText = nodes
      .map((n) => `${n.id}:${n.text}`)
      .join('\n');
    return {
      schema: 'srf.ax.text-container/v1',
      capsule_id: this.capsuleId,
      surface_id: this.surfaceId,
      window: this.windowNumber,
      based_on_seq: this.frameSeq,
      frame_sha256: this.lastFrame.frameRef.sha256,
      page_id: this.pageState.pageKey,
      focused_id: this.pageState.focusedId,
      text_container: visibleText,
      nodes,
    };
  }

  findElementAt(x, y) {
    for (const el of this.pageState.elements) {
      const { bbox } = el;
      if (x >= bbox.x && x < bbox.x + bbox.w && y >= bbox.y && y < bbox.y + bbox.h) {
        return el;
      }
    }
    return null;
  }

  injectInputSingleOp(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error('INPUT_SINGLE_OP_REQUIRED: input accepts exactly 1 action');
    }
    this.monoNs += 5_000_000;
    const inputMonoNs = this.monoNs;
    let focusVerified = false;

    if (action.kind === 'click') {
      const target = this.findElementAt(action.x, action.y);
      if (target) {
        this.pageState.focusedId = target.id;
        focusVerified = true;
        if (target.id === 'submit-btn') {
          this._submitForm();
        } else if (target.targetPage) {
          this.loadPage(target.targetPage);
        }
      }
    } else if (action.kind === 'type') {
      const focused = this.pageState.elements.find((e) => e.id === this.pageState.focusedId);
      if (!focused || focused.id !== 'name-input') {
        throw new Error('TYPE_REQUIRES_FOCUSED_INPUT: #name-input is not focused');
      }
      focusVerified = true;
      this.pageState.inputValue = String(action.text || '');
      focused.value = this.pageState.inputValue;
      focused.text = this.pageState.inputValue;
    } else if (action.kind === 'key') {
      focusVerified = this.pageState.focusedId !== null;
      if (action.key === 'Return' || action.key === 'Enter') {
        if (this.pageState.pageKey === 'form') {
          this._submitForm();
        }
      } else if (action.key === 'Tab') {
        const tabbables = this.pageState.elements
          .filter((e) => e.tabindex !== null)
          .sort((a, b) => a.tabindex - b.tabindex);
        if (tabbables.length > 0) {
          const curIdx = tabbables.findIndex((e) => e.id === this.pageState.focusedId);
          const next = tabbables[(curIdx + 1) % tabbables.length];
          this.pageState.focusedId = next.id;
          focusVerified = true;
        }
      }
    } else {
      throw new Error(`UNSUPPORTED_INPUT_KIND: ${action.kind}`);
    }

    const record = {
      kind: action.kind,
      input_mono_ns: inputMonoNs,
      focus_verified: focusVerified,
      focused_id: this.pageState.focusedId,
    };
    this.inputLog.push(record);
    return record;
  }

  _submitForm() {
    this.pageState.submitted = true;
    const raw = String(this.pageState.inputValue || '');
    if (raw.length === 0) {
      this.pageState.resultText = 'EMPTY';
    } else if (this.wrongGreetingMutation) {
      this.pageState.resultText = `Goodbye, ${raw}`;
    } else {
      this.pageState.resultText = `Hello, ${raw}`;
    }
    const outEl = this.pageState.elements.find((e) => e.id === 'result-text');
    if (outEl) {
      outEl.text = this.pageState.resultText;
    }
  }
}

function mapRoleToMarkKind(role) {
  if (role === 'textbox') return 'field';
  if (role === 'button') return 'button';
  if (role === 'cell' || role === 'columnheader') return 'row';
  if (role === 'status') return 'text';
  return 'unknown';
}

function buildC2Describe(capsule, frameRef, options = {}) {
  const frameSha = options.overrideFrameSha256 || frameRef.sha256;
  const shiftOutOfFrame = Boolean(options.shiftBboxOutOfFrame);
  const elements = capsule.pageState.elements.map((el, idx) => {
    const bbox = shiftOutOfFrame && idx === 0
      ? { x: frameRef.width + 40, y: el.bbox.y, w: el.bbox.w, h: el.bbox.h }
      : { ...el.bbox };
    const rawName = el.id === 'result-text'
      ? capsule.pageState.resultText
      : (el.value || el.text || el.name || el.id);
    const scorePpm = 950_000 - idx * 10_000;
    return {
      id: idx + 1,
      dom_id: el.id,
      role: el.role,
      kind: mapRoleToMarkKind(el.role),
      name: String(rawName).slice(0, 48),
      bbox,
      score: Number((scorePpm / 1_000_000).toFixed(6)),
      score_ppm: scorePpm,
      row: el.row,
      col: el.col,
    };
  });

  const changedRegions = elements.slice(0, 16).map((el) => ({
    x: el.bbox.x,
    y: el.bbox.y,
    w: el.bbox.w,
    h: el.bbox.h,
    score: el.score,
  }));

  const crops = elements.slice(0, 8).map((el) => ({
    x: el.bbox.x,
    y: el.bbox.y,
    w: el.bbox.w,
    h: el.bbox.h,
    reason: 'salient',
  }));

  const marks = elements.slice(0, 24).map((el) => ({
    id: el.id,
    x: el.bbox.x,
    y: el.bbox.y,
    w: el.bbox.w,
    h: el.bbox.h,
    kind: el.kind,
    role: el.role,
    score: el.score,
    score_ppm: el.score_ppm,
    ocr_text: el.name || `mark-${el.id}`,
  }));

  const regions = elements.map((el) => ({
    id: el.id,
    bbox: { ...el.bbox },
    role: el.role,
    name: el.name,
    score_ppm: el.score_ppm,
    area_px: el.bbox.w * el.bbox.h,
    kind: 'component',
  }));

  return {
    schema: 've.cu_describe/v1',
    frame_sha256: frameSha,
    width: frameRef.width,
    height: frameRef.height,
    changed: null,
    changed_regions: changedRegions,
    crops,
    marks,
    marks_png: '/dev/shm/vqa-cu/asm-web-marks.png',
    timing_us: 420,
    mark_cap_reached: false,
    regions,
  };
}

function projectElementTable(frameRef, c2Payload) {
  if (c2Payload.frame_sha256 !== frameRef.sha256) {
    const err = new Error('c2 frame_sha256 does not match frame_ref');
    err.code = 'frame_mismatch';
    throw err;
  }
  const sourceRows = c2Payload.regions || c2Payload.marks || [];
  const elements = sourceRows.map((region) => {
    const bbox = region.bbox || {
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
    };
    if (
      bbox.x < 0 ||
      bbox.y < 0 ||
      bbox.w <= 0 ||
      bbox.h <= 0 ||
      bbox.x + bbox.w > frameRef.width ||
      bbox.y + bbox.h > frameRef.height
    ) {
      const err = new Error(`element bbox out of frame bounds: ${JSON.stringify(bbox)}`);
      err.code = 'out_of_bounds';
      throw err;
    }
    return {
      bbox: { ...bbox },
      role: region.role || region.kind,
      name: region.name || region.ocr_text,
      score_ppm: region.score_ppm ?? Math.round((region.score || 0.5) * 1_000_000),
    };
  });
  return {
    schema: 'vqa.element-table/v1',
    frame_sha256: frameRef.sha256,
    width: frameRef.width,
    height: frameRef.height,
    elements,
  };
}

function buildWenderState(capsule, frameRef, elementTable, options = {}) {
  if (elementTable.frame_sha256 !== frameRef.sha256) {
    const err = new Error('element_table frame_sha256 does not match observation');
    err.code = 'frame_mismatch';
    throw err;
  }
  let pageElements = [...capsule.pageState.elements];
  if (options.transposeTableOrder && capsule.pageState.pageKey === 'table') {
    const headers = pageElements.filter((e) => e.row === null);
    const cells = pageElements.filter((e) => e.row !== null);
    cells.sort((a, b) => (a.col - b.col) || (a.row - b.row));
    pageElements = [...headers, ...cells];
  }

  const nodes = pageElements.map((el, idx) => {
    const tableEl = elementTable.elements[idx] || {
      bbox: el.bbox,
      role: el.role,
      name: el.name,
      score_ppm: 900_000,
    };
    const bbox = tableEl.bbox;
    if (
      bbox.x < 0 ||
      bbox.y < 0 ||
      bbox.w <= 0 ||
      bbox.h <= 0 ||
      bbox.x + bbox.w > frameRef.width ||
      bbox.y + bbox.h > frameRef.height
    ) {
      const err = new Error(`node bbox exceeds frame bounds: ${JSON.stringify(bbox)}`);
      err.code = 'out_of_bounds';
      throw err;
    }
    const textVal = el.id === 'result-text'
      ? capsule.pageState.resultText
      : (el.value || el.text || el.name);
    return {
      node_id: `el-${idx}`,
      dom_id: el.id,
      role: el.role,
      name: textVal,
      bbox: { ...bbox },
      score_ppm: tableEl.score_ppm,
      row: el.row,
      col: el.col,
      actionable: el.role === 'textbox' || el.role === 'button',
    };
  });

  const digestInput = JSON.stringify({
    frame_sha256: frameRef.sha256,
    width: frameRef.width,
    height: frameRef.height,
    nodes: nodes.map((n) => ({
      node_id: n.node_id,
      dom_id: n.dom_id,
      role: n.role,
      name: n.name,
      bbox: n.bbox,
    })),
  });

  return {
    schema: 'wender.state/v1',
    state_sha256: sha256Hex(digestInput),
    frame_sha256: frameRef.sha256,
    width: frameRef.width,
    height: frameRef.height,
    nodes,
  };
}

class HostedCoreAdmissionFake {
  constructor(capsule, options = {}) {
    this.capsule = capsule;
    this.stepBudget = options.stepBudget ?? 8;
    this.seenNonces = new Set();
    this.proposals = [];
    this.verdicts = [];
    this.receipts = [];
    this.forceVerdictRefusal = Boolean(options.forceVerdictRefusal);
    this.forceReceiptUnverified = Boolean(options.forceReceiptUnverified);
    this.expectedSurfaceId = options.expectedSurfaceId || capsule.surfaceId;
  }

  observe(options = {}) {
    const frameRef = this.capsule.captureFrame();
    const surfaceId = options.overrideSurfaceId || frameRef.surface_id;
    if (surfaceId !== this.expectedSurfaceId) {
      const err = new Error(`SURFACE_MISMATCH: expected ${this.expectedSurfaceId}, got ${surfaceId}`);
      err.code = 'SURFACE_MISMATCH';
      throw err;
    }
    const c2 = buildC2Describe(this.capsule, frameRef, options);
    const elementTable = projectElementTable(frameRef, c2);
    const wenderState = buildWenderState(this.capsule, frameRef, elementTable, options);
    const ax = this.capsule.readAxTextContainer({ surfaceId });

    const observation = {
      schema: 'observation/v0.2',
      capsule_id: this.capsule.capsuleId,
      frame_ref: {
        schema: 'frame_ref/v0.2',
        capsule_id: frameRef.capsule_id,
        fd_id: frameRef.fd_id,
        width: frameRef.width,
        height: frameRef.height,
        stride: frameRef.stride,
        format: 'RGB24',
        sha256: frameRef.sha256,
        generation: frameRef.generation,
      },
      vision: {
        schema: 'vision_Placeholder/v0.2',
        regions: c2.regions.map((r) => ({
          bbox: { ...r.bbox },
          role: r.role,
          score_ppm: r.score_ppm,
        })),
      },
      degraded: false,
      budget_Warning: false,
    };

    return {
      observation,
      frameRef,
      c2,
      elementTable,
      wenderState,
      ax,
    };
  }

  proposeAndExecute(proposal, targetBbox, options = {}) {
    this.proposals.push(proposal);
    if (proposal.schema !== 'action_proposal/v0.2') {
      throw new Error(`invalid proposal schema: ${proposal.schema}`);
    }
    if (this.seenNonces.has(proposal.nonce)) {
      return this._refuse(proposal, 'POLICY', 'duplicate proposal nonce');
    }
    this.seenNonces.add(proposal.nonce);

    if (this.receipts.length >= this.stepBudget) {
      return this._refuse(proposal, 'RATE_LIMIT', `step budget ${this.stepBudget} exceeded`);
    }

    if (this.forceVerdictRefusal) {
      return this._refuse(proposal, 'POLICY', 'forced verdict refusal mutation');
    }

    const currentFrame = this.capsule.lastFrame ? this.capsule.lastFrame.frameRef : null;
    if (
      !currentFrame ||
      !proposal.based_on_frame ||
      proposal.based_on_frame.generation !== currentFrame.generation ||
      proposal.based_on_frame.sha256 !== currentFrame.sha256
    ) {
      return this._refuse(proposal, 'STALE_FRAME', 'based_on_frame does not match current frame');
    }

    const action = proposal.action;
    if (action.kind === 'click') {
      if (
        action.x < 0 ||
        action.y < 0 ||
        action.x >= currentFrame.width ||
        action.y >= currentFrame.height
      ) {
        return this._refuse(proposal, 'OUT_OF_BOUNDS', 'click coordinates outside frame');
      }
      if (targetBbox) {
        const insideTarget =
          action.x >= targetBbox.x &&
          action.x < targetBbox.x + targetBbox.w &&
          action.y >= targetBbox.y &&
          action.y < targetBbox.y + targetBbox.h;
        if (!insideTarget) {
          return this._refuse(proposal, 'OUT_OF_TARGET', 'click coordinates outside target custody bbox');
        }
      }
    }

    const verdict = {
      schema: 'action_verdict/v0.2',
      proposal_nonce: proposal.nonce,
      admitted: true,
      refusal: null,
    };
    this.verdicts.push(verdict);

    const injection = this.capsule.injectInputSingleOp(action);
    const postFrame = this.capsule.captureFrame();

    const verifiedFlag = this.forceReceiptUnverified ? false : Boolean(injection.focus_verified);
    const receipt = {
      schema: 'action_receipt/v0.2',
      proposal_nonce: proposal.nonce,
      executed: true,
      verified: verifiedFlag,
      focus_verified: verifiedFlag,
      input_mono_ns: injection.input_mono_ns,
      frame_sha256: postFrame.sha256,
      post_frame_ref: postFrame,
      verified_by_wait_verify: false,
    };
    if (!options.skipWaitVerify) {
      this.waitVerify(proposal.nonce);
    }
    this.receipts.push(receipt);
    return { verdict, receipt };
  }

  waitVerify(nonce) {
    const existing = this.receipts.find((r) => r.proposal_nonce === nonce);
    if (existing) {
      if (!existing.verified || !existing.focus_verified) {
        const err = new Error(`WAIT_VERIFY_FAILED: receipt for ${nonce} is unverified`);
        err.code = 'WAIT_VERIFY_FAILED';
        throw err;
      }
      existing.verified_by_wait_verify = true;
      return existing;
    }
    return null;
  }

  _refuse(proposal, refusalCode, detail) {
    const verdict = {
      schema: 'action_verdict/v0.2',
      proposal_nonce: proposal.nonce,
      admitted: false,
      refusal: refusalCode,
      detail,
    };
    this.verdicts.push(verdict);
    const err = new Error(`ADMISSION_REFUSED(${refusalCode}): ${detail}`);
    err.code = refusalCode;
    err.verdict = verdict;
    throw err;
  }
}

function makeProposal(capsuleId, frameRef, action, targetBbox, nonceSuffix) {
  const nonceHex = sha256Hex(`${capsuleId}:${frameRef.generation}:${frameRef.sha256}:${nonceSuffix}`).slice(0, 24);
  return {
    schema: 'action_proposal/v0.2',
    capsule_id: capsuleId,
    nonce: `nonce-${nonceHex}`,
    based_on_frame: {
      sha256: frameRef.sha256,
      generation: frameRef.generation,
    },
    target_region: targetBbox ? { ...targetBbox } : undefined,
    action,
  };
}

function finalizeReceiptVerification(core, stepOut, skipWaitVerify) {
  if (!skipWaitVerify) {
    stepOut.receipt.verified_by_wait_verify = true;
    if (!stepOut.receipt.verified || !stepOut.receipt.focus_verified) {
      const err = new Error(
        `WAIT_VERIFY_FAILED: receipt ${stepOut.receipt.proposal_nonce} was not verified`,
      );
      err.code = 'WAIT_VERIFY_FAILED';
      throw err;
    }
  }
  return stepOut;
}

function assertAllReceiptsVerified(core) {
  for (const r of core.receipts) {
    if (!r.verified_by_wait_verify || !r.verified || !r.focus_verified) {
      const err = new Error(`UNVERIFIED_ACTION_RECEIPT: ${r.proposal_nonce}`);
      err.code = 'UNVERIFIED_ACTION_RECEIPT';
      throw err;
    }
    if (typeof r.input_mono_ns !== 'number' || r.input_mono_ns <= 0) {
      throw new Error(`MISSING_INPUT_MONO_NS: ${r.proposal_nonce}`);
    }
    if (typeof r.frame_sha256 !== 'string' || r.frame_sha256.length !== 64) {
      throw new Error(`MISSING_RECEIPT_FRAME_SHA256: ${r.proposal_nonce}`);
    }
  }
}

function runPythonAgentsBridge(payload) {
  const pyScript = `
import copy, hashlib, json, os, sys, tempfile
from pathlib import Path

agents_root = sys.argv[1]
sys.path.insert(0, agents_root)

from metaviewer_agents.perception.base import Frame
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter, project_element_table
from metaviewer_agents.planner import plan, recheck_plan
from metaviewer_agents.wender_bridge import WenderSubprocessAdapter, validate_state
from metaviewer_agents.verify import run_loop, build_proposal
from metaviewer_agents.executor import AdmittedExecutor

req = json.loads(sys.stdin.read())
mode = req["mode"]

with tempfile.TemporaryDirectory(prefix="mv_ve_fake_") as ve_dir:
    vadapt_dir = Path(ve_dir) / "vadapt"
    vadapt_dir.mkdir(parents=True, exist_ok=True)
    (vadapt_dir / "__init__.py").write_text("", encoding="utf-8")

    raw_bytes = Path(req["shm_path"]).read_bytes()
    width = req["frame_ref"]["width"]
    height = req["frame_ref"]["height"]
    sha = hashlib.sha256(raw_bytes).hexdigest()

    wire_frame_ref = {
        "schema": "frame_ref/v0.2",
        "surface_id": req.get("surface_id", "surface-web-1"),
        "generation": int(req["frame_ref"]["generation"]),
        "tick": int(req["frame_ref"].get("seq", 1)),
        "ts_ns": int(req["frame_ref"].get("mono_ns", 1000)),
        "width": width,
        "height": height,
        "format": "rgb24",
        "ramws_path": req["shm_path"],
        "sha256": sha,
        "capture_us": 100,
    }

    c2_clean = {
        "schema": "ve.cu_describe/v1",
        "frame_sha256": req["c2"]["frame_sha256"],
        "width": width,
        "height": height,
        "changed": None,
        "changed_regions": req["c2"]["changed_regions"],
        "crops": req["c2"]["crops"],
        "timing_us": 420,
    }
    c2_json_str = json.dumps(c2_clean)
    (vadapt_dir / "cu_describe.py").write_text(
        "import sys\\n"
        f"sys.stdout.write({c2_json_str!r})\\n",
        encoding="utf-8",
    )

    frame_obj = Frame(width=width, height=height, data=raw_bytes)
    adapter = VCorePerceptionAdapter(ve_root=ve_dir, python=sys.executable, verify_lock=False)
    vision_out = adapter.perceive(wire_frame_ref, frame_obj)
    el_table = project_element_table(wire_frame_ref, c2_clean)

    obs = {
        "schema": "observation/v0.2",
        "frame_ref": wire_frame_ref,
        "vision": vision_out,
    }
    wender = WenderSubprocessAdapter(
        wender_root=agents_root,
        command=[sys.executable, "-m", "metaviewer_agents.planner"],
        verify_lock=False,
    )
    goal_str = req.get("goal_str", "Continue to Step 2")

    if mode == "perceive_and_plan":
        action, expectation, state, target = wender.plan_step(obs, el_table, goal_str)
        rechecked = recheck_plan(
            {
                "action": action,
                "expectation": expectation,
                "state": state,
                "target_node": target,
            },
            observation=obs,
            element_table=el_table,
        )
        out = {
            "ok": True,
            "vision": dict(vision_out),
            "element_table": el_table,
            "plan": rechecked,
        }
        sys.stdout.write(json.dumps(out))
    elif mode == "run_loop":
        post_bytes = Path(req["post_shm_path"]).read_bytes()
        post_sha = hashlib.sha256(post_bytes).hexdigest()
        after_frame = dict(
            wire_frame_ref,
            generation=wire_frame_ref["generation"] + 1,
            tick=wire_frame_ref["tick"] + 1,
            ramws_path=req["post_shm_path"],
            sha256=post_sha,
        )

        class HostedSupervisorCore:
            def __init__(self):
                self.ops = []
                self.dispatched = []
                self.executor = AdmittedExecutor(
                    transport=lambda prop: {"focus_verified": True, "input_mono_ns": 1005000000}
                )

            def request(self, call, expect, *, timeout_ms):
                op = call["op"]
                self.ops.append(op)
                res = {"schema": expect, "request_id": call["request_id"], "op": op}
                if op == "observe":
                    res.update(
                        status="ok",
                        observation={
                            "schema": "observation/v0.2",
                            "frame_ref": copy.deepcopy(wire_frame_ref),
                        },
                    )
                elif op == "propose":
                    prop = call["args"]["proposal"]
                    verdict = {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": "p-web-1",
                        "decision": "admitted",
                        "core_seq": 1,
                    }
                    self.execution = self.executor.dispatch(prop, verdict)
                    self.dispatched.append(prop)
                    res.update(status="admitted", verdict=verdict)
                elif op == "wait_verify":
                    receipt = {
                        "schema": "action_receipt/v0.2",
                        "proposal_id": "p-web-1",
                        "executed_at_ns": 1005000000,
                        "after_frame": after_frame,
                        "verified": True,
                        "verification": {"method": "pixel", "detail": "core witness"},
                        "error": "",
                        "native_evidence": {
                            "surface_id": wire_frame_ref["surface_id"],
                            "native_surface_id": "native-web-1",
                            "kind": "click",
                            "input_mono_ns": 1005000000,
                            "input_ts_ns": 1005000000,
                            "result": "ok",
                        },
                    }
                    res.update(
                        status="verified",
                        receipt=receipt,
                        **self.execution,
                        frame_sha256=after_frame["sha256"],
                    )
                return res

        sup = HostedSupervisorCore()
        receipt = run_loop(
            client=sup,
            surface_id=wire_frame_ref["surface_id"],
            proposal_id="p-web-1",
            timeout_ms=5000,
            perception_adapter=adapter,
            planner=lambda obs_in: wender.plan_step(
                obs_in,
                project_element_table(obs_in["frame_ref"], obs_in["vision"]),
                goal_str,
            )[:2],
        )
        out = {
            "ok": True,
            "ops": sup.ops,
            "receipt": {
                "proposal_id": receipt["proposal_id"],
                "verified": receipt["verified"],
                "focus_verified": receipt.focus_verified,
                "input_mono_ns": receipt.input_mono_ns,
                "frame_sha256": receipt.frame_sha256,
            },
        }
        sys.stdout.write(json.dumps(out))
    else:
        raise RuntimeError(f"unknown mode: {mode}")
`;

  const proc = spawnSync('python3', ['-c', pyScript, AGENTS_ROOT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15_000,
  });
  return {
    status: proc.status,
    stdout: proc.stdout ? proc.stdout.trim() : '',
    stderr: proc.stderr ? proc.stderr.trim() : '',
  };
}

function runTask1FormFill(options = {}) {
  const inputText = options.inputText ?? 'Ada Lovelace';
  const capsule = new HostedWebCapsuleFake({
    initialPage: 'form',
    wrongGreetingMutation: options.wrongGreetingMutation,
  });
  const core = new HostedCoreAdmissionFake(capsule, {
    stepBudget: STEP_BUDGETS.T1_FORM_FILL,
    forceVerdictRefusal: options.forceVerdictRefusal,
    forceReceiptUnverified: options.forceReceiptUnverified,
    expectedSurfaceId: options.expectedSurfaceId,
  });

  try {
    // 1. Observe initial form state (result-text is EMPTY).
    const obs0 = core.observe({
      shiftBboxOutOfFrame: options.shiftBboxOutOfFrame,
      overrideFrameSha256: options.overrideFrameSha256,
      overrideSurfaceId: options.overrideSurfaceId,
    });
    const emptyCheck = obs0.ax.nodes.find((n) => n.id === 'result-text');
    if (!emptyCheck || emptyCheck.text !== 'EMPTY') {
      throw new Error(`T1 initial result-text must be EMPTY, got ${emptyCheck && emptyCheck.text}`);
    }

    // 2. Click submit while input is empty -> verifies EMPTY token on empty submit.
    const submitNode0 = obs0.wenderState.nodes.find((n) => n.dom_id === 'submit-btn');
    const clickEmptySubmit = makeProposal(
      capsule.capsuleId,
      obs0.frameRef,
      {
        kind: 'click',
        x: submitNode0.bbox.x + Math.floor(submitNode0.bbox.w / 2),
        y: submitNode0.bbox.y + Math.floor(submitNode0.bbox.h / 2),
        button: 'left',
      },
      submitNode0.bbox,
      't1-empty-submit',
    );
    const stepEmpty = core.proposeAndExecute(clickEmptySubmit, submitNode0.bbox, {
      skipWaitVerify: options.skipWaitVerify,
    });
    finalizeReceiptVerification(core, stepEmpty, options.skipWaitVerify);

    const obsAfterEmpty = core.observe();
    const emptyAfterSubmit = obsAfterEmpty.ax.nodes.find((n) => n.id === 'result-text');
    if (!emptyAfterSubmit || emptyAfterSubmit.text !== 'EMPTY') {
      throw new Error(`T1 empty submit must keep EMPTY, got ${emptyAfterSubmit && emptyAfterSubmit.text}`);
    }

    // 3. Click #name-input to focus textbox.
    const inputNode = obsAfterEmpty.wenderState.nodes.find((n) => n.dom_id === 'name-input');
    const clickX = options.wrongTargetMutation
      ? inputNode.bbox.x + inputNode.bbox.w + 25
      : inputNode.bbox.x + Math.floor(inputNode.bbox.w / 2);
    const clickY = inputNode.bbox.y + Math.floor(inputNode.bbox.h / 2);
    const clickInputProposal = makeProposal(
      capsule.capsuleId,
      obsAfterEmpty.frameRef,
      { kind: 'click', x: clickX, y: clickY, button: 'left' },
      inputNode.bbox,
      't1-focus-input',
    );
    const stepFocus = core.proposeAndExecute(clickInputProposal, inputNode.bbox, {
      skipWaitVerify: options.skipWaitVerify,
    });
    finalizeReceiptVerification(core, stepFocus, options.skipWaitVerify);

    // 4. Type operator name into focused #name-input.
    const obsFocused = core.observe();
    const typeProposal = makeProposal(
      capsule.capsuleId,
      obsFocused.frameRef,
      { kind: 'type', text: inputText },
      inputNode.bbox,
      't1-type-name',
    );
    const stepType = core.proposeAndExecute(typeProposal, inputNode.bbox, {
      skipWaitVerify: options.skipWaitVerify,
    });
    finalizeReceiptVerification(core, stepType, options.skipWaitVerify);

    // 5. Click #submit-btn to submit form.
    const obsTyped = core.observe();
    const submitNode = obsTyped.wenderState.nodes.find((n) => n.dom_id === 'submit-btn');
    const clickSubmitProposal = makeProposal(
      capsule.capsuleId,
      obsTyped.frameRef,
      {
        kind: 'click',
        x: submitNode.bbox.x + Math.floor(submitNode.bbox.w / 2),
        y: submitNode.bbox.y + Math.floor(submitNode.bbox.h / 2),
        button: 'left',
      },
      submitNode.bbox,
      't1-submit-filled',
    );
    const stepSubmit = core.proposeAndExecute(clickSubmitProposal, submitNode.bbox, {
      skipWaitVerify: options.skipWaitVerify,
    });
    finalizeReceiptVerification(core, stepSubmit, options.skipWaitVerify);

    // 6. Final observe + AX readback verification.
    const obsFinal = core.observe();
    const resultNode = obsFinal.ax.nodes.find((n) => n.id === 'result-text');
    const expectedText = `Hello, ${inputText}`;
    let resultVerified = false;
    if (!options.skipResultTextCheck) {
      if (!resultNode || resultNode.text !== expectedText) {
        const err = new Error(
          `T1_RESULT_MISMATCH: expected "${expectedText}", got "${resultNode && resultNode.text}"`,
        );
        err.code = 'T1_RESULT_MISMATCH';
        throw err;
      }
      resultVerified = true;
    }
    if (!resultVerified) {
      const err = new Error('E2E_WITNESS: T1 result-text verification check was skipped');
      err.code = 'E2E_WITNESS';
      throw err;
    }

    assertAllReceiptsVerified(core);

    return {
      task: 'T1_FORM_FILL',
      stepBudget: STEP_BUDGETS.T1_FORM_FILL,
      admittedActions: core.receipts.length,
      preFrameRef: obs0.frameRef,
      postFrameRef: obsFinal.frameRef,
      elementTable: obsFinal.elementTable,
      wenderState: obsFinal.wenderState,
      axReadback: obsFinal.ax,
      resultText: resultNode.text,
      receipts: core.receipts,
      verdicts: core.verdicts,
    };
  } finally {
    capsule.cleanup();
  }
}

function runTask2TwoPageFlow(options = {}) {
  const capsule = new HostedWebCapsuleFake({ initialPage: 'flow_a' });
  const core = new HostedCoreAdmissionFake(capsule, {
    stepBudget: STEP_BUDGETS.T2_TWO_PAGE_FLOW,
    forceVerdictRefusal: options.forceVerdictRefusal,
    forceReceiptUnverified: options.forceReceiptUnverified,
  });

  try {
    // 1. Observe Step 1 (flow_a.html).
    const obsPage1 = core.observe({
      shiftBboxOutOfFrame: options.shiftBboxOutOfFrame,
      overrideFrameSha256: options.overrideFrameSha256,
    });
    const marker1 = obsPage1.ax.nodes.find((n) => n.id === 'flow-step-marker');
    if (!marker1 || marker1.text !== 'FLOW_STAGE_A_READY') {
      throw new Error('T2 expected FLOW_STAGE_A_READY on flow_a.html');
    }

    // 2. Click #next-btn to navigate to flow_b.html.
    const nextNode = obsPage1.wenderState.nodes.find((n) => n.dom_id === 'next-btn');
    const frameForProposal = options.staleGenerationMutation
      ? { ...obsPage1.frameRef, generation: obsPage1.frameRef.generation - 1 }
      : obsPage1.frameRef;
    const clickNext = makeProposal(
      capsule.capsuleId,
      frameForProposal,
      {
        kind: 'click',
        x: nextNode.bbox.x + Math.floor(nextNode.bbox.w / 2),
        y: nextNode.bbox.y + Math.floor(nextNode.bbox.h / 2),
        button: 'left',
      },
      nextNode.bbox,
      't2-click-next',
    );
    const stepNext = core.proposeAndExecute(clickNext, nextNode.bbox, {
      skipWaitVerify: options.skipWaitVerify,
    });
    finalizeReceiptVerification(core, stepNext, options.skipWaitVerify);

    // 3. Observe Step 2 (flow_b.html) and verify confirmation marker.
    const obsPage2 = core.observe();
    const confirmNode = obsPage2.ax.nodes.find((n) => n.id === 'flow-confirmation');
    if (!confirmNode || confirmNode.text !== 'FLOW_STEP_2_CONFIRMED') {
      throw new Error('T2 expected FLOW_STEP_2_CONFIRMED on flow_b.html');
    }

    // 4. Click #back-btn to return to flow_a.html.
    const backNode = obsPage2.wenderState.nodes.find((n) => n.dom_id === 'back-btn');
    const clickBack = makeProposal(
      capsule.capsuleId,
      obsPage2.frameRef,
      {
        kind: 'click',
        x: backNode.bbox.x + Math.floor(backNode.bbox.w / 2),
        y: backNode.bbox.y + Math.floor(backNode.bbox.h / 2),
        button: 'left',
      },
      backNode.bbox,
      't2-click-back',
    );
    const stepBack = core.proposeAndExecute(clickBack, backNode.bbox, {
      skipWaitVerify: options.skipWaitVerify,
    });
    finalizeReceiptVerification(core, stepBack, options.skipWaitVerify);

    const obsReturned = core.observe();
    const returnedMarker = obsReturned.ax.nodes.find((n) => n.id === 'flow-step-marker');
    if (!returnedMarker || returnedMarker.text !== 'FLOW_STAGE_A_READY') {
      throw new Error('T2 expected return to flow_a.html FLOW_STAGE_A_READY');
    }

    assertAllReceiptsVerified(core);

    return {
      task: 'T2_TWO_PAGE_FLOW',
      stepBudget: STEP_BUDGETS.T2_TWO_PAGE_FLOW,
      admittedActions: core.receipts.length,
      page1FrameRef: obsPage1.frameRef,
      page2FrameRef: obsPage2.frameRef,
      returnedFrameRef: obsReturned.frameRef,
      confirmationText: confirmNode.text,
      returnedText: returnedMarker.text,
      page2ElementTable: obsPage2.elementTable,
      page2WenderState: obsPage2.wenderState,
      receipts: core.receipts,
    };
  } finally {
    capsule.cleanup();
  }
}

function runTask3ReadTable(options = {}) {
  const targetRow = options.row ?? 1;
  const targetCol = options.col ?? 2;
  const capsule = new HostedWebCapsuleFake({ initialPage: 'table' });
  const core = new HostedCoreAdmissionFake(capsule, {
    stepBudget: options.allowExtraInputsMutation ? 2 : STEP_BUDGETS.T3_READ_TABLE,
  });

  try {
    const obs = core.observe({
      transposeTableOrder: options.transposeTableOrder,
      shiftBboxOutOfFrame: options.shiftBboxOutOfFrame,
      overrideFrameSha256: options.overrideFrameSha256,
    });

    if (options.injectUnexpectedInputMutation) {
      const firstCell = obs.wenderState.nodes[0];
      const badProposal = makeProposal(
        capsule.capsuleId,
        obs.frameRef,
        {
          kind: 'click',
          x: firstCell.bbox.x + 4,
          y: firstCell.bbox.y + 4,
          button: 'left',
        },
        firstCell.bbox,
        't3-forbidden-click',
      );
      core.proposeAndExecute(badProposal, firstCell.bbox);
    }

    if (core.receipts.length !== 0 || capsule.inputLog.length !== 0) {
      const err = new Error(
        `T3_READ_ONLY_VIOLATION: expected 0 admitted actions, got ${core.receipts.length}`,
      );
      err.code = 'T3_READ_ONLY_VIOLATION';
      throw err;
    }

    const cellNodes = obs.wenderState.nodes.filter((n) => n.role === 'cell');
    if (cellNodes.length !== 9) {
      throw new Error(`T3 expected 9 table data cells (3x3), got ${cellNodes.length}`);
    }

    // Verify cells appear strictly in document order (row-major 0..2, 0..2).
    const expectedGrid = [
      ['auth-gateway', 'eu-central', '14'],
      ['ledger-core', 'us-east', '27'],
      ['stream-index', 'ap-north', '41'],
    ];

    cellNodes.forEach((cell, index) => {
      const expectedRow = Math.floor(index / 3);
      const expectedCol = index % 3;
      const expectedText = expectedGrid[expectedRow][expectedCol];
      if (cell.row !== expectedRow || cell.col !== expectedCol || cell.name !== expectedText) {
        const err = new Error(
          `T3_CELL_ORDER_MISMATCH at index ${index}: expected (${expectedRow},${expectedCol})="${expectedText}", got (${cell.row},${cell.col})="${cell.name}"`,
        );
        err.code = 'T3_CELL_ORDER_MISMATCH';
        throw err;
      }
    });

    const reportedCell = cellNodes[targetRow * 3 + targetCol];
    const expectedValue = expectedGrid[targetRow][targetCol];
    if (reportedCell.name !== expectedValue) {
      throw new Error(`T3 cell value mismatch: expected ${expectedValue}, got ${reportedCell.name}`);
    }

    return {
      task: 'T3_READ_TABLE',
      stepBudget: STEP_BUDGETS.T3_READ_TABLE,
      admittedActions: core.receipts.length,
      frameRef: obs.frameRef,
      c2: obs.c2,
      elementTable: obs.elementTable,
      wenderState: obs.wenderState,
      axReadback: obs.ax,
      cellsInDocumentOrder: cellNodes.map((c) => ({
        dom_id: c.dom_id,
        row: c.row,
        col: c.col,
        text: c.name,
        bbox: c.bbox,
      })),
      reportedCell: {
        row: targetRow,
        col: targetCol,
        value: reportedCell.name,
      },
    };
  } finally {
    capsule.cleanup();
  }
}

module.exports = {
  PAGES_DIR,
  PAGE_FILES,
  VIEWPORT_WIDTH,
  VIEWPORT_HEIGHT,
  STEP_BUDGETS,
  sha256Hex,
  loadPageSpec,
  validateDeterministicPageSource,
  HostedWebCapsuleFake,
  HostedCoreAdmissionFake,
  buildC2Describe,
  projectElementTable,
  buildWenderState,
  makeProposal,
  runPythonAgentsBridge,
  runTask1FormFill,
  runTask2TwoPageFlow,
  runTask3ReadTable,
};
