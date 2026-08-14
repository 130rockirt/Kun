import { describe, expect, it } from 'vitest'
import {
  isWriteFocusModeFormControl,
  isWriteFocusModeShortcut,
  writeFocusModeFloatingLayerClassName,
  writeFocusModeShellClassName
} from './write-focus-mode'

describe('isWriteFocusModeShortcut', () => {
  const event = (overrides: Partial<KeyboardEvent> = {}) => ({
    code: 'KeyF',
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    ...overrides
  }) as KeyboardEvent

  it('accepts Ctrl/Command + Shift + F once', () => {
    expect(isWriteFocusModeShortcut(event())).toBe(true)
    expect(isWriteFocusModeShortcut(event({ ctrlKey: false, metaKey: true }))).toBe(true)
  })

  it('rejects incomplete, repeated, composing, and Alt-modified shortcuts', () => {
    expect(isWriteFocusModeShortcut(event({ shiftKey: false }))).toBe(false)
    expect(isWriteFocusModeShortcut(event({ repeat: true }))).toBe(false)
    expect(isWriteFocusModeShortcut(event({ isComposing: true }))).toBe(false)
    expect(isWriteFocusModeShortcut(event({ altKey: true }))).toBe(false)
    expect(isWriteFocusModeShortcut(event({ defaultPrevented: true }))).toBe(false)
  })

  it('leaves form-control shortcuts to dialogs and other focused inputs', () => {
    expect(isWriteFocusModeFormControl({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isWriteFocusModeFormControl({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
    expect(isWriteFocusModeFormControl({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false)
  })

  it('uses the titlebar-safe viewport layer without covering higher-priority dialogs', () => {
    expect(writeFocusModeShellClassName(true)).toContain('ds-titlebar-fixed-overlay')
    expect(writeFocusModeShellClassName(true)).toContain('write-focus-mode-shell')
    expect(writeFocusModeShellClassName(true)).toContain('z-[60]')
    expect(writeFocusModeShellClassName(true)).not.toContain('backdrop-blur-xl')
    expect(writeFocusModeShellClassName(false)).toContain('bg-ds-card')
    expect(writeFocusModeShellClassName(false)).toContain('pb-3')
    expect(writeFocusModeShellClassName(false)).toContain('sm:pb-4')
    expect(writeFocusModeShellClassName(false)).not.toContain('rounded-2xl')
    expect(writeFocusModeShellClassName(false)).not.toContain('backdrop-blur-xl')
    expect(writeFocusModeShellClassName(true)).not.toContain('pb-3')
    expect(writeFocusModeFloatingLayerClassName(true, 'z-50')).toBe('z-[65]')
    expect(writeFocusModeFloatingLayerClassName(false, 'z-50')).toBe('z-50')
    expect(writeFocusModeFloatingLayerClassName(true, 'z-40')).not.toBe('z-[80]')
  })
})
