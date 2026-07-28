import { describe, expect, it } from 'vitest'
import {
  resolveTrayQuotaAnchorBounds,
  resolveTrayQuotaPopoverPosition
} from './tray-quota-position'

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

  it('positions above a Windows taskbar on a negative-origin secondary display', () => {
    expect(resolveTrayQuotaPopoverPosition({
      trayBounds: { x: -1700, y: 1040, width: 24, height: 24 },
      windowSize: { width: 420, height: 660 },
      workArea: { x: -1920, y: 0, width: 1920, height: 1040 }
    })).toEqual({ x: -1898, y: 372 })
  })

  it('positions below a Windows taskbar docked at the top', () => {
    expect(resolveTrayQuotaPopoverPosition({
      trayBounds: { x: 1510, y: 0, width: 24, height: 40 },
      windowSize: { width: 420, height: 660 },
      workArea: { x: 0, y: 40, width: 1920, height: 1040 }
    })).toEqual({ x: 1312, y: 48 })
  })
})

describe('resolveTrayQuotaAnchorBounds', () => {
  it('keeps valid Electron tray bounds unchanged', () => {
    const bounds = { x: 1600, y: 1040, width: 24, height: 24 }
    expect(resolveTrayQuotaAnchorBounds(bounds, { x: 10, y: 20 })).toBe(bounds)
  })

  it('falls back to a pointer-centered anchor when Windows reports empty bounds', () => {
    expect(resolveTrayQuotaAnchorBounds(
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 1900, y: 1060 }
    )).toEqual({ x: 1888, y: 1048, width: 24, height: 24 })
  })
})
