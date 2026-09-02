import type { AgentProvider, ThreadDetail } from '../agent/types'
import type { ThreadActionRuntime } from './chat-store-thread-actions-support'
import { cancelThreadRecoveriesExcept } from './thread-recovery-coordinator'

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

export function finishThreadHydration(
  runtime: ThreadActionRuntime,
  controller: AbortController
): void {
  if (runtime.threadHydrationAbort === controller) runtime.threadHydrationAbort = undefined
}
