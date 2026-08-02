import type { ChatBlock, NormalizedThread } from '../agent/types'
import {
  activeDesignThreadForWorkspace,
  designDocRefForThreadId,
  designDocKey,
  markDesignThread,
  readDesignThreadRegistry,
  saveDesignThreadRegistry,
  type DesignThreadRegistry,
  type DesignThreadWorkspaceRecord
} from './design-thread-registry'
import { persistDesignChatMetaForDoc } from './design-chat-transcript'
import {
  deriveDrawingTitleFromBlocks,
  drawingTitleNeedsBackfill
} from './design-drawing-title'
import { normalizeDesignWorkspaceRoot } from './design-workspace-lifecycle'
import type { DesignDocument } from './design-types'

export type DesignThreadSelectorOptions = {
  threads: NormalizedThread[]
  workspaceRoot?: string | null
  docId?: string | null
  registry?: DesignThreadRegistry
}

export function registeredDesignThreadIdsForDocument(
  options: Omit<DesignThreadSelectorOptions, 'threads'>
): string[] {
  const root = options.workspaceRoot?.trim()
  const docId = options.docId?.trim()
  if (!root || !docId) return []
  const registry = options.registry ?? readDesignThreadRegistry()
  return [...(registry.workspaces[designDocKey(root, docId)]?.threadIds ?? [])]
}

