import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'

/**
 * GET /v1/delegation/diagnostics
 *
 * Returns a snapshot of all child runs (queued/running/completed/failed/
 * aborted) tracked by the delegation runtime. Optional `parentThreadId`
 * query param filters by parent thread.
 *
 * Used by the GUI SubagentsView to show realtime status per profile.
 */
export async function delegationDiagnostics(
  runtime: DelegationRuntime | undefined,
  request: Request
): Promise<JsonResponse> {
  if (!runtime) {
    return jsonResponse({
      enabled: false,
      active: 0,
      childRuns: [],
      aggregates: []
    })
  }
  const url = new URL(request.url)
  const parent = url.searchParams.get('parent_thread_id') ?? undefined
  return jsonResponse(await runtime.diagnostics(parent))
}

/**
 * GET /v1/delegation/profiles
 *
 * Without `workspace`, returns the static roster (builtin + GUI config).
 * With `?workspace=...`, returns `.kun/agents/*.md` overlays for the GUI
 * Settings / Sidebar roster (`source: "workspace"`).
 */
export async function delegationProfiles(
  runtime: DelegationRuntime | undefined,
  request?: Request
): Promise<JsonResponse> {
  if (!runtime) {
    return jsonResponse({ profiles: [], defaultProfile: undefined })
  }
  const workspace = request
    ? new URL(request.url).searchParams.get('workspace')?.trim() || undefined
    : undefined
  if (workspace) {
    return jsonResponse({
      profiles: await runtime.listWorkspaceProfiles(workspace),
      defaultProfile: runtime.defaultProfileName
    })
  }
  return jsonResponse({
    profiles: runtime.listProfiles(),
    defaultProfile: runtime.defaultProfileName
  })
}

/**
 * POST /v1/delegation/abort/:childId
 *
 * Stop one active child run without interrupting its parent or siblings.
 */
export async function delegationAbort(
  runtime: DelegationRuntime | undefined,
  childId: string
): Promise<JsonResponse> {
  if (!runtime) return ERRORS.unavailable('delegation runtime is unavailable')
  if (!childId.trim()) return ERRORS.validation('childId is required', [])
  const aborted = runtime.abortChild(childId)
  return jsonResponse({ childId, aborted })
}

/**
 * POST /v1/delegation/detach/:childId
 *
 * Release a queued/running foreground child from the parent turn while
 * preserving the same child thread and execution.
 */
export async function delegationDetach(
  runtime: DelegationRuntime | undefined,
  childId: string
): Promise<JsonResponse> {
  if (!runtime) return ERRORS.unavailable('delegation runtime is unavailable')
  if (!childId.trim()) return ERRORS.validation('childId is required', [])
  const detached = await runtime.detachChild(childId)
  return jsonResponse({ childId, detached })
}

export { ERRORS as DelegationErrors }
