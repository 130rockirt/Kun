import { describe, expect, it } from 'vitest'

import {
  MAIN_WINDOW_DEFAULT_HEIGHT,
  MAIN_WINDOW_DEFAULT_WIDTH,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  resolveMainWindowInitialBounds
} from './main-window-initial-bounds'

describe('resolveMainWindowInitialBounds', () => {
  it('keeps the default size centered on large work areas', () => {
    expect(resolveMainWindowInitialBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({
      x: 320,
      y: 100,
      width: MAIN_WINDOW_DEFAULT_WIDTH,
      height: MAIN_WINDOW_DEFAULT_HEIGHT
    })
  })

  it('shrinks below the work area on small or scaled displays so restore stays visible', () => {
    // 1280x800 panel at 150% scaling: work area is smaller than the default
    // window, so the unclamped default would make restore look like a no-op.
    const bounds = resolveMainWindowInitialBounds({ x: 0, y: 0, width: 1280, height: 752 })
    expect(bounds).toEqual({ x: 96, y: 56, width: 1088, height: 640 })
    expect(bounds.width).toBeLessThan(1280)
    expect(bounds.height).toBeLessThan(752)
  })

  it('never goes below the minimum window size on tiny work areas', () => {
    expect(resolveMainWindowInitialBounds({ x: 0, y: 0, width: 800, height: 600 })).toEqual({
      x: 0,
      y: 0,
      width: MAIN_WINDOW_MIN_WIDTH,
      height: MAIN_WINDOW_MIN_HEIGHT
    })
  })

  it('respects the work area offset of non-primary displays', () => {
    expect(resolveMainWindowInitialBounds({ x: 1920, y: 40, width: 1920, height: 1040 })).toEqual({
      x: 2240,
      y: 140,
      width: MAIN_WINDOW_DEFAULT_WIDTH,
      height: MAIN_WINDOW_DEFAULT_HEIGHT
    })
  })
})
