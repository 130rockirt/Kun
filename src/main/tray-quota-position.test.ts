import { describe, expect, it } from 'vitest'
import { resolveTrayQuotaPopoverPosition } from './tray-quota-position'

describe('resolveTrayQuotaPopoverPosition', () => {
  it('centers a popover below a top menu-bar tray icon', () => {
    expect(resolveTrayQuotaPopoverPosition({
      trayBounds: { x: 820, y: 0, width: 24, height: 24 },
      windowSize: { width: 420, height: 640 },
      workArea: { x: 0, y: 24, width: 1440, height: 876 }
    })).toEqual({ x: 622, y: 32 })
  })

  it('places a popover above a bottom taskbar tray icon', () => {
    expect(resolveTrayQuotaPopoverPosition({
      trayBounds: { x: 1600, y: 1040, width: 24, height: 24 },
      windowSize: { width: 420, height: 640 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 }
    })).toEqual({ x: 1402, y: 392 })
  })

  it('clamps the horizontal position to the display work area', () => {
    expect(resolveTrayQuotaPopoverPosition({
      trayBounds: { x: 4, y: 0, width: 24, height: 24 },
      windowSize: { width: 420, height: 640 },
      workArea: { x: 0, y: 24, width: 1440, height: 876 }
    })).toEqual({ x: 8, y: 32 })
  })

  it('keeps an oversized popover anchored inside a small work area', () => {
    expect(resolveTrayQuotaPopoverPosition({
      trayBounds: { x: 170, y: 0, width: 20, height: 20 },
      windowSize: { width: 420, height: 640 },
      workArea: { x: 0, y: 20, width: 400, height: 600 }
    })).toEqual({ x: 8, y: 28 })
  })
})