export function designThreadsForDocument(options: DesignThreadSelectorOptions): NormalizedThread[] {
  const root = options.workspaceRoot?.trim()
  const docId = options.docId?.trim()
  if (!root || !docId) return []
  const registry = options.registry ?? readDesignThreadRegistry()
  const key = designDocKey(root, docId)
  const record = registry.workspaces[key]
  if (!record) return []
  const idSet = new Set(record.threadIds)
  return options.threads
    .filter((thread) => idSet.has(thread.id) && thread.archived !== true)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export function designThreadBelongsToDocument(options: DesignThreadSelectorOptions & {
  activeThreadId?: string | null
}): boolean {
  const activeThreadId = options.activeThreadId?.trim()
  if (!activeThreadId) return false
  return registeredDesignThreadIdsForDocument(options).includes(activeThreadId)
}

export function designThreadToSelectForDocument(options: DesignThreadSelectorOptions & {
  activeThreadId?: string | null
  route: string
}): string | null {
  const root = options.workspaceRoot?.trim()
  const docId = options.docId?.trim()
  if (options.route !== 'design' || !root || !docId) return null
  const registry = options.registry ?? readDesignThreadRegistry()
  const record = registry.workspaces[designDocKey(root, docId)]
  const registeredActiveThreadId = record?.activeThreadId || record?.threadIds[0] || null
  const activeThreadId = options.activeThreadId?.trim()
  if (activeThreadId && record?.threadIds.includes(activeThreadId)) return null
  if (!activeThreadId) {
    return designThreadsForDocument(options)[0]?.id ?? registeredActiveThreadId
  }
  const existing = activeDesignThreadForWorkspace(
    root,
    docId,
    options.threads,
    registry
  )
  if (existing?.id === activeThreadId) return null
  return existing?.id ?? registeredActiveThreadId
}

export type DesignThreadSelectionSync =
  | { action: 'none' }
  | { action: 'select'; threadId: string }
  | { action: 'clear' }

export function designThreadSelectionSyncForDocument(options: DesignThreadSelectorOptions & {
  activeThreadId?: string | null
  route: string
}): DesignThreadSelectionSync {
  const activeThreadId = options.activeThreadId?.trim()
  if (options.route !== 'design') return { action: 'none' }
  const threadId = designThreadToSelectForDocument(options)
  if (threadId) return { action: 'select', threadId }
  if (!activeThreadId) return { action: 'none' }
  return designThreadBelongsToDocument(options)
    ? { action: 'none' }
    : { action: 'clear' }
}

export type SwitchDesignThreadOptions = {
  workspaceRoot?: string | null
  docId?: string | null
  threadId: string
  selectThread: (threadId: string) => Promise<void>
  registry?: DesignThreadRegistry
  saveRegistry?: (registry: DesignThreadRegistry) => void
  persistMeta?: typeof persistDesignChatMetaForDoc
  canSwitch?: () => boolean
}

export async function switchDesignThreadForDocument(
  options: SwitchDesignThreadOptions
): Promise<boolean> {
  const root = options.workspaceRoot?.trim()
  const docId = options.docId?.trim()
  const threadId = options.threadId.trim()
  if (!root || !threadId || options.canSwitch?.() === false) return false
  const nextRegistry = markDesignThread(root, docId ?? '', threadId, options.registry ?? readDesignThreadRegistry())
  const saveRegistry = options.saveRegistry ?? saveDesignThreadRegistry
  saveRegistry(nextRegistry)
  void (options.persistMeta ?? persistDesignChatMetaForDoc)({
    workspaceRoot: root,
    docId: docId ?? '',
    stampThreadId: threadId
  }).catch(() => undefined)
  await options.selectThread(threadId)
  return true
}

type RecoverOrphanDesignThreadOptions = {
  route: string
  workspaceRoot?: string | null
  docId?: string | null
  documents: readonly Pick<DesignDocument, 'id' | 'title' | 'titleOrigin'>[]
  threads: readonly NormalizedThread[]
  getThreadDetail: (threadId: string) => Promise<{ blocks: ChatBlock[] }>
  selectThread: (threadId: string) => Promise<void>
  isCurrent: () => boolean
  readRegistry?: () => DesignThreadRegistry
  saveRegistry?: (registry: DesignThreadRegistry) => void
  persistMeta?: typeof persistDesignChatMetaForDoc
}

const orphanDesignThreadClaims = new Set<string>()

function normalizedDrawingTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function recoveredRecord(
  registry: DesignThreadRegistry,
  workspaceRoot: string,
  docId: string,
  threadId: string
): DesignThreadWorkspaceRecord | null {
  return markDesignThread(workspaceRoot, docId, threadId, registry).workspaces[
    designDocKey(workspaceRoot, docId)
  ] ?? null
}

/**
 * Conservatively adopts a legacy Design-only thread whose old renderer lost
 * its drawing registry binding. The on-disk drawing metadata is committed
 * before localStorage and selection, so a crash cannot expose an in-memory-only
 * ownership decision.
 */
export async function recoverOrphanDesignThreadForDocument(
  options: RecoverOrphanDesignThreadOptions
): Promise<boolean> {
  const workspaceRoot = normalizeDesignWorkspaceRoot(options.workspaceRoot ?? '')
  const docId = options.docId?.trim() ?? ''
  if (options.route !== 'design' || !workspaceRoot || !docId || !options.isCurrent()) return false

  const drawing = options.documents.find((document) => document.id === docId)
  if (!drawing || drawingTitleNeedsBackfill(drawing)) return false
  const drawingTitle = normalizedDrawingTitle(drawing.title)
  if (!drawingTitle) return false
  if (
    options.documents.filter(
      (document) => normalizedDrawingTitle(document.title) === drawingTitle
    ).length !== 1
  ) return false

  const readRegistry = options.readRegistry ?? readDesignThreadRegistry
  const initialRegistry = readRegistry()
  const candidates = options.threads.filter((thread) =>
    thread.agentSurface === 'design' &&
    thread.archived !== true &&
    !designDocRefForThreadId(thread.id, initialRegistry)
  )
  if (candidates.length === 0) return false

  const inspected = await Promise.all(candidates.map(async (thread) => {
    try {
      const detail = await options.getThreadDetail(thread.id)
      return {
        readable: true as const,
        threadId: thread.id,
        title: normalizedDrawingTitle(deriveDrawingTitleFromBlocks(detail.blocks))
      }
    } catch {
      return { readable: false as const, threadId: thread.id }
    }
  }))
  // Unreadable candidates make uniqueness unknowable. Legacy misdirected turns
  // can retain their original Code workspace while the drawing lives in the
  // dedicated Design workspace, so every orphan Design history must be checked.
  if (inspected.some((candidate) => !candidate.readable)) return false
  const matches = inspected
    .filter((candidate) => candidate.readable && candidate.title === drawingTitle)
    .map((candidate) => candidate.threadId)
  if (matches.length !== 1 || !options.isCurrent()) return false

  const threadId = matches[0]
  if (!threadId) return false
  if (orphanDesignThreadClaims.has(threadId)) return false
  orphanDesignThreadClaims.add(threadId)
  try {
    if (!options.isCurrent()) return false
    const latestRegistry = readRegistry()
    if (designDocRefForThreadId(threadId, latestRegistry)) return false
    const record = recoveredRecord(latestRegistry, workspaceRoot, docId, threadId)
    if (!record) return false

    const persisted = await (options.persistMeta ?? persistDesignChatMetaForDoc)({
      workspaceRoot,
      docId,
      stampThreadId: threadId,
      record
    })
    if (!persisted || !options.isCurrent()) return false

    const registryBeforeCommit = readRegistry()
    if (designDocRefForThreadId(threadId, registryBeforeCommit)) return false
    const nextRegistry = markDesignThread(workspaceRoot, docId, threadId, registryBeforeCommit)
    ;(options.saveRegistry ?? saveDesignThreadRegistry)(nextRegistry)
    if (!options.isCurrent()) return false
    await options.selectThread(threadId)
    return true
  } finally {
    orphanDesignThreadClaims.delete(threadId)
  }
}
