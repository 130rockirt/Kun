import type { Router } from '../router.js'
import {
  cancelGraphRun,
  cancelGraphPlanningDraft,
  createGraphRun,
  getGraphRun,
  getGraphSupervision,
  getGraphPlanningDraft,
  graphRunCommand,
  graphRunEvents,
  listGraphRuns,
  listGraphPlanningDrafts,
  patchGraphRun,
  readGraphArtifact,
  retryGraphNode,
  resumeGraphPlanningDraft,
  reviewGraphNode,
  steerGraphRun,
  validateGraphPlan,
  wakeGraphSupervision
} from './graphs.js'
import {
  consolidateLearning,
  exportProjectAgent,
  exploreGraphCapability,
  governLearningCandidate,
  graphDiagnostics,
  graphProjectIdentity,
  listGraphGovernanceAudit,
  listLearningCandidates,
  listLearningEpisodes,
  listLearningJobs,
  listProjectAgentEvidence,
  listProjectAgentScores,
  listProjectAgents,
  listProjectRoutingExplanations,
  listThreadGraphReferences,
  importProjectAgent,
  mergeProjectAgents,
  routeProjectAgent,
  transitionProjectAgent
} from './graph-agents.js'
import { ERRORS } from './runtime-error.js'
import type { ServerRuntime } from './server-runtime.js'
import { authorize } from './route-auth.js'

