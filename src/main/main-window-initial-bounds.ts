// Initial main-window bounds.
//
// The fixed 1280x840 default fills the whole work area on small or
// high-DPI-scaled displays (for example a 1280x800 panel at 150% scaling
// has a 1280x752 work area). There the window opens effectively
// full-screen, so restoring from maximize returns to bounds that match the
// maximized size and the restore button looks like a no-op. Keep the
// initial window at most 85% of the work area so restore always shrinks
// visibly, and center it.

export const MAIN_WINDOW_MIN_WIDTH = 960
export const MAIN_WINDOW_MIN_HEIGHT = 640
export const MAIN_WINDOW_DEFAULT_WIDTH = 1280
export const MAIN_WINDOW_DEFAULT_HEIGHT = 840
const MAX_WORK_AREA_FRACTION = 0.85

export type MainWindowBounds = { x: number; y: number; width: number; height: number }

export function resolveMainWindowInitialBounds(workArea: MainWindowBounds): MainWindowBounds {
  const width = Math.min(
    MAIN_WINDOW_DEFAULT_WIDTH,
    Math.max(MAIN_WINDOW_MIN_WIDTH, Math.floor(workArea.width * MAX_WORK_AREA_FRACTION))
  )
  const height = Math.min(
    MAIN_WINDOW_DEFAULT_HEIGHT,
    Math.max(MAIN_WINDOW_MIN_HEIGHT, Math.floor(workArea.height * MAX_WORK_AREA_FRACTION))
  )
  return {
    x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
    width,
    height
  }
}
