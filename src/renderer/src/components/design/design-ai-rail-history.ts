import type { ChatBlock, NormalizedThread, RuntimeConnectionStatus } from '../../agent/types'
import { DESIGN_ASSISTANT_THREAD_TITLE } from '../../design/design-thread-registry'

export function designThreadTitleLooksDefault(
  title: string | null | undefined,
  localizedDefaultTitle?: string
): boolean {
  const raw = title?.trim() ?? ''
  if (!raw) return true
  return raw === DESIGN_ASSISTANT_THREAD_TITLE || raw === localizedDefaultTitle?.trim()
}

export type DesignHistoryMenuEntry = {
  id: string
  title: string
  updatedAt: string | null
}

export function designHistoryMenuEntries(options: {
  registeredThreadIds: readonly string[]
  designThreads: readonly NormalizedThread[]
  localizedDefaultTitle: string
  fallbackTitle: (index: number) => string
}): DesignHistoryMenuEntry[] {
  const sourceIds = options.registeredThreadIds.length > 0
    ? options.registeredThreadIds
    : options.designThreads.map((thread) => thread.id)
  return [...new Set(sourceIds)].map((id, index) => {
    const thread = options.designThreads.find((candidate) => candidate.id === id) ?? null
    return {
      id,
      title: thread && !designThreadTitleLooksDefault(thread.title, options.localizedDefaultTitle)
        ? thread.title
        : options.fallbackTitle(index),
      updatedAt: thread?.updatedAt ?? null
    }
  })
}

export function canClearDesignHistory(options: {
  runtimeConnection: RuntimeConnectionStatus
  busy: boolean
  viewingChildThread: boolean
  hasHistory: boolean
}): boolean {
  return (
    options.runtimeConnection === 'ready' &&
    !options.busy &&
    !options.viewingChildThread &&
    options.hasHistory
  )
}

export function designHistoryInteractionsLocked(options: {
  historyClearing: boolean
  historyMutationPending: boolean
}): boolean {
  return options.historyClearing || options.historyMutationPending
}

export function hasClearableDesignHistory(options: {
  hasRegisteredHistory: boolean
  registeredHistoryCount?: number
  designThreads: readonly NormalizedThread[]
  showingDocumentThread: boolean
  blocks: readonly ChatBlock[]
  liveReasoning: string
  liveAssistant: string
}): boolean {
  const registeredHistoryCount = options.registeredHistoryCount ?? (options.hasRegisteredHistory ? 1 : 0)
  if (registeredHistoryCount > 1) return true
  if (options.designThreads.length === 0) return registeredHistoryCount > 0
  if (options.designThreads.length > 1) return true
  if (
    options.designThreads.some((thread) =>
      Boolean(thread.preview?.trim() || thread.summary?.trim())
    )
  ) return true
  return options.showingDocumentThread && (
    options.blocks.length > 0 ||
    options.liveReasoning.trim().length > 0 ||
    options.liveAssistant.trim().length > 0
  )
}

export function designRailHeaderTitle(options: {
  drawingTitle: string
  fallbackTitle: string
  viewingChildThread: boolean
}): string {
  return options.drawingTitle.trim() || options.fallbackTitle
}
