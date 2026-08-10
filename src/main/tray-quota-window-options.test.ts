import { describe, expect, it } from 'vitest'
import {
  resolveTrayQuotaWindowPlatformOptions,
  resolveTrayQuotaWorkspaceOptions
} from './tray-quota-window-options'

describe('tray quota window options', () => {
  it('keeps the macOS app in the Dock when creating the menu-bar popover', () => {
    expect(resolveTrayQuotaWindowPlatformOptions('darwin')).toEqual({ type: 'panel' })
    expect(resolveTrayQuotaWorkspaceOptions('darwin')).toEqual({
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
  })

  it.each(['win32', 'linux'] as const)(
    'keeps the tray popover out of the %s taskbar',
    (platform) => {
      expect(resolveTrayQuotaWindowPlatformOptions(platform)).toEqual({ skipTaskbar: true })
      expect(resolveTrayQuotaWorkspaceOptions(platform)).toEqual({ visibleOnFullScreen: true })
    }
  )
})
