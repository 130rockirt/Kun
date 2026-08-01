import { Router } from '../router.js'
import { healthJsonResponse } from './health.js'
import { buildWorkspaceStatusResponse } from './workspace.js'
import {
  createThread,
  clearThreadGoal,
  clearThreadTodos,
  deleteThread,
  forkThread,
  getThreadGoal,
  getThreadTodos,
  getThread,
  listThreads,
  setThreadGoal,
  setThreadTodos,
  updateThread
} from './threads.js'
import { summarizeThread } from './threads-summarize.js'
import {
  compactTurn,
  getSteeringQueue,
  getTurn,
  interruptTurn,
  rewindThread,
  startTurn,
  steerTurn,
  replaceSteeringQueue
} from './turns.js'
import { startReview } from './review.js'
import { buildEventStreamResponse, parseEventCursor } from './events.js'
import { decideApproval } from './approvals.js'
import { resolveUserInput } from './user-inputs.js'
import { resumeSession } from './sessions.js'
import { usageJsonResponse } from './usage.js'
import { listProviderQuotas } from './provider-quotas.js'
import { llmDebugRoundsResponse } from './debug-llm.js'
import { modelRequestsResponse } from './model-requests.js'
import { runtimeInfoJsonResponse, runtimeToolDiagnosticsJsonResponse } from './runtime-info.js'
import { shutdownRuntime } from './runtime-shutdown.js'
import {
  cancelModelConnectionOAuth,
  clearModelCredential,
  claudeSdkStatus,
  completeOfficialProviderAuth,
  connectModelConnection,
  deleteModelConnection,
  listModelConnections,
  modelConnectionEvents,
  patchModelConnection,
  probeModelConnection,
  replaceModelCredential,
  selectModelConnection,
  startModelConnectionOAuth,
  modelConnectionOAuthStatus,
  submitModelConnectionOAuth,
  installClaudeSdk,
  updateModelConnectionGlobals
} from './model-connections.js'
import { applyRuntimeConfig } from './runtime-config.js'
import { listSkills, refreshSkills, setSkillsEnabled } from './skills.js'
import { setLocalRuntimeCapability } from './runtime-capabilities.js'
import {
  attachmentDiagnostics,
  getAttachmentContent,
  getAttachmentMetadata,
  releaseAttachment,
  uploadAttachment
} from './attachments.js'
import {
  createMemory,
  deleteMemory,
  listMemories,
  memoryDiagnostics,
  updateMemory
} from './memory.js'
import {
  delegationAbort,
  delegationDetach,
  delegationDiagnostics,
  delegationProfiles
} from './delegation.js'
import {
  backgroundShellGet,
  backgroundShellList,
  backgroundShellStop
} from './background-shells.js'
import { authorizeMcpOAuth, clearMcpOAuth, mcpOAuthDiagnostics } from './mcp-oauth.js'
import { deleteMcpConfig, listMcpConfig, patchMcpConfig, putMcpConfig } from './mcp-config.js'
import { auditSupplyChainPackage, checkSupplyChainUpdate } from './supply-chain.js'
import { isAuthorized, bearerToken } from '../auth.js'
import { ApprovalConsentVerifier } from '../approval-consent.js'
import { ERRORS } from './runtime-error.js'
import type { ServerRuntime } from './server-runtime.js'
import { registerExtensionManagementRoutes } from './extensions.js'
import { registerExtensionPublicRoutes } from './extension-public.js'
import {
  createMigrationExport,
  commitMigrationImport,
  preflightMigrationImport,
  releaseMigrationImport,
  releaseMigrationExport,
  rollbackMigrationImport,
  verifyMigrationImport,
  streamMigrationExport
} from './migrations.js'
import {
  gatewayChatCompletions,
  gatewayModels,
  gatewayResponses,
  routePoolStatus,
  testRoutePool
} from './openai-model-gateway.js'
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

