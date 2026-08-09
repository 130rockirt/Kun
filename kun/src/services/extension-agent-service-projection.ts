import { resolve, relative, isAbsolute } from 'node:path'
import { isPublicRuntimeEvent, type RuntimeEvent } from '../contracts/events.js'
import type {
  ExtensionAgentProfileSnapshot,
  ExtensionRunBudget,
  ExtensionThreadVisibility,
  ExtensionToolCatalogEpoch,
  ThreadRecord,
  ThreadSummary
} from '../contracts/threads.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import type { ExtensionProviderBinding } from '../contracts/extension-providers.js'
import type { EventBus } from '../ports/event-bus.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadService } from './thread-service.js'
import { TurnConflictError, type TurnService } from './turn-service.js'
import type {
  ExtensionAgentProfileRegistry
} from './extension-agent-profile-registry.js'
import { DEFAULT_BUDGET, type ExtensionAgentEvent, type ExtensionAgentRunStatus, type ExtensionOwnedThread, type ExtensionPrincipal, MAXIMUM_BUDGET } from './extension-agent-service-core.js'
import { ExtensionBrokerError } from './extension-agent-service-event-usage.js'

export function projectThread(thread: ThreadRecord): ExtensionOwnedThread {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    workspace: thread.workspace,
    model: thread.model,
    providerBinding: {
      providerId: thread.providerId ?? 'default',
      ...(thread.accountId ? { accountId: thread.accountId } : {}),
      modelId: thread.model
    },
    ownerExtensionVersion: thread.ownerExtensionVersion ?? 'unknown',
    ...(thread.extensionProfile?.id ? { profileId: thread.extensionProfile.id } : {}),
    visibility: thread.extensionVisibility ?? 'private',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    runCount: thread.turns.length
  }
}

export function projectEvent(
  principal: ExtensionPrincipal,
  runId: string,
  event: RuntimeEvent
): ExtensionAgentEvent | undefined {
  if (!isPublicRuntimeEvent(event)) return undefined
  const { seq, timestamp, kind, threadId, turnId: _turnId, ...raw } = event
  return {
    seq,
    timestamp,
    type: kind,
    runId,
    threadId,
    ownerExtensionId: principal.extensionId,
    payload: redactProtectedFields(raw as Record<string, unknown>)
  }
}

export function redactProtectedFields(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = JSON.parse(JSON.stringify(value, (key, current) => {
    if (/^(approvalId|inputId|consentToken|runtimeToken|apiKey|accessToken|refreshToken|clientSecret|authorization|cookie)$/i.test(key)) {
      return undefined
    }
    return current
  })) as Record<string, unknown>
  return redacted
}

export function runStatus(status: ThreadRecord['turns'][number]['status']): ExtensionAgentRunStatus {
  switch (status) {
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'aborted': return 'cancelled'
    default: return 'running'
  }
}

export function validateBinding(binding: ExtensionProviderBinding): void {
  if (!binding.providerId.trim() || !binding.modelId.trim()) {
    throw new ExtensionBrokerError('validation_error', 'Provider binding requires providerId and modelId')
  }
  if (binding.accountId !== undefined && !binding.accountId.trim()) {
    throw new ExtensionBrokerError('validation_error', 'Provider binding accountId cannot be empty')
  }
}

export function normalizeOwnedWorkspace(principal: ExtensionPrincipal, requested?: string): string {
  const roots = principal.workspaceRoots.map((root) => resolve(root))
  if (roots.length === 0) throw new ExtensionBrokerError('workspace_denied', 'Extension has no workspace grant')
  const workspace = resolve(requested ?? roots[0]!)
  const owned = roots.some((root) => {
    const child = relative(root, workspace)
    return child === '' || (!child.startsWith('..') && !isAbsolute(child))
  })
  if (!owned) throw new ExtensionBrokerError('workspace_denied', 'Workspace is outside the extension grant')
  return workspace
}

export function completeBudget(
  partial: Partial<ExtensionRunBudget> | undefined,
  fallback: ExtensionRunBudget
): ExtensionRunBudget {
  return clampBudget({ ...fallback, ...partial }, MAXIMUM_BUDGET)
}

export function clampBudget(
  requested: Partial<ExtensionRunBudget>,
  maximum: ExtensionRunBudget
): ExtensionRunBudget {
  const out = {} as ExtensionRunBudget
  for (const key of Object.keys(DEFAULT_BUDGET) as Array<keyof ExtensionRunBudget>) {
    const value = requested[key] ?? DEFAULT_BUDGET[key]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ExtensionBrokerError('validation_error', `Invalid extension run budget: ${key}`)
    }
    out[key] = Math.min(value, maximum[key])
  }
  return out
}

export function narrowToolScopes(profileScopes: readonly string[], requested: readonly string[] | undefined): string[] {
  const profile = [...new Set(profileScopes.map((value) => value.trim()).filter(Boolean))].sort()
  if (!requested) return profile
  const wanted = [...new Set(requested.map((value) => value.trim()).filter(Boolean))]
  if (profile.length === 0) return wanted.sort()
  const allowed = new Set(profile)
  for (const tool of wanted) {
    if (!allowed.has(tool)) {
      throw new ExtensionBrokerError('permission_denied', `Tool is outside the profile scope: ${tool}`)
    }
  }
  return wanted.sort()
}

export function titleFromInput(input: string): string {
  const line = input.split(/\r?\n/, 1)[0]?.trim() || 'Extension run'
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }
    if (Number.isSafeInteger(value.offset) && Number(value.offset) >= 0) return Number(value.offset)
  } catch {
    // Stable validation error below.
  }
  throw new ExtensionBrokerError('validation_error', 'Invalid thread cursor')
}

export function opaqueNotFound(): ExtensionBrokerError {
  return new ExtensionBrokerError('not_found', 'Extension-owned resource was not found')
}
