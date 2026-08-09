import { describe, expect, it } from 'vitest'
import {
  normalizeDesktopTitleBarMode,
  resolveDesktopTitleBarMode,
  usesCustomDesktopTitleBar
} from './desktop-title-bar'

describe('desktop title bar mode', () => {
  it('lets only Linux opt into the system title bar', () => {
    expect(resolveDesktopTitleBarMode('linux', false)).toBe('custom')
    expect(resolveDesktopTitleBarMode('linux', true)).toBe('system')
    expect(resolveDesktopTitleBarMode('win32', true)).toBe('custom')
    expect(resolveDesktopTitleBarMode('darwin', false)).toBe('system')
  })

  it('normalizes renderer arguments to a platform-safe mode', () => {
    expect(normalizeDesktopTitleBarMode('linux', 'system')).toBe('system')
    expect(normalizeDesktopTitleBarMode('linux', 'unexpected')).toBe('custom')
    expect(normalizeDesktopTitleBarMode('win32', 'system')).toBe('custom')
    expect(normalizeDesktopTitleBarMode('darwin', 'custom')).toBe('system')
  })

  it('reports whether the renderer owns the desktop title bar', () => {
    expect(usesCustomDesktopTitleBar('linux', 'custom')).toBe(true)
    expect(usesCustomDesktopTitleBar('linux', 'system')).toBe(false)
    expect(usesCustomDesktopTitleBar('win32', 'system')).toBe(true)
    expect(usesCustomDesktopTitleBar('darwin', 'custom')).toBe(false)
  })
})
