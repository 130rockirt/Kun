import { describe, expect, it } from 'vitest'
import { isWorkbenchNavigationShortcutLocked } from './useWorkbenchKeyboardShortcuts'

describe('isWorkbenchNavigationShortcutLocked', () => {
  it('locks navigation commands during a scoped drawing submission', () => {
    expect(isWorkbenchNavigationShortcutLocked('new-chat', true)).toBe(true)
    expect(isWorkbenchNavigationShortcutLocked('choose-workspace', true)).toBe(true)
    expect(isWorkbenchNavigationShortcutLocked('settings', true)).toBe(true)
  })

  it('keeps non-navigation commands available and unlocks navigation afterwards', () => {
    expect(isWorkbenchNavigationShortcutLocked('toggle-terminal', true)).toBe(false)
    expect(isWorkbenchNavigationShortcutLocked('new-chat', false)).toBe(false)
  })
})
