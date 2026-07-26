import type { RuntimeEvent } from '../contracts/events.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import type {
  ApprovalTurnItem,
  TurnItem,
  UserInputQuestionSchema,
  UserInputTurnItem
} from '../contracts/items.js'
import type { Turn } from '../contracts/turns.js'
import type { DelegationDiagnostics, ThreadDetail } from './client.js'
import type { z } from 'zod'

export type PendingApproval = {
  approvalId: string
  toolName: string
  summary: string
  turnId?: string
  itemId?: string
}

export type PendingUserInput = {
  inputId: string
  prompt: string
  questions: Array<z.infer<typeof UserInputQuestionSchema>>
  turnId?: string
  itemId?: string
}

export type ProjectedTurnActivity = {
  turnId: string
  phase: 'starting' | 'thinking' | 'responding' | 'tool' | 'retrying' | 'compacting' | 'waiting'
  label?: string
  toolName?: string
  /** Start of the current visible phase; resets when the phase/label changes. */
  startedAt: string
  /** Start of the parent turn; remains stable across model/tool/subagent phases. */
  turnStartedAt: string
  updatedAt: string
  attempt?: number
  maxAttempts?: number
}

export type ProjectedChildRun = {
  childId: string
  parentTurnId: string
  childSeq?: number
  label?: string
  prompt?: string
  profile?: string
  profileName?: string
  model?: string
  providerId?: string
  reasoningEffort?: string
  toolPolicy?: 'readOnly' | 'inherit'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted'
  text?: string
  detached?: boolean
  prefixReused?: boolean
  inheritedHistoryItems?: number
  toolInvocations?: number
  activity?: {
    phase: 'starting' | 'thinking' | 'responding' | 'tool' | 'retrying' | 'compacting' | 'waiting'
    label: string
    toolName?: string
    startedAt: string
    updatedAt: string
  }
  durationMs?: number
  queuedMs?: number
  totalTokens?: number
  cacheHitRate?: number | null
  costUsd?: number
  costCny?: number
  startedAt: string
  updatedAt: string
}

export type ThreadProjection = {
  thread: ThreadDetail
  items: TurnItem[]
  lastSeq: number
  runningTurnId?: string
  pendingApproval?: PendingApproval
  pendingUserInput?: PendingUserInput
  usage?: UsageSnapshot
  lastError?: string
  activity?: ProjectedTurnActivity
  childRuns: ProjectedChildRun[]
}

export function projectThreadSnapshot(thread: ThreadDetail): ThreadProjection {
  const items = thread.turns.flatMap((turn) => turn.items)
  const running = [...thread.turns].reverse().find((turn) => turn.status === 'running' || turn.status === 'queued')
  const pendingApprovalItem = [...items].reverse().find(
    (item): item is ApprovalTurnItem => item.kind === 'approval' && item.status === 'pending'
  )
  const pendingInputItem = [...items].reverse().find(
    (item): item is UserInputTurnItem =>
      item.kind === 'user_input' && item.status === 'pending' && thread.pendingUserInputIds.includes(item.inputId)
  )
  return {
    thread,
    items,
    lastSeq: thread.latestSeq,
    childRuns: [],
    ...(running ? { runningTurnId: running.id } : {}),
    ...(running ? { activity: activityFromTurn(running) } : {}),
    ...(pendingApprovalItem ? {
      pendingApproval: {
        approvalId: pendingApprovalItem.approvalId,
        toolName: pendingApprovalItem.toolName,
        summary: pendingApprovalItem.summary,
        turnId: pendingApprovalItem.turnId,
        itemId: pendingApprovalItem.id
      }
    } : {}),
    ...(pendingInputItem ? {
      pendingUserInput: {
        inputId: pendingInputItem.inputId,
        prompt: pendingInputItem.prompt,
        questions: pendingInputItem.questions,
        turnId: pendingInputItem.turnId,
        itemId: pendingInputItem.id
      }
    } : {})
  }
}

