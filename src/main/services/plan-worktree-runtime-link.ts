import { z } from 'zod'
import type {
  PlanWorktreeAttachThreadRequest,
  PlanWorktreeRunRecord
} from '../../shared/plan-worktree'
import type { RuntimeRequestResult } from '../../shared/kun-gui-api'
import { currentExecutionWorkspace } from './plan-worktree-admission-fence'
import { PlanWorktreeCoordinatorError } from './plan-worktree-coordinator'
import {
  matchesPlanWorktreeAdmission,
  matchesPlanWorktreeAdmissionBinding
} from './plan-worktree-runtime-admission'

type RuntimeRequest = (
  path: string,
  method?: string,
  body?: string,
  headers?: Record<string, string>
) => Promise<RuntimeRequestResult>

const ThreadIdentitySchema = z.object({
  id: z.string().min(1),
  workspace: z.string().min(1),
  relation: z.enum(['primary', 'fork', 'side']),
  parentThreadId: z.string().optional(),
  planBuildRunId: z.string().optional(),
  planBuildAdmissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  planBuildAdmissionCapabilityHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).passthrough()

const ThreadDetailSchema = ThreadIdentitySchema.extend({
  forkedFromTurnCount: z.number().int().nonnegative().optional(),
  goal: z.object({ objective: z.string().min(1), status: z.string().min(1) })
    .passthrough().nullish(),
  turns: z.array(z.object({
    id: z.string().min(1),
    clientRequestId: z.string().optional(),
    clientRequestFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    prompt: z.string().optional(),
    orchestration: z.enum(['direct', 'graph']).default('direct'),
    agentSurface: z.enum(['code', 'write', 'design']).optional()
  }).passthrough()).default([])
}).passthrough()

const ThreadListSchema = z.object({
  threads: z.array(ThreadIdentitySchema)
}).passthrough()

export function createPlanWorktreeRuntimeLinkResolver(runtimeRequest: RuntimeRequest) {
  return async (
    record: PlanWorktreeRunRecord
  ): Promise<PlanWorktreeAttachThreadRequest | null> => {
    let threadId = record.executionThreadId
    if (!threadId) {
      const listed = await requestJson(
        runtimeRequest,
        '/v1/threads?include=side&include_archived=true'
      )
      const parsed = ThreadListSchema.safeParse(listed)
      if (!parsed.success) throw invalidRuntimeProjection()
      const candidates = parsed.data.threads.filter(
        (thread) => thread.planBuildRunId === record.runId
      )
      if (candidates.length > 1) {
        throw new PlanWorktreeCoordinatorError(
          'thread_attach_failed',
          'Multiple Kun side threads claim this plan-worktree run.'
        )
      }
      if (candidates.length === 0) return null
      // Older index rows can omit the admission binding; the detailed
      // projection below proves it before anything is attached.
      assertIdentity(record, candidates[0]!, false)
      threadId = candidates[0]!.id
    }

    const rawDetail = await requestJson(
      runtimeRequest,
      `/v1/threads/${encodeURIComponent(threadId)}`
    )
    const parsedDetail = ThreadDetailSchema.safeParse(rawDetail)
    if (!parsedDetail.success) throw invalidRuntimeProjection()
    const thread = parsedDetail.data
    assertIdentity(record, thread)
    if (thread.goal && thread.goal.objective !== record.goalObjective) {
      throw new PlanWorktreeCoordinatorError(
        'external_state_changed',
        'The recovered execution thread has a different goal objective.'
      )
    }

    const recovered: PlanWorktreeAttachThreadRequest = {
      runId: record.runId,
      executionThreadId: thread.id
    }
    if (record.executionTurnId) return { ...recovered, executionTurnId: record.executionTurnId }
    const boundary = thread.forkedFromTurnCount
    if (boundary === undefined) {
      if (thread.turns.length > 0) throw ambiguousTurnBoundary()
      return recovered
    }
    const admitted = thread.turns.slice(boundary)
    if (admitted.length === 0) return recovered
    if (!thread.goal || thread.goal.objective !== record.goalObjective) {
      throw new PlanWorktreeCoordinatorError(
        'external_state_changed',
        'The recovered execution turn is not bound to the durable plan goal.'
      )
    }
    const origin = admitted[0]!
    if (!matchesDurableAdmission(record, origin)) {
      throw new PlanWorktreeCoordinatorError(
        'external_state_changed',
        'A foreign turn was admitted before the durable plan-build origin.'
      )
    }
    // The first exact post-fork admission is immutable. Later turns are
    // continuations and remain visible to the completion verifier.
    return { ...recovered, executionTurnId: origin.id }
  }
}

function matchesDurableAdmission(
  record: PlanWorktreeRunRecord,
  turn: z.infer<typeof ThreadDetailSchema>['turns'][number]
): boolean {
  return matchesPlanWorktreeAdmission(record, turn)
}

function assertIdentity(
  record: PlanWorktreeRunRecord,
  thread: z.infer<typeof ThreadIdentitySchema>,
  requireAdmissionBinding = true
): void {
  const expectedWorkspace = currentExecutionWorkspace(record)
  if (thread.workspace !== expectedWorkspace || thread.relation !== 'side'
    || thread.parentThreadId !== record.sourceThreadId
    || thread.planBuildRunId !== record.runId) {
    throw new PlanWorktreeCoordinatorError(
      'external_state_changed',
      'The recovered Kun thread does not match the durable plan-worktree identity.'
    )
  }
  if (requireAdmissionBinding && !matchesPlanWorktreeAdmissionBinding(record, thread)) {
    throw new PlanWorktreeCoordinatorError(
      'external_state_changed',
      'The recovered Kun thread does not match the durable plan-build admission binding.'
    )
  }
}

async function requestJson(
  runtimeRequest: RuntimeRequest,
  path: string
): Promise<unknown> {
  let response: RuntimeRequestResult
  try {
    response = await runtimeRequest(path, 'GET')
  } catch (error) {
    throw runtimeUnavailable(error)
  }
  if (!response || !response.ok) {
    throw runtimeUnavailable(new Error(`Kun runtime returned ${response?.status ?? 'no response'}.`))
  }
  try {
    return JSON.parse(response.body) as unknown
  } catch {
    throw invalidRuntimeProjection()
  }
}

function runtimeUnavailable(error: unknown): PlanWorktreeCoordinatorError {
  return new PlanWorktreeCoordinatorError(
    'thread_attach_failed',
    `Kun runtime could not prove execution-thread ownership: ${
      error instanceof Error ? error.message : String(error)
    }`
  )
}

function invalidRuntimeProjection(): PlanWorktreeCoordinatorError {
  return new PlanWorktreeCoordinatorError(
    'thread_attach_failed',
    'Kun returned an invalid plan-worktree recovery projection.'
  )
}

function ambiguousTurnBoundary(): PlanWorktreeCoordinatorError {
  return new PlanWorktreeCoordinatorError(
    'thread_attach_failed',
    'The execution turn cannot be uniquely adopted after the fork boundary.'
  )
}
