import type { AppRoute, ChatState } from './chat-store-types'
import { readBrowserStorageItem, writeBrowserStorageItem } from '../lib/browser-storage'

export const UNREAD_COMPLETIONS_STORAGE_KEY = 'kun.unreadCompletions.v1'
export const MAX_UNREAD_COMPLETION_IDS = 1_000

type UnreadCompletionRegistry = Record<string, boolean>

type CompletionVisibilityState = Pick<
  ChatState,
  'route' | 'activeThreadId' | 'sideConversations' | 'sidePanel'
>

export type DocumentAttention = {
  visible: boolean
  focused: boolean
}

function normalizedThreadId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeUnreadCompletions(value: unknown): UnreadCompletionRegistry {
  const candidates = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Array.isArray((value as { ids?: unknown }).ids)
        ? (value as { ids: unknown[] }).ids
        : Object.entries(value as Record<string, unknown>).flatMap(([id, unread]) =>
            unread === true ? [id] : []
          )
      : []
  const normalized: UnreadCompletionRegistry = {}
  for (const candidate of candidates) {
    const threadId = normalizedThreadId(candidate)
    if (!threadId || normalized[threadId]) continue
    normalized[threadId] = true
    if (Object.keys(normalized).length >= MAX_UNREAD_COMPLETION_IDS) break
  }
  return normalized
}

export function readUnreadCompletions(): UnreadCompletionRegistry {
  const raw = readBrowserStorageItem(UNREAD_COMPLETIONS_STORAGE_KEY)
  if (!raw) return {}
  try {
    return normalizeUnreadCompletions(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function persistUnreadCompletions(value: unknown): UnreadCompletionRegistry {
  const normalized = normalizeUnreadCompletions(value)
  writeBrowserStorageItem(
    UNREAD_COMPLETIONS_STORAGE_KEY,
    JSON.stringify({ version: 1, ids: Object.keys(normalized) })
  )
  return normalized
}

export function unreadCompletionCount(value: unknown): number {
  return Object.keys(normalizeUnreadCompletions(value)).length
}

export function markUnreadCompletion(
  registry: UnreadCompletionRegistry,
  threadId: string
): UnreadCompletionRegistry {
  const normalized = normalizedThreadId(threadId)
  if (!normalized || registry[normalized] === true) return registry
  return normalizeUnreadCompletions({ ...registry, [normalized]: true })
}

export function clearUnreadCompletion(
  registry: UnreadCompletionRegistry,
  threadId: string
): UnreadCompletionRegistry {
  const normalized = normalizedThreadId(threadId)
  if (!normalized || registry[normalized] !== true) return registry
  const next = { ...registry }
  delete next[normalized]
  return next
}

export function retainUnreadCompletions(
  registry: UnreadCompletionRegistry,
  validThreadIds: Iterable<string>
): UnreadCompletionRegistry {
  const valid = new Set([...validThreadIds].map(normalizedThreadId).filter(Boolean))
  const next: UnreadCompletionRegistry = {}
  let changed = false
  for (const [threadId, unread] of Object.entries(registry)) {
    if (unread === true && valid.has(threadId)) next[threadId] = true
    else changed = true
  }
  return changed ? next : registry
}

export function currentDocumentAttention(): DocumentAttention {
  if (typeof document === 'undefined') return { visible: false, focused: false }
  return {
    visible: document.visibilityState === 'visible',
    focused: typeof document.hasFocus === 'function' && document.hasFocus()
  }
}

function mainConversationRouteIsVisible(route: AppRoute): boolean {
  return route === 'chat' || route === 'claw'
}

export function completionIsCurrentlyVisible(
  state: CompletionVisibilityState,
  threadId: string,
  attention: DocumentAttention = currentDocumentAttention()
): boolean {
  const normalized = normalizedThreadId(threadId)
  if (!normalized || !attention.visible || !attention.focused) return false
  if (state.sideConversations[normalized]) {
    return state.route === 'chat' &&
      state.sidePanel.open &&
      state.sidePanel.activeSideId === normalized
  }
  return mainConversationRouteIsVisible(state.route) && state.activeThreadId === normalized
}

export function clearCurrentlyVisibleUnreadCompletions(
  registry: UnreadCompletionRegistry,
  state: CompletionVisibilityState,
  attention: DocumentAttention = currentDocumentAttention()
): UnreadCompletionRegistry {
  if (!attention.visible || !attention.focused) return registry
  let next = registry
  if (state.activeThreadId && completionIsCurrentlyVisible(state, state.activeThreadId, attention)) {
    next = clearUnreadCompletion(next, state.activeThreadId)
  }
  const activeSideId = state.sidePanel.activeSideId
  if (activeSideId && completionIsCurrentlyVisible(state, activeSideId, attention)) {
    next = clearUnreadCompletion(next, activeSideId)
  }
  return next
}