export function hydrateProjectedChildRuns(
  current: ThreadProjection,
  diagnostics: DelegationDiagnostics | undefined
): ThreadProjection {
  if (!diagnostics) return current
  return {
    ...current,
    childRuns: diagnostics.childRuns.map((run) => ({
      childId: run.id,
      parentTurnId: run.parentTurnId,
      ...(run.label ? { label: run.label } : {}),
      ...(run.prompt ? { prompt: run.prompt } : {}),
      ...(run.profile ? { profile: run.profile } : {}),
      ...(run.profileSnapshot?.name ? { profileName: run.profileSnapshot.name } : {}),
      ...(typeof run.model === 'string' && run.model ? { model: run.model } : {}),
      ...(typeof run.providerId === 'string' && run.providerId ? { providerId: run.providerId } : {}),
      ...(typeof run.reasoningEffort === 'string' && run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
      ...(run.toolPolicy ? { toolPolicy: run.toolPolicy } : {}),
      status: run.status,
      ...(run.summary || run.error ? { text: run.summary ?? run.error } : {}),
      ...(run.detached ? { detached: true } : {}),
      ...(run.prefixReused !== undefined ? { prefixReused: run.prefixReused } : {}),
      ...(typeof run.inheritedHistoryItems === 'number' ? { inheritedHistoryItems: run.inheritedHistoryItems } : {}),
      ...(typeof run.toolInvocations === 'number' ? { toolInvocations: run.toolInvocations } : {}),
      ...(run.activity ? { activity: run.activity } : {}),
      ...(typeof run.durationMs === 'number' ? { durationMs: run.durationMs } : {}),
      ...(typeof run.queuedMs === 'number' ? { queuedMs: run.queuedMs } : {}),
      ...(typeof run.childSeq === 'number' ? { childSeq: run.childSeq } : {}),
      ...(run.usage?.totalTokens > 0 ? { totalTokens: run.usage.totalTokens } : {}),
      ...(run.usage?.cacheHitRate !== undefined ? { cacheHitRate: run.usage.cacheHitRate } : {}),
      ...(run.usage?.costUsd !== undefined ? { costUsd: run.usage.costUsd } : {}),
      ...(run.usage?.costCny !== undefined ? { costCny: run.usage.costCny } : {}),
      startedAt: run.startedAt ?? run.createdAt,
      updatedAt: run.updatedAt
    }))
  }
}

export function applyRuntimeEvent(
  current: ThreadProjection,
  event: RuntimeEvent
): ThreadProjection {
  if (event.threadId !== current.thread.id || event.seq <= current.lastSeq) return current
  let next: ThreadProjection = {
    ...current,
    lastSeq: event.seq,
    thread: { ...current.thread, latestSeq: event.seq }
  }
  // Delegated child lifecycle records intentionally use the parent turn id so
  // all clients can find them on the parent stream. They are not parent turn
  // lifecycle transitions: completing one child must never mark the main turn
  // idle while the parent model is still running.
  if (event.child && (
    event.kind === 'turn_started' || event.kind === 'turn_completed' ||
    event.kind === 'turn_failed' || event.kind === 'turn_aborted' || event.kind === 'turn_steered'
  )) {
    return projectChildLifecycle(next, event)
  }
  switch (event.kind) {
    case 'item_created':
    case 'item_updated':
    case 'item_completed':
    case 'tool_call_started':
    case 'tool_call_finished': {
      next = {
        ...next,
        items: upsertItem(current.items, event.item),
        thread: upsertTurnItem(next.thread, event.item)
      }
      if (event.item.kind === 'approval') {
        next = event.item.status === 'pending'
          ? {
              ...next,
              pendingApproval: {
                approvalId: event.item.approvalId,
                toolName: event.item.toolName,
                summary: event.item.summary,
                turnId: event.item.turnId,
                itemId: event.item.id
              }
            }
          : omitPendingApproval(next, event.item.approvalId)
      } else if (event.item.kind === 'user_input') {
        next = event.item.status === 'pending'
          ? {
              ...next,
              pendingUserInput: {
                inputId: event.item.inputId,
                prompt: event.item.prompt,
                questions: event.item.questions,
                turnId: event.item.turnId,
                itemId: event.item.id
              }
            }
          : omitPendingUserInput(next, event.item.inputId)
      }
      next = updateActivityForItem(next, event.item, event.kind, event.timestamp)
      break
    }
    case 'assistant_text_delta':
    case 'assistant_reasoning_delta': {
      const item = appendDeltaItem(current.items, event.item)
      next = {
        ...next,
        items: upsertItem(current.items, item),
        thread: upsertTurnItem(next.thread, item),
        activity: {
          turnId: event.turnId ?? item.turnId,
          phase: event.kind === 'assistant_reasoning_delta' ? 'thinking' : 'responding',
          label: event.kind === 'assistant_reasoning_delta' ? 'Thinking' : 'Responding',
          startedAt: current.activity?.turnId === (event.turnId ?? item.turnId) &&
            current.activity.phase === (event.kind === 'assistant_reasoning_delta' ? 'thinking' : 'responding')
            ? current.activity.startedAt
            : event.timestamp,
          turnStartedAt: current.activity?.turnId === (event.turnId ?? item.turnId)
            ? current.activity.turnStartedAt
            : event.timestamp,
          updatedAt: event.timestamp
        }
      }
      break
    }
    case 'turn_started':
      next = {
        ...next,
        runningTurnId: event.turnId,
        lastError: undefined,
        ...(event.turnId ? {
          activity: {
            turnId: event.turnId,
            phase: 'starting',
            label: 'Waiting for model',
            startedAt: event.timestamp,
            turnStartedAt: event.timestamp,
            updatedAt: event.timestamp
          }
        } : {}),
        thread: updateTurnStatus(next.thread, event.turnId, 'running', 'running', event.timestamp, '', {
          ...(event.model ? { model: event.model } : {}),
          ...(event.providerId ? { providerId: event.providerId } : {}),
          ...(event.accountId ? { accountId: event.accountId } : {}),
          ...(event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {}),
          ...(event.mode ? { mode: event.mode } : {})
        })
      }
      break
    case 'turn_completed':
    case 'turn_failed':
    case 'turn_aborted': {
      const status = event.kind === 'turn_completed'
        ? 'completed'
        : event.kind === 'turn_failed'
          ? 'failed'
          : 'aborted'
      next = {
        ...next,
        ...(next.runningTurnId === event.turnId ? { runningTurnId: undefined } : {}),
        ...(next.activity?.turnId === event.turnId ? { activity: undefined } : {}),
        thread: updateTurnStatus(next.thread, event.turnId, status, 'idle', event.timestamp),
        ...(event.kind === 'turn_failed' && event.message ? { lastError: event.message } : {})
      }
      if (event.kind === 'turn_failed' && event.turnId) {
        next = upsertVisibleError(next, {
          turnId: event.turnId,
          timestamp: event.timestamp,
          message: event.message ?? 'The turn failed before Kun produced a response.',
          code: event.code,
          details: event.details,
          severity: event.severity ?? 'error'
        })
      } else if (event.kind === 'turn_aborted' && event.turnId) {
        next = upsertVisibleError(next, {
          turnId: event.turnId,
          timestamp: event.timestamp,
          message: event.message ?? 'Turn stopped.',
          code: event.code ?? 'aborted',
          details: event.details,
          severity: 'warning',
          status: 'aborted'
        })
      } else if (event.kind === 'turn_completed' && event.turnId && !hasVisibleTurnOutcome(next.items, event.turnId)) {
        next = upsertVisibleError(next, {
          turnId: event.turnId,
          timestamp: event.timestamp,
          message: 'Kun completed this turn without a text response.',
          code: 'empty_turn',
          severity: 'warning',
          status: 'completed'
        })
      }
      break
    }
    case 'thread_updated':
      next = {
        ...next,
        thread: {
          ...next.thread,
          ...(event.title !== undefined ? { title: event.title } : {}),
          ...(event.titleAuto !== undefined ? { titleAuto: event.titleAuto } : {}),
          ...(event.status === 'idle' || event.status === 'running' || event.status === 'archived'
            ? { status: event.status }
            : {}),
          ...(event.mode ? { mode: event.mode } : {}),
          ...(event.workspace ? { workspace: event.workspace } : {}),
          ...(event.additionalWorkspaces ? { additionalWorkspaces: event.additionalWorkspaces } : {}),
          ...(event.approvalPolicy ? { approvalPolicy: event.approvalPolicy } : {}),
          ...(event.sandboxMode ? { sandboxMode: event.sandboxMode } : {})
        }
      }
      break
    case 'approval_requested':
      next = {
        ...next,
        ...(event.turnId ? {
          activity: activityFor(event.turnId, 'waiting', 'Waiting for approval', event.timestamp, current.activity)
        } : {}),
        pendingApproval: {
          approvalId: event.approvalId,
          toolName: event.toolName,
          summary: event.summary ?? event.toolName,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(event.itemId ? { itemId: event.itemId } : {})
        }
      }
      break
    case 'approval_resolved':
      next = omitPendingApproval(next, event.approvalId)
      next = {
        ...next,
        items: next.items.map((item) => item.kind === 'approval' && item.approvalId === event.approvalId
          ? { ...item, status: event.status }
          : item),
        thread: mapTurnItems(next.thread, (item) => item.kind === 'approval' && item.approvalId === event.approvalId
          ? { ...item, status: event.status }
          : item)
      }
      break
    case 'user_input_requested':
      next = {
        ...next,
        ...(event.turnId ? {
          activity: activityFor(event.turnId, 'waiting', 'Waiting for your input', event.timestamp, current.activity)
        } : {}),
        pendingUserInput: {
          inputId: event.inputId,
          prompt: event.prompt ?? 'Input requested',
          questions: event.questions ?? [],
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(event.itemId ? { itemId: event.itemId } : {})
        }
      }
      break
    case 'user_input_resolved':
      next = omitPendingUserInput(next, event.inputId)
      next = {
        ...next,
        items: next.items.map((item) => item.kind === 'user_input' && item.inputId === event.inputId
          ? { ...item, status: event.status, ...(event.answers ? { answers: event.answers } : {}) }
          : item),
        thread: mapTurnItems(next.thread, (item) => item.kind === 'user_input' && item.inputId === event.inputId
          ? { ...item, status: event.status, ...(event.answers ? { answers: event.answers } : {}) }
          : item)
      }
      break
    case 'usage':
      next = { ...next, usage: event.usage }
      break
    case 'turn_steered':
      if (event.turnId && event.text) {
        const thread = ensureTurn(next.thread, event.turnId, 'running', event.timestamp)
        next = {
          ...next,
          thread: {
            ...thread,
            turns: thread.turns.map((turn) => turn.id === event.turnId
              ? { ...turn, steering: [...turn.steering, event.text!] }
              : turn)
          }
        }
      }
      break
    case 'turn_steering_updated':
      if (event.turnId) {
        const thread = ensureTurn(next.thread, event.turnId, 'running', event.timestamp)
        next = {
          ...next,
          thread: {
            ...thread,
            turns: thread.turns.map((turn) => turn.id === event.turnId
              ? { ...turn, steering: event.entries.map((entry) => entry.text) }
              : turn)
          }
        }
      }
      break
    case 'goal_updated':
    case 'goal_cleared':
      next = { ...next, thread: replaceGoal(next.thread, event.goal ?? undefined) }
      break
    case 'todos_updated':
    case 'todos_cleared':
      next = { ...next, thread: replaceTodos(next.thread, event.todos ?? undefined) }
      break
    case 'error':
      next = { ...next, lastError: event.message }
      if (event.turnId) {
        next = upsertVisibleError(next, {
          turnId: event.turnId,
          timestamp: event.timestamp,
          message: event.message,
          code: event.code,
          details: event.details,
          severity: event.severity ?? 'error'
        })
      }
      break
    case 'heartbeat':
    case 'thread_created':
      break
    case 'tool_call_ready':
      if (event.turnId) {
        next = {
          ...next,
          activity: {
            ...activityFor(event.turnId, 'tool', `Running ${event.toolName}`, event.timestamp, current.activity),
            toolName: event.toolName
          }
        }
      }
      break
    case 'model_request_retry':
      if (event.turnId) {
        next = {
          ...next,
          activity: {
            ...activityFor(event.turnId, 'retrying', `Retrying model request ${event.attempt}/${event.maxAttempts}`, event.timestamp, current.activity),
            attempt: event.attempt,
            maxAttempts: event.maxAttempts
          }
        }
      }
      break
    case 'tool_result_upload_wait':
      if (event.turnId) {
        next = {
          ...next,
          activity: activityFor(event.turnId, 'waiting', 'Waiting for tool results', event.timestamp, current.activity)
        }
      }
      break
    case 'tool_storm_suppressed':
    case 'tool_catalog_changed':
      break
    case 'compaction_started':
      if (event.turnId) {
        next = {
          ...next,
          activity: activityFor(event.turnId, 'compacting', event.summary ?? 'Compacting context', event.timestamp, current.activity)
        }
      }
      break
    case 'compaction_completed':
      if (event.turnId && next.runningTurnId === event.turnId) {
        next = {
          ...next,
          activity: activityFor(event.turnId, 'starting', 'Continuing', event.timestamp, current.activity)
        }
      }
      break
    case 'bash_session_started':
    case 'bash_session_updated':
    case 'bash_session_completed':
      break
    case 'pipeline_stage':
      if (event.turnId && next.runningTurnId === event.turnId && event.stage === 'pre_send') {
        next = {
          ...next,
          activity: activityFor(event.turnId, 'starting', event.label ?? 'Calling model', event.timestamp, current.activity)
        }
      }
      break
  }
  return next
}

function replaceGoal(thread: ThreadDetail, goal: ThreadDetail['goal'] | undefined): ThreadDetail {
  const { goal: _goal, ...withoutGoal } = thread
  return goal ? { ...withoutGoal, goal } : withoutGoal
}

function replaceTodos(thread: ThreadDetail, todos: ThreadDetail['todos'] | undefined): ThreadDetail {
  const { todos: _todos, ...withoutTodos } = thread
  return todos ? { ...withoutTodos, todos } : withoutTodos
}

export function setProjectionRunningTurn(
  current: ThreadProjection,
  turnId: string,
  prompt = '',
  timestamp = new Date().toISOString(),
  metadata: Partial<Pick<Turn, 'model' | 'providerId' | 'accountId' | 'reasoningEffort' | 'mode' | 'attachmentIds'>> = {}
): ThreadProjection {
  return {
    ...current,
    runningTurnId: turnId,
    lastError: undefined,
    activity: {
      turnId,
      phase: 'starting',
      label: 'Sending message',
      startedAt: timestamp,
      turnStartedAt: timestamp,
      updatedAt: timestamp
    },
    thread: updateTurnStatus(current.thread, turnId, 'queued', 'running', timestamp, prompt, metadata)
  }
}

function activityFromTurn(turn: Turn): ProjectedTurnActivity {
  const last = [...turn.items].reverse().find((item) =>
    item.kind === 'assistant_text' || item.kind === 'assistant_reasoning' || item.kind === 'tool_call'
  )
  const phase = last?.kind === 'assistant_text'
    ? 'responding'
    : last?.kind === 'assistant_reasoning'
      ? 'thinking'
      : last?.kind === 'tool_call'
        ? 'tool'
        : 'starting'
  return {
    turnId: turn.id,
    phase,
    ...(last?.kind === 'tool_call' ? { label: last.summary ?? last.toolName, toolName: last.toolName } : {}),
    startedAt: last?.createdAt ?? turn.startedAt ?? turn.createdAt,
    turnStartedAt: turn.startedAt ?? turn.createdAt,
    updatedAt: last?.createdAt ?? turn.startedAt ?? turn.createdAt
  }
}

function activityFor(
  turnId: string,
  phase: ProjectedTurnActivity['phase'],
  label: string,
  timestamp: string,
  previous?: ProjectedTurnActivity
): ProjectedTurnActivity {
  const sameTurn = previous?.turnId === turnId
  const samePhase = sameTurn && previous.phase === phase && previous.label === label
  return {
    turnId,
    phase,
    label,
    startedAt: samePhase ? previous.startedAt : timestamp,
    turnStartedAt: sameTurn ? previous.turnStartedAt : timestamp,
    updatedAt: timestamp
  }
}

function updateActivityForItem(
  state: ThreadProjection,
  item: TurnItem,
  eventKind: 'item_created' | 'item_updated' | 'item_completed' | 'tool_call_started' | 'tool_call_finished',
  timestamp: string
): ThreadProjection {
  if (state.runningTurnId !== item.turnId) return state
  if (eventKind === 'tool_call_started' || item.kind === 'tool_call' && item.status === 'running') {
    return {
      ...state,
      activity: {
        ...activityFor(item.turnId, 'tool', item.kind === 'tool_call' ? item.summary ?? item.toolName : 'Running tool', timestamp, state.activity),
        ...(item.kind === 'tool_call' ? { toolName: item.toolName } : {})
      }
    }
  }
  if (item.kind === 'assistant_reasoning' && item.status === 'running') {
    return { ...state, activity: activityFor(item.turnId, 'thinking', 'Thinking', timestamp, state.activity) }
  }
  if (item.kind === 'assistant_text' && item.status === 'running') {
    return { ...state, activity: activityFor(item.turnId, 'responding', 'Responding', timestamp, state.activity) }
  }
  if (eventKind === 'tool_call_finished' || item.kind === 'tool_result') {
    return { ...state, activity: activityFor(item.turnId, 'starting', 'Processing tool result', timestamp, state.activity) }
  }
  return state
}

function projectChildLifecycle(
  state: ThreadProjection,
  event: Extract<RuntimeEvent, { kind: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' | 'turn_steered' }>
): ThreadProjection {
  const child = event.child!
  const index = state.childRuns.findIndex((run) => run.childId === child.childId)
  const existing = index >= 0 ? state.childRuns[index] : undefined
  const next: ProjectedChildRun = {
    childId: child.childId,
    parentTurnId: child.parentTurnId,
    ...(child.childLabel ? { label: child.childLabel } : {}),
    ...(child.childProfile ? { profile: child.childProfile } : {}),
    ...(child.childProfileName ? { profileName: child.childProfileName } : {}),
    ...(child.childModel ? { model: child.childModel } : {}),
    ...(child.childProviderId ? { providerId: child.childProviderId } : {}),
    ...(child.childToolPolicy ? { toolPolicy: child.childToolPolicy } : {}),
    status: child.childStatus,
    ...(event.text ? { text: event.text } : {}),
    ...(child.detached ? { detached: true } : {}),
    ...(child.prefixReused !== undefined ? { prefixReused: child.prefixReused } : {}),
    ...(child.inheritedHistoryItems !== undefined ? { inheritedHistoryItems: child.inheritedHistoryItems } : {}),
    ...(child.toolInvocations !== undefined ? { toolInvocations: child.toolInvocations } : {}),
    ...(child.activity ? { activity: child.activity } : {}),
    ...(child.durationMs !== undefined ? { durationMs: child.durationMs } : {}),
    ...(child.queuedMs !== undefined ? { queuedMs: child.queuedMs } : {}),
    ...(child.totalTokens !== undefined ? { totalTokens: child.totalTokens } : {}),
    ...(child.cacheHitRate !== undefined ? { cacheHitRate: child.cacheHitRate } : {}),
    ...(child.costUsd !== undefined ? { costUsd: child.costUsd } : {}),
    ...(child.costCny !== undefined ? { costCny: child.costCny } : {}),
    childSeq: child.childSeq,
    startedAt: existing?.startedAt ?? event.timestamp,
    updatedAt: event.timestamp
  }
  const childRuns = [...state.childRuns]
  if (index >= 0) childRuns[index] = { ...childRuns[index], ...next }
  else childRuns.push(next)
  return { ...state, childRuns }
}

function upsertVisibleError(
  state: ThreadProjection,
  input: {
    turnId: string
    timestamp: string
    message: string
    code?: string
    details?: unknown
    severity: 'info' | 'warning' | 'error'
    status?: 'failed' | 'aborted' | 'completed'
  }
): ThreadProjection {
  const item: TurnItem = {
    id: `item_${input.turnId}_error`,
    turnId: input.turnId,
    threadId: state.thread.id,
    role: 'system',
    status: input.status ?? 'failed',
    createdAt: input.timestamp,
    finishedAt: input.timestamp,
    kind: 'error',
    message: input.message,
    ...(input.code ? { code: input.code } : {}),
    ...(input.details !== undefined ? { details: input.details } : {}),
    severity: input.severity
  }
  return {
    ...state,
    items: upsertItem(state.items, item),
    thread: upsertTurnItem(state.thread, item)
  }
}

function hasVisibleTurnOutcome(items: readonly TurnItem[], turnId: string): boolean {
  return items.some((item) => item.turnId === turnId && (
    item.kind === 'assistant_text' && item.text.trim().length > 0 ||
    item.kind === 'tool_result' || item.kind === 'error'
  ))
}

function appendDeltaItem(items: readonly TurnItem[], fragment: TurnItem): TurnItem {
  const current = items.find((item) => item.id === fragment.id)
  if (
    !current ||
    current.kind !== fragment.kind ||
    (fragment.kind !== 'assistant_text' && fragment.kind !== 'assistant_reasoning') ||
    (current.kind !== 'assistant_text' && current.kind !== 'assistant_reasoning')
  ) return fragment
  return {
    ...fragment,
    createdAt: current.createdAt,
    text: `${current.text}${fragment.text}`
  }
}

function upsertItem(items: readonly TurnItem[], item: TurnItem): TurnItem[] {
  const index = items.findIndex((entry) => entry.id === item.id)
  if (index < 0) return [...items, item]
  if (items[index] === item) return [...items]
  const next = [...items]
  next[index] = item
  return next
}

function updateTurnStatus(
  thread: ThreadDetail,
  turnId: string | undefined,
  status: Turn['status'],
  threadStatus: ThreadDetail['status'],
  timestamp: string,
  prompt = '',
  metadata: Partial<Pick<Turn, 'model' | 'providerId' | 'accountId' | 'reasoningEffort' | 'mode' | 'attachmentIds'>> = {}
): ThreadDetail {
  if (!turnId) return { ...thread, status: threadStatus }
  const withTurn = ensureTurn(thread, turnId, status, timestamp, prompt, metadata)
  const terminal = status === 'completed' || status === 'failed' || status === 'aborted'
  return {
    ...withTurn,
    status: threadStatus,
    turns: withTurn.turns.map((turn) => turn.id === turnId
      ? {
          ...turn,
          ...metadata,
          status,
          ...(status === 'running' && !turn.startedAt ? { startedAt: timestamp } : {}),
          ...(terminal ? { finishedAt: timestamp, steering: [] } : {})
        }
      : turn)
  }
}

function ensureTurn(
  thread: ThreadDetail,
  turnId: string,
  status: Turn['status'],
  timestamp: string,
  prompt = '',
  metadata: Partial<Pick<Turn, 'model' | 'providerId' | 'accountId' | 'reasoningEffort' | 'mode' | 'attachmentIds'>> = {}
): ThreadDetail {
  if (thread.turns.some((turn) => turn.id === turnId)) {
    if (Object.keys(metadata).length === 0) return thread
    return {
      ...thread,
      turns: thread.turns.map((turn) => turn.id === turnId ? { ...turn, ...metadata } : turn)
    }
  }
  const turn: Turn = {
    id: turnId,
    threadId: thread.id,
    status,
    prompt,
    model: thread.model,
    ...(thread.providerId ? { providerId: thread.providerId } : {}),
    ...(thread.accountId ? { accountId: thread.accountId } : {}),
    steering: [],
    createdAt: timestamp,
    ...(status === 'running' ? { startedAt: timestamp } : {}),
    items: [],
    attachmentIds: [],
    activeSkillIds: [],
    injectedMemoryIds: [],
    injectedMemorySummaries: [],
    injectedInstructionSources: [],
    mode: thread.mode,
    ...metadata
  }
  return { ...thread, turns: [...thread.turns, turn] }
}

function upsertTurnItem(thread: ThreadDetail, item: TurnItem): ThreadDetail {
  const prompt = item.kind === 'user_message' ? item.text : ''
  const withTurn = ensureTurn(thread, item.turnId, 'running', item.createdAt, prompt)
  return {
    ...withTurn,
    turns: withTurn.turns.map((turn) => turn.id === item.turnId
      ? {
          ...turn,
          ...(item.kind === 'user_message' ? { prompt: item.text } : {}),
          ...(item.kind === 'user_message' && item.attachmentIds
            ? { attachmentIds: item.attachmentIds }
            : {}),
          items: upsertItem(turn.items, item)
        }
      : turn)
  }
}

function mapTurnItems(thread: ThreadDetail, map: (item: TurnItem) => TurnItem): ThreadDetail {
  return {
    ...thread,
    turns: thread.turns.map((turn) => ({ ...turn, items: turn.items.map(map) }))
  }
}

function omitPendingApproval(state: ThreadProjection, approvalId: string): ThreadProjection {
  if (state.pendingApproval?.approvalId !== approvalId) return state
  const { pendingApproval: _pending, ...rest } = state
  return rest
}

function omitPendingUserInput(state: ThreadProjection, inputId: string): ThreadProjection {
  if (state.pendingUserInput?.inputId !== inputId) return state
  const { pendingUserInput: _pending, ...rest } = state
  return rest
}
