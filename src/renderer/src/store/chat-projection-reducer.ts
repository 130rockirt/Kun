import type {
  ChatBlock,
  RuntimeErrorEventPayload,
  RuntimeStatusEventPayload,
  ThreadDeltaEvent,
  ToolBlock,
  ToolEventPayload
} from '../agent/types'
import type { RuntimeProjectionAction } from '../agent/runtime-projection-actions'
import { isBackgroundShellNoticeUserMessage } from '@shared/background-shell-notice'
import type { ChatState } from './chat-store-types'
import {
  isOptimisticUserBlockId,
  matchingOptimisticUserBlockId,
  reconcileOptimisticUserBlock,
  upsertUserBlock
} from './chat-store-runtime-helpers'

export type ChatProjectionReducerContext = {
  now: number
  clearRecoveringError: (error: string | null) => string | null
  goalTimelineText: (goal: ChatState['activeThreadGoal'], cleared?: boolean) => string
  runtimeStatusText: (event: RuntimeStatusEventPayload) => string
  runtimeErrorView: (event: RuntimeErrorEventPayload) => {
    summary: string
    message: string
    code?: string
    detail?: string
  }
  upsertRuntimeError: (
    blocks: ChatBlock[],
    block: Extract<ChatBlock, { kind: 'system' }>
  ) => ChatBlock[]
  formatRuntimeError: (error: unknown) => string
  runtimeErrorDetail: (error: unknown) => string
  isInterruptSettledError: (error: unknown, message: string) => boolean
  settlePendingRuntimeWork: (blocks: ChatBlock[]) => ChatBlock[]
  threadSnapshotLooksRunning: (blocks: ChatBlock[], threadStatus?: string) => boolean
}

export function monotonicToolStatus(
  current: ToolBlock['status'],
  incoming: ToolBlock['status']
): ToolBlock['status'] {
  // A persisted replay may contain the historical tool_call_started record
  // after the snapshot already contains its terminal result.  Terminal state
  // is durable; only a running -> terminal transition is actionable.
  return current !== 'running' && incoming === 'running' ? current : incoming
}

function unseenDeltaText(
  delta: ThreadDeltaEvent,
  blocks: ChatBlock[],
  liveText: string,
  liveItemId: string | undefined
): string {
  const offset = delta.deltaOffset
  if (
    !delta.itemId ||
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    // Legacy events have no stable item-relative position and retain the
    // original append-only projection semantics.
    return delta.text
  }

  const blockKind = delta.kind === 'agent_message' ? 'assistant' : 'reasoning'
  const hydrated = blocks.find(
    (block) => block.kind === blockKind && block.id === delta.itemId
  )
  const hydratedText = hydrated && (
    hydrated.kind === 'assistant' || hydrated.kind === 'reasoning'
  ) ? hydrated.text : ''
  const projectedText = hydratedText + (
    liveItemId === delta.itemId ? liveText : ''
  )
  const overlapLength = Math.min(
    delta.text.length,
    Math.max(0, projectedText.length - offset)
  )
  if (
    overlapLength > 0 &&
    projectedText.slice(offset, offset + overlapLength) !== delta.text.slice(0, overlapLength)
  ) {
    // The offset is only a deduplication hint. If the projected prefix does
    // not actually contain this fragment, preserve the payload instead of
    // silently trimming potentially new content.
    return delta.text
  }
  return delta.text.slice(overlapLength)
}

export function flushLiveProjection(
  state: ChatState,
  now: number,
  base: Partial<ChatState> = {}
): Partial<ChatState> {
  let nextBlocks = state.blocks
  const createdAt = new Date(now).toISOString()
  if (state.liveReasoning.trim()) {
    nextBlocks = upsertTimelineBlock(nextBlocks, {
      kind: 'reasoning',
      id: state.liveReasoningItemId ?? `r-${now}`,
      turnId: state.liveReasoningTurnId ?? state.currentTurnId ?? undefined,
      createdAt: state.liveReasoningCreatedAt ?? createdAt,
      text: state.liveReasoning
    })
  }
  if (state.liveAssistant.trim()) {
    nextBlocks = upsertTimelineBlock(nextBlocks, {
      kind: 'assistant',
      id: state.liveAssistantItemId ?? `a-${now}`,
      turnId: state.liveAssistantTurnId ?? state.currentTurnId ?? undefined,
      createdAt: state.liveAssistantCreatedAt ?? createdAt,
      text: state.liveAssistant
    })
  }
  if (
    nextBlocks === state.blocks &&
    !state.liveReasoningItemId &&
    !state.liveReasoningTurnId &&
    !state.liveReasoningCreatedAt &&
    !state.liveAssistantItemId &&
    !state.liveAssistantTurnId &&
    !state.liveAssistantCreatedAt
  ) return base
  return {
    ...base,
    ...(nextBlocks !== state.blocks ? { blocks: nextBlocks } : {}),
    liveReasoning: '',
    liveAssistant: '',
    liveReasoningItemId: undefined,
    liveReasoningTurnId: undefined,
    liveReasoningCreatedAt: undefined,
    liveAssistantItemId: undefined,
    liveAssistantTurnId: undefined,
    liveAssistantCreatedAt: undefined
  }
}

