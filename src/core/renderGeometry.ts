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

/** Device pixel ratio used for rendering, after the canvas-area cap. */
export function effectiveDpr(cssW: number, cssH: number, deviceDpr: number): number {
  let dpr = deviceDpr || 1;
  while (cssW * dpr * cssH * dpr > MAX_CANVAS_AREA && dpr > 0.5) dpr *= 0.8;
  return dpr;
}

/**
 * Backing-store size (integer device pixels) and the CSS box that
 * corresponds exactly to it.
 */
export function backingGeometry(cssW: number, cssH: number, deviceDpr: number):
{ dpr: number; backingW: number; backingH: number; cssW: number; cssH: number } {
  const dpr = effectiveDpr(cssW, cssH, deviceDpr);
  const backingW = Math.round(cssW * dpr);
  const backingH = Math.round(cssH * dpr);
  return { dpr, backingW, backingH, cssW: backingW / dpr, cssH: backingH / dpr };
}
