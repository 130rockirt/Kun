import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  PlanWorktreeAttentionReason,
  PlanWorktreeCompletionSnapshot,
  PlanWorktreeRunRecord
} from '../../shared/plan-worktree'
import type { RuntimeRequestResult } from '../../shared/kun-gui-api'

type RuntimeRequest = (
  path: string,
  method?: string,
  body?: string,
  headers?: Record<string, string>
) => Promise<RuntimeRequestResult>

const RuntimeTurnSchema = z.object({
  id: z.string().min(1),
  clientRequestId: z.string().optional(),
  prompt: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'aborted']),
  orchestration: z.enum(['direct', 'graph']).default('direct'),
  agentSurface: z.enum(['code', 'write', 'design']).optional()
}).passthrough()

const RuntimeThreadSchema = z.object({
  id: z.string().min(1),
  workspace: z.string().min(1),
  relation: z.enum(['primary', 'fork', 'side']),
  parentThreadId: z.string().optional(),
  planBuildRunId: z.string().optional(),
  forkedFromTurnCount: z.number().int().nonnegative().optional(),
  goal: z.object({
    objective: z.string().min(1),
    status: z.string().min(1)
  }).passthrough().nullish(),
  pendingUserInputIds: z.array(z.string()).default([]),
  pendingApprovalIds: z.array(z.string()).default([]),
  turns: z.array(RuntimeTurnSchema).default([])
}).passthrough()

const GraphRunListSchema = z.object({
  runs: z.array(z.object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    sourceTurnId: z.string().min(1),
    status: z.string().min(1)
  }).passthrough()),
  nextCursor: z.string().min(1).optional()
}).passthrough()

const GraphRunSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  sourceTurnId: z.string().min(1),
  status: z.string().min(1),
  nodes: z.record(z.string(), z.object({
    status: z.string().min(1),
    node: z.object({ kind: z.string().min(1), required: z.boolean().optional() }).passthrough()
  }).passthrough()).default({}),
  cleanup: z.array(z.object({ state: z.string().min(1) }).passthrough()).default([]),
  supervision: z.object({
    pendingActions: z.array(z.object({ pendingAction: z.string().min(1) }).passthrough()).default([]),
    peerReviewLeases: z.array(z.unknown()).default([])
  }).passthrough().optional()
}).passthrough()

export class PlanWorktreeRuntimeCompletionError extends Error {
  constructor(
    readonly reason: PlanWorktreeAttentionReason,
    message: string
  ) {
    super(message)
    this.name = 'PlanWorktreeRuntimeCompletionError'
  }
}