/** Pure state projection for normalized actions; browser work is emitted elsewhere. */
export function reduceChatProjection(
  state: ChatState,
  action: RuntimeProjectionAction,
  context: ChatProjectionReducerContext
): Partial<ChatState> {
  switch (action.type) {
    case 'user_message_received': {
      const event = action.payload
      const flushed = flushLiveProjection(state, context.now)
      const baseBlocks = flushed.blocks ?? state.blocks
      const optimisticUserId = state.currentTurnUserId
      const backgroundNotice = isBackgroundShellNoticeUserMessage({ text: event.text, meta: event.meta })
      const currentOptimisticUserId =
        !backgroundNotice &&
        optimisticUserId &&
        optimisticUserId !== event.itemId &&
        isOptimisticUserBlockId(optimisticUserId) &&
        baseBlocks.some((block) => block.kind === 'user' && block.id === optimisticUserId)
          ? optimisticUserId
          : null
      const optimisticMatchId = currentOptimisticUserId ?? (
        backgroundNotice ? null : matchingOptimisticUserBlockId(baseBlocks, event)
      )
      const reconcileOptimistic = Boolean(optimisticMatchId && optimisticMatchId !== event.itemId)
      const reconciledBlocks = reconcileOptimistic && optimisticMatchId
        ? reconcileOptimisticUserBlock(
            baseBlocks,
            optimisticMatchId,
            event.itemId,
            event.text,
            event.modelLabel
          )
        : baseBlocks
      const currentTurnUserId = backgroundNotice
        ? optimisticUserId
        : currentOptimisticUserId
          ? event.itemId
          : optimisticUserId ?? event.itemId
      const startedAt = runtimeEventStartedAt(event.createdAt, context.now)
      return {
        ...flushed,
        blocks: upsertUserBlock(reconciledBlocks, event),
        busy: true,
        currentTurnId: event.turnId ?? state.currentTurnId,
        currentTurnUserId,
        turnStartedAtByUserId: backgroundNotice
          ? state.turnStartedAtByUserId
          : {
              ...state.turnStartedAtByUserId,
              [event.itemId]: state.turnStartedAtByUserId[event.itemId] ?? startedAt
            },
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'deltas_received': {
      const deltas = action.deltas.filter(
        (delta) => !delta.threadId || !state.activeThreadId || delta.threadId === state.activeThreadId
      )
      if (deltas.length === 0) return {}
      const seqs = deltas
        .map((delta) => delta.seq)
        .filter((value): value is number => typeof value === 'number')
      const patch: Partial<ChatState> = {
        error: context.clearRecoveringError(state.error),
        ...(seqs.length > 0 ? { lastSeq: Math.max(state.lastSeq, ...seqs) } : {})
      }
      let blocks = state.blocks
      let liveReasoning = state.liveReasoning
      let liveReasoningItemId = state.liveReasoningItemId
      let liveReasoningTurnId = state.liveReasoningTurnId
      let liveReasoningCreatedAt = state.liveReasoningCreatedAt
      let liveAssistant = state.liveAssistant
      let liveAssistantItemId = state.liveAssistantItemId
      let liveAssistantTurnId = state.liveAssistantTurnId
      let liveAssistantCreatedAt = state.liveAssistantCreatedAt
      let liveDeltaSeqFloor = state.liveDeltaSeqFloor
      let reasoningFirst = state.turnReasoningFirstAtByUserId
      let reasoningLast = state.turnReasoningLastAtByUserId
      let sawReasoning = false
      let sawUnseenDelta = false
      for (const delta of deltas) {
        if (typeof delta.seq === 'number') {
          if (delta.seq <= liveDeltaSeqFloor) continue
          liveDeltaSeqFloor = delta.seq
        }
        if (delta.kind === 'agent_reasoning') {
          const text = unseenDeltaText(
            delta,
            blocks,
            liveReasoning,
            liveReasoningItemId
          )
          if (!text) continue
          if (delta.itemId && liveReasoningItemId && delta.itemId !== liveReasoningItemId) {
            if (liveReasoning.trim()) {
              blocks = upsertTimelineBlock(blocks, {
                kind: 'reasoning',
                id: liveReasoningItemId,
                turnId: liveReasoningTurnId,
                createdAt: liveReasoningCreatedAt,
                text: liveReasoning
              })
            }
            liveReasoning = ''
          }
          liveReasoningItemId = delta.itemId ?? liveReasoningItemId
          liveReasoningTurnId = delta.turnId ?? liveReasoningTurnId ?? state.currentTurnId ?? undefined
          liveReasoningCreatedAt = delta.createdAt ?? liveReasoningCreatedAt
          liveReasoning += text
          sawReasoning = true
          sawUnseenDelta = true
        } else {
          const text = unseenDeltaText(
            delta,
            blocks,
            liveAssistant,
            liveAssistantItemId
          )
          if (!text) continue
          if (delta.itemId && liveAssistantItemId && delta.itemId !== liveAssistantItemId) {
            if (liveAssistant.trim()) {
              blocks = upsertTimelineBlock(blocks, {
                kind: 'assistant',
                id: liveAssistantItemId,
                turnId: liveAssistantTurnId,
                createdAt: liveAssistantCreatedAt,
                text: liveAssistant
              })
            }
            liveAssistant = ''
          }
          liveAssistantItemId = delta.itemId ?? liveAssistantItemId
          liveAssistantTurnId = delta.turnId ?? liveAssistantTurnId ?? state.currentTurnId ?? undefined
          liveAssistantCreatedAt = delta.createdAt ?? liveAssistantCreatedAt
          liveAssistant += text
          sawUnseenDelta = true
        }
      }
      if (sawUnseenDelta && !state.busy) patch.busy = true
      const userId = state.currentTurnUserId
      if (sawReasoning && userId) {
        if (typeof reasoningFirst[userId] !== 'number') {
          reasoningFirst = { ...reasoningFirst, [userId]: context.now }
        }
        reasoningLast = { ...reasoningLast, [userId]: context.now }
      }
      return {
        ...patch,
        ...(blocks !== state.blocks ? { blocks } : {}),
        ...(liveReasoning !== state.liveReasoning ? { liveReasoning } : {}),
        ...(liveReasoningItemId !== state.liveReasoningItemId ? { liveReasoningItemId } : {}),
        ...(liveReasoningTurnId !== state.liveReasoningTurnId ? { liveReasoningTurnId } : {}),
        ...(liveReasoningCreatedAt !== state.liveReasoningCreatedAt ? { liveReasoningCreatedAt } : {}),
        ...(liveAssistant !== state.liveAssistant ? { liveAssistant } : {}),
        ...(liveAssistantItemId !== state.liveAssistantItemId ? { liveAssistantItemId } : {}),
        ...(liveAssistantTurnId !== state.liveAssistantTurnId ? { liveAssistantTurnId } : {}),
        ...(liveAssistantCreatedAt !== state.liveAssistantCreatedAt ? { liveAssistantCreatedAt } : {}),
        ...(liveDeltaSeqFloor !== state.liveDeltaSeqFloor ? { liveDeltaSeqFloor } : {}),
        ...(reasoningFirst !== state.turnReasoningFirstAtByUserId
          ? { turnReasoningFirstAtByUserId: reasoningFirst }
          : {}),
        ...(reasoningLast !== state.turnReasoningLastAtByUserId
          ? { turnReasoningLastAtByUserId: reasoningLast }
          : {})
      }
    }
    case 'assistant_item_upserted': {
      const item = action.payload
      if (state.activeThreadId && item.threadId !== state.activeThreadId) return {}
      const block: ChatBlock = item.kind === 'agent_message'
        ? {
            kind: 'assistant',
            id: item.itemId,
            turnId: item.turnId,
            createdAt: item.createdAt,
            text: item.text
          }
        : {
            kind: 'reasoning',
            id: item.itemId,
            turnId: item.turnId,
            createdAt: item.createdAt,
            text: item.text
          }
      const patch: Partial<ChatState> = {
        blocks: upsertTimelineBlock(state.blocks, block),
        error: context.clearRecoveringError(state.error)
      }
      if (
        item.kind === 'agent_message' &&
        (
          state.liveAssistantItemId === item.itemId ||
          (!state.liveAssistantItemId && state.liveAssistantTurnId === item.turnId)
        )
      ) {
        patch.liveAssistant = ''
        patch.liveAssistantItemId = undefined
        patch.liveAssistantTurnId = undefined
        patch.liveAssistantCreatedAt = undefined
      }
      if (
        item.kind === 'agent_reasoning' &&
        (
          state.liveReasoningItemId === item.itemId ||
          (!state.liveReasoningItemId && state.liveReasoningTurnId === item.turnId)
        )
      ) {
        patch.liveReasoning = ''
        patch.liveReasoningItemId = undefined
        patch.liveReasoningTurnId = undefined
        patch.liveReasoningCreatedAt = undefined
      }
      return patch
    }
    case 'tool_updated': {
      const event = action.payload
      const base: Partial<ChatState> =
        !state.busy && !event.updateOnly && !isDetachedSubagentToolEvent(event)
          ? { busy: true }
          : {}
      const childId = toolEventChildId(event)
      const index = state.blocks.findIndex((block) =>
        block.kind === 'tool' && (
          block.id === event.itemId || Boolean(childId && toolBlockChildId(block) === childId)
        )
      )
      if (index >= 0) {
        const current = state.blocks[index]
        if (current.kind !== 'tool') return base
        const nextStatus = monotonicToolStatus(current.status, event.status)
        // A stale queued/running lifecycle snapshot must never replace the
        // terminal summary/detail of an already settled tool block.
        const staleRunning = nextStatus !== event.status
        const blocks = [...state.blocks]
        blocks[index] = {
          ...current,
          turnId: event.turnId ?? current.turnId,
          summary: staleRunning ? current.summary : (event.summary || current.summary),
          status: nextStatus,
          toolKind: event.toolKind ?? current.toolKind,
          detail: staleRunning ? current.detail : (event.detail ?? current.detail),
          filePath: event.filePath ?? current.filePath,
          meta: mergeToolProjectionMeta(current.meta, event.meta)
        }
        return { ...base, blocks, error: context.clearRecoveringError(state.error) }
      }
      if (event.updateOnly) return base
      const block: ToolBlock = {
        kind: 'tool',
        id: event.itemId,
        turnId: event.turnId,
        createdAt: event.createdAt ?? new Date(context.now).toISOString(),
        summary: event.summary,
        status: event.status,
        toolKind: event.toolKind,
        detail: event.detail,
        filePath: event.filePath,
        meta: event.meta
      }
      return {
        ...base,
        blocks: [...state.blocks, block],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'approval_received': {
      const request = action.payload
      if (state.blocks.some(
        (block) => block.kind === 'approval' && block.approvalId === request.approvalId
      )) return {}
      return {
        blocks: [...state.blocks, {
          kind: 'approval',
          id: `approval-${request.approvalId}`,
          turnId: request.turnId,
          createdAt: request.createdAt ?? new Date(context.now).toISOString(),
          approvalId: request.approvalId,
          summary: request.summary,
          toolName: request.toolName,
          status: 'pending',
          ...(request.meta ? { meta: request.meta } : {})
        }],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'approval_status_changed': {
      const event = action.payload
      return {
        blocks: state.blocks.map((block) => {
          if (block.kind !== 'approval' || block.approvalId !== event.approvalId) return block
          const next = { ...block, status: event.status }
          delete next.errorMessage
          if (event.status === 'expired' && event.errorMessage) {
            next.errorMessage = event.errorMessage
          }
          return next
        })
      }
    }
    case 'approval_review_updated': {
      const event = action.payload
      const id = `approval-review-${event.reviewId}`
      const current = state.blocks.find(
        (block): block is Extract<ChatBlock, { kind: 'approval_review' }> =>
          block.kind === 'approval_review' && block.reviewId === event.reviewId
      )
      const block: Extract<ChatBlock, { kind: 'approval_review' }> = {
        kind: 'approval_review',
        id,
        reviewId: event.reviewId,
        approvalId: event.approvalId,
        turnId: event.turnId ?? current?.turnId,
        createdAt:
          current?.createdAt ??
          event.createdAt ??
          new Date(context.now).toISOString(),
        summary: event.summary || current?.summary || 'Tool action',
        toolName: event.toolName ?? current?.toolName,
        status: event.status,
        decision: event.decision ?? current?.decision,
        riskLevel: event.riskLevel ?? current?.riskLevel,
        rationale: event.rationale ?? current?.rationale
      }
      return {
        blocks: upsertTimelineBlock(state.blocks, block),
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'user_input_requested': {
      const req = action.payload
      if (req.questions.length === 0) return {}
      const existing = state.blocks.find(
        (block) => block.kind === 'user_input' && block.requestId === req.requestId
      )
      if (existing) {
        if (existing.kind === 'user_input' && existing.live === true) return {}
        return {
          blocks: state.blocks.map((block) =>
            block.kind === 'user_input' && block.requestId === req.requestId
              ? { ...block, live: true, status: 'pending' as const }
              : block
          )
        }
      }
      return {
        blocks: [...state.blocks, {
          kind: 'user_input',
          id: req.itemId,
          turnId: req.turnId,
          createdAt: req.createdAt ?? new Date(context.now).toISOString(),
          requestId: req.requestId,
          questions: req.questions,
          status: 'pending',
          live: true
        }],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'user_input_status_changed': {
      const event = action.payload
      return {
        error: context.clearRecoveringError(state.error),
        blocks: state.blocks.map((block) =>
          block.kind === 'user_input' && block.id === event.itemId
            ? block.status === 'submitted' && event.status === 'error' &&
                isUserInputInterruptError(event.errorMessage)
              ? block
              : {
                  ...block,
                  status: event.status,
                  answers: event.answers ?? block.answers,
                  errorMessage: event.errorMessage ?? block.errorMessage
                }
            : block
        )
      }
    }
    case 'runtime_status_received': {
      const event = action.payload
      const base: Partial<ChatState> = state.busy ? {} : { busy: true }
      const block: ChatBlock = {
        kind: 'system',
        id: event.itemId,
        turnId: event.turnId,
        createdAt: event.createdAt ?? new Date(context.now).toISOString(),
        text: context.runtimeStatusText(event),
        ...(event.failureSummary ? { detail: event.failureSummary } : {}),
        ...(event.code ? { code: event.code } : {}),
        ...(event.kind === 'required_tool_gate' && event.phase === 'failed'
          ? { severity: 'error' as const }
          : {})
      }
      const index = state.blocks.findIndex(
        (candidate) => candidate.kind === 'system' && candidate.id === event.itemId
      )
      const blocks = [...state.blocks]
      if (index >= 0) blocks[index] = block
      else blocks.push(block)
      return {
        ...base,
        blocks,
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'runtime_error_received': {
      const event = action.payload
      const view = context.runtimeErrorView(event)
      const block: Extract<ChatBlock, { kind: 'system' }> = {
        kind: 'system',
        id: event.itemId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        createdAt: event.createdAt ?? new Date(context.now).toISOString(),
        text: view.message,
        ...(view.code ? { code: view.code } : {}),
        ...(view.detail ? { detail: view.detail } : {}),
        severity: event.severity ?? 'error',
        runtimeError: true
      }
      return {
        blocks: context.upsertRuntimeError(state.blocks, block),
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'compaction_updated': {
      const event = action.payload
      const base: Partial<ChatState> = {}
      if (!state.busy && event.status === 'running') base.busy = true
      if (state.busy && event.status !== 'running' && !state.currentTurnId) base.busy = false
      const index = state.blocks.findIndex(
        (block) => block.kind === 'compaction' && block.id === event.itemId
      )
      if (index >= 0) {
        const current = state.blocks[index]
        if (current.kind !== 'compaction') return base
        const blocks = [...state.blocks]
        blocks[index] = {
          ...current,
          turnId: event.turnId ?? current.turnId,
          summary: event.summary || current.summary,
          status: event.status,
          detail: event.detail ?? current.detail,
          auto: event.auto ?? current.auto,
          messagesBefore: event.messagesBefore ?? current.messagesBefore,
          messagesAfter: event.messagesAfter ?? current.messagesAfter,
          createdAt: current.createdAt ?? event.createdAt
        }
        return { ...base, blocks, error: context.clearRecoveringError(state.error) }
      }
      return {
        ...base,
        blocks: [...state.blocks, {
          kind: 'compaction',
          id: event.itemId,
          turnId: event.turnId,
          createdAt: event.createdAt ?? new Date(context.now).toISOString(),
          summary: event.summary,
          status: event.status,
          detail: event.detail,
          auto: event.auto,
          messagesBefore: event.messagesBefore,
          messagesAfter: event.messagesAfter
        }],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'review_updated': {
      const event = action.payload
      const base: Partial<ChatState> = !state.busy && event.status === 'running' ? { busy: true } : {}
      const index = state.blocks.findIndex(
        (block) => block.kind === 'review' && block.id === event.itemId
      )
      if (index >= 0) {
        const current = state.blocks[index]
        if (current.kind !== 'review') return base
        const blocks = [...state.blocks]
        blocks[index] = {
          ...current,
          turnId: event.turnId ?? current.turnId,
          title: event.title || current.title,
          status: event.status,
          target: event.target ?? current.target,
          reviewText: event.reviewText ?? current.reviewText,
          output: event.output ?? current.output,
          createdAt: current.createdAt ?? event.createdAt
        }
        return { ...base, blocks, error: context.clearRecoveringError(state.error) }
      }
      return {
        ...base,
        blocks: [...state.blocks, {
          kind: 'review',
          id: event.itemId,
          turnId: event.turnId,
          createdAt: event.createdAt ?? new Date(context.now).toISOString(),
          title: event.title,
          status: event.status,
          target: event.target,
          reviewText: event.reviewText,
          output: event.output
        }],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'goal_changed': {
      const event = action.payload
      if (!event.threadId) return {}
      const currentThread = state.activeThreadId === event.threadId
      const updatedAt = event.goal?.updatedAt ?? event.createdAt ?? new Date(context.now).toISOString()
      const threads = state.threads.map((thread) =>
        thread.id === event.threadId ? { ...thread, goal: event.goal, updatedAt } : thread
      )
      if (!currentThread) return { threads }
      const block: ChatBlock = {
        kind: 'system',
        id: `goal-${event.threadId}-${updatedAt}-${event.goal?.status ?? 'cleared'}`,
        createdAt: updatedAt,
        text: context.goalTimelineText(event.goal, event.cleared)
      }
      return {
        activeThreadGoal: event.goal,
        threads,
        blocks: [...state.blocks, block],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'todos_changed': {
      const event = action.payload
      if (!event.threadId) return {}
      const todos = event.cleared ? null : event.todos
      const updatedAt = todos?.updatedAt ?? event.createdAt ?? new Date(context.now).toISOString()
      const threads = state.threads.map((thread) =>
        thread.id === event.threadId ? { ...thread, todos, updatedAt } : thread
      )
      return state.activeThreadId === event.threadId
        ? { activeThreadTodos: todos, threads, error: context.clearRecoveringError(state.error) }
        : { threads }
    }
    case 'thread_metadata_changed': {
      const event = action.payload
      const title = event.title?.trim()
      const status = event.status?.trim()
      if (!event.threadId || (!title && !status && event.titleAuto === undefined)) return {}
      return {
        threads: state.threads.map((thread) =>
          thread.id === event.threadId
            ? {
                ...thread,
                ...(title ? { title } : {}),
                ...(status ? { status } : {}),
                ...(event.titleAuto !== undefined ? { titleAuto: event.titleAuto } : {})
              }
            : thread
        )
      }
    }
    case 'context_snapshot_received':
      return state.activeThreadId === action.payload.threadId
        ? { lastContextSnapshot: action.payload }
        : {}
    case 'delegated_runtime_received':
      return state.activeThreadId === action.payload.threadId
        ? { lastDelegatedRuntimeState: action.payload }
        : {}
    case 'usage_received': {
      const threadId = state.activeThreadId ?? ''
      const turnId = action.payload.turnId
      const turnTimingMetrics = new Map(state.turnTimingMetrics)
      if (threadId !== (state.lastTurnUsage?.threadId ?? '')) turnTimingMetrics.clear()
      if (turnId) {
        const avgTtftMs = action.payload.turnAvgTtftMs
        const avgTokensPerSecond = action.payload.turnAvgTokensPerSecond
        if (avgTtftMs != null || avgTokensPerSecond != null) {
          turnTimingMetrics.set(turnId, { avgTtftMs, avgTokensPerSecond })
        } else {
          turnTimingMetrics.delete(turnId)
        }
      }
      return {
        usageRefreshKey: state.usageRefreshKey + 1,
        lastTurnUsage: { threadId, snapshot: action.payload },
        turnTimingMetrics
      }
    }
    case 'thread_snapshot_reconciled': {
      const snapshot = action.payload
      if (state.activeThreadId !== snapshot.threadId) return {}
      const busy = context.threadSnapshotLooksRunning(snapshot.blocks, snapshot.threadStatus)
      const threads = snapshot.threadStatus
        ? updateProjectedThreadStatus(state.threads, snapshot.threadId, snapshot.threadStatus)
        : state.threads
      const canonicalBlocks = busy
        ? snapshot.blocks
        : context.settlePendingRuntimeWork(snapshot.blocks)
      const shouldClearLive = (
        !snapshot.turnId ||
        !state.currentTurnId ||
        state.currentTurnId === snapshot.turnId
      )
      return {
        blocks: snapshot.turnId
          ? reconcileSnapshotTurn(
              state.blocks,
              canonicalBlocks,
              snapshot.turnId,
              snapshot.userBlockId
            )
          : reconcileSnapshotBlocks(state.blocks, canonicalBlocks),
        lastSeq: Math.max(state.lastSeq, snapshot.latestSeq),
        ...(shouldClearLive
          ? {
              liveReasoning: '',
              liveAssistant: '',
              liveReasoningItemId: undefined,
              liveReasoningTurnId: undefined,
              liveReasoningCreatedAt: undefined,
              liveAssistantItemId: undefined,
              liveAssistantTurnId: undefined,
              liveAssistantCreatedAt: undefined
            }
          : {}),
        ...(state.lastTurnUsage && state.lastTurnUsage.threadId !== snapshot.threadId
          ? { turnTimingMetrics: new Map() }
          : {}),
        activeThreadGoal: snapshot.goal ?? state.activeThreadGoal,
        activeThreadTodos: snapshot.todos ?? state.activeThreadTodos,
        ...(threads !== state.threads ? { threads } : {}),
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'turn_completed':
    case 'turn_aborted': {
      const aborted = action.type === 'turn_aborted'
      const threadId = state.activeThreadId
      const threads = threadId
        ? settleProjectedThreadStatus(state.threads, threadId, aborted ? 'aborted' : 'completed')
        : state.threads
      if (!state.busy && !state.currentTurnId) {
        if (!aborted) return threads === state.threads ? {} : { threads }
        const blocks = context.settlePendingRuntimeWork(state.blocks)
        return {
          ...(threads !== state.threads ? { threads } : {}),
          ...(blocks !== state.blocks ? { blocks } : {})
        }
      }
      const patch = flushLiveProjection(state, context.now, {
        ...finalizeTurnTimingAt(state, context.now),
        error: null,
        currentTurnId: null,
        currentTurnOrchestration: null,
        ...(aborted ? {
          currentTurnUserId: null,
          blocks: context.settlePendingRuntimeWork(state.blocks)
        } : {}),
        ...(state.busy ? { busy: false } : {}),
        ...(threads !== state.threads ? { threads } : {})
      })
      if (!threadId) return patch
      const watchTurnCompletion = { ...state.watchTurnCompletion }
      const unreadThreadIds = { ...state.unreadThreadIds }
      delete watchTurnCompletion[threadId]
      delete unreadThreadIds[threadId]
      return { ...patch, watchTurnCompletion, unreadThreadIds }
    }
    case 'turn_failed': {
      const message = context.formatRuntimeError(action.error)
      const detail = context.runtimeErrorDetail(action.error)
      const terminal = action.options?.terminal === true
      const conversationScoped = action.options?.scope === 'conversation'
      const interrupted = context.isInterruptSettledError(action.error, message)
      const shouldSettle = terminal || !state.busy || interrupted
      const patch = flushLiveProjection(state, context.now, {
        ...finalizeTurnTimingAt(state, context.now),
        error: interrupted || conversationScoped ? null : message,
        runtimeErrorDetail: interrupted || conversationScoped ? null : detail || null
      })
      if (!shouldSettle) return patch
      patch.busy = false
      patch.currentTurnId = null
      patch.currentTurnOrchestration = null
      patch.currentTurnUserId = null
      patch.blocks = context.settlePendingRuntimeWork(patch.blocks ?? state.blocks)
      if (state.activeThreadId) {
        const threads = settleProjectedThreadStatus(
          state.threads,
          state.activeThreadId,
          interrupted ? 'aborted' : 'failed'
        )
        if (threads !== state.threads) patch.threads = threads
      }
      if (terminal && state.activeThreadId) {
        const watchTurnCompletion = { ...state.watchTurnCompletion }
        const unreadThreadIds = { ...state.unreadThreadIds }
        delete watchTurnCompletion[state.activeThreadId]
        delete unreadThreadIds[state.activeThreadId]
        patch.watchTurnCompletion = watchTurnCompletion
        patch.unreadThreadIds = unreadThreadIds
      }
      return patch
    }
    default:
      return {}
  }
}

function updateProjectedThreadStatus(
  threads: ChatState['threads'],
  threadId: string,
  status: string,
  latestTurnStatus?: string
): ChatState['threads'] {
  let changed = false
  const next = threads.map((thread) => {
    if (thread.id !== threadId) return thread
    if (thread.status === status && (
      latestTurnStatus === undefined || thread.latestTurnStatus === latestTurnStatus
    )) {
      return thread
    }
    changed = true
    return {
      ...thread,
      status,
      ...(latestTurnStatus ? { latestTurnStatus } : {})
    }
  })
  return changed ? next : threads
}

function settleProjectedThreadStatus(
  threads: ChatState['threads'],
  threadId: string,
  latestTurnStatus: 'completed' | 'failed' | 'aborted'
): ChatState['threads'] {
  const thread = threads.find((candidate) => candidate.id === threadId)
  if (!thread || thread.status?.trim().toLowerCase() !== 'running') return threads
  return updateProjectedThreadStatus(threads, threadId, 'idle', latestTurnStatus)
}

function runtimeEventStartedAt(createdAt: string | undefined, now: number): number {
  if (!createdAt) return now
  const parsed = Date.parse(createdAt)
  if (!Number.isFinite(parsed)) return now
  const maxPastAgeMs = 30 * 60_000
  const maxFutureSkewMs = 5_000
  return parsed < now - maxPastAgeMs || parsed > now + maxFutureSkewMs ? now : parsed
}

function finalizeTurnTimingAt(state: ChatState, now: number): Partial<ChatState> {
  const userId = state.currentTurnUserId
  if (!userId) return {}
  const startedAt = state.turnStartedAtByUserId[userId]
  if (typeof startedAt !== 'number') return { currentTurnUserId: null }
  return {
    currentTurnUserId: null,
    turnDurationByUserId: {
      ...state.turnDurationByUserId,
      [userId]: Math.max(0, now - startedAt)
    }
  }
}

export function toolBlockChildId(block: ToolBlock): string | undefined {
  const child = block.meta?.child
  if (child && typeof child === 'object' && !Array.isArray(child)) {
    const nested = (child as Record<string, unknown>).childId
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  return childIdFromDetail(block.detail)
}

export function toolEventChildId(event: ToolEventPayload): string | undefined {
  const child = event.meta?.child
  if (child && typeof child === 'object' && !Array.isArray(child)) {
    const nested = (child as Record<string, unknown>).childId
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  return childIdFromDetail(event.detail)
}

export function mergeToolProjectionEvents(
  base: ToolEventPayload,
  update: ToolEventPayload
): ToolEventPayload {
  const status = monotonicToolStatus(base.status, update.status)
  // The pending update may be an older queued/running lifecycle snapshot that
  // raced ahead of the settled tool result. Keep terminal summary/detail intact
  // instead of replacing them with the minimal lifecycle payload.
  const staleRunning = status !== update.status
  return {
    ...base,
    turnId: update.turnId ?? base.turnId,
    createdAt: base.createdAt ?? update.createdAt,
    summary: staleRunning ? base.summary : (update.summary || base.summary),
    status,
    toolKind: update.toolKind ?? base.toolKind,
    detail: staleRunning ? base.detail : (update.detail ?? base.detail),
    filePath: update.filePath ?? base.filePath,
    meta: mergeToolProjectionMeta(base.meta, update.meta)
  }
}

function mergeToolProjectionMeta(
  current: ToolBlock['meta'],
  incoming: ToolEventPayload['meta']
): ToolBlock['meta'] {
  if (!current) return incoming
  if (!incoming) return current
  const merged = { ...current, ...incoming }
  const currentChild = current.child
  const incomingChild = incoming.child
  if (
    currentChild && typeof currentChild === 'object' && !Array.isArray(currentChild) &&
    incomingChild && typeof incomingChild === 'object' && !Array.isArray(incomingChild)
  ) {
    merged.child = mergeChildMetadata(
      currentChild as Record<string, unknown>,
      incomingChild as Record<string, unknown>
    )
  }
  return merged
}

/**
 * Child lifecycle metadata is monotonic: a terminal `childStatus` recorded by
 * the settled result must survive an older queued/running snapshot, while a
 * genuine running -> terminal transition still wins.
 */
function mergeChildMetadata(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...current, ...incoming }
  const currentStatus = current.childStatus
  const incomingStatus = incoming.childStatus
  if (
    typeof currentStatus === 'string' &&
    typeof incomingStatus === 'string' &&
    isTerminalChildStatus(currentStatus) &&
    (incomingStatus === 'queued' || incomingStatus === 'running')
  ) {
    merged.childStatus = currentStatus
  }
  return merged
}

function isTerminalChildStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

function isDetachedSubagentToolEvent(event: ToolEventPayload): boolean {
  const child = event.meta?.child
  if (child && typeof child === 'object' && !Array.isArray(child) &&
    (child as Record<string, unknown>).detached === true) return true
  return detailRecord(event.detail)?.detached === true
}

function childIdFromDetail(detail: string | undefined): string | undefined {
  const id = detailRecord(detail)?.childId
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

function detailRecord(detail: string | undefined): Record<string, unknown> | undefined {
  if (!detail?.trim()) return undefined
  try {
    const parsed = JSON.parse(detail) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function isUserInputInterruptError(message: string | undefined): boolean {
  if (!message) return false
  const normalized = message.trim().toLowerCase()
  return normalized.includes('interrupt') || normalized.includes('cancelled') || normalized.includes('canceled')
}

function upsertTimelineBlock(blocks: ChatBlock[], incoming: ChatBlock): ChatBlock[] {
  const index = blocks.findIndex(
    (block) => block.kind === incoming.kind && block.id === incoming.id
  )
  if (index < 0) return [...blocks, incoming]
  const current = blocks[index]
  if (sameStableTimelineBlock(current, incoming)) return blocks
  const next = [...blocks]
  next[index] = incoming
  return next
}

function sameStableTimelineBlock(left: ChatBlock, right: ChatBlock): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false
  if (
    (left.kind === 'assistant' && right.kind === 'assistant') ||
    (left.kind === 'reasoning' && right.kind === 'reasoning')
  ) {
    return (
      left.turnId === right.turnId &&
      left.createdAt === right.createdAt &&
      left.text === right.text
    )
  }
  return left === right
}

function reconcileSnapshotBlocks(current: ChatBlock[], persisted: ChatBlock[]): ChatBlock[] {
  const currentByIdentity = new Map(
    current.map((block) => [`${block.kind}:${block.id}`, block] as const)
  )
  return persisted.map((block) => {
    const existing = currentByIdentity.get(`${block.kind}:${block.id}`)
    return existing && sameStableTimelineBlock(existing, block) ? existing : block
  })
}

function reconcileSnapshotTurn(
  current: ChatBlock[],
  persisted: ChatBlock[],
  turnId: string,
  userBlockId?: string | null
): ChatBlock[] {
  const persistedTurn = persisted.filter(
    (block) => block.turnId === turnId || Boolean(userBlockId && block.id === userBlockId)
  )
  if (persistedTurn.length === 0) return current

  const currentByIdentity = new Map(
    current.map((block) => [`${block.kind}:${block.id}`, block] as const)
  )
  const stablePersistedTurn = persistedTurn.map((block) => {
    const existing = currentByIdentity.get(`${block.kind}:${block.id}`)
    return existing && sameStableTimelineBlock(existing, block) ? existing : block
  })
  const explicitTargetIndexes = current.flatMap((block, index) =>
    block.turnId === turnId || Boolean(userBlockId && block.id === userBlockId) ? [index] : []
  )
  const userIndex = userBlockId
    ? current.findIndex((block) => block.kind === 'user' && block.id === userBlockId)
    : -1
  let nextUserIndex = current.length
  if (userIndex >= 0) {
    for (let index = userIndex + 1; index < current.length; index += 1) {
      if (current[index]?.kind === 'user') {
        nextUserIndex = index
        break
      }
    }
  }
  const belongsToTarget = (block: ChatBlock, index: number): boolean => {
    if (block.turnId === turnId || Boolean(userBlockId && block.id === userBlockId)) return true
    return (
      userIndex >= 0 &&
      index > userIndex &&
      index < nextUserIndex &&
      !block.turnId &&
      (block.kind === 'assistant' || block.kind === 'reasoning')
    )
  }
  const insertionIndex = explicitTargetIndexes.length > 0
    ? Math.min(...explicitTargetIndexes)
    : current.length
  const before = current.slice(0, insertionIndex).filter((block, index) => !belongsToTarget(block, index))
  const after = current.slice(insertionIndex).filter(
    (block, offset) => !belongsToTarget(block, insertionIndex + offset)
  )
  return [...before, ...stablePersistedTurn, ...after]
}
