import { isRuntimeTokenAuthorized } from '../auth.js'
import { jsonResponse } from '../response.js'
import { Router, type RouteHandler } from '../router.js'
import type { ServerRuntime } from './server-runtime.js'
import { ERRORS } from './runtime-error.js'
import {
  accountListRoute,
  cancelManagedAccountSession,
  completeManagedAccountSession,
  createManagedAccountSession,
  createManagedApiKeyAccount,
  decideSecretReveal,
  deleteManagedAccount,
  getManagedAccountSession,
  renameManagedAccount,
  replaceManagedApiKeyAccount
} from './extension-public-accounts.js'
import {
  agentRunEvents,
  cancelAgentRun,
  createAgentRun,
  getAgentRun,
  getOwnThread,
  listOwnProviderModels,
  listOwnProviders,
  listOwnThreads,
  listOwnTools,
  probeOwnProvider,
  steerAgentRun
} from './extension-public-agent.js'
import { sessionRoute, withErrors } from './extension-public-common.js'
import {
  ProtectedMediaOperationTokenRegistry,
  registerProtectedMediaSelections,
  resolveProtectedArtifact,
  resolveProtectedMediaLease
} from './extension-public-media.js'
import {
  listManagedModelProviders,
  listManagedProviderModels,
  setManagedProviderBinding
} from './extension-public-providers.js'
import {
  cancelViewRequest,
  createViewSession,
  dispatchViewRequest,
  disposeViewSession,
  postHostViewMessage,
  postViewMessage,
  setWorkbenchEnvironment,
  viewSessionEvents
} from './extension-public-views.js'
import {
  configurationSnapshot,
  invokeExtensionCommand,
  listWorkbenchNotifications,
  respondWorkbenchNotification,
  updateConfiguration,
  workbenchSnapshot
} from './extension-public-workbench.js'

export {
  EXTENSION_SESSION_ID_HEADER,
  EXTENSION_SESSION_NONCE_HEADER
} from './extension-public-schemas.js'

