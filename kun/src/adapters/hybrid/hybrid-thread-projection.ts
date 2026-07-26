import type { ThreadRecord } from '../../contracts/threads.js'
import { ThreadSchema } from '../../contracts/threads.js'
import type { TurnItem } from '../../contracts/items.js'
import type { Turn } from '../../contracts/turns.js'

export type ThreadMetadataLine = {
  kind: 'thread_metadata'
  version: 1
  timestamp: string
  thread: ThreadRecord
}

export function stripThreadItemBodies(thread: ThreadRecord): ThreadRecord {
  return { ...thread, turns: thread.turns.map((turn) => ({ ...turn, prompt: '', items: [] })) }
}

export function hydrateThreadItems(
  thread: ThreadRecord,
  items: TurnItem[],
  options: { preserveExistingItemsWhenNoFileItems: boolean }
): ThreadRecord {
  if (items.length === 0) return options.preserveExistingItemsWhenNoFileItems ? thread : stripThreadItemBodies(thread)
  const itemsByTurn = new Map<string, TurnItem[]>()
  for (const item of items) itemsByTurn.set(item.turnId, [...(itemsByTurn.get(item.turnId) ?? []), item])
  const knownTurnIds = new Set(thread.turns.map((turn) => turn.id))
  const turns = thread.turns.map((turn): Turn => {
    const turnItems = itemsByTurn.get(turn.id) ?? []
    return {
      ...turn,
      prompt: promptFromItems(turnItems) || turn.prompt,
      attachmentIds: turn.attachmentIds.length > 0 ? turn.attachmentIds : attachmentIdsFromItems(turnItems),
      items: turnItems
    }
  })
  for (const [turnId, turnItems] of itemsByTurn) {
    if (!knownTurnIds.has(turnId)) turns.push(turnFromItems(thread.id, turnId, turnItems, thread.updatedAt))
  }
  turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { ...thread, turns }
}

export function normalizeThreadMetadata(thread: ThreadRecord, entries: ThreadMetadataLine[]): ThreadRecord {
  const recovery = collectTurnMetadata(entries, thread.id)
  const mergedById = new Map<string, Turn>()
  const order: string[] = []
  for (const turn of thread.turns) {
    if (!mergedById.has(turn.id)) order.push(turn.id)
    const existing = mergedById.get(turn.id)
    mergedById.set(turn.id, existing ? mergeTurnMetadata(existing, turn) : turn)
  }
  const turns = order.map((turnId) => applyRecoveredTurnMetadata(mergedById.get(turnId)!, recovery.get(turnId)))
  return turns.length === thread.turns.length && turns.every((turn, index) => turn === thread.turns[index])
    ? thread : { ...thread, turns }
}

type RecoveredTurnMetadata = {
  attachmentIds: string[]
  model?: string
  mode?: Turn['mode']
  guiPlan?: Turn['guiPlan']
}

function collectTurnMetadata(entries: ThreadMetadataLine[], threadId: string): Map<string, RecoveredTurnMetadata> {
  const recovered = new Map<string, RecoveredTurnMetadata>()
  for (const entry of entries) {
    if (entry?.kind !== 'thread_metadata' || entry.thread?.id !== threadId) continue
    const parsed = ThreadSchema.safeParse(entry.thread)
    if (!parsed.success) continue
    for (const turn of parsed.data.turns) {
      const current = recovered.get(turn.id) ?? { attachmentIds: [] }
      recovered.set(turn.id, {
        attachmentIds: mergeStringArrays(current.attachmentIds, turn.attachmentIds),
        ...(turn.model ? { model: turn.model } : current.model ? { model: current.model } : {}),
        ...(turn.mode ? { mode: turn.mode } : current.mode ? { mode: current.mode } : {}),
        ...(turn.guiPlan ? { guiPlan: turn.guiPlan } : current.guiPlan ? { guiPlan: current.guiPlan } : {})
      })
    }
  }
  return recovered
}

function mergeTurnMetadata(previous: Turn, next: Turn): Turn {
  return {
    ...previous, ...next,
    prompt: next.prompt || previous.prompt,
    attachmentIds: mergeStringArrays(previous.attachmentIds, next.attachmentIds),
    activeSkillIds: mergeStringArrays(previous.activeSkillIds, next.activeSkillIds),
    injectedMemoryIds: mergeStringArrays(previous.injectedMemoryIds, next.injectedMemoryIds),
    injectedMemorySummaries: next.injectedMemorySummaries.length > 0 ? next.injectedMemorySummaries : previous.injectedMemorySummaries,
    injectedInstructionSources: next.injectedInstructionSources.length > 0 ? next.injectedInstructionSources : previous.injectedInstructionSources,
    items: mergeTurnItems(previous.items, next.items)
  }
}

function applyRecoveredTurnMetadata(turn: Turn, recovered: RecoveredTurnMetadata | undefined): Turn {
  if (!recovered) return turn
  return {
    ...turn,
    attachmentIds: turn.attachmentIds.length > 0 ? turn.attachmentIds : recovered.attachmentIds,
    ...(turn.model || !recovered.model ? {} : { model: recovered.model }),
    ...(turn.mode || !recovered.mode ? {} : { mode: recovered.mode }),
    ...(turn.guiPlan || !recovered.guiPlan ? {} : { guiPlan: recovered.guiPlan })
  }
}

function mergeTurnItems(previous: TurnItem[], next: TurnItem[]): TurnItem[] {
  if (previous.length === 0) return next
  if (next.length === 0) return previous
  const byId = new Map(previous.map((item) => [item.id, item]))
  for (const item of next) byId.set(item.id, item)
  return [...byId.values()]
}

function turnFromItems(threadId: string, turnId: string, items: TurnItem[], fallbackTime: string): Turn {
  const prompt = promptFromItems(items) || `Turn ${turnId}`
  const createdAt = items[0]?.createdAt ?? fallbackTime
  const hasOpenItem = items.some((item) => item.status === 'pending' || item.status === 'running')
  const hasFailedItem = items.some((item) => item.status === 'failed' || item.status === 'aborted')
  return {
    id: turnId, threadId,
    status: hasOpenItem ? 'running' : hasFailedItem ? 'failed' : 'completed',
    prompt, orchestration: 'direct', steering: [], attachmentIds: attachmentIdsFromItems(items), activeSkillIds: [],
    injectedMemoryIds: [], injectedMemorySummaries: [], injectedInstructionSources: [],
    createdAt,
    finishedAt: hasOpenItem ? undefined : items[items.length - 1]?.finishedAt ?? fallbackTime,
    items
  }
}

function promptFromItems(items: TurnItem[]): string {
  return items.find((item): item is Extract<TurnItem, { kind: 'user_message' }> => item.kind === 'user_message')?.text ?? ''
}

function attachmentIdsFromItems(items: TurnItem[]): string[] {
  const ids = new Set<string>()
  for (const item of items) if (item.kind === 'user_message') {
    for (const id of item.attachmentIds ?? []) if (id.trim()) ids.add(id.trim())
  }
  return [...ids]
}

function mergeStringArrays(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second].filter(Boolean))]
}
