import { rendererRuntimeClient } from '../agent/runtime-client'
import {
  KUN_GRAPHS_PATH,
  KUN_GRAPH_PROJECT_IDENTITY_PATH,
  kunDelegationDiagnosticsPath,
  kunGraphActionPath,
  kunGraphArtifactPath,
  kunGraphEventsPath,
  kunGraphPath,
  kunGraphProjectAgentActionPath,
  kunGraphProjectAgentsActionPath,
  kunGraphProjectAgentsPath,
  kunGraphProjectCandidateActionPath,
  kunGraphProjectCollectionPath,
  kunGraphProjectConsolidatePath
} from '@shared/kun-endpoints'
import type {
  GraphAgentEvidence,
  GraphAgentProfile,
  GraphAgentScore,
  GraphArtifactPage,
  GraphDelegationDiagnostics,
  GraphEventEnvelope,
  GraphGovernanceAudit,
  GraphLearningCandidate,
  GraphLearningJob,
  GraphPatchOperation,
  GraphRun,
  ProjectIdentity
} from './graph-types'

type RuntimeResponse = { ok: boolean; status: number; body: string }

function graphId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function parse<T>(response: RuntimeResponse, fallback: string): T {
  let value: unknown
  try {
    value = response.body ? JSON.parse(response.body) : {}
  } catch {
    throw new Error(`${fallback}: runtime returned invalid JSON`)
  }
  if (!response.ok) {
    const detail = value && typeof value === 'object'
      ? String((value as { message?: unknown }).message ?? fallback)
      : fallback
    throw new Error(detail)
  }
  return value as T
}

async function request<T>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>
): Promise<T> {
  const response = await rendererRuntimeClient.runtimeRequest(
    path,
    method,
    body ? JSON.stringify(body) : undefined
  )
  return parse<T>(response, `Graph request failed (${response.status})`)
}

