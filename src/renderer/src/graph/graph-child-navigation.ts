import { useChatStore } from '../store/chat-store'
import { useGraphStore } from './graph-store'

const CHILD_THREAD_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000] as const

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

/**
 * Opens a just-created child thread with the same bounded retry behavior used
 * by the TUI. The Graph run continues on the shared server while a short 404
 * race is retried; no runtime or child execution is restarted.
 */
export async function openGraphChildThread(childThreadId: string): Promise<boolean> {
  const initial = useGraphStore.getState().childReturnTarget
  if (!initial || initial.childThreadId !== childThreadId) return false
  useGraphStore.getState().updateChildSessionStatus('creating')

  for (const delay of CHILD_THREAD_RETRY_DELAYS_MS) {
    await wait(delay)
    const target = useGraphStore.getState().childReturnTarget
    if (!target || target.openedAt !== initial.openedAt) return false
    await useChatStore.getState().selectThread(childThreadId)
    if (useChatStore.getState().activeThreadId === childThreadId) {
      useGraphStore.getState().updateChildSessionStatus('open')
      return true
    }
  }

  const target = useGraphStore.getState().childReturnTarget
  if (target?.openedAt === initial.openedAt) {
    useGraphStore.getState().updateChildSessionStatus('failed')
    // selectThread aborts the currently active transcript stream before it
    // resolves the destination thread. Restore the parent subscription when
    // every child lookup missed, while keeping the failed child context visible
    // so the user can retry without losing the selected Graph node.
    await useChatStore.getState().selectThread(target.parentThreadId)
  }
  return false
}
