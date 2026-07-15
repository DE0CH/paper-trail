// Canvas backing-store geometry shared by the viewer, the hover preview,
// and the thumbnail panel: how large a page canvas's backing bitmap may
// be, and the exact CSS box that maps onto it 1:1 (backing / dpr, so the
// bitmap never resamples and glyphs stay crisp). Pure math with no DOM
// dependencies, so the caps are unit-testable.

/** Total backing-pixel budget for one page canvas (memory cap). */
export const MAX_CANVAS_AREA = 64_000_000;

/**
 * Hard per-dimension canvas maximum (Chromium): a canvas beyond it
 * silently becomes a zeroed bitmap — drawing succeeds as a no-op, so a
 * page rendered into one shows permanently blank with no error.
 */
export const MAX_CANVAS_DIM = 16_384;

/**
 * Device pixel ratio used for rendering a cssW×cssH page, reduced only as
 * far as the canvas caps demand. Computed DIRECTLY from the caps — never
 * an iterative reduction with a floor, which can give up with the area
 * still over budget — and honoring the per-dimension maximum, which the
 * area budget alone does not imply (large-format pages, up to
 * 14400×14400pt per the PDF spec, exceed it at high zoom).
 */
export function effectiveDpr(cssW: number, cssH: number, deviceDpr: number): number {
  let dpr = deviceDpr > 0 ? deviceDpr : 1;
  const area = cssW * cssH;
  if (area > 0) dpr = Math.min(dpr, Math.sqrt(MAX_CANVAS_AREA / area));
  if (cssW > 0) dpr = Math.min(dpr, MAX_CANVAS_DIM / cssW);
  if (cssH > 0) dpr = Math.min(dpr, MAX_CANVAS_DIM / cssH);
  return dpr;
}

/**
 * Backing-store size (integer device pixels, inside every cap) and the
 * CSS box that corresponds exactly to it.
 */
export function backingGeometry(cssW: number, cssH: number, deviceDpr: number):
{ dpr: number; backingW: number; backingH: number; cssW: number; cssH: number } {
  const dpr = effectiveDpr(cssW, cssH, deviceDpr);
  // Math.round can land at most half a pixel above an exactly-at-cap
  // product; Math.min keeps the hard dimension cap hard.
  const backingW = Math.min(Math.round(cssW * dpr), MAX_CANVAS_DIM);
  const backingH = Math.min(Math.round(cssH * dpr), MAX_CANVAS_DIM);
  return { dpr, backingW, backingH, cssW: backingW / dpr, cssH: backingH / dpr };
}
