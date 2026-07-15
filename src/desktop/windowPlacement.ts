// Validation of remembered window bounds against the displays that are
// connected right now. Pure — unit-tested without Electron.

export interface Rect { x: number; y: number; width: number; height: number }
export interface SavedBounds { width: number; height: number; x?: number; y?: number }

/**
 * How much of the window (px, in each axis) must land on a display for
 * a remembered position to count as usable — enough of the title bar to
 * see and grab.
 */
const MIN_VISIBLE = 64;

/**
 * A remembered window position is kept only while it still lands on a
 * connected display: after a monitor unplug (or a resolution change)
 * the saved x/y can sit entirely outside every screen, restoring an
 * invisible window that makes the app look broken. The size survives
 * either way; an unusable position is dropped so the OS places the
 * window itself.
 */
export function placeWindow(saved: SavedBounds, workAreas: Rect[]): SavedBounds {
  const { x, y, width, height } = saved;
  if (x === undefined || y === undefined) return { width, height };
  const usable = workAreas.some((a) =>
    Math.min(x + width, a.x + a.width) - Math.max(x, a.x) >= MIN_VISIBLE
    && Math.min(y + height, a.y + a.height) - Math.max(y, a.y) >= MIN_VISIBLE);
  return usable ? { x, y, width, height } : { width, height };
}
