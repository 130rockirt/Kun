import { z } from 'zod'
import {
  GraphAgentLifecycleSchema,
  GraphAgentProfileVersionV1Schema,
  GraphAgentRoutingRequestV1Schema
} from '../../contracts/graph-agents.js'
import type { ServerRuntime } from './server-runtime.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'

const PortableId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const WorkspaceSchema = z.string().trim().min(1).max(4_096)

const RouteAgentRequestSchema = z.object({
  workspace: WorkspaceSchema,
  request: GraphAgentRoutingRequestV1Schema
}).strict()

const TransitionProfileRequestSchema = z.object({
  workspace: WorkspaceSchema,
  lifecycle: GraphAgentLifecycleSchema,
  reason: z.string().trim().min(1).max(4_096)
}).strict()

const ImportProfileRequestSchema = z.object({
  workspace: WorkspaceSchema,
  profile: GraphAgentProfileVersionV1Schema,
  reason: z.string().trim().min(1).max(4_096)
}).strict()

const MergeProfilesRequestSchema = z.object({
  workspace: WorkspaceSchema,
  sourceProfileIds: z.array(PortableId).min(2).max(64),
  targetProfileId: PortableId,
  name: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(4_096)
}).strict()

const ConsolidateRequestSchema = z.object({
  workspace: WorkspaceSchema,
  idempotencyKey: PortableId
}).strict()

const GovernCandidateRequestSchema = z.object({
  workspace: WorkspaceSchema,
  action: z.enum(['approve', 'reject', 'start_probation', 'promote', 'rollback', 'delete']),
  reason: z.string().trim().min(1).max(4_096)
}).strict()

const ExploreRequestSchema = z.object({
  workspace: WorkspaceSchema,
  capabilityGap: z.string().trim().min(1).max(4_096)
}).strict()