export function createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest: RuntimeRequest) {
  return async (
    record: PlanWorktreeRunRecord,
    claimed: PlanWorktreeCompletionSnapshot
  ): Promise<PlanWorktreeCompletionSnapshot> => {
    if (!record.executionThreadId) {
      throw new PlanWorktreeRuntimeCompletionError(
        'thread_attach_failed',
        'The isolated execution thread is not durably attached to this run.'
      )
    }
    const thread = RuntimeThreadSchema.parse(await requestJson(
      runtimeRequest,
      `/v1/threads/${encodeURIComponent(record.executionThreadId)}`
    ))
    assertThreadIdentity(record, thread)
    if (thread.goal?.objective !== record.goalObjective) {
      throw new PlanWorktreeRuntimeCompletionError(
        'external_state_changed',
        'The execution thread goal no longer matches this plan-build objective.'
      )
    }
    if (!record.executionTurnId) {
      throw new PlanWorktreeRuntimeCompletionError(
        'thread_attach_failed',
        'The execution origin turn has not been durably adopted by the host.'
      )
    }
    const turnId = record.executionTurnId
    const turnIndex = thread.turns.findIndex((turn) => turn.id === turnId)
    if (turnIndex < 0 || (
      thread.forkedFromTurnCount !== undefined && turnIndex < thread.forkedFromTurnCount
    )) {
      throw new PlanWorktreeRuntimeCompletionError(
        'external_state_changed',
        'The claimed execution turn does not belong to this isolated plan run.'
      )
    }
    const origin = thread.turns[turnIndex]!
    if (!matchesDurableAdmission(record, origin)) {
      throw new PlanWorktreeRuntimeCompletionError(
        'external_state_changed',
        'The execution origin does not match the durable plan admission identity.'
      )
    }
    const executionTurns = thread.turns.slice(turnIndex)
    const graphSnapshots = await Promise.all(executionTurns.flatMap((turn, index) => {
      const usesGraph = turn.orchestration === 'graph' || (index === 0 && record.orchestration === 'graph')
      return usesGraph
        ? [loadGraphSnapshot(
            runtimeRequest,
            record,
            turn.id,
            index === 0 ? record.graphRunId : undefined
          )]
        : []
    }))
    const graph = aggregateGraphSnapshots(graphSnapshots)
    return {
      executionTurnId: turnId,
      turnStatus: aggregateTurnStatus(executionTurns),
      goalStatus: mapGoalStatus(thread.goal?.status),
      hasLaterRunningTurn: executionTurns.slice(1)
        .some((candidate) => candidate.status === 'queued' || candidate.status === 'running')
        || graphSnapshots.slice(record.orchestration === 'graph' ? 1 : 0)
          .some((candidate) => candidate.status === 'running' || candidate.hasPendingGate),
      hasPendingApproval: thread.pendingApprovalIds.length > 0,
      hasPendingUserInput: thread.pendingUserInputIds.length > 0,
      graphStatus: graph.status,
      graphHasPendingGate: graph.hasPendingGate
    }
  }
}

function matchesDurableAdmission(
  record: PlanWorktreeRunRecord,
  turn: z.infer<typeof RuntimeTurnSchema>
): boolean {
  if (!record.executionPromptSha256 || !record.admissionClientRequestId) return false
  return turn.clientRequestId === record.admissionClientRequestId
    && turn.orchestration === record.orchestration
    && turn.agentSurface === 'code'
    && typeof turn.prompt === 'string'
    && createHash('sha256').update(turn.prompt).digest('hex') === record.executionPromptSha256
}

function assertThreadIdentity(
  record: PlanWorktreeRunRecord,
  thread: z.infer<typeof RuntimeThreadSchema>
): void {
  if (thread.id !== record.executionThreadId || thread.planBuildRunId !== record.runId
    || thread.relation !== 'side' || thread.parentThreadId !== record.sourceThreadId
    || thread.workspace !== (record.executionWorkspace ?? record.worktreePath)) {
    throw new PlanWorktreeRuntimeCompletionError(
      'external_state_changed',
      'The runtime execution thread no longer matches the durable plan-worktree identity.'
    )
  }
}

async function loadGraphSnapshot(
  runtimeRequest: RuntimeRequest,
  record: PlanWorktreeRunRecord,
  turnId: string,
  preferredGraphRunId?: string
): Promise<{
  status: PlanWorktreeCompletionSnapshot['graphStatus']
  hasPendingGate: boolean
}> {
  let graphRunId = preferredGraphRunId
  if (!graphRunId) {
    const listed = await listGraphRunsForTurn(runtimeRequest, record.executionThreadId!, turnId)
    if (listed.length !== 1) {
      throw new PlanWorktreeRuntimeCompletionError(
        'graph_incomplete',
        listed.length ? 'Multiple Graph runs match the execution turn.' : 'The Graph run is not available yet.'
      )
    }
    graphRunId = listed[0]!.id
  }
  const graph = GraphRunSchema.parse(await requestJson(
    runtimeRequest,
    `/v1/graphs/${encodeURIComponent(graphRunId)}`
  ))
  if (graph.threadId !== record.executionThreadId || graph.sourceTurnId !== turnId) {
    throw new PlanWorktreeRuntimeCompletionError(
      'external_state_changed',
      'The Graph run does not belong to this execution thread and turn.'
    )
  }
  const activeNodeStatuses = new Set([
    'pending', 'blocked', 'ready', 'queued', 'running', 'submitted', 'reviewing', 'repair_required'
  ])
  const integrationIncomplete = Object.values(graph.nodes).some((projection) =>
    activeNodeStatuses.has(projection.status)
    || (projection.node.kind === 'integration'
      && projection.node.required !== false
      && projection.status !== 'accepted'
      && projection.status !== 'superseded'))
  const cleanupIncomplete = graph.cleanup.some((item) =>
    item.state !== 'completed' && item.state !== 'preserved')
  const supervisionPending = Boolean(
    graph.supervision?.pendingActions.some((action) => action.pendingAction !== 'completion')
      || graph.supervision?.peerReviewLeases.length
  )
  return {
    status: mapGraphStatus(graph.status),
    hasPendingGate: integrationIncomplete
      || cleanupIncomplete
      || supervisionPending
  }
}