export function registerGraphRoutes(router: Router, runtime: ServerRuntime): void {
  router.add('POST', '/v1/graphs/validate', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return validateGraphPlan(runtime.graph?.control, request)
  })
  router.add('GET', '/v1/graph-drafts', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listGraphPlanningDrafts(runtime.graph?.drafts, request)
  })
  router.add('GET', '/v1/graph-drafts/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return getGraphPlanningDraft(runtime.graph?.drafts, ctx.params.id)
  })
  router.add('POST', '/v1/graph-drafts/:id/resume', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return resumeGraphPlanningDraft(
      runtime.graph?.drafts,
      runtime.turnService,
      runtime.events,
      runtime.runTurn,
      ctx.params.id,
      request
    )
  })
  router.add('POST', '/v1/graph-drafts/:id/cancel', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return cancelGraphPlanningDraft(
      runtime.graph?.drafts,
      runtime.turnService,
      runtime.events,
      ctx.params.id,
      request
    )
  })
  router.add('GET', '/v1/graphs/diagnostics', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return graphDiagnostics(runtime)
  })
  router.add('GET', '/v1/graphs', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listGraphRuns(runtime.graph?.control, request)
  })
  router.add('POST', '/v1/graphs', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return createGraphRun(runtime.graph?.control, request)
  })
  router.add('GET', '/v1/graphs/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return getGraphRun(runtime.graph?.control, runtime.graph?.supervisor, ctx.params.id)
  })
  router.add('GET', '/v1/graphs/:id/supervision', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return getGraphSupervision(runtime.graph?.supervisor, ctx.params.id)
  })
  router.add('POST', '/v1/graphs/:id/supervision/wake', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return wakeGraphSupervision(runtime.graph?.supervisor, ctx.params.id, request)
  })
  router.add('GET', '/v1/graphs/:id/events', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return graphRunEvents(
      runtime.graph?.control,
      runtime.graph
        ? async (runId, sinceSeq) => runtime.graph!.store.eventReplay
          ? runtime.graph!.store.eventReplay(runId, sinceSeq)
          : {
              events: await runtime.graph!.store.events(runId, sinceSeq),
              replayFloorSeq: 1,
              currentSeq: 0,
              snapshotSeq: 0,
              truncated: false
            }
        : undefined,
      ctx.params.id,
      request
    )
  })
  router.add('GET', '/v1/graphs/:id/artifacts/:artifactId', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return readGraphArtifact(
      runtime.graph?.control,
      runtime.graph?.artifacts,
      (runId, artifactId) => externalizedGraphArtifactReference(runtime, runId, artifactId),
      ctx.params.id,
      ctx.params.artifactId,
      request
    )
  })
  for (const action of ['start', 'pause', 'resume', 'cleanup'] as const) {
    router.add('POST', `/v1/graphs/:id/${action}`, async (request, ctx) => {
      if (!authorize(request, runtime)) return ERRORS.unauthorized()
      return graphRunCommand(runtime.graph?.control, ctx.params.id, action, request)
    })
  }
  router.add('POST', '/v1/graphs/:id/cancel', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return cancelGraphRun(runtime.graph?.control, ctx.params.id, request)
  })
  router.add('POST', '/v1/graphs/:id/retry', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return retryGraphNode(runtime.graph?.control, ctx.params.id, request)
  })
  router.add('POST', '/v1/graphs/:id/steer', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return steerGraphRun(runtime.graph?.control, ctx.params.id, request)
  })
  router.add('POST', '/v1/graphs/:id/patch', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return patchGraphRun(runtime.graph?.control, ctx.params.id, request)
  })
  router.add('POST', '/v1/graphs/:id/reviews', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return reviewGraphNode(runtime.graph?.control, ctx.params.id, request)
  })
  router.add('GET', '/v1/graph-projects/identity', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return graphProjectIdentity(runtime, request)
  })
  router.add('GET', '/v1/graph-projects/:projectId/agents', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listProjectAgents(runtime, ctx.params.projectId, request)
  })
  router.add('POST', '/v1/graph-projects/:projectId/agents/route', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return routeProjectAgent(runtime, ctx.params.projectId, request)
  })
  router.add('POST', '/v1/graph-projects/:projectId/agents/import', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return importProjectAgent(runtime, ctx.params.projectId, request)
  })
  router.add('POST', '/v1/graph-projects/:projectId/agents/merge', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return mergeProjectAgents(runtime, ctx.params.projectId, request)
  })
  router.add('GET', '/v1/graph-projects/:projectId/agents/:profileId/export', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return exportProjectAgent(runtime, ctx.params.projectId, ctx.params.profileId, request)
  })
  router.add('POST', '/v1/graph-projects/:projectId/agents/:profileId/lifecycle', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return transitionProjectAgent(runtime, ctx.params.projectId, ctx.params.profileId, request)
  })
  router.add('GET', '/v1/graph-projects/:projectId/evidence', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listProjectAgentEvidence(runtime, ctx.params.projectId, request)
  })
  router.add('GET', '/v1/graph-projects/:projectId/scores', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listProjectAgentScores(runtime, ctx.params.projectId)
  })
  router.add('GET', '/v1/graph-projects/:projectId/routing', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listProjectRoutingExplanations(runtime, ctx.params.projectId)
  })
  router.add('GET', '/v1/graph-projects/:projectId/candidates', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listLearningCandidates(runtime, ctx.params.projectId)
  })
  router.add('POST', '/v1/graph-projects/:projectId/candidates/:candidateId/action', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return governLearningCandidate(
      runtime,
      ctx.params.projectId,
      ctx.params.candidateId,
      request
    )
  })
  router.add('POST', '/v1/graph-projects/:projectId/consolidate', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return consolidateLearning(runtime, ctx.params.projectId, request)
  })
  router.add('POST', '/v1/graph-projects/:projectId/explore', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return exploreGraphCapability(runtime, ctx.params.projectId, request)
  })
  router.add('GET', '/v1/graph-projects/:projectId/episodes', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listLearningEpisodes(runtime, ctx.params.projectId)
  })
  router.add('GET', '/v1/graph-projects/:projectId/jobs', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listLearningJobs(runtime, ctx.params.projectId)
  })
  router.add('GET', '/v1/graph-projects/:projectId/audit', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listGraphGovernanceAudit(runtime, ctx.params.projectId)
  })
  router.add('GET', '/v1/threads/:id/graph-references', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listThreadGraphReferences(runtime, ctx.params.id)
  })
}

async function externalizedGraphArtifactReference(
  runtime: ServerRuntime,
  runId: string,
  artifactId: string
) {
  const store = runtime.graph?.store
  if (!store) return undefined
  const events = store.eventReplay
    ? (await store.eventReplay(runId, 0)).events
    : await store.events(runId, 0)
  for (const entry of events) {
    if (entry.runId === runId && entry.event.type === 'payload_externalized' &&
      entry.event.payload.artifact.artifactId === artifactId) {
      return entry.event.payload.artifact
    }
  }
  return undefined
}
