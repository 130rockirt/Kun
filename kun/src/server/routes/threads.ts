import { z } from 'zod'
import {
  CreateThreadRequest,
  ClearThreadGoalResponse,
  ClearThreadTodosResponse,
  DeleteThreadResponse,
  ForkThreadRequest,
  ListThreadsResponse,
  SetThreadGoalRequest,
  SetThreadTodosRequest,
  ThreadGoalResponse,
  ThreadSchema,
  ThreadTodosResponse,
  UpdateThreadRequest,
  type ThreadRecord
} from '../../contracts/threads.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import type { ForkThreadOptions, ListThreadsOptions, ThreadService } from '../../services/thread-service.js'
import type { RuntimeError } from './runtime-error.js'
import type { SessionStore } from '../../ports/session-store.js'
import type { UserInputGate } from '../../ports/user-input-gate.js'
import type { ApprovalGate } from '../../ports/approval-gate.js'
import type { Turn } from '../../contracts/turns.js'
import {
  isPublicTurnItem,
  type ApprovalTurnItem,
  type TurnItem
} from '../../contracts/items.js'
import type { ApprovalRequest } from '../../domain/approval.js'
import { placeCompactionsChronologically } from '../../loop/compaction-history.js'

/**
 * Handlers for the thread CRUD endpoints. The handlers accept a
 * pre-validated body when possible and otherwise parse it through
 * the contract Zod schema. Validation failures return HTTP 400.
 */
const BooleanQuery = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return value
}, z.boolean())

const ListThreadsQuery = z.object({
  limit: z.preprocess((value) => {
    if (typeof value !== 'string' || value.trim() === '') return undefined
    return Number(value)
  }, z.number().int().positive().max(500).optional()),
  search: z.string().optional(),
  include_archived: BooleanQuery.optional(),
  archived_only: BooleanQuery.optional(),
  /**
   * Comma-separated list of additional categories to include. Currently
   * the only opt-in category is `side` (side conversations are hidden
   * from the default listing).
   */
  include: z.string().optional()
})

export async function listThreads(
  service: ThreadService,
  request: Request
): Promise<JsonResponse> {
  const parsed = parseListThreadsOptions(request)
  if (!parsed.ok) return parsed.response
  const threads = await service.list(parsed.options)
  const payload: ListThreadsResponse = { threads }
  return jsonResponse(payload)
}

export async function createThread(
  service: ThreadService,
  request: Request
): Promise<JsonResponse | Response> {
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = CreateThreadRequest.safeParse(body.value)
  if (!parsed.success) {
    return validationError('invalid create thread body', parsed.error.issues)
  }
  const thread = await service.create(parsed.data)
  return jsonResponse(ThreadSchema.parse(projectPublicThreadRecord(thread)), 201)
}