export async function graphProjectIdentity(
  runtime: ServerRuntime,
  request: Request
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const workspace = new URL(request.url).searchParams.get('workspace')
  if (!workspace) return ERRORS.validation('workspace is required', [])
  try {
    return jsonResponse(await runtime.graph.registry.identify(workspace))
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function listProjectAgents(
  runtime: ServerRuntime,
  projectId: string,
  request: Request
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    const includeArchived = new URL(request.url).searchParams.get('include_archived') === 'true'
    return jsonResponse({
      profiles: await runtime.graph.registry.listProfiles(projectId, includeArchived)
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function routeProjectAgent(
  runtime: ServerRuntime,
  projectId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, RouteAgentRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    const identity = await verifiedIdentity(runtime, projectId, parsed.data.workspace)
    return jsonResponse(await runtime.graph.registry.route(identity, parsed.data.request))
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function transitionProjectAgent(
  runtime: ServerRuntime,
  projectId: string,
  profileId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, TransitionProfileRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    const identity = await verifiedIdentity(runtime, projectId, parsed.data.workspace)
    return jsonResponse(await runtime.graph.registry.transitionProfile(
      identity,
      profileId,
      parsed.data.lifecycle,
      parsed.data.reason,
      'user'
    ))
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function exportProjectAgent(
  runtime: ServerRuntime,
  projectId: string,
  profileId: string,
  request: Request
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const rawVersion = new URL(request.url).searchParams.get('version')
  const version = rawVersion === null ? undefined : Number(rawVersion)
  if (version !== undefined && (!Number.isInteger(version) || version <= 0)) {
    return ERRORS.validation('version must be a positive integer', [])
  }
  try {
    const profile = await runtime.graph.registry.getProfile(projectId, profileId, version)
    if (!profile) return ERRORS.notFound(`project agent not found: ${profileId}`)
    await runtime.graph.registry.recordProfileExport(projectId, profile)
    return jsonResponse({
      format: 'kun.graph-agent-profile',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      profile
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function importProjectAgent(
  runtime: ServerRuntime,
  projectId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, ImportProfileRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    const identity = await verifiedIdentity(runtime, projectId, parsed.data.workspace)
    return jsonResponse(await runtime.graph.registry.importProfile(
      identity,
      parsed.data.profile,
      parsed.data.reason
    ), 201)
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function mergeProjectAgents(
  runtime: ServerRuntime,
  projectId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, MergeProfilesRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    const identity = await verifiedIdentity(runtime, projectId, parsed.data.workspace)
    return jsonResponse(await runtime.graph.registry.mergeProfiles(
      identity,
      parsed.data.sourceProfileIds,
      parsed.data.targetProfileId,
      parsed.data.name,
      parsed.data.reason
    ), 201)
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function listProjectAgentEvidence(
  runtime: ServerRuntime,
  projectId: string,
  request: Request
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    const profileId = new URL(request.url).searchParams.get('profile_id') ?? undefined
    return jsonResponse({
      evidence: await runtime.graph.registry.listEvidence(projectId, profileId)
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function listProjectAgentScores(
  runtime: ServerRuntime,
  projectId: string
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    return jsonResponse({
      scores: await runtime.graph.registry.listScores(projectId)
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function listProjectRoutingExplanations(
  runtime: ServerRuntime,
  projectId: string
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    return jsonResponse({
      explanations: await runtime.graph.registry.listExplanations(projectId)
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function listLearningCandidates(
  runtime: ServerRuntime,
  projectId: string
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    return jsonResponse({
      candidates: await runtime.graph.registry.listCandidates(projectId)
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function governLearningCandidate(
  runtime: ServerRuntime,
  projectId: string,
  candidateId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, GovernCandidateRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    const identity = await verifiedIdentity(runtime, projectId, parsed.data.workspace)
    return jsonResponse(await runtime.graph.learning.governCandidate({
      identity,
      candidateId,
      action: parsed.data.action,
      actor: 'user',
      reason: parsed.data.reason
    }))
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function consolidateLearning(
  runtime: ServerRuntime,
  projectId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, ConsolidateRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    const identity = await verifiedIdentity(runtime, projectId, parsed.data.workspace)
    return jsonResponse({
      job: await runtime.graph.learning.enqueueConsolidation(
        identity,
        'manual',
        parsed.data.idempotencyKey
      )
    }, 202)
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function listLearningEpisodes(
  runtime: ServerRuntime,
  projectId: string
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    return jsonResponse({
      episodes: await runtime.graph.learning.listEpisodes(projectId)
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function listLearningJobs(
  runtime: ServerRuntime,
  projectId: string
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    return jsonResponse({
      jobs: await runtime.graph.learning.listJobs(projectId)
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function listGraphGovernanceAudit(
  runtime: ServerRuntime,
  projectId: string
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    return jsonResponse({
      audit: await runtime.graph.registry.listAudit(projectId)
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function exploreGraphCapability(
  runtime: ServerRuntime,
  projectId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, ExploreRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    const identity = await verifiedIdentity(runtime, projectId, parsed.data.workspace)
    return jsonResponse({
      results: await runtime.graph.learning.exploreCapabilityGap(
        identity,
        parsed.data.capabilityGap
      )
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

export async function graphDiagnostics(runtime: ServerRuntime): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    const [runs, identities, writes] = await Promise.all([
      runtime.graph.store.list({}),
      runtime.graph.registry.listProjectIdentities(),
      runtime.graph.writes.list()
    ])
    const projectMetrics = await Promise.all(identities.slice(0, 1_000).map(async (identity) => {
      const [profiles, scores, candidates, jobs, explanations] = await Promise.all([
        runtime.graph!.registry.listProfiles(identity.projectId, true),
        runtime.graph!.registry.listScores(identity.projectId),
        runtime.graph!.registry.listCandidates(identity.projectId),
        runtime.graph!.learning.listJobs(identity.projectId),
        runtime.graph!.registry.listExplanations(identity.projectId)
      ])
      return {
        profiles: profiles.length,
        scores: scores.length,
        candidates: candidates.length,
        routingDecisions: explanations.length,
        learningJobs: jobs.length,
        failedLearningJobs: jobs.filter((job) => job.status === 'failed').length
      }
    }))
    const nodes = runs.flatMap((run) => Object.values(run.nodes))
    const attempts = nodes.flatMap((node) => node.attempts)
    return jsonResponse({
      enabled: runtime.graph.config().enabled,
      scheduler: runtime.graph.scheduler.diagnostics(),
      store: await runtime.graph.store.diagnostics?.() ?? [],
      metrics: {
        runs: runs.length,
        runStatuses: countBy(runs.map((run) => run.status)),
        nodeStatuses: countBy(nodes.map((node) => node.status)),
        attempts: attempts.length,
        attemptStatuses: countBy(attempts.map((attempt) => attempt.status)),
        failureClasses: countBy(attempts.flatMap((attempt) =>
          attempt.failureClass ? [attempt.failureClass] : [])),
        retries: nodes.reduce((sum, node) => sum + Math.max(0, node.attempts.length - 1), 0),
        totalQueueTimeMs: attempts.reduce((sum, attempt) =>
          sum + (attempt.startedAt
            ? Math.max(0, Date.parse(attempt.startedAt) - Date.parse(attempt.queuedAt))
            : 0), 0),
        totalRunLatencyMs: runs.reduce((sum, run) =>
          sum + Math.max(
            0,
            Date.parse(run.finishedAt ?? run.updatedAt) - Date.parse(run.createdAt)
          ), 0),
        revisions: runs.reduce((sum, run) => sum + run.budget.revisions, 0),
        loopIterations: runs.reduce((sum, run) => sum + run.budget.loopIterations, 0),
        totalTokens: runs.reduce((sum, run) => sum + run.budget.totalTokens, 0),
        mailboxMessages: runs.reduce((sum, run) => sum + run.messages.length, 0),
        peakMailboxMessages: runs.reduce((peak, run) =>
          Math.max(peak, run.messages.length), 0),
        artifactBytes: runs.reduce((sum, run) => sum + run.budget.artifactBytes, 0),
        reviewOutcomes: countBy(runs.flatMap((run) =>
          run.reviews.map((review) => review.outcome))),
        cleanupStates: countBy(runs.flatMap((run) =>
          run.cleanup.map((cleanup) => cleanup.state))),
        projects: identities.length,
        projectAgents: projectMetrics.reduce((sum, item) => sum + item.profiles, 0),
        agentScores: projectMetrics.reduce((sum, item) => sum + item.scores, 0),
        routingDecisions: projectMetrics.reduce((sum, item) =>
          sum + item.routingDecisions, 0),
        learningCandidates: projectMetrics.reduce((sum, item) => sum + item.candidates, 0),
        learningJobs: projectMetrics.reduce((sum, item) => sum + item.learningJobs, 0),
        failedLearningJobs: projectMetrics.reduce((sum, item) =>
          sum + item.failedLearningJobs, 0)
      },
      resources: {
        leaseStates: countBy(writes.leases.map((lease) => lease.state)),
        worktreeStates: countBy(writes.worktrees.map((worktree) => worktree.state)),
        activeLeases: writes.leases.filter((lease) => lease.state === 'active').length,
        preservedWorktrees: writes.worktrees.filter((worktree) =>
          worktree.state === 'preserved').length,
        conflictedWorktrees: writes.worktrees.filter((worktree) =>
          worktree.state === 'conflict').length
      }
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

export async function listThreadGraphReferences(
  runtime: ServerRuntime,
  threadId: string
): Promise<JsonResponse> {
  if (!runtime.graph) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    return jsonResponse({
      references: await runtime.graph.references.list(threadId)
    })
  } catch (error) {
    return graphAgentError(error)
  }
}

async function verifiedIdentity(
  runtime: ServerRuntime,
  projectId: string,
  workspace: string
) {
  const identity = await runtime.graph!.registry.identify(workspace)
  if (identity.projectId !== projectId) {
    throw new Error('project id does not match canonical workspace identity')
  }
  return identity
}

async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<
  | { ok: true; data: z.output<T> }
  | { ok: false; response: JsonResponse | Response }
> {
  const body = await readJsonBody(request)
  if (!body.ok) return body
  const parsed = schema.safeParse(body.value)
  if (!parsed.success) {
    return {
      ok: false,
      response: ERRORS.validation('invalid Graph project request body', parsed.error.issues)
    }
  }
  return { ok: true, data: parsed.data }
}

function graphAgentError(error: unknown): JsonResponse {
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) return ERRORS.notFound(message)
  if (/requires explicit user|illegal|cannot|mismatch|does not match|outside/i.test(message)) {
    return ERRORS.conflict(message)
  }
  return jsonResponse({ code: 'graph_project_error', message: message.slice(0, 2_048) }, 500)
}
