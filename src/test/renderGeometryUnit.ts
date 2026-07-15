// The canvas caps are the difference between a crisp page and a silently
// blank one: Chromium zeroes the backing store of a canvas that exceeds
// its per-dimension maximum, drawing into it becomes a no-op, and pdf.js
// render() still resolves — so an over-cap page shows permanently blank
// with no error and no retry. These tests pin the shared, pure geometry
// math (src/core/renderGeometry.ts) that the viewer, the hover preview,
// and the thumbnail panel all use to size page canvases.
// Run with `npm run test:unit:render`.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  effectiveDpr, backingGeometry, MAX_CANVAS_AREA, MAX_CANVAS_DIM,
} from '../core/renderGeometry';

test('normal pages render at the full device pixel ratio', () => {
  // US-letter at a typical fit-width scale on a 2x display: far inside caps.
  const g = backingGeometry(612 * 2.23, 792 * 2.23, 2);
  assert.equal(g.dpr, 2);
  assert.equal(g.backingW, Math.round(612 * 2.23 * 2));
  // The CSS box maps 1:1 onto the backing store (no resampling blur).
  assert.ok(Math.abs(g.backingW / g.cssW - g.dpr) < 1e-9);
});

test('a huge page at high zoom stays inside BOTH canvas caps', () => {
  // The PDF spec allows 14400x14400pt pages; at scale 2.8 the CSS box is
  // ~40320px on each side. The dpr must drop as far as the caps demand
  // (an iterative reduction with a floor gives up with the area still
  // over budget, and never respects the per-dimension cap at all).
  const side = 14400 * 2.8;
  const g = backingGeometry(side, side, 2);
  assert.ok(g.backingW <= MAX_CANVAS_DIM, `backingW ${g.backingW} > ${MAX_CANVAS_DIM}`);
  assert.ok(g.backingH <= MAX_CANVAS_DIM, `backingH ${g.backingH} > ${MAX_CANVAS_DIM}`);
  // rounding each dimension can add at most half a pixel per side
  assert.ok(g.backingW * g.backingH <= MAX_CANVAS_AREA + 2 * MAX_CANVAS_DIM,
    `area ${g.backingW * g.backingH} > ${MAX_CANVAS_AREA}`);
  assert.ok(g.dpr > 0, `dpr ${g.dpr} must stay positive`);
});

test('an extreme aspect ratio hits the per-dimension cap', () => {
  // A scroll-like page: the AREA is fine but one dimension alone would
  // exceed the platform maximum and zero the whole canvas.
  const g = backingGeometry(60_000, 500, 2);
  assert.ok(g.backingW <= MAX_CANVAS_DIM, `backingW ${g.backingW} > ${MAX_CANVAS_DIM}`);
  assert.ok(g.backingH >= 1, 'the short side must not collapse to nothing');
});

test('degenerate sizes neither divide by zero nor go negative', () => {
  const zero = backingGeometry(0, 0, 2);
  assert.ok(zero.dpr > 0);
  assert.equal(zero.backingW, 0);
  const bogus = backingGeometry(612, 792, 0); // bogus devicePixelRatio
  assert.equal(bogus.dpr, 1);
});

test('effectiveDpr never exceeds the device ratio', () => {
  assert.equal(effectiveDpr(100, 100, 3), 3);
});