export async function getThread(
  service: ThreadService,
  threadId: string,
  sessionStore?: SessionStore,
  userInputGate?: UserInputGate,
  approvalGate?: ApprovalGate
): Promise<JsonResponse> {
  // Freeze the replay floor before reading the projection. Runtime writers
  // persist terminal/tool/goal state before appending the corresponding event,
  // so those records at or below this boundary are visible to the reads below.
  // Streaming text deltas follow the same state-first ordering and carry a
  // text offset, making a fragment replayed from the opposite hydration window
  // idempotent. Every event appended after this floor therefore remains safely
  // replayable without creating either an old-state/new-cursor gap or duplicate
  // assistant text.
  const latestSeq = sessionStore ? await sessionStore.highestSeq(threadId) : 0
  const thread = await service.get(threadId)
  if (!thread) {
    return jsonResponse(
      { code: 'not_found', message: `thread not found: ${threadId}` },
      404
    )
  }
  const pendingApprovals = approvalGate?.pending(threadId) ?? []
  let sessionItems: TurnItem[] = []
  if (sessionStore) {
    sessionItems = await sessionStore.loadItems(threadId)
    sessionItems = await healSessionItemsForFinishedTurns(thread, sessionItems, sessionStore)
  } else if (pendingApprovals.length > 0) {
    // Tests and lightweight embedded callers can omit the session store. Use
    // the thread's in-memory items as the merge base so recovering a live
    // approval never replaces the rest of that turn with only the card.
    sessionItems = thread.turns.flatMap((turn) => turn.items)
  }
  // Goal context belongs to canonical model history only. It has no event and
  // must not become visible through the GET snapshot used to hydrate the
  // renderer after reconnect or restart.
  sessionItems = sessionItems.filter(isPublicTurnItem)
  // Tool approvals intentionally remain event-only in history. A live gate is
  // the authoritative source during SSE recovery, so materialize only the
  // currently actionable requests rather than replaying the full events log
  // on every thread-detail poll.
  sessionItems = mergePendingApprovalItems(sessionItems, pendingApprovals)
  const hydratedThread = projectPublicThreadRecord(hydrateThreadItemsFromSession(thread, sessionItems))
  // Request ids the runtime is still actively awaiting. The renderer uses these
  // to tell a live ask-user prompt (answerable across reconnects) apart from a
  // stale `pending` item rehydrated from a finished thread (issue #606).
  const pendingUserInputIds = userInputGate?.pending(threadId).map((request) => request.id) ?? []
  // The renderer uses this live-gate list to distinguish an actionable approval
  // from a stale pending card rehydrated after its runtime request expired.
  const pendingApprovalIds = approvalGate
    ? pendingApprovals.map((request) => request.id)
    : undefined
  return jsonResponse({
    ...ThreadSchema.parse(hydratedThread),
    latestSeq,
    pendingUserInputIds,
    ...(pendingApprovalIds ? { pendingApprovalIds } : {})
  })
}

function mergePendingApprovalItems(
  sessionItems: TurnItem[],
  pendingApprovals: readonly ApprovalRequest[]
): TurnItem[] {
  if (pendingApprovals.length === 0) return sessionItems
  const byApprovalId = new Map(pendingApprovals.map((approval) => [approval.id, approval]))
  const foundApprovalIds = new Set<string>()
  const merged = sessionItems.map((item) => {
    if (item.kind !== 'approval') return item
    const approval = byApprovalId.get(item.approvalId)
    if (!approval) return item
    foundApprovalIds.add(approval.id)
    return approvalItemFromRequest(approval, item)
  })
  const additions = pendingApprovals
    .filter((approval) => !foundApprovalIds.has(approval.id))
    .map((approval) => approvalItemFromRequest(approval))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))

  for (const item of additions) {
    const firstLaterItem = merged.findIndex(
      (candidate) => candidate.turnId === item.turnId && candidate.createdAt > item.createdAt
    )
    if (firstLaterItem >= 0) {
      merged.splice(firstLaterItem, 0, item)
      continue
    }
    const lastTurnItem = merged.reduce(
      (index, candidate, candidateIndex) => candidate.turnId === item.turnId ? candidateIndex : index,
      -1
    )
    if (lastTurnItem >= 0) merged.splice(lastTurnItem + 1, 0, item)
    else merged.push(item)
  }
  return merged
}

function approvalItemFromRequest(
  approval: ApprovalRequest,
  existing?: ApprovalTurnItem
): ApprovalTurnItem {
  return {
    id: existing?.id ?? `item_${approval.id}`,
    turnId: approval.turnId,
    threadId: approval.threadId,
    role: 'tool',
    createdAt: existing?.createdAt ?? approval.createdAt,
    kind: 'approval',
    approvalId: approval.id,
    toolName: approval.toolName,
    summary: approval.summary,
    status: 'pending',
    approvalReviewer: 'user'
  }
}

type FinishedTurnStatus = Extract<Turn['status'], 'completed' | 'failed' | 'aborted'>

async function healSessionItemsForFinishedTurns(
  thread: ThreadRecord,
  items: TurnItem[],
  sessionStore: SessionStore
): Promise<TurnItem[]> {
  if (items.length === 0 || thread.turns.length === 0) return items
  const finishedByTurnId = new Map<string, { status: FinishedTurnStatus; finishedAt?: string }>()
  for (const turn of thread.turns) {
    const status = finishedTurnStatus(turn.status)
    if (!status) continue
    finishedByTurnId.set(turn.id, { status, finishedAt: turn.finishedAt })
  }
  if (finishedByTurnId.size === 0) return items

  const healedAt = new Date().toISOString()
  const healedItems: TurnItem[] = []
  const nextItems = items.map((item) => {
    const finished = finishedByTurnId.get(item.turnId)
    if (!finished) return item
    const next = finalizeOpenSessionItem(item, finished.status, finished.finishedAt ?? healedAt)
    if (next !== item) healedItems.push(next)
    return next
  })
  if (healedItems.length === 0) return items

  for (const item of healedItems) {
    try {
      await sessionStore.updateItem(thread.id, item.id, item)
    } catch {
      // Healing is best-effort; the response still uses the repaired view.
    }
  }
  return nextItems
}