export const graphRuntimeClient = {
  delegationDiagnostics(parentThreadId: string): Promise<GraphDelegationDiagnostics> {
    return request(kunDelegationDiagnosticsPath(parentThreadId))
  },

  async listRuns(threadId?: string): Promise<GraphRun[]> {
    const query = threadId ? `?thread_id=${encodeURIComponent(threadId)}` : ''
    const page = await request<{ runs: Array<{ id: string }> }>(`${KUN_GRAPHS_PATH}${query}`)
    return Promise.all(page.runs.map((run) => graphRuntimeClient.getRun(run.id)))
  },

  getRun(runId: string): Promise<GraphRun> {
    return request(kunGraphPath(runId))
  },

  async listEvents(runId: string, sinceSeq = 0): Promise<GraphEventEnvelope[]> {
    return (await request<{ events: GraphEventEnvelope[] }>(
      `${kunGraphEventsPath(runId)}?since_seq=${sinceSeq}`
    )).events
  },

  readArtifact(
    runId: string,
    artifactId: string,
    cursor?: { offset?: number; startLine?: number }
  ): Promise<GraphArtifactPage> {
    const query = new URLSearchParams()
    if (cursor?.startLine !== undefined) query.set('start_line', String(cursor.startLine))
    else query.set('offset', String(cursor?.offset ?? 0))
    return request(`${kunGraphArtifactPath(runId, artifactId)}?${query}`)
  },

  command(runId: string, action: 'start' | 'pause' | 'resume' | 'cleanup'): Promise<GraphRun> {
    const commandId = graphId(`user_${action}`)
    return request(kunGraphActionPath(runId, action), 'POST', {
      commandId,
      idempotencyKey: commandId
    })
  },

  async cancel(runId: string, reason: string): Promise<GraphRun> {
    const commandId = graphId('user_cancel')
    return request(kunGraphActionPath(runId, 'cancel'), 'POST', {
      commandId,
      idempotencyKey: commandId,
      reason
    })
  },

  async retry(runId: string, nodeId: string): Promise<GraphRun> {
    const commandId = graphId('user_retry')
    return request(kunGraphActionPath(runId, 'retry'), 'POST', {
      commandId,
      idempotencyKey: commandId,
      nodeId
    })
  },

  async review(
    run: GraphRun,
    nodeId: string,
    attemptId: string,
    outcome: 'pass' | 'fail'
  ): Promise<GraphRun> {
    const commandId = graphId('human_review')
    return request(kunGraphActionPath(run.id, 'reviews'), 'POST', {
      commandId,
      idempotencyKey: commandId,
      expectedSeq: run.lastEventSeq,
      expectedRevision: run.currentRevision,
      review: {
        version: 1,
        reviewId: graphId('review'),
        nodeId,
        attemptId,
        reviewerKind: 'human',
        outcome,
        summary: outcome === 'pass'
          ? 'Approved by the user from the Graph panel.'
          : 'Rejected by the user from the Graph panel.',
        evidence: [],
        artifactRefs: [],
        ...(outcome === 'fail'
          ? { repairInstructions: 'Address the user rejection before resubmitting.' }
          : {}),
        createdAt: new Date().toISOString()
      }
    })
  },

  async patch(
    run: GraphRun,
    operations: GraphPatchOperation[],
    reason: string
  ): Promise<GraphRun> {
    const commandId = graphId('user_patch')
    const patchId = graphId('graph_patch')
    return request(kunGraphActionPath(run.id, 'patch'), 'POST', {
      commandId,
      idempotencyKey: patchId,
      expectedSeq: run.lastEventSeq,
      expectedRevision: run.currentRevision,
      patch: {
        version: 1,
        patchId,
        commandId,
        runId: run.id,
        baseRevision: run.currentRevision,
        requester: { kind: 'user', id: 'graph_workbench' },
        reason,
        operations,
        createdAt: new Date().toISOString()
      }
    })
  },

  async steer(
    runId: string,
    text: string,
    target: { kind: 'run' | 'lead' } | { kind: 'phase'; phaseId: string } |
      { kind: 'node'; nodeId: string } |
      { kind: 'attempt'; nodeId: string; attemptId: string }
  ): Promise<GraphRun> {
    const commandId = graphId('user_steer')
    return request(kunGraphActionPath(runId, 'steer'), 'POST', {
      commandId,
      idempotencyKey: commandId,
      target,
      text
    })
  },

  identity(workspace: string): Promise<ProjectIdentity> {
    return request(`${KUN_GRAPH_PROJECT_IDENTITY_PATH}?workspace=${encodeURIComponent(workspace)}`)
  },

  async listProfiles(projectId: string, includeArchived = true): Promise<GraphAgentProfile[]> {
    return (await request<{ profiles: GraphAgentProfile[] }>(
      `${kunGraphProjectAgentsPath(projectId)}?include_archived=${includeArchived}`
    )).profiles
  },

  async listEvidence(projectId: string): Promise<GraphAgentEvidence[]> {
    return (await request<{ evidence: GraphAgentEvidence[] }>(
      kunGraphProjectCollectionPath(projectId, 'evidence')
    )).evidence
  },

  async listScores(projectId: string): Promise<GraphAgentScore[]> {
    return (await request<{ scores: GraphAgentScore[] }>(
      kunGraphProjectCollectionPath(projectId, 'scores')
    )).scores
  },

  async listAudit(projectId: string): Promise<GraphGovernanceAudit[]> {
    return (await request<{ audit: GraphGovernanceAudit[] }>(
      kunGraphProjectCollectionPath(projectId, 'audit')
    )).audit
  },

  async listCandidates(projectId: string): Promise<GraphLearningCandidate[]> {
    return (await request<{ candidates: GraphLearningCandidate[] }>(
      kunGraphProjectCollectionPath(projectId, 'candidates')
    )).candidates
  },

  async listJobs(projectId: string): Promise<GraphLearningJob[]> {
    return (await request<{ jobs: GraphLearningJob[] }>(
      kunGraphProjectCollectionPath(projectId, 'jobs')
    )).jobs
  },

  transitionProfile(
    projectId: string,
    profileId: string,
    workspace: string,
    lifecycle: GraphAgentProfile['lifecycle'],
    reason: string
  ): Promise<GraphAgentProfile> {
    return request(
      kunGraphProjectAgentActionPath(projectId, profileId, 'lifecycle'),
      'POST',
      { workspace, lifecycle, reason }
    )
  },

  exportProfile(projectId: string, profileId: string): Promise<{
    format: 'kun.graph-agent-profile'
    formatVersion: 1
    exportedAt: string
    profile: GraphAgentProfile
  }> {
    return request(
      kunGraphProjectAgentActionPath(projectId, profileId, 'export')
    )
  },

  importProfile(
    projectId: string,
    workspace: string,
    profile: GraphAgentProfile
  ): Promise<GraphAgentProfile> {
    return request(
      kunGraphProjectAgentsActionPath(projectId, 'import'),
      'POST',
      {
        workspace,
        profile,
        reason: 'User imported a portable Graph project-agent profile.'
      }
    )
  },

  mergeProfiles(
    projectId: string,
    workspace: string,
    sourceProfileIds: string[],
    targetProfileId: string,
    name: string
  ): Promise<GraphAgentProfile> {
    return request(
      kunGraphProjectAgentsActionPath(projectId, 'merge'),
      'POST',
      {
        workspace,
        sourceProfileIds,
        targetProfileId,
        name,
        reason: 'User merged project-agent profiles from the Graph panel.'
      }
    )
  },

  governCandidate(
    projectId: string,
    candidateId: string,
    workspace: string,
    action: 'approve' | 'reject' | 'start_probation' | 'promote' | 'rollback' | 'delete',
    reason: string
  ): Promise<GraphLearningCandidate> {
    return request(
      kunGraphProjectCandidateActionPath(projectId, candidateId),
      'POST',
      { workspace, action, reason }
    )
  },

  async consolidate(projectId: string, workspace: string): Promise<GraphLearningJob | null> {
    return (await request<{ job: GraphLearningJob | null }>(
      kunGraphProjectConsolidatePath(projectId),
      'POST',
      { workspace, idempotencyKey: graphId('manual_consolidation') }
    )).job
  }
}
