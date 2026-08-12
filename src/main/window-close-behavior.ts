import type { WindowCloseAction } from '../shared/app-settings'

export type MainWindowCloseDecision = 'allow' | 'hide-to-tray' | 'prompt'

export type MainWindowCloseState = {
  closeAction?: WindowCloseAction
  isQuitting: boolean
  isUpdateInstallQuitting: boolean
  trayAvailable?: boolean
}

export function resolveMainWindowCloseDecision(state: MainWindowCloseState): MainWindowCloseDecision {
  if (state.isQuitting || state.isUpdateInstallQuitting) return 'allow'
  if (state.closeAction === 'quit') return 'allow'
  if (state.closeAction === 'tray' && state.trayAvailable !== false) return 'hide-to-tray'
  return 'prompt'
}