function finishedTurnStatus(status: Turn['status']): FinishedTurnStatus | null {
  return status === 'completed' || status === 'failed' || status === 'aborted' ? status : null
}

function finalizeOpenSessionItem(
  item: TurnItem,
  status: FinishedTurnStatus,
  finishedAt: string
): TurnItem {
  if (item.status !== 'pending' && item.status !== 'running') return item
  if (item.kind === 'approval') {
    return { ...item, status: 'expired', finishedAt }
  }
  if (item.kind === 'user_input') {
    return { ...item, status: 'cancelled', finishedAt }
  }
  const itemStatus = status === 'completed' ? 'completed' : status
  return { ...item, status: itemStatus, finishedAt } as TurnItem
}

function hydrateThreadItemsFromSession(thread: ThreadRecord, items: TurnItem[]): ThreadRecord {
  if (thread.turns.length === 0) return thread
  const itemsByTurn = new Map<string, TurnItem[]>()
  for (const item of items) {
    if (!isPublicTurnItem(item)) continue
    const turnItems = itemsByTurn.get(item.turnId) ?? []
    turnItems.push(item)
    itemsByTurn.set(item.turnId, turnItems)
  }
  let changed = false
  const turns = thread.turns.map((turn): Turn => {
    const sessionTurnItems = itemsByTurn.get(turn.id)
    if (sessionTurnItems) {
      changed = true
      return { ...turn, items: placeCompactionsChronologically(sessionTurnItems) }
    }
    const publicItems = turn.items.filter(isPublicTurnItem)
    if (publicItems.length === turn.items.length) return turn
    changed = true
    return { ...turn, items: publicItems }
  })
  return changed ? { ...thread, turns } : thread
}

/**
 * Defense in depth for every HTTP endpoint that returns a ThreadRecord.
 * The durable SessionStore intentionally contains internal goal-context
 * items; an old or manually repaired ThreadRecord may contain one too.
 */
function projectPublicThreadRecord(thread: ThreadRecord): ThreadRecord {
  let changed = false
  const turns = thread.turns.map((turn): Turn => {
    const items = turn.items.filter(isPublicTurnItem)
    if (items.length === turn.items.length) return turn
    changed = true
    return { ...turn, items }
  })
  return changed ? { ...thread, turns } : thread
}

export async function updateThread(
  service: ThreadService,
  threadId: string,
  request: Request
): Promise<JsonResponse | Response> {
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = UpdateThreadRequest.safeParse(body.value)
  if (!parsed.success) {
    return validationError('invalid update thread body', parsed.error.issues)
  }
  try {
    const updated: ThreadRecord = await service.update(threadId, parsed.data)
    return jsonResponse(ThreadSchema.parse(projectPublicThreadRecord(updated)))
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return jsonResponse(
        { code: 'not_found', message: error.message },
        404
      )
    }
    throw error
  }
}

export async function deleteThread(
  service: ThreadService,
  threadId: string
): Promise<JsonResponse> {
  const ok = await service.delete(threadId)
  if (!ok) {
    return jsonResponse(
      { code: 'not_found', message: `thread not found: ${threadId}` },
      404
    )
  }
  const payload: DeleteThreadResponse = { id: threadId, deleted: true }
  return jsonResponse(payload)
}

