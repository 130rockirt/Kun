import { useChatStore } from '../../store/chat-store'
import type { UseWorkbenchComposerSubmitControllerParams } from './workbench-composer-submit-types'

export function restoreWorkbenchWritePrompt(
  value: string,
  setInput: UseWorkbenchComposerSubmitControllerParams['setInput']
): void {
  // The composer state is shared across routes. Never prepend a stale Work
  // prompt to text the user has started composing in Chat or Design.
  if (useChatStore.getState().route !== 'write') return
  setInput((current) => {
    if (!value) return current
    if (!current) return value
    if (current.trim() === value || current.startsWith(`${value}\n\n`)) return current
    return `${value}\n\n${current}`
  })
}