/**
 * Build the full router used by the HTTP server. The router exposes:
 * - `GET /health` (unauthenticated)
 * - `GET /v1/runtime/info` (auth)
 * - `GET /v1/runtime/tools` (auth)
 * - `POST /v1/runtime/config/apply` (auth)
 * - `GET /v1/mcp/oauth`, `DELETE /v1/mcp/oauth/{id}` (auth)
 * - `GET /v1/skills` (auth)
 * - `POST /v1/attachments` (auth)
 * - `GET /v1/attachments/diagnostics` (auth)
 * - `GET /v1/attachments/{id}` and `{id}/content` (auth)
 * - `GET/POST /v1/memory`, `PATCH/DELETE /v1/memory/{id}`, diagnostics (auth)
 * - `GET /v1/delegation/diagnostics` and `/v1/delegation/profiles` (auth)
 * - `POST /v1/delegation/abort/{childId}` (auth)
 * - `GET /v1/workspace/status` (auth)
 * - `GET/POST /v1/threads` (auth)
 * - `GET/PATCH/DELETE /v1/threads/{id}` (auth)
 * - `GET /v1/threads/{id}/model-requests` (auth)
 * - `POST /v1/threads/{id}/fork` (auth)
 * - `POST /v1/threads/{id}/summarize` (auth)
 * - `GET/POST/DELETE /v1/threads/{id}/goal` (auth)
 * - `GET/POST/DELETE /v1/threads/{id}/todos` (auth)
 * - `POST /v1/threads/{id}/turns` (auth)
 * - `POST /v1/threads/{id}/review` (auth)
 * - `GET /v1/threads/{id}/turns/{turnId}` (auth)
 * - `POST /v1/threads/{id}/turns/{turnId}/steer` (auth)
 * - `POST /v1/threads/{id}/turns/{turnId}/interrupt` (auth)
 * - `POST /v1/threads/{id}/compact` (auth)
 * - `GET /v1/threads/{id}/events` (auth)
 * - `POST /v1/approvals/{id}` (auth)
 * - `POST /v1/user-inputs/{id}` and `/v1/user-input/{id}` (auth)
 * - `POST /v1/sessions/{id}/resume-thread` (auth)
 * - `GET /v1/usage` (auth)
 * - `GET /v1/provider-quotas` (auth)
 * - `GET /v1/debug/llm-rounds` (auth)
 * - `POST /v1/supply-chain/audit`, `/v1/supply-chain/update-check` (auth)
 */
