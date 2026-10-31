// REC-STATE test helpers: ESM-vue SFC compile (one vue instance, so reactive
// stores and compiled components track each other), a deterministic fake
// clock and literal-mutation utilities. Portable: paths derive from import.meta.url.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { applyMutation, importMutant, mount, nodes, textOf, byId, flush, UI_ROOT } from './capfix-helpers.mjs';

export { applyMutation, importMutant, mount, nodes, textOf, byId, flush, UI_ROOT };

let serial = 0;
const ICON = { name: 'SidebarIconStub', props: { name: { type: String, default: '' } }, render() { return vue.h('i', { 'data-icon': this.name }); } };

/** Stub for the kit record button used by the wall chrome (renders the phase label). */
export const RECORD_BUTTON_STUB = {
  name: 'SaasRecordButtonStub',
  props: { capsuleId: String, capsuleLabel: String, phase: String, disabled: Boolean, unavailableReason: String },
  render() { return vue.h('button', { 'data-phase': this.phase }, this.phase === 'recording' ? 'Stop' : 'Record'); },
};
export { ICON as SIDEBAR_ICON_STUB };

/**
 * Compile a ui SFC to a component. Bare `vue` resolves to the ESM build used
 * by the test; `.kit/**` SidebarIcon is stubbed; other specifiers map through
 * `specifiers` (absolute URL overrides) or `components` (stub objects).
 * @param {string} relFromUi Path below ui/.
 * @param {ReadonlyArray<readonly [string,string]>} [edits] Literal source mutations.
 * @param {{ specifiers?: Record<string,string>, components?: Record<string,unknown> }} [maps]
 */
export async function sfc(relFromUi, edits = [], maps = {}) {
  const url = new URL(relFromUi, UI_ROOT);
  const source = applyMutation(readFileSync(fileURLToPath(url), 'utf8'), edits);
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: `recstate-${serial}`, inlineTemplate: true });
  const components = { ...(maps.components ?? {}) };
  const slot = `__recstate_${serial}`;
  const code = compiled.content.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
    if (spec === 'vue') return `import ${binding} from ${JSON.stringify(import.meta.resolve('vue'))};`;
    if (spec.endsWith('shell/SidebarIcon.vue')) components[spec] = ICON;
    if (spec in components) return `const ${binding.trim()} = globalThis.${slot}[${JSON.stringify(spec)}];`;
    const target = maps.specifiers?.[spec] ?? new URL(spec, url).href;
    return `import ${binding} from ${JSON.stringify(target)};`;
  });
  globalThis[slot] = components;
  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
  } finally {
    delete globalThis[slot];
  }
}

/**
 * Write a mutated copy of a ui module to a temp dir and return its URL.
 * Relative and bare specifiers are rewritten to absolute URLs.
 * @param {string} relFromUi
 * @param {ReadonlyArray<readonly [string,string]>} edits
 * @returns {{ href: string, cleanup: () => void }}
 */
export function mutantModule(relFromUi, edits) {
  const url = new URL(relFromUi, UI_ROOT);
  const source = applyMutation(readFileSync(fileURLToPath(url), 'utf8'), edits);
  const rewritten = source.replace(/(\bfrom\s+|\bimport\s+)(['"])([^'"]+)\2/g, (all, lead, quote, spec) => {
    const target = spec.startsWith('.') ? new URL(spec, url).href : import.meta.resolve(spec);
    return `${lead}${quote}${target}${quote}`;
  });
  const dir = mkdtempSync(join(tmpdir(), 'recstate-mutant-'));
  const file = join(dir, `mutant-${serial++}.mjs`);
  writeFileSync(file, rewritten);
  return { href: pathToFileURL(file).href, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Deterministic clock with interval support. `advance(ms)` moves time and
 * fires each live interval once per elapsed period.
 */
export function fakeClock(start = 0) {
  const state = { t: start, next: 1, timers: new Map(), started: 0, cleared: 0 };
  return {
    state,
    now: () => state.t,
    setInterval(callback, ms) {
      const id = state.next++;
      state.started++;
      state.timers.set(id, { callback, ms, due: state.t + ms });
      return id;
    },
    clearInterval(id) { if (state.timers.delete(id)) state.cleared++; },
    get active() { return state.timers.size; },
    advance(ms) {
      const end = state.t + ms;
      for (;;) {
        const due = [...state.timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        const [id, timer] = due;
        state.t = timer.due;
        timer.due += timer.ms;
        timer.callback();
        if (!state.timers.has(id)) continue;
      }
      state.t = end;
    },
    /** Move local time without firing intervals (a stalled event loop). */
    jump(ms) { state.t += ms; },
  };
}

/** A reactive capture store with the entry shape of createCaptureState. */
export function storeWith(surfaceId, entry = {}) {
  const store = {
    bySurface: vue.reactive({ [surfaceId]: { phase: 'idle', recordingId: null, frames: 0, elapsedMs: 0, lastShot: null, lastCode: '', ...entry } }),
    rows: vue.reactive([]),
    calls: [],
    async toggleRecord(...args) { store.calls.push(args); return { ok: true, recording_id: 'rec-1' }; },
    async screenshot() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
    async refresh() { return { ok: true }; },
    async exportCapture() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
    dispose() {},
  };
  return store;
}

/** Assert that `check` passes on the faithful module and fails on a mutant. */
export async function mutantMustFail(check, label) {
  let failed = false;
  try { await check(); } catch { failed = true; }
  assert.ok(failed, `mutant survived: ${label}`);
}