function aggregateTurnStatus(
  turns: Array<z.infer<typeof RuntimeTurnSchema>>
): PlanWorktreeCompletionSnapshot['turnStatus'] {
  if (turns.some((turn) => turn.status === 'queued' || turn.status === 'running')) return 'running'
  const latest = turns.at(-1)?.status
  if (latest === 'failed') return 'failed'
  if (latest === 'aborted') return 'interrupted'
  return latest === 'completed' ? 'completed' : 'running'
}

function aggregateGraphSnapshots(
  snapshots: Array<{
    status: PlanWorktreeCompletionSnapshot['graphStatus']
    hasPendingGate: boolean
  }>
): {
  status: PlanWorktreeCompletionSnapshot['graphStatus']
  hasPendingGate: boolean
} {
  if (!snapshots.length) return { status: 'not_applicable', hasPendingGate: false }
  const latest = snapshots.at(-1)!
  const hasActiveAttempt = snapshots.some((item) => item.status === 'running')
  // A later successful continuation supersedes repair obligations left by an
  // older terminal attempt. Truly active attempts still block integration.
  const hasPendingGate = hasActiveAttempt || latest.hasPendingGate
  const status = hasActiveAttempt ? 'running' : latest.status
  return { status, hasPendingGate }
}

async function listGraphRunsForTurn(
  runtimeRequest: RuntimeRequest,
  threadId: string,
  turnId: string
): Promise<Array<z.infer<typeof GraphRunListSchema>['runs'][number]>> {
  const matches: Array<z.infer<typeof GraphRunListSchema>['runs'][number]> = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = GraphRunListSchema.parse(await requestJson(
      runtimeRequest,
      `/v1/graphs?thread_id=${encodeURIComponent(threadId)}&limit=100${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`
    ))
    matches.push(...page.runs.filter((run) => run.sourceTurnId === turnId))
    cursor = page.nextCursor
    if (cursor && seenCursors.has(cursor)) {
      throw new PlanWorktreeRuntimeCompletionError(
        'external_state_changed',
        'Kun runtime repeated a Graph list cursor.'
      )
    }
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return matches
}

async function requestJson(runtimeRequest: RuntimeRequest, path: string): Promise<unknown> {
  const response = await runtimeRequest(path, 'GET')
  if (!response.ok) {
    throw new PlanWorktreeRuntimeCompletionError(
      'execution_incomplete',
      `Kun runtime completion query failed (${response.status}).`
    )
  }
  try {
    return JSON.parse(response.body) as unknown
  } catch {
    throw new PlanWorktreeRuntimeCompletionError(
      'external_state_changed',
      'Kun runtime returned an invalid completion projection.'
    )
  }
}

function mapGoalStatus(status: string | undefined): PlanWorktreeCompletionSnapshot['goalStatus'] {
  if (!status) return 'missing'
  if (status === 'complete') return 'complete'
  if (status === 'blocked' || status === 'paused' || status.endsWith('Limited')) return 'blocked'
  return 'active'
}

function mapGraphStatus(status: string): PlanWorktreeCompletionSnapshot['graphStatus'] {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'interrupted'
  return 'running'
}
