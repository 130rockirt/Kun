import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveKeyboardShortcutBindings,
  type KeyboardShortcutBindingsV1
} from '@shared/keyboard-shortcuts'
import {
  isWorkbenchNavigationShortcutLocked,
  resolveWorkbenchShortcutKeyDown,
  runWorkbenchShortcutCommand
} from './useWorkbenchKeyboardShortcuts'

const DARWIN_BINDINGS = resolveKeyboardShortcutBindings(null, 'darwin')

function keyEvent(overrides: Partial<{
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  repeat: boolean
  isComposing: boolean
}> = {}): {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  repeat: boolean
  isComposing: boolean
} {
  return {
    key: 'k',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    repeat: false,
    isComposing: false,
    ...overrides
  }
}

function bindingsWith(bindings: Partial<KeyboardShortcutBindingsV1>): Required<KeyboardShortcutBindingsV1> {
  return resolveKeyboardShortcutBindings({ bindings }, 'darwin')
}

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

describe('resolveWorkbenchShortcutKeyDown', () => {
  it('resolves the palette chord to command-palette by default', () => {
    expect(
      resolveWorkbenchShortcutKeyDown(keyEvent({ key: 'k', metaKey: true }), DARWIN_BINDINGS, {
        slashMenuOpen: false
      })
    ).toBe('command-palette')
  })

  it('yields while the composer slash menu is open and leaves the event unconsumed', () => {
    expect(
      resolveWorkbenchShortcutKeyDown(keyEvent({ key: 'k', metaKey: true }), DARWIN_BINDINGS, {
        slashMenuOpen: true
      })
    ).toBeNull()
  })

  it('suppresses repeated, composing, and default-prevented events', () => {
    expect(
      resolveWorkbenchShortcutKeyDown(
        keyEvent({ key: 'k', metaKey: true, repeat: true }),
        DARWIN_BINDINGS,
        { slashMenuOpen: false }
      )
    ).toBeNull()
    expect(
      resolveWorkbenchShortcutKeyDown(
        keyEvent({ key: 'k', metaKey: true, isComposing: true }),
        DARWIN_BINDINGS,
        { slashMenuOpen: false }
      )
    ).toBeNull()
    expect(
      resolveWorkbenchShortcutKeyDown(
        keyEvent({ key: 'k', metaKey: true, defaultPrevented: true }),
        DARWIN_BINDINGS,
        { slashMenuOpen: false }
      )
    ).toBeNull()
  })

  it('honors a user binding that claims the palette default chord', () => {
    const rebound = bindingsWith({ 'new-chat': ['Meta+K'] })
    expect(
      resolveWorkbenchShortcutKeyDown(keyEvent({ key: 'k', metaKey: true }), rebound, {
        slashMenuOpen: false
      })
    ).toBe('new-chat')
  })

  it('yields the palette chord to any command, not just earlier ones', () => {
    // The palette is registered last precisely so a user binding wins
    // regardless of where the other command sits in the registry.
    for (const commandId of ['close', 'toggle-maximize', 'minimize'] as const) {
      const rebound = bindingsWith({ [commandId]: ['Meta+K'] })
      expect(
        resolveWorkbenchShortcutKeyDown(keyEvent({ key: 'k', metaKey: true }), rebound, {
          slashMenuOpen: false
        })
      ).toBe(commandId)
    }
  })

  it('yields while a native dialog owns input', () => {
    expect(
      resolveWorkbenchShortcutKeyDown(keyEvent({ key: 'k', metaKey: true }), DARWIN_BINDINGS, {
        slashMenuOpen: false,
        nativeDialogOpen: true
      })
    ).toBeNull()
    // Suppression is palette-only; other chords still resolve.
    expect(
      resolveWorkbenchShortcutKeyDown(keyEvent({ key: 'n', ctrlKey: true }), DARWIN_BINDINGS, {
        slashMenuOpen: false,
        nativeDialogOpen: true
      })
    ).toBe('new-chat')
  })

  it('honors a rebound palette chord', () => {
    const rebound = bindingsWith({ 'command-palette': ['Meta+P'] })
    expect(
      resolveWorkbenchShortcutKeyDown(keyEvent({ key: 'p', metaKey: true }), rebound, {
        slashMenuOpen: false
      })
    ).toBe('command-palette')
    expect(
      resolveWorkbenchShortcutKeyDown(keyEvent({ key: 'k', metaKey: true }), rebound, {
        slashMenuOpen: false
      })
    ).toBeNull()
  })
})