export function buildRouter(runtime: ServerRuntime): Router {
  const router = new Router()
  const approvalConsent = new ApprovalConsentVerifier(runtime.runtimeToken)
  router.add('GET', '/health', () => healthJsonResponse())
  router.add('GET', '/v1/models', () => gatewayModels(runtime))
  router.add('POST', '/v1/chat/completions', (request) => gatewayChatCompletions(runtime, request))
  router.add('POST', '/v1/responses', (request) => gatewayResponses(runtime, request))
  router.add('GET', '/v1/model-routes', (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return routePoolStatus(runtime)
  })
  router.add('POST', '/v1/model-routes/:id/test', (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return testRoutePool(runtime, ctx.params.id)
  })
  if (runtime.extensionPlatform) {
    // Static public extension paths must precede `/v1/extensions/:id` because
    // the minimal Router uses first-match ordering.
    registerExtensionPublicRoutes(router, runtime)
    registerExtensionManagementRoutes(router, {
      packageManager: runtime.extensionPlatform.packageManager,
      registry: runtime.extensionPlatform.registry,
      manager: runtime.extensionPlatform.manager,
      indexClient: runtime.extensionPlatform.indexClient,
      validation: runtime.extensionPlatform.validation,
      runtimeToken: runtime.runtimeToken,
      insecure: runtime.insecure,
      ...(runtime.extensionPlatform.jobs ? { jobs: runtime.extensionPlatform.jobs } : {}),
      ...(runtime.extensionPlatform.bundledSeedResults
        ? { bundledSeedResults: runtime.extensionPlatform.bundledSeedResults }
        : {})
    })
  }
  router.add('POST', '/v1/migrations/exports', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return createMigrationExport(runtime.migrationService, request)
  })
  router.add('GET', '/v1/migrations/exports/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return streamMigrationExport(runtime.migrationService, ctx.params.id)
  })
  router.add('DELETE', '/v1/migrations/exports/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return releaseMigrationExport(runtime.migrationService, ctx.params.id)
  })
  router.add('POST', '/v1/migrations/imports/preflight', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return preflightMigrationImport(runtime.migrationImportService, request)
  })
  router.add('POST', '/v1/migrations/imports/:id/commit', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return commitMigrationImport(runtime.migrationImportService, ctx.params.id)
  })
  router.add('POST', '/v1/migrations/imports/:id/verify', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return verifyMigrationImport(runtime.migrationImportService, ctx.params.id)
  })
  router.add('POST', '/v1/migrations/imports/:id/rollback', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return rollbackMigrationImport(runtime.migrationImportService, ctx.params.id)
  })
  router.add('DELETE', '/v1/migrations/imports/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return releaseMigrationImport(runtime.migrationImportService, ctx.params.id)
  })
  router.add('GET', '/v1/runtime/info', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return runtimeInfoJsonResponse(runtime)
  })
  router.add('GET', '/v1/runtime/tools', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return runtimeToolDiagnosticsJsonResponse(runtime)
  })
  router.add('POST', '/v1/runtime/shutdown', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return shutdownRuntime(runtime, request)
  })
  router.add('GET', '/v1/model-connections', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listModelConnections(runtime.modelConnections)
  })
  router.add('PATCH', '/v1/model-connections', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return updateModelConnectionGlobals(runtime.modelConnections, request)
  })
  router.add('POST', '/v1/model-connections/connect', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return connectModelConnection(runtime.modelConnections, request)
  })
  router.add('POST', '/v1/model-connections/oauth/start', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return startModelConnectionOAuth(runtime.modelConnectionOAuth, request)
  })
  router.add('POST', '/v1/model-connections/cli/complete', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return completeOfficialProviderAuth(runtime.officialProviderAuth, request)
  })
  router.add('GET', '/v1/model-connections/oauth/:sessionId', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return modelConnectionOAuthStatus(runtime.modelConnectionOAuth, ctx.params.sessionId)
  })
  router.add('POST', '/v1/model-connections/oauth/:sessionId/submit', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return submitModelConnectionOAuth(runtime.modelConnectionOAuth, ctx.params.sessionId, request)
  })
  router.add('DELETE', '/v1/model-connections/oauth/:sessionId', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return cancelModelConnectionOAuth(runtime.modelConnectionOAuth, ctx.params.sessionId)
  })
  router.add('GET', '/v1/model-connections/claude/sdk', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return claudeSdkStatus(runtime.modelConnectionOAuth)
  })
  router.add('POST', '/v1/model-connections/claude/sdk/install', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return installClaudeSdk(runtime.modelConnectionOAuth)
  })
  router.add('POST', '/v1/model-connections/select', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return selectModelConnection(runtime.modelConnections, request)
  })
  router.add('GET', '/v1/model-connections/events', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return modelConnectionEvents(runtime.modelConnections, request)
  })
  router.add('PATCH', '/v1/model-connections/:providerId', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return patchModelConnection(runtime.modelConnections, ctx.params.providerId, request)
  })
  router.add('PUT', '/v1/model-connections/:providerId/credential', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return replaceModelCredential(runtime.modelConnections, ctx.params.providerId, request)
  })
  router.add('DELETE', '/v1/model-connections/:providerId/credential', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return clearModelCredential(runtime.modelConnections, ctx.params.providerId, request)
  })
  router.add('DELETE', '/v1/model-connections/:providerId', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return deleteModelConnection(runtime.modelConnections, ctx.params.providerId, request)
  })
  router.add('POST', '/v1/model-connections/:providerId/probe', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return probeModelConnection(runtime.modelConnections, ctx.params.providerId)
  })
  router.add('POST', '/v1/runtime/config/apply', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return applyRuntimeConfig(runtime, request)
  })
  router.add('GET', '/v1/mcp/oauth', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return mcpOAuthDiagnostics(runtime)
  })
  router.add('GET', '/v1/mcp/config', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listMcpConfig(runtime)
  })
  router.add('PUT', '/v1/mcp/config/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return putMcpConfig(runtime, ctx.params.id, request)
  })
  router.add('PATCH', '/v1/mcp/config/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return patchMcpConfig(runtime, ctx.params.id, request)
  })
  router.add('DELETE', '/v1/mcp/config/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return deleteMcpConfig(runtime, ctx.params.id)
  })
  router.add('DELETE', '/v1/mcp/oauth', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return clearMcpOAuth(runtime)
  })
  router.add('DELETE', '/v1/mcp/oauth/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return clearMcpOAuth(runtime, ctx.params.id)
  })
  router.add('POST', '/v1/mcp/oauth/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return authorizeMcpOAuth(runtime, ctx.params.id)
  })
  router.add('GET', '/v1/skills', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listSkills(runtime, request)
  })
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
  router.add('POST', '/v1/skills/refresh', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return refreshSkills(runtime)
  })
  router.add('PATCH', '/v1/skills/config', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return setSkillsEnabled(runtime, request)
  })
  router.add('PATCH', '/v1/runtime/capabilities/:id', async (request, context) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return setLocalRuntimeCapability(runtime, context.params.id, request)
  })
  router.add('POST', '/v1/supply-chain/audit', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return auditSupplyChainPackage(runtime, request)
  })
  router.add('POST', '/v1/supply-chain/update-check', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return checkSupplyChainUpdate(request)
  })
  router.add('POST', '/v1/attachments', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return uploadAttachment(runtime.attachmentStore, request)
  })
  router.add('DELETE', '/v1/attachments/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return releaseAttachment(runtime, ctx.params.id, request)
  })
  router.add('GET', '/v1/attachments/diagnostics', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return attachmentDiagnostics(runtime.attachmentStore)
  })
  router.add('GET', '/v1/attachments/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return getAttachmentMetadata(runtime.attachmentStore, ctx.params.id)
  })
  router.add('GET', '/v1/attachments/:id/content', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return getAttachmentContent(runtime.attachmentStore, ctx.params.id, request)
  })
  router.add('GET', '/v1/memory', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listMemories(runtime.memoryStore, request)
  })
  router.add('POST', '/v1/memory', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return createMemory(runtime.memoryStore, request)
  })
  router.add('GET', '/v1/memory/diagnostics', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return memoryDiagnostics(runtime.memoryStore)
  })
  router.add('PATCH', '/v1/memory/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return updateMemory(runtime.memoryStore, ctx.params.id, request)
  })
  router.add('DELETE', '/v1/memory/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return deleteMemory(runtime.memoryStore, ctx.params.id, request)
  })
  router.add('GET', '/v1/delegation/diagnostics', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return delegationDiagnostics(runtime.delegationRuntime, request)
  })
  router.add('GET', '/v1/delegation/profiles', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return delegationProfiles(runtime.delegationRuntime, request)
  })
  router.add('POST', '/v1/delegation/abort/:childId', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return delegationAbort(runtime.delegationRuntime, ctx.params.childId)
  })
  router.add('POST', '/v1/delegation/detach/:childId', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return delegationDetach(runtime.delegationRuntime, ctx.params.childId)
  })
  router.add('GET', '/v1/background-shells', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return backgroundShellList(runtime.backgroundShellRuntime, request)
  })
  router.add('GET', '/v1/background-shells/:sessionId', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return backgroundShellGet(runtime.backgroundShellRuntime, ctx.params.sessionId)
  })
  router.add('POST', '/v1/background-shells/:sessionId/stop', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return backgroundShellStop(runtime.backgroundShellRuntime, ctx.params.sessionId)
  })
  router.add('GET', '/v1/workspace/status', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    const url = new URL(request.url)
    const path = url.searchParams.get('path')
    return buildWorkspaceStatusResponse({ inspector: runtime.workspaceInspector, path })
  })
  router.add('GET', '/v1/threads', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return listThreads(runtime.threadService, request)
  })
  router.add('POST', '/v1/threads', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return createThread(runtime.threadService, request)
  })
  router.add('GET', '/v1/threads/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    // The active approval gate is process-local. When a manager lease belongs
    // to another runtime, obtain the detail snapshot from that execution owner
    // so its live approval state cannot be mistaken for expired locally.
    const forwarded = await runtime.forwardThreadControl?.(request, ctx.params.id)
    if (forwarded) return forwarded
    return getThread(
      runtime.threadService,
      ctx.params.id,
      runtime.sessionStore,
      runtime.userInputGate,
      runtime.approvalGate
    )
  })
  router.add('GET', '/v1/threads/:id/model-requests', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return modelRequestsResponse(runtime, ctx.params.id, request)
  })
  router.add('PATCH', '/v1/threads/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return updateThread(runtime.threadService, ctx.params.id, request)
  })
  router.add('DELETE', '/v1/threads/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return deleteThread(runtime.threadService, ctx.params.id)
  })
  router.add('POST', '/v1/threads/:id/fork', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return forkThread(runtime.threadService, ctx.params.id, request)
  })
  router.add('POST', '/v1/threads/:id/summarize', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return summarizeThread(runtime, ctx.params.id, request)
  })
  router.add('GET', '/v1/threads/:id/goal', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return getThreadGoal(runtime.threadService, ctx.params.id)
  })
  router.add('POST', '/v1/threads/:id/goal', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return setThreadGoal(runtime.threadService, ctx.params.id, request)
  })
  router.add('DELETE', '/v1/threads/:id/goal', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return clearThreadGoal(runtime.threadService, ctx.params.id)
  })
  router.add('GET', '/v1/threads/:id/todos', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return getThreadTodos(runtime.threadService, ctx.params.id)
  })
  router.add('POST', '/v1/threads/:id/todos', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return setThreadTodos(runtime.threadService, ctx.params.id, request)
  })
  router.add('DELETE', '/v1/threads/:id/todos', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return clearThreadTodos(runtime.threadService, ctx.params.id)
  })
  router.add('POST', '/v1/threads/:id/turns', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return startTurn(
      runtime.turnService,
      ctx.params.id,
      request,
      ({ threadId, turnId }) => {
        runtime.runTurn(threadId, turnId)
      },
      () => runtime.graph?.config().enabled === true
    )
  })
  router.add('POST', '/v1/threads/:id/rewind', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return rewindThread(runtime.turnService, ctx.params.id, request)
  })
  router.add('POST', '/v1/threads/:id/review', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    if (!runtime.reviewService || !runtime.runReview) {
      return ERRORS.unavailable('review is not available')
    }
    return startReview(
      runtime.turnService,
      ctx.params.id,
      request,
      ({ threadId, turnId, reviewItemId }, target, model, providerId, accountId) => {
        runtime.runReview?.({ threadId, turnId, reviewItemId, target, model, providerId, accountId })
      }
    )
  })
  router.add('GET', '/v1/threads/:id/turns/:turnId', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return getTurn(runtime.turnService, ctx.params.id, ctx.params.turnId)
  })
  router.add('POST', '/v1/threads/:id/turns/:turnId/steer', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    const forwarded = await runtime.forwardThreadControl?.(request, ctx.params.id)
    if (forwarded) return forwarded
    return steerTurn(
      runtime.turnService,
      ctx.params.id,
      ctx.params.turnId,
      request,
      ({ threadId, turnId }) => {
        runtime.runTurn(threadId, turnId)
      }
    )
  })
  router.add('GET', '/v1/threads/:id/turns/:turnId/steering', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    const forwarded = await runtime.forwardThreadControl?.(request, ctx.params.id)
    if (forwarded) return forwarded
    return getSteeringQueue(runtime.turnService, ctx.params.id, ctx.params.turnId)
  })
  router.add('PATCH', '/v1/threads/:id/turns/:turnId/steering', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    const forwarded = await runtime.forwardThreadControl?.(request, ctx.params.id)
    if (forwarded) return forwarded
    return replaceSteeringQueue(runtime.turnService, ctx.params.id, ctx.params.turnId, request)
  })
  router.add('POST', '/v1/threads/:id/turns/:turnId/interrupt', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    const forwarded = await runtime.forwardThreadControl?.(request, ctx.params.id)
    if (forwarded) return forwarded
    return interruptTurn(runtime.turnService, ctx.params.id, ctx.params.turnId, request)
  })
  router.add('POST', '/v1/threads/:id/compact', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return compactTurn(runtime.turnService, ctx.params.id, request)
  })
  router.add('GET', '/v1/threads/:id/events', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    const sinceSeq = parseEventCursor(request)
    if (sinceSeq === null) return ERRORS.validation('since_seq must be a non-negative safe integer')
    if (!await runtime.threadService.get(ctx.params.id)) {
      return ERRORS.notFound(`thread not found: ${ctx.params.id}`)
    }
    return buildEventStreamResponse({
      request,
      threadId: ctx.params.id,
      eventBus: runtime.eventBus,
      sessionStore: runtime.sessionStore,
      streamRegistry: runtime.eventStreamRegistry,
      sinceSeq
    })
  })
  router.add('POST', '/v1/approvals/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    const forwarded = await runtime.forwardControlById?.(request, 'approval', ctx.params.id)
    if (forwarded) return forwarded
    return decideApproval({
      approvalId: ctx.params.id,
      request,
      gate: runtime.approvalGate,
      events: runtime.events,
      consent: approvalConsent
    })
  })
  router.add('POST', '/v1/user-inputs/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    const forwarded = await runtime.forwardControlById?.(request, 'user-input', ctx.params.id)
    if (forwarded) return forwarded
    return resolveUserInput({
      inputId: ctx.params.id,
      request,
      gate: runtime.userInputGate,
      events: runtime.events
    })
  })
  router.add('POST', '/v1/user-input/:id', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    const forwarded = await runtime.forwardControlById?.(request, 'user-input', ctx.params.id)
    if (forwarded) return forwarded
    return resolveUserInput({
      inputId: ctx.params.id,
      request,
      gate: runtime.userInputGate,
      events: runtime.events
    })
  })
  router.add('POST', '/v1/sessions/:id/resume-thread', async (request, ctx) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return resumeSession(runtime.threadService, ctx.params.id, request)
  })
  router.add('GET', '/v1/usage', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return usageJsonResponse(request, runtime)
  })
  router.add('GET', '/v1/provider-quotas', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    if (!runtime.providerQuotaService) {
      return ERRORS.unavailable('provider quota service is not available')
    }
    return listProviderQuotas(runtime.providerQuotaService)
  })
  router.add('GET', '/v1/debug/llm-rounds', async (request) => {
    if (!authorize(request, runtime)) return ERRORS.unauthorized()
    return llmDebugRoundsResponse(runtime)
  })
  return router
}

function authorize(request: Request, runtime: ServerRuntime): boolean {
  return isAuthorized(request.headers, runtime.runtimeToken, runtime.insecure)
}

void bearerToken
