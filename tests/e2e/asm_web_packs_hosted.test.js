import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { HostedWebCapsuleFake, HostedCoreAdmissionFake, makeProposal } = require('./asm_web_fakes.cjs');
const runner = fileURLToPath(new URL('./e2e1_slice/asm_web_live.py', import.meta.url));
const builtins = fileURLToPath(new URL('./packs/builtin-fixtures/', import.meta.url));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const externalHTML = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head><body><p id="external-marker" data-bbox="0,0,100,20">EXTERNAL_READY</p><p id="second-marker">EXTERNAL_SECOND</p><a href="#external-marker">Marker</a></body></html>\n`;

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-packs-Música-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function copyPack(t, name = 'T1', staticHTML = true) {
  const dest = path.join(temporary(t), 'pack');
  fs.cpSync(path.join(builtins, name), dest, { recursive: true });
  // General external mutation fixtures are static; the raw-copy regression
  // below separately proves that built-in script privilege is location based.
  if (staticHTML) {
    editPack(dest, spec => {
      for (const page of Object.keys(spec.fixtures)) {
        const file = path.join(dest, 'pages', page + '.html');
        const html = fs.readFileSync(file, 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace("script-src 'unsafe-inline'", "script-src 'none'");
        fs.writeFileSync(file, html);
        spec.fixtures[page] = sha(html);
      }
    });
  }
  return dest;
}
function editPack(directory, change) {
  const file = path.join(directory, 'automation.json');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(spec);
  fs.writeFileSync(file, JSON.stringify(spec));
}
function externalPack(t) {
  const root = temporary(t), directory = path.join(root, 'external');
  fs.mkdirSync(path.join(directory, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'pages', 'external.html'), externalHTML);
  fs.writeFileSync(path.join(directory, 'automation.json'), JSON.stringify({
    schema: 'metaviewer.automation/v1', name: 'external', version: '1.0.0',
    mode: 'offline', start: 'external', steps: ['read:EXTERNAL_READY'], budget: 0,
    expect: ['EXTERNAL_READY', 'EXTERNAL_SECOND'], fixtures: { external: sha(externalHTML) },
  }));
  return { root, directory };
}

// [TARGET, unit decision] Backend substitution only: orchestration, pack
// admission, pin/CSP checks, budgets, AX and receipt gates execute in Python.
async function hosted(packArgs = [], environment = {}, mutation = '') {
  const capsule = new HostedWebCapsuleFake({ identity: 'mv-live-1' });
  let core, latest, report, previousClick, external = false;
  const calls = [];
  const wire = [];
  const child = spawn(process.env.PYTHON || 'python3', [runner, '--hosted-rpc', ...packArgs], {
    env: { ...process.env, MV_AUTOMATIONS_DIR: '', MV_LIVE_WEB: '',
      PYTHONDONTWRITEBYTECODE: '1', ...environment }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  // [TARGET, unit decision] Navigation boundary fake: chrome begins with its
  // omnibox selected and retains an untouched restore bubble. Real op_navigate
  // owns the sequence and changed_region plans; this fake renders the focus cue.
  const navigationUrls = [];
  let navigation, navFrame, navPending, navGeneration = 0;
  const navigationFrame = () => {
    const pixels = Buffer.alloc(1280 * 900 * 3, 255);
    // Selection/focus cue in browser chrome, outside blank page content.
    for (let y = 30; y < 60; y++) {
      pixels.fill(navigation.focus === 'omnibox' ? 50 : 240,
        (y * 1280 + 100) * 3, (y * 1280 + 700) * 3);
    }
    for (let y = 80; y < 210; y++) {
      pixels.fill(100, (y * 1280 + 950) * 3, (y * 1280 + 1270) * 3);
    } // Persistent restore bubble.
    if (navigation.typed) pixels.writeUInt32LE(navigation.text.length, 0);
    if (navigation.loaded) pixels[4] = 20;
    navFrame = { surface_id: capsule.surfaceId, width: 1280, height: 900,
      generation: ++navGeneration, sha256: sha(pixels) };
    return navFrame;
  };
  const dispatch = (stage, args) => {
    calls.push(stage);
    switch (stage) {
      case 'start': case 'ownership': return { profile: 'mv-live-1', capsules: [capsule.capsuleId] };
      case 'offline_proof': return { fixtures_offline: mutation !== 'net-up' };
      case 'navigate_begin':
        navigationUrls.push(args.url);
        assert.equal(calls.at(-2), 'offline_proof');
        navigation = { focus: 'omnibox', selected: true, typed: false,
          loaded: false, text: '', page: args.page, url: args.url, marker: args.marker };
        return {};
      case 'navigation_offline_proof': return { fixtures_offline: true };
      case 'navigation_observe': return { frame_ref: navigationFrame() };
      case 'navigation_ax': return { elements: [{ name: navigation.marker }] };
      case 'navigation_propose': {
        assert.deepEqual(args.sensed.frame, navFrame, 'fresh custody-bound setup frame');
        assert.equal(args.max_ms, 30000);
        assert.deepEqual(args.plan.expectation, { type: 'changed_region',
          bbox: { x: 0, y: 0, w: 1280, h: 900 } });
        const action = args.plan.action;
        const refusal = capsule.typeRefusal({ kind: action.type, text: action.text });
        if (refusal) return refusal;
        if (action.type === 'click') {
          assert.ok(action.x > 0 && action.x < 640 && action.y > 450 && action.y < 900);
          navigation.focus = 'content';
          navigation.selected = false;
        } else if (action.type === 'key' && action.keys.join('+') === 'ctrl+l') {
          navigation.focus = 'omnibox'; navigation.selected = true;
        } else if (action.type === 'type') {
          assert.equal(navigation.focus, 'omnibox');
          assert.equal(navigation.selected, navigation.text.length === 0);
          assert.ok(Array.from(action.text).length <= 2000);
          navigation.text += action.text;
          assert.ok(navigation.url.startsWith(navigation.text));
          navigation.selected = false;
          navigation.typed = true;
        } else {
          assert.deepEqual(action, { type: 'key', keys: ['Return'] });
          assert.equal(navigation.typed, true);
          assert.equal(navigation.text, navigation.url);
          navigation.loaded = true;
        }
        const id = `navigation-${navGeneration}`;
        navPending = { before: args.sensed.frame, after: navigationFrame(), id };
        return { proposal_id: id, verdict: { admitted: true }, verified: false, error: '',
          native_evidence: { input_mono_ns: navGeneration } };
      }
      case 'navigation_wait_verify': {
        assert.equal(args.admitted.proposal_id, navPending.id);
        if (navPending.before.sha256 === navPending.after.sha256) {
          throw Object.assign(new Error('VERIFICATION_FAILED: unchanged chrome pixels'),
            { code: 'VERIFICATION_FAILED' });
        }
        return { status: 'verified', receipt: { proposal_id: navPending.id,
          verified: true, after_frame: navPending.after }, focus_verified: true,
          input_mono_ns: navGeneration, frame_sha256: navPending.after.sha256,
          receipt_binding_negative_control: 'PASS' };
      }
      case 'navigate': {
        assert.ok(calls.includes('offline_proof'));
        assert.ok(!calls.some(x => /^net(?:_|$)/.test(x)));
        assert.equal(navigation.loaded, true);
        assert.equal(navigation.text, args.url);
        const html = decodeURIComponent(args.url.slice(args.url.indexOf(',') + 1));
        assert.ok(html.includes("default-src 'none'"));
        external = args.page === 'external';
        if (external) {
          assert.equal(html, externalHTML);
          assert.equal(args.marker, 'EXTERNAL_READY');
          // The fake's public page state is the hosted native boundary. This
          // page's bytes and marker are supplied solely by the external pack.
          capsule.pageState.elements = [{ id: 'external-marker', tag: 'p', role: 'status',
            name: 'EXTERNAL_READY', text: 'EXTERNAL_READY', row: null, col: null,
            bbox: { x: 0, y: 0, w: 100, h: 20 } },
            { id: 'second-marker', tag: 'p', role: 'status', name: 'EXTERNAL_SECOND',
              text: 'EXTERNAL_SECOND', row: null, col: null, bbox: { x: 0, y: 30, w: 100, h: 20 } }];
        } else capsule.loadPage(args.page);
        core = new HostedCoreAdmissionFake(capsule, { stepBudget: args.page === 'table' || external ? 0 : 12 });
        return [];
      }
      case 'observe': latest = core.observe(); wire.push(latest.observation); return latest.observation;
      case 'perceive': {
        const frame = latest.frameRef, bytes = fs.readFileSync(frame.shm_path);
        assert.equal(sha(bytes), frame.sha256);
        return { frame, table: latest.elementTable, frame_witness: {
          sha256: sha(bytes), bytes: bytes.length, generation: frame.generation,
          surface_id: frame.surface_id, artifact: frame.shm_path } };
      }
      case 'state': return latest.wenderState;
      case 'plan': {
        const [kind, ...rest] = args.goal.split(':'), value = rest.join(':');
        if (kind === 'read') {
          assert.ok(args.sensed.read_expected?.length, 'read_expected is required');
          const values = args.sensed.state.nodes.map(e => e.name)
            .filter(name => args.sensed.read_expected.includes(name));
          const cell = args.sensed.report_cell;
          return { values, ...(cell ? { row: cell.row, col: cell.col, value: values[cell.index] } : {}) };
        }
        if (kind === 'type') {
          assert.ok(previousClick);
          assert.equal(args.sensed.typing_target, previousClick);
          previousClick = undefined;
          return { action: { kind: 'type', text: value } };
        }
        previousClick = value;
        const target = capsule.pageState.elements.find(e => e.name === value);
        assert.ok(target, `named target ${value}`);
        const { x, y, w, h } = target.bbox;
        return { action: { kind: 'click', x: x + Math.floor(w / 2),
          y: y + Math.floor(h / 2), button: 'left' }, bbox: target.bbox };
      }
      case 'propose': {
        const proposal = makeProposal(capsule.capsuleId, args.sensed.frame,
          args.plan.action, args.plan.bbox, calls.length);
        const result = core.proposeAndExecute(proposal, args.plan.bbox, { skipWaitVerify: true });
        wire.push(result.verdict, result.receipt);
        return { proposal_id: proposal.nonce,
          native_evidence: { input_mono_ns: result.receipt.input_mono_ns } };
      }
      case 'wait_verify': {
        const r = core.waitVerify(args.admitted.proposal_id);
        return { status: 'verified', receipt: { ...r, proposal_id: args.admitted.proposal_id,
          verified: true, after_frame: r.post_frame_ref }, focus_verified: r.focus_verified,
        input_mono_ns: r.input_mono_ns, receipt_binding_negative_control: 'PASS', frame_sha256: r.frame_sha256 };
      }
      case 'ax': {
        if (mutation === 'ax-missing') return { nodes: [] };
        const tree = capsule.readAxTextContainer();
        if (mutation === 'ax-reversed') tree.nodes.reverse();
        return tree;
      }
      // Native address-bar setup also commits records for read-only packs.
      case 'replay': return { status: 'PASS', digest: sha(JSON.stringify(wire)),
        committed_records: calls.filter(c => c === 'propose' || c === 'navigate').length, corrupt_rc: 1 };
      case 'cleanup': capsule.cleanup(); return { container_cleanup: 'PASS', wire_evidence: wire,
        process_cleanup: { status: 'PASS', temporary_tree_absent: true, socket_absent: true },
        ram_cleanup: { status: 'PASS', ram_absent: true } };
      default: throw new Error(`unexpected stage ${stage}`);
    }
  };
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.report) { report = message.report; return; }
      try { child.stdin.write(JSON.stringify({ result: dispatch(message.rpc, message.args) }) + '\n'); }
      catch (error) { child.stdin.write(JSON.stringify({ error: error.message }) + '\n'); }
    } catch (error) { stderr += String(error); child.kill(); }
  });
  try {
    const rc = await new Promise((resolve, reject) => {
      child.on('error', reject); child.on('close', resolve);
    });
    assert.ok(report, stderr);
    return { rc, report, calls };
  } finally { clearTimeout(timer); lines.close(); capsule.cleanup(); }
}

test('built-in packs reproduce T1-T3 through hosted RPC', async () => {
  const { rc, report } = await hosted();
  assert.equal(rc, 0, JSON.stringify(report.error));
  assert.deepEqual(report.tasks.map(t => [t.task, t.verdict, t.steps]),
    [['T1', 'PASS', 3], ['T2', 'PASS', 2], ['T3', 'PASS', 0]]);
  assert.deepEqual(report.tasks.map(t => t.ax_proofs.flatMap(p => p.expected)), [
    ['EMPTY', 'Hello, Ada Lovelace'], ['FLOW_STEP_2_CONFIRMED', 'FLOW_STAGE_A_READY'],
    ['auth-gateway', 'eu-central', '14', 'ledger-core', 'us-east', '27', 'stream-index', 'ap-north', '41'],
  ]);
  assert.deepEqual(report.tasks[2].reported_cell, { row: 1, col: 2, value: '27' });
  for (const name of ['T1', 'T2', 'T3']) {
    const spec = JSON.parse(fs.readFileSync(path.join(builtins, name, 'automation.json')));
    for (const [page, pin] of Object.entries(spec.fixtures)) {
      const bytes = fs.readFileSync(path.join(builtins, name, 'pages', page + '.html'));
      assert.equal(sha(bytes), pin);
      assert.deepEqual(bytes, fs.readFileSync(fileURLToPath(new URL(`./asm_web_pages/${page}.html`, import.meta.url))));
    }
  }
});

test('MUT-DEFAULT-PACKS: discovery stays exactly T1-T3 with META available only explicitly', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from automation_pack import BUILTINS, load_packs
assert [p.document['name'] for p in load_packs()] == ['T1', 'T2', 'T3']
assert [p.document['budget'] for p in load_packs()] == [8, 12, 0]
assert [p.document['name'] for p in load_packs([BUILTINS / 'META'])] == ['META']
# Negative contrast: indiscriminate directory discovery must violate the default.
assert [p.document['name'] for p in load_packs(sorted(BUILTINS.iterdir()))] != ['T1', 'T2', 'T3']
`, runner], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('explicit META pack replays MemoryWeb through hosted RPC using its own pinned page', () => {
  const result = spawnSync(process.execPath, [path.join(builtins, 'META', 'hosted.mjs')],
    { encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'PASS');
});

function editHTML(dir, change) {
  const page = path.join(dir, 'pages/form.html');
  const html = change(fs.readFileSync(page, 'utf8'));
  fs.writeFileSync(page, html);
  editPack(dir, spec => { spec.fixtures.form = sha(html); });
}

const rejected = [
  ['MUT-JS-VOID-HREF', 'CSP', dir => editHTML(dir, h => h + '<a href="javascript:void(0)">go</a>')],
  ...['javascript:void(1)', "javascript:fetch('x')"].map((value, i) =>
    [`MUT-JS-ACTION-OTHER-${i}`, 'SCRIPT', dir => editHTML(dir, h => h.replace('action="javascript:void(0)"', `action="${value}"`))]),
  ...['javascript:Void(0)', 'javascript: void(0)', 'javascript:void(0);', 'javascript:void(0) x'].map((value, i) =>
    [`MUT-JS-ACTION-EXACT-${i}`, 'SCRIPT', dir => editHTML(dir, h => h.replace('action="javascript:void(0)"', `action="${value}"`))]),
  ...['<!-- javascript:void(0) -->', '<p>javascript:void(0)</p>', '<script>"javascript:void(0)"</script>', '<p title="javascript:void(0)">go</p>'].map((html, i) =>
    [`MUT-JS-ANYWHERE-${i}`, html.startsWith('<script>') ? 'SCRIPT' : 'CSP', dir => editHTML(dir, h => h + html)]),
  ['MUT-REFRESH', 'CSP', dir => editHTML(dir, h => h + '<meta http-equiv="ReFrEsH" content="0;url=https://e">')],
  ['MUT-HTTP-EQUIV', 'CSP', dir => editHTML(dir, h => h + '<meta http-equiv="x-unknown" content="x">')],
  ['MUT-LOCATION', 'SCRIPT', dir => editHTML(dir, h => h + '<script>location.href="https://e"</script>')],
  ['MUT-ONCLICK-NAV', 'SCRIPT', dir => editHTML(dir, h => h + '<button onclick="location=\'https://e\'">go</button>')],
  ['MUT-C0-HREF', 'CSP', dir => editHTML(dir, h => h + '<a href="&#x01;https://evil.example">go</a>')],
  ['MUT-FORMACTION', 'CSP', dir => editHTML(dir, h => h + '<button formaction="https://e">go</button>')],
  ['MUT-CSS-URL', 'CSP', dir => editHTML(dir, h => h + '<p style="background:url(https://e)">go</p>')],
  ['MUT-STYLE-TEXT', 'CSP', dir => editHTML(dir, h => h + '<style>p{background:url(https://e)}</style>')],
  ['MUT-CSS-EOF', 'CSP', dir => editHTML(dir, h => h + '<style>p{background:url(https://e</style>')],
  ...['src', 'href', 'action', 'srcset', 'poster', 'data', 'cite', 'background',
    'ping', 'xlink:href', 'manifest', 'longdesc', 'codebase', 'archive', 'usemap'].map(attr =>
    [`MUT-URL-${attr}`, 'CSP', dir => editHTML(dir, h => h + `<a ${attr}="https://e">go</a>`)]),
  ...['http:', 'https:', '//e', 'javascript:', 'data:', 'blob:', 'ws:', 'wss:', 'file:', 'ftp:'].map(url =>
    [`MUT-SCHEME-${url}`, 'CSP', dir => editHTML(dir, h => h + `<a href="${url}">go</a>`)]),
  ...['document.location', 'window.location', 'top.location', 'parent.location',
    'self.location', 'opener.location', 'window["location"]', 'window.open("/x")',
    'open("/x")', 'location.assign("/x")', 'location.replace("/x")',
    'document.write("x")', 'history.pushState({}, "", "/x")',
    'history.replaceState({}, "", "/x")', 'eval("x")', 'Function("x")',
    'setTimeout("x", 1)', 'setInterval("x", 1)', 'import("/x")'].map((source, i) =>
    [`MUT-SCRIPT-${i}`, 'SCRIPT', dir => editHTML(dir, h => h + `<script>${source}</script>`)]),
  ['MUT-C0-INTERNAL', 'CSP', dir => editHTML(dir, h => h + '<a href="ht&#x09;tps://e">go</a>')],
  ['MUT-SRCSET-CANDIDATE', 'CSP', dir => editHTML(dir, h => h + '<img srcset="local.png 1x, https://e 2x">')],
  ['MUT-PING-CANDIDATE', 'CSP', dir => editHTML(dir, h => h + '<a ping="/local https://e">go</a>')],
  ['MUT-CSP-OVERRIDE', 'CSP', dir => editHTML(dir, h => h.replace("script-src 'none'", 'script-src https://evil.example'))],
  ['MUT-KEY-CHROME', 'STEPS', dir => editPack(dir, s => { s.steps[1] = 'key:ctrl+l'; })],
  ...['alt+Left', 'meta+l', 'super+l', 'F1', 'F12'].map(key =>
    [`MUT-KEY-${key}`, 'STEPS', dir => editPack(dir, s => { s.steps[1] = 'key:' + key; })]),
  ['MUT-REMOTE-SRC', 'CSP', dir => editHTML(dir, h => h + '<img src="https://evil.example/x">')],
  ['MUT-CSP-CONNECT-OVERRIDE', 'CSP', dir => editHTML(dir, h => h.replace("default-src 'none'", "default-src 'none'; connect-src https://evil.example"))],
  ['MUT-CSP-DISAGREE', 'CSP', dir => editHTML(dir, h => h + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`)],
  ['MUT-BASE', 'CSP', dir => editHTML(dir, h => h + '<base href="/">')],
  ...['preload', 'prefetch', 'dns-prefetch', 'preconnect'].map(rel =>
    [`MUT-LINK-${rel}`, 'CSP', dir => editHTML(dir, h => h + `<link rel="${rel}" href="/local">`)]),
  ...['data:', 'blob:', 'ws:', '*', "'unsafe-eval'"].map(token =>
    [`MUT-SOURCE-${token}`, 'CSP', dir => editHTML(dir, h => h.replace("script-src 'none'", `script-src ${token}`))]),
  ['MUT-REPORT-CLOSED', 'SCHEMA', dir => editPack(dir, s => { s.report_cell = { row: 0, col: 0, index: 0, extra: true }; })],
  ['MUT-REPORT-INDEX', 'SCHEMA', dir => editPack(dir, s => { s.report_cell = { row: 0, col: 0, index: 255 }; })],
  ['MUT-PIN', 'PIN', (dir) => fs.appendFileSync(path.join(dir, 'pages/form.html'), '<!-- tampered -->')],
  ['MUT-ESCAPE', 'ESCAPE', (dir, t) => {
    const outside = path.join(temporary(t), 'outside.html');
    fs.copyFileSync(path.join(dir, 'pages/form.html'), outside);
    fs.unlinkSync(path.join(dir, 'pages/form.html'));
    fs.symlinkSync(outside, path.join(dir, 'pages/form.html'));
  }],
  ['MUT-CLOSED', 'SCHEMA', dir => editPack(dir, spec => { spec.hosts = ['example.invalid']; })],
  ['MUT-LIVE', 'LIVE', dir => editPack(dir, spec => { spec.mode = 'live'; })],
  ['MUT-NAVIGATE', 'SCHEMA', dir => editPack(dir, spec => { spec.steps[0] = 'navigate:https://example.invalid'; })],
  ['MUT-BOOL-BUDGET', 'SCHEMA', dir => editPack(dir, spec => { spec.budget = true; })],
  ['MUT-START', 'SCHEMA', dir => editPack(dir, spec => { spec.start = '../form'; })],
  ['MUT-UNPINNED', 'START', dir => editPack(dir, spec => { spec.fixtures = {}; })],
  ['MUT-FINAL-READ', 'STEPS', dir => editPack(dir, spec => { spec.steps.pop(); })],
  ['MUT-CHECKPOINT', 'STEPS', dir => editPack(dir, spec => { spec.steps.shift(); })],
  ['MUT-BUDGET', 'BUDGET', dir => editPack(dir, spec => { spec.budget = 2; })],
  ['MUT-PIN-FORMAT', 'SCHEMA', dir => editPack(dir, spec => { spec.fixtures.form = 'g'.repeat(64); })],
  ['MUT-PAGE-CAP', 'SIZE', dir => fs.writeFileSync(path.join(dir, 'pages/form.html'), Buffer.alloc(1024 * 1024 + 1))],
  ['MUT-JSON-CAP', 'SIZE', dir => fs.appendFileSync(path.join(dir, 'automation.json'), ' '.repeat(65536))],
  ['MUT-DUPLICATE-KEY', 'SCHEMA', dir => {
    const file = path.join(dir, 'automation.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"name":', '"name":"shadow","name":'));
  }],
  ['MUT-CSP', 'CSP', dir => {
    const page = path.join(dir, 'pages/form.html');
    const html = fs.readFileSync(page, 'utf8').replace("default-src 'none'", 'default-src *');
    fs.writeFileSync(page, html);
    editPack(dir, spec => { spec.fixtures.form = sha(html); });
  }],
];
for (const [name, code, mutate] of rejected) {
  test(`${name}: refused before backend allocation`, async t => {
    const dir = copyPack(t);
    mutate(dir, t);
    const result = await hosted(['--pack', dir]);
    assert.equal(result.rc, 1);
    assert.equal(result.report.error.code, 'E2E_PACK_' + code);
    if (name === 'MUT-LIVE') assert.match(result.report.error.detail, /WEB-NET-2/);
    assert.deepEqual(result.calls, []);
    if (code === 'SCRIPT') {
      // Preserve the earlier built-in token/attribute negative controls too:
      // the external static gate must not mask a regression in safe_script.
      const scan = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from automation_pack import PageFacts, PackError
try:
    PageFacts(Path(sys.argv[2]).read_text(), builtin=True)
except PackError as error:
    assert error.code == 'E2E_PACK_CSP', error.code
else:
    raise AssertionError('built-in defense-in-depth scan accepted mutant')
`, path.dirname(runner), path.join(dir, 'pages/form.html')], {
        encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      assert.equal(scan.status, 0, scan.stdout + scan.stderr);
    }
  });
}