describe('runWorkbenchShortcutCommand', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      kunGui: { runDesktopCommand: vi.fn() }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('toggles plan mode and invokes the plan command when enabling', () => {
    const setComposerMode = vi.fn()
    const handleGuiPlanCommand = vi.fn()
    runWorkbenchShortcutCommand('toggle-plan-mode', {
      composerMode: 'agent',
      setComposerMode,
      handleGuiPlanCommand,
      createThread: vi.fn(),
      chooseWorkspace: vi.fn(),
      toggleTerminal: vi.fn(),
      openSettings: vi.fn(),
      useWorktreePool: false,
      setUseWorktreePool: vi.fn(),
      worktreeBranch: ''
    })
    expect(setComposerMode).toHaveBeenCalledWith('plan')
    expect(handleGuiPlanCommand).toHaveBeenCalledTimes(1)
  })

  it('creates a thread with worktree options and clears the pool flag', () => {
    const createThread = vi.fn()
    const setUseWorktreePool = vi.fn()
    runWorkbenchShortcutCommand('new-chat', {
      composerMode: 'agent',
      setComposerMode: vi.fn(),
      handleGuiPlanCommand: vi.fn(),
      createThread,
      chooseWorkspace: vi.fn(),
      toggleTerminal: vi.fn(),
      openSettings: vi.fn(),
      useWorktreePool: true,
      setUseWorktreePool,
      worktreeBranch: 'feature/x'
    })
    expect(createThread).toHaveBeenCalledWith({ useWorktreePool: true, worktreeBranch: 'feature/x' })
    expect(setUseWorktreePool).toHaveBeenCalledWith(false)
  })

  it('ignores navigation-locked commands', () => {
    const createThread = vi.fn()
    const chooseWorkspace = vi.fn()
    const openSettings = vi.fn()
    const context = {
      composerMode: 'agent' as const,
      setComposerMode: vi.fn(),
      handleGuiPlanCommand: vi.fn(),
      createThread,
      chooseWorkspace,
      toggleTerminal: vi.fn(),
      openSettings,
      useWorktreePool: false,
      setUseWorktreePool: vi.fn(),
      worktreeBranch: '',
      navigationLocked: true
    }
    runWorkbenchShortcutCommand('new-chat', context)
    runWorkbenchShortcutCommand('choose-workspace', context)
    runWorkbenchShortcutCommand('settings', context)
    expect(createThread).not.toHaveBeenCalled()
    expect(chooseWorkspace).not.toHaveBeenCalled()
    expect(openSettings).not.toHaveBeenCalled()
  })

  it('runs window-level desktop commands', () => {
    const windowApi = window as unknown as { kunGui: { runDesktopCommand: ReturnType<typeof vi.fn> } }
    runWorkbenchShortcutCommand('quit', {
      composerMode: 'agent',
      setComposerMode: vi.fn(),
      handleGuiPlanCommand: vi.fn(),
      createThread: vi.fn(),
      chooseWorkspace: vi.fn(),
      toggleTerminal: vi.fn(),
      openSettings: vi.fn(),
      useWorktreePool: false,
      setUseWorktreePool: vi.fn(),
      worktreeBranch: ''
    })
    expect(windowApi.kunGui.runDesktopCommand).toHaveBeenCalledWith('quit')
  })
})