export function registerExtensionPublicRoutes(router: Router, runtime: ServerRuntime): void {
  if (!runtime.extensionPlatform) return
  const platform = runtime.extensionPlatform
  const trusted = (handler: RouteHandler): RouteHandler => withErrors(async (request, context) => {
    if (!isRuntimeTokenAuthorized(request.headers, runtime.runtimeToken)) return ERRORS.unauthorized()
    return handler(request, context)
  })
  const protectedMediaTokens = new ProtectedMediaOperationTokenRegistry()

  router.add('GET', '/v1/extensions/workbench', trusted((request) => workbenchSnapshot(platform, request)))
  router.add('POST', '/v1/extensions/configuration/snapshot', trusted((request) =>
    configurationSnapshot(platform, request)))
  router.add('PUT', '/v1/extensions/configuration', trusted((request) =>
    updateConfiguration(platform, request)))
  router.add('PUT', '/v1/extensions/workbench/environment', trusted((request) =>
    setWorkbenchEnvironment(platform, request)))
  router.add('GET', '/v1/extensions/workbench/notifications', trusted(() =>
    listWorkbenchNotifications(platform)))
  router.add('DELETE', '/v1/extensions/workbench/presence', trusted(() => {
    platform.viewSessions.disconnectWorkbench()
    return jsonResponse({ schemaVersion: 1, disconnected: true })
  }))
  router.add(
    'POST',
    '/v1/extensions/workbench/notifications/:notificationId/respond',
    trusted((request, context) => respondWorkbenchNotification(platform, request, context))
  )
  router.add('POST', '/v1/extensions/commands/invoke', trusted((request) => invokeExtensionCommand(platform, request)))
  router.add('POST', '/v1/extensions/accounts/sessions', trusted((request) => createManagedAccountSession(platform, request)))
  router.add('GET', '/v1/extensions/model-providers', trusted((request) =>
    listManagedModelProviders(platform, request)))
  router.add('GET', '/v1/extensions/model-providers/models', trusted((request) =>
    listManagedProviderModels(platform, request)))
  router.add('PUT', '/v1/extensions/model-providers/binding', trusted((request) =>
    setManagedProviderBinding(platform, request)))
  router.add('GET', '/v1/extensions/accounts/sessions/:sessionId', trusted((request, context) =>
    getManagedAccountSession(platform, request, context)))
  router.add('POST', '/v1/extensions/accounts/sessions/:sessionId/cancel', trusted((request, context) =>
    cancelManagedAccountSession(platform, request, context)))
  router.add('POST', '/v1/extensions/accounts/sessions/:sessionId/complete', trusted((request, context) =>
    completeManagedAccountSession(platform, request, context)))
  router.add('POST', '/v1/extensions/accounts/api-key', trusted((request) => createManagedApiKeyAccount(platform, request)))
  router.add('PATCH', '/v1/extensions/accounts/:accountId/label', trusted((request, context) =>
    renameManagedAccount(platform, request, context)))
  router.add('PUT', '/v1/extensions/accounts/:accountId/api-key', trusted((request, context) =>
    replaceManagedApiKeyAccount(platform, request, context)))
  router.add('DELETE', '/v1/extensions/accounts/:accountId', trusted((request, context) =>
    deleteManagedAccount(platform, request, context)))
  router.add('GET', '/v1/extensions/secret-reveal-requests', trusted(() =>
    jsonResponse({ schemaVersion: 1, requests: platform.secretReveals.list() })))
  router.add('POST', '/v1/extensions/secret-reveal-requests/:requestId/decision', trusted((request, context) =>
    decideSecretReveal(platform, request, context)))
  router.add('POST', '/v1/extensions/media/selections', trusted((request) =>
    registerProtectedMediaSelections(platform, protectedMediaTokens, request)))
  router.add('POST', '/v1/extensions/media/leases/resolve', trusted((request) =>
    resolveProtectedMediaLease(platform, request)))
  router.add('POST', '/v1/extensions/media/artifacts/resolve', trusted((request) =>
    resolveProtectedArtifact(platform, request)))
  router.add('POST', '/v1/extensions/view-sessions', trusted((request) => createViewSession(platform, request)))
  router.add('POST', '/v1/extensions/view-sessions/:sessionId/host-messages', trusted((request, context) =>
    postHostViewMessage(platform, request, context)))
  router.add('DELETE', '/v1/extensions/view-sessions/:sessionId', withErrors((request, context) =>
    disposeViewSession(runtime, request, context)))
  router.add('POST', '/v1/extensions/view-sessions/:sessionId/messages', withErrors((request, context) =>
    postViewMessage(platform, request, context)))
  router.add('POST', '/v1/extensions/view-sessions/:sessionId/requests', withErrors((request, context) =>
    dispatchViewRequest(platform, request, context)))
  router.add('POST', '/v1/extensions/view-sessions/:sessionId/requests/:requestId/cancel', withErrors((request, context) =>
    cancelViewRequest(platform, request, context)))
  router.add('GET', '/v1/extensions/view-sessions/:sessionId/events', withErrors((request, context) =>
    viewSessionEvents(platform, request, context)))

  router.add('POST', '/v1/extensions/agent/runs', sessionRoute(platform, (principal, request) =>
    createAgentRun(platform, principal, request)))
  router.add('GET', '/v1/extensions/agent/runs/:runId', sessionRoute(platform, (principal, _request, context) =>
    getAgentRun(platform, principal, context)))
  router.add('POST', '/v1/extensions/agent/runs/:runId/steer', sessionRoute(platform, (principal, request, context) =>
    steerAgentRun(platform, principal, request, context)))
  router.add('POST', '/v1/extensions/agent/runs/:runId/cancel', sessionRoute(platform, (principal, _request, context) =>
    cancelAgentRun(platform, principal, context)))
  router.add('GET', '/v1/extensions/agent/runs/:runId/events', sessionRoute(platform, (principal, request, context) =>
    agentRunEvents(platform, principal, request, context)))
  router.add('GET', '/v1/extensions/agent/threads', sessionRoute(platform, (principal, request) =>
    listOwnThreads(platform, principal, request)))
  router.add('GET', '/v1/extensions/agent/threads/:threadId', sessionRoute(platform, (principal, _request, context) =>
    getOwnThread(platform, principal, context)))

  // Tool execution deliberately has no direct HTTP route: calls must retain
  // ToolHost approval, sandbox, journal, budget and cancellation semantics.
  router.add('GET', '/v1/extensions/tools', sessionRoute(platform, (principal) =>
    listOwnTools(platform, principal)))
  router.add('GET', '/v1/extensions/providers', sessionRoute(platform, (principal) =>
    listOwnProviders(platform, principal)))
  router.add('POST', '/v1/extensions/providers/:providerId/probe', sessionRoute(platform, (principal, request, context) =>
    probeOwnProvider(platform, principal, request, context)))
  router.add('GET', '/v1/extensions/providers/:providerId/models', sessionRoute(platform, (principal, request, context) =>
    listOwnProviderModels(platform, principal, request, context)))
  router.add('GET', '/v1/extensions/accounts', accountListRoute(runtime, platform))
}

export function buildExtensionPublicRouter(runtime: ServerRuntime): Router {
  const router = new Router()
  registerExtensionPublicRoutes(router, runtime)
  return router
}