for (const value of ['JaVaScRiPt:void(0)', '\u0001 JavaScript:void(0) \u001f', 'javascript:void(0)', 'javascript:&#118;oid(0)', 'java&#115;cript:void(0)']) {
  test(`exact inert action admitted: ${JSON.stringify(value)}`, async t => {
    const dir = copyPack(t);
    editHTML(dir, h => h.replace('action="javascript:void(0)"', `action="${value}"`));
    const result = await hosted(['--pack', dir]);
    assert.equal(result.rc, 0, JSON.stringify(result.report.error));
    assert.equal(result.report.tasks[0].verdict, 'PASS');
  });
}

test('MUT-EXT-FORM-ACTION: fragment form submission is refused', async t => {
  const dir = copyPack(t);
  editHTML(dir, h => h.replace('action="javascript:void(0)"', 'action="#"'));
  const result = await hosted(['--pack', dir]);
  assert.equal(result.rc, 1);
  assert.equal(result.report.error.code, 'E2E_PACK_SCRIPT');
  assert.deepEqual(result.calls, []);
});


for (const [name, addition] of [
  ['MUT-EXT-SCRIPT', '<script></script>'],
  ['MUT-EXT-ONCLICK', '<button onclick="">Go</button>'],
  ['MUT-EXT-HREF-WRITE', `<script>const a = document.createElement('a'); a.href = 'https:' + '//evil.example'; document.body.append(a); a.click();</script>`],
  ...['iframe', 'frame', 'object', 'embed'].map(tag => ['MUT-EXT-' + tag.toUpperCase(), `<${tag}></${tag}>`]),
  ['MUT-EXT-SCRIPT-CSP', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">`],
]) {
  test(`${name}: refused before backend allocation`, async t => {
    const { directory } = externalPack(t);
    const file = path.join(directory, 'pages/external.html');
    const html = externalHTML + addition;
    fs.writeFileSync(file, html);
    editPack(directory, spec => { spec.fixtures.external = sha(html); });
    const result = await hosted(['--pack', directory]);
    assert.equal(result.rc, 1);
    assert.equal(result.report.error.code, 'E2E_PACK_SCRIPT');
    assert.deepEqual(result.calls, []);
  });
}

test('unchanged scripted built-in copy is external and refused', async t => {
  const result = await hosted(['--pack', copyPack(t, 'T1', false)]);
  assert.equal(result.rc, 1);
  assert.equal(result.report.error.code, 'E2E_PACK_SCRIPT');
  assert.deepEqual(result.calls, []);
});

test('static external pack with fragment link passes explicit selection', async t => {
  const { directory } = externalPack(t);
  const result = await hosted(['--pack', directory]);
  assert.equal(result.rc, 0, JSON.stringify(result.report.error));
  assert.deepEqual(result.report.tasks[0].reported_values, ['EXTERNAL_READY', 'EXTERNAL_SECOND']);
});

test('MUT-EXTERNAL: environment pack with its own pinned page executes through hosted RPC', async t => {
  const { root } = externalPack(t);
  const { rc, report, calls } = await hosted([], { MV_AUTOMATIONS_DIR: root });
  assert.equal(rc, 0, JSON.stringify(report.error));
  assert.deepEqual(report.tasks.map(t => t.task), ['T1', 'T2', 'T3', 'external']);
  const external = report.tasks.at(-1);
  assert.equal(external.page.source_sha256, sha(externalHTML));
  assert.deepEqual(external.ax_proofs.map(p => p.expected), [['EXTERNAL_READY', 'EXTERNAL_SECOND']]);
  assert.deepEqual(external.reported_values, ['EXTERNAL_READY', 'EXTERNAL_SECOND']);
  assert.equal(external.steps, 0);
  assert.equal(calls.at(-1), 'cleanup');
});

test('repeatable --pack replaces built-ins and honors caller order', async () => {
  const { rc, report } = await hosted(['--pack', path.join(builtins, 'T2'), '--pack', path.join(builtins, 'T1')]);
  assert.equal(rc, 0, JSON.stringify(report.error));
  assert.deepEqual(report.tasks.map(t => t.task), ['T2', 'T1']);
});

for (const mutation of ['net-up', 'ax-missing', 'ax-reversed']) {
  test(`external pack retains ${mutation} failure gate`, async t => {
    const { directory } = externalPack(t);
    const { rc, report, calls } = await hosted(['--pack', directory], {}, mutation);
    assert.equal(rc, 1);
    assert.equal(report.error.code, 'E2E_WITNESS');
    assert.equal(calls.at(-1), 'cleanup');
    if (mutation === 'net-up') assert.ok(!calls.includes('navigate'));
    if (mutation === 'ax-reversed') assert.match(report.error.detail, /document order/);
  });
}

test('generic backend planning preserves typing custody and ordered table proofs', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import json, runpy, sys
from pathlib import Path
root = Path(sys.argv[1]).resolve().parents[3]
sys.path.insert(0, str(root / 'agents'))
web = runpy.run_path(sys.argv[1])
backend = object.__new__(web['LiveBackend'])
failure = web['Failure']
expected = json.loads((root / 'tests/e2e/packs/builtin-fixtures/T3/automation.json').read_text())['expect']
sensed = dict(frame=dict(sha256='frame', width=640, height=360), table={},
              state=dict(nodes=[dict(id='field', name='External Field')], actionable=['field']))
def refused(value, goal):
    try:
        backend.op_plan(value, goal)
    except failure:
        return
    raise AssertionError('planner accepted invalid custody/order')
refused(sensed, 'type:hello')
sensed['typing_target'] = 'External Field'
assert backend.op_plan(sensed, 'type:hello')['action'] == dict(type='type', text='hello')
sensed['typing_target'] = 'Different Field'
refused(sensed, 'type:hello')
refused(sensed, 'key:ctrl+l')
assert backend.op_plan(sensed, 'key:shift+Tab')['action'] == dict(type='key', keys=['shift', 'Tab'])
from metaviewer_agents.tools import _check_key, _check_scroll
_check_key(backend.op_plan(sensed, 'key:shift+Tab')['action'])
for direction in ['up', 'down', 'left', 'right']:
    action = backend.op_plan(sensed, 'scroll:' + direction)['action']
    _check_scroll(action)
    assert (action['dx'] == 0) != (action['dy'] == 0)
sensed['state'] = dict(nodes=[dict(name=x) for x in expected])
refused(sensed, 'read:table')
sensed['read_expected'] = expected
sensed['report_cell'] = dict(row=1, col=2, index=5)
assert backend.op_plan(sensed, 'read:table')['value'] == '27'
sensed['state']['nodes'].reverse()
refused(sensed, 'read:table')
refused(sensed, 'navigate:https://example.invalid')
`, runner], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MV_LIVE_WEB: '' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('MUT-NAME: duplicate T1 names refuse without backend calls', async t => {
  const result = await hosted(['--pack', path.join(builtins, 'T1'), '--pack', copyPack(t)]);
  assert.equal(result.rc, 1);
  assert.equal(result.report.error.code, 'E2E_PACK_NAME');
  assert.deepEqual(result.calls, []);
});

test('MUT-FLOW-PIN: flow_a requires flow_b before backend allocation', async t => {
  const dir = copyPack(t, 'T2');
  editPack(dir, s => { delete s.fixtures.flow_b; });
  const result = await hosted(['--pack', dir]);
  assert.equal(result.rc, 1);
  assert.equal(result.report.error.code, 'E2E_PACK_START');
  assert.deepEqual(result.calls, []);
});
