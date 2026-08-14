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

/**
 * A Code-owned conversation that also owns a locked Design document. It keeps
 * the Code task identity (per-turn surface) while carrying a Design artifact
 * badge, instead of being classified as a single Design task.
 */
export function isMixedDesignWorkbenchThread(
  threadId: string | null | undefined,
  thread: DesignClassifiableThread | null | undefined,
  registry: DesignThreadRegistry = readDesignThreadRegistry()
): boolean {
  if (!thread || isLegacyDesignWorkbenchThread(threadId, thread, registry)) return false
  return Boolean(thread.designProfile)
}

/** Canonical renderer classifier for a Design conversation in the Code workbench. */
export function isDesignWorkbenchThread(
  threadId: string | null | undefined,
  thread: DesignClassifiableThread | null | undefined,
  registry: DesignThreadRegistry = readDesignThreadRegistry()
): boolean {
  if (isLegacyDesignWorkbenchThread(threadId, thread, registry)) return true
  if (!thread) return false
  // Code-owned conversations are Design-capable only through a locked Design
  // document; the legacy lockedTaskSurface signal never applies to them.
  return Boolean(thread.designProfile)
}
