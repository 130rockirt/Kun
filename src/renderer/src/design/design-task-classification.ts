import type { NormalizedThread } from '../agent/types'
import {
  isDesignThreadId,
  readDesignThreadRegistry,
  type DesignThreadRegistry
} from './design-thread-registry'

type DesignClassifiableThread = Pick<
  NormalizedThread,
  'agentSurface' | 'designProfile' | 'lockedTaskSurface'
>

export function isLegacyDesignWorkbenchThread(
  threadId: string | null | undefined,
  thread: DesignClassifiableThread | null | undefined,
  registry: DesignThreadRegistry = readDesignThreadRegistry()
): boolean {
  return thread?.agentSurface === 'design' || isDesignThreadId(threadId, registry)
}

/** Canonical renderer classifier for a Design conversation in the Code workbench. */
export function isDesignWorkbenchThread(
  threadId: string | null | undefined,
  thread: DesignClassifiableThread | null | undefined,
  registry: DesignThreadRegistry = readDesignThreadRegistry()
): boolean {
  if (isLegacyDesignWorkbenchThread(threadId, thread, registry)) return true
  if (!thread) return false
  if (thread.lockedTaskSurface) return thread.lockedTaskSurface === 'design'
  return Boolean(thread.designProfile)
}
