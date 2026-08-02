import { useEffect, useMemo } from 'react'
import type { DesktopCommand } from '@shared/kun-gui-api'
import {
  findKeyboardShortcutCommand,
  keyboardEventToShortcut,
  resolveKeyboardShortcutBindings,
  type KeyboardShortcutCommandId
} from '@shared/keyboard-shortcuts'
import { useKeyboardShortcutSettings } from '../../lib/keyboard-shortcut-settings'

const DESKTOP_SHORTCUT_COMMANDS: Partial<Record<KeyboardShortcutCommandId, DesktopCommand>> = {
  quit: 'quit',
  undo: 'undo',
  redo: 'redo',
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  'select-all': 'selectAll',
  reload: 'reload',
  'zoom-in': 'zoomIn',
  'zoom-out': 'zoomOut',
  'reset-zoom': 'resetZoom',
  'toggle-devtools': 'toggleDevTools',
  close: 'close',
  minimize: 'minimize',
  'toggle-maximize': 'toggleMaximize'
}

type ComposerMode = 'agent' | 'plan'

export function isWorkbenchNavigationShortcutLocked(
  commandId: KeyboardShortcutCommandId,
  navigationLocked: boolean
): boolean {
  return navigationLocked && (
    commandId === 'new-chat' ||
    commandId === 'choose-workspace' ||
    commandId === 'settings'
  )
}

type UseWorkbenchKeyboardShortcutsInput = {
  composerMode: ComposerMode
  setComposerMode: (mode: ComposerMode) => void
  handleGuiPlanCommand: () => void | Promise<unknown>
  createThread: (options: { useWorktreePool?: boolean; worktreeBranch?: string }) => void | Promise<unknown>
  chooseWorkspace: () => void | Promise<unknown>
  toggleTerminal: () => void
  openSettings: () => void
  useWorktreePool: boolean
  setUseWorktreePool: (enabled: boolean) => void
  worktreeBranch: string
  navigationLocked?: boolean
}

export function useWorkbenchKeyboardShortcuts({
  composerMode,
  setComposerMode,
  handleGuiPlanCommand,
  createThread,
  chooseWorkspace,
  toggleTerminal,
  openSettings,
  useWorktreePool,
  setUseWorktreePool,
  worktreeBranch,
  navigationLocked = false
}: UseWorkbenchKeyboardShortcutsInput): void {
  const keyboardShortcuts = useKeyboardShortcutSettings()
  const shortcutPlatform = typeof window === 'undefined' ? undefined : window.kunGui?.platform
  const keyboardShortcutBindings = useMemo(
    () => resolveKeyboardShortcutBindings(keyboardShortcuts, shortcutPlatform),
    [keyboardShortcuts, shortcutPlatform]
  )

  useEffect(() => {
    const runDesktopShortcut = (command: DesktopCommand): void => {
      if (typeof window.kunGui?.runDesktopCommand !== 'function') return
      void window.kunGui.runDesktopCommand(command)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      const commandId = findKeyboardShortcutCommand(
        keyboardShortcutBindings,
        keyboardEventToShortcut(event)
      )
      if (!commandId) return
      event.preventDefault()

      if (isWorkbenchNavigationShortcutLocked(commandId, navigationLocked)) return

      if (commandId === 'toggle-plan-mode') {
        if (composerMode === 'plan') {
          setComposerMode('agent')
        } else {
          setComposerMode('plan')
          void handleGuiPlanCommand()
        }
        return
      }
      if (commandId === 'new-chat') {
        void createThread({ useWorktreePool, worktreeBranch })
        if (useWorktreePool) setUseWorktreePool(false)
        return
      }
      if (commandId === 'choose-workspace') {
        void chooseWorkspace()
        return
      }
      if (commandId === 'toggle-terminal') {
        toggleTerminal()
        return
      }
      if (commandId === 'settings') {
        openSettings()
        return
      }

      const desktopCommand = DESKTOP_SHORTCUT_COMMANDS[commandId]
      if (desktopCommand) runDesktopShortcut(desktopCommand)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [
    chooseWorkspace,
    composerMode,
    createThread,
    handleGuiPlanCommand,
    keyboardShortcutBindings,
    navigationLocked,
    openSettings,
    setComposerMode,
    setUseWorktreePool,
    toggleTerminal,
    useWorktreePool,
    worktreeBranch
  ])
}
