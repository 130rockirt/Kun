import type { AgentProvider, NormalizedThread, ThreadDetail } from '../agent/types'
import type { ThreadActionRuntime } from './chat-store-thread-actions-support'
import { cancelThreadRecoveriesExcept } from './thread-recovery-coordinator'
import { threadPrewarmHandleIsCurrent, type ThreadPrewarmHandle } from './thread-detail-prewarm'

export function beginThreadSelection(
  runtime: ThreadActionRuntime,
  currentThreadId: string | null,
  targetThreadId: string
): number {
  runtime.threadSelectionGeneration += 1
  if (currentThreadId !== targetThreadId) {
    runtime.threadHydrationAbort?.abort()
    runtime.threadHydrationAbort = undefined
    cancelThreadRecoveriesExcept(targetThreadId)
  }
  return runtime.threadSelectionGeneration
}

export function startThreadHydration(runtime: ThreadActionRuntime): AbortController {
  const controller = new AbortController()
  runtime.threadHydrationAbort = controller
  return controller
}

export function loadForegroundThreadDetail(
  provider: AgentProvider,
  threadId: string,
  signal: AbortSignal
): Promise<ThreadDetail> {
  return provider.getThreadDetail(threadId, { signal, priority: 'foreground' })
}

/**
 * Hydrate a selected thread's timeline, adopting an in-flight background
 * prewarm request when one is available. The prewarm promise is bound to the
 * prewarm coordinator's own controller (hover leave, recovery activity), not
 * to this selection's signal, so a prewarm rejection must fall back to a
 * fresh foreground request instead of surfacing as a selection failure.
 */
export async function hydrateThreadDetail(
  provider: AgentProvider,
  threadId: string,
  prewarmHandle: ThreadPrewarmHandle | null,
  readCurrentThread: () => NormalizedThread | null,
  signal: AbortSignal
): Promise<ThreadDetail> {
  if (prewarmHandle) {
    let detail: ThreadDetail | undefined
    try {
      detail = await prewarmHandle.promise
    } catch {
      // This selection itself was cancelled; keep the silent-abort contract.
      signal.throwIfAborted()
      // Otherwise the prewarm controller aborted for its own reasons; refetch.
    }
    // Read the thread snapshot after the await: the sidebar may refresh
    // thread metadata while the prewarm request is in flight, and a stale
    // detail must not be adopted under the new fingerprint.
    if (detail && threadPrewarmHandleIsCurrent(prewarmHandle, readCurrentThread())) {
      return detail
    }
  }
  return loadForegroundThreadDetail(provider, threadId, signal)
}

/**
 * Cancellation of an unrelated in-flight request (prewarm coordinator,
 * superseded subscription) is not a selection failure. Chromium's default
 * message for `controller.abort()` without a reason reads
 * "signal is aborted without reason".
 */
export function isThreadHydrationCancellation(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error) {
    return error.name === 'AbortError' || /\babort/i.test(error.message)
  }
  return false
}

export function finishThreadHydration(
  runtime: ThreadActionRuntime,
  controller: AbortController
): void {
  if (runtime.threadHydrationAbort === controller) runtime.threadHydrationAbort = undefined
}
