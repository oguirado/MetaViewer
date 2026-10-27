/**
 * MVUI24 lane S (RV9 NEW-01): raw host surface ids must not leak into DOM
 * ids or QA anchors. Safe ids pass through byte-identical; hostile ids map
 * to a deterministic grammar-valid segment.
 *
 * Runs under the repository `node --test` gate; bounded inputs only, no DOM.
 * Fails before the fix: `surfaceCanvasDomId('a b/c')` interpolates the raw
 * id (`mv-surface-canvas-a b/c`, invalid HTML id) and the anchor gains a
 * fourth segment (`capsule/a b/c/slot`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  surfaceCanvasAnchor,
  surfaceCanvasDomId,
} from '../src/surfaces/tileScheduler.js';
import * as tileScheduler from '../src/surfaces/tileScheduler.js';

const { surfaceIdSegment, SURFACE_ID_SEGMENT_RE } = tileScheduler;

describe('mvui24-sched NEW-01 surface id segments', () => {
  it('exposes the segment helper and grammar', () => {
    assert.equal(typeof surfaceIdSegment, 'function');
    assert.ok(SURFACE_ID_SEGMENT_RE instanceof RegExp);
  });

  it('keeps safe surface ids byte-identical', () => {
    for (const id of ['capsule-a', 's1', 'A', 'cap-01', 'srf_01.main:slot-2', 'a', 'x'.repeat(64)]) {
      assert.equal(surfaceIdSegment(id), id, `segment passthrough for ${id}`);
      assert.equal(surfaceCanvasDomId(id), `mv-surface-canvas-${id}`, `dom id for ${id}`);
      assert.equal(surfaceCanvasAnchor(id), `capsule/${id}/slot`, `anchor for ${id}`);
    }
  });

  it('sanitizes the hostile RV9 id into a valid DOM id and 3-segment anchor', () => {
    const segment = surfaceIdSegment('a b/c');
    assert.ok(!/[\s/]/.test(segment), `segment carries whitespace/slash: ${segment}`);
    assert.ok(SURFACE_ID_SEGMENT_RE.test(segment), `segment outside grammar: ${segment}`);
    const domId = surfaceCanvasDomId('a b/c');
    assert.ok(!/\s/.test(domId), `DOM id carries whitespace: ${domId}`);
    assert.ok(domId.startsWith('mv-surface-canvas-'), `DOM id prefix lost: ${domId}`);
    const anchor = surfaceCanvasAnchor('a b/c');
    assert.deepEqual(anchor.split('/').length, 3, `anchor shape broken: ${anchor}`);
    assert.ok(anchor.startsWith('capsule/') && anchor.endsWith('/slot'), `anchor family lost: ${anchor}`);
    assert.notEqual(domId, 'mv-surface-canvas-a b/c', 'raw id still interpolated');
    assert.notEqual(anchor, 'capsule/a b/c/slot', 'raw id still interpolated');
  });

  it('stays deterministic and distinct across hostile ids', () => {
    assert.equal(surfaceIdSegment('a b/c'), surfaceIdSegment('a b/c'), 'not deterministic');
    assert.equal(surfaceCanvasAnchor('a b/c'), surfaceCanvasAnchor('a b/c'), 'anchor not deterministic');
    const ids = ['a b/c', 'a b/d', '.hidden', '_a', '-x', 'x'.repeat(65), 'a/b/c/d', 'a\tb'];
    const segments = ids.map((id) => surfaceIdSegment(id));
    for (const segment of segments) {
      assert.ok(SURFACE_ID_SEGMENT_RE.test(segment), `outside grammar: ${segment}`);
      assert.ok(segment.length <= 61, `over-long segment: ${segment}`);
    }
    assert.equal(new Set(segments).size, segments.length, 'hostile ids collide');
    assert.equal(surfaceIdSegment('a-b-c'), 'a-b-c', 'safe lookalike must pass through');
  });

  it('maps non-string input to a deterministic valid segment without throwing', () => {
    for (const input of [undefined, null, 123, '', '   ']) {
      const first = surfaceIdSegment(input);
      assert.equal(typeof first, 'string');
      assert.ok(SURFACE_ID_SEGMENT_RE.test(first), `outside grammar for ${String(input)}: ${first}`);
      assert.equal(surfaceIdSegment(input), first, 'not deterministic');
    }
  });

  it('negative control: naive interpolation of the hostile id is invalid', () => {
    const naiveDomId = `mv-surface-canvas-${'a b/c'}`;
    const naiveAnchor = `capsule/${'a b/c'}/slot`;
    assert.ok(/\s/.test(naiveDomId), 'control must carry whitespace');
    assert.equal(naiveAnchor.split('/').length, 4, 'control must gain a segment');
  });
});

describe('mvui24-sched NEW-01 memory', () => {
  it('suite rss stays under the 512 MiB ceiling', () => {
    const rss = process.memoryUsage().rss;
    assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  });
});