export async function forkThread(
  service: ThreadService,
  threadId: string,
  request?: Request
): Promise<JsonResponse> {
  let options: ForkThreadOptions = {}
  if (request) {
    const body = await readJsonBody(request)
    if (!body.ok) return body.response
    const parsed = ForkThreadRequest.safeParse(body.value)
    if (!parsed.success) {
      return validationError('invalid fork thread body', parsed.error.issues)
    }
    options = parsed.data ?? {}
  }
  try {
    const fork = await service.fork(threadId, options)
    return jsonResponse(ThreadSchema.parse(projectPublicThreadRecord(fork)), 201)
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return jsonResponse(
        { code: 'not_found', message: error.message },
        404
      )
    }
    throw error
  }
}

export async function getThreadGoal(
  service: ThreadService,
  threadId: string
): Promise<JsonResponse> {
  try {
    const payload: ThreadGoalResponse = { goal: await service.getGoal(threadId) }
    return jsonResponse(payload)
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return jsonResponse(
        { code: 'not_found', message: error.message },
        404
      )
    }
    throw error
  }
}

export async function setThreadGoal(
  service: ThreadService,
  threadId: string,
  request: Request
): Promise<JsonResponse | Response> {
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = SetThreadGoalRequest.safeParse(body.value)
  if (!parsed.success) {
    return validationError('invalid thread goal body', parsed.error.issues)
  }
  try {
    const payload: ThreadGoalResponse = { goal: await service.setGoal(threadId, parsed.data) }
    return jsonResponse(payload)
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return jsonResponse(
        { code: 'not_found', message: error.message },
        404
      )
    }
    if (error instanceof Error && /no goal exists/i.test(error.message)) {
      return jsonResponse(
        { code: 'validation_error', message: error.message },
        400
      )
    }
    throw error
  }
}

export async function clearThreadGoal(
  service: ThreadService,
  threadId: string
): Promise<JsonResponse> {
  try {
    const payload: ClearThreadGoalResponse = { cleared: await service.clearGoal(threadId) }
    return jsonResponse(payload)
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return jsonResponse(
        { code: 'not_found', message: error.message },
        404
      )
    }
    throw error
  }
}

export async function getThreadTodos(
  service: ThreadService,
  threadId: string
): Promise<JsonResponse> {
  try {
    const payload: ThreadTodosResponse = { todos: await service.getTodos(threadId) }
    return jsonResponse(payload)
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return jsonResponse(
        { code: 'not_found', message: error.message },
        404
      )
    }
    throw error
  }
}

export async function setThreadTodos(
  service: ThreadService,
  threadId: string,
  request: Request
): Promise<JsonResponse | Response> {
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = SetThreadTodosRequest.safeParse(body.value)
  if (!parsed.success) {
    return validationError('invalid thread todos body', parsed.error.issues)
  }
  try {
    const payload: ThreadTodosResponse = { todos: await service.setTodos(threadId, parsed.data) }
    return jsonResponse(payload)
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return jsonResponse(
        { code: 'not_found', message: error.message },
        404
      )
    }
    if (error instanceof Error && /todo|plan|in_progress|content/i.test(error.message)) {
      return jsonResponse(
        { code: 'validation_error', message: error.message },
        400
      )
    }
    throw error
  }
}

export async function clearThreadTodos(
  service: ThreadService,
  threadId: string
): Promise<JsonResponse> {
  try {
    const payload: ClearThreadTodosResponse = { cleared: await service.clearTodos(threadId) }
    return jsonResponse(payload)
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return jsonResponse(
        { code: 'not_found', message: error.message },
        404
      )
    }
    throw error
  }
}

function validationError(message: string, issues: unknown): JsonResponse {
  const body: RuntimeError = {
    code: 'validation_error',
    message,
    details: issues
  }
  return jsonResponse(body, 400)
}

// Re-export for tests
export const _internal = { readJsonBody, parseListThreadsOptions }

function parseListThreadsOptions(
  request: Request
): { ok: true; options: ListThreadsOptions } | { ok: false; response: JsonResponse } {
  const url = new URL(request.url)
  const parsed = ListThreadsQuery.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return {
      ok: false,
      response: validationError('invalid list threads query', parsed.error.issues)
    }
  }
  const includeSide = (parsed.data.include ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .includes('side')
  return {
    ok: true,
    options: {
      limit: parsed.data.limit,
      search: parsed.data.search,
      includeArchived: parsed.data.include_archived,
      archivedOnly: parsed.data.archived_only,
      includeSide
    }
  }
}

void z
