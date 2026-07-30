import type { RuntimeChildEventPayload } from '../agent/types'
import type {
  GraphChildRuntime,
  GraphDelegationDiagnostics
} from './graph-types'

export type GraphChildReturnTarget = {
  parentThreadId: string
  childThreadId: string
  runId: string
  nodeId: string
  attemptId: string
  parentEventSeq: number
  childSessionStatus: 'creating' | 'open' | 'failed'
  observerStatus: 'connecting' | 'live' | 'reconnecting' | 'stopped'
  openedAt: string
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function graphChildRuntimeFromDiagnostics(
  record: GraphDelegationDiagnostics['childRuns'][number]
): GraphChildRuntime {
  return {
    childId: record.id,
    parentThreadId: record.parentThreadId,
    parentTurnId: record.parentTurnId,
    ...(record.childSeq !== undefined ? { childSeq: record.childSeq } : {}),
    ...(record.label ? { label: record.label } : {}),
    ...(record.profile ? { profile: record.profile } : {}),
    ...(record.profileSnapshot?.name ? { profileName: record.profileSnapshot.name } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.providerId ? { providerId: record.providerId } : {}),
    status: record.status,
    ...(record.activity ? { activity: record.activity } : {}),
    ...(record.toolInvocations !== undefined
      ? { toolInvocations: record.toolInvocations }
      : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.queuedMs !== undefined ? { queuedMs: record.queuedMs } : {}),
    ...(record.usage?.totalTokens !== undefined
      ? { totalTokens: record.usage.totalTokens }
      : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    updatedAt: record.updatedAt
  }
}

export function graphChildRuntimeFromEvent(
  event: RuntimeChildEventPayload
): GraphChildRuntime {
  const child = event.child
  const updatedAt = child.activity?.updatedAt ?? event.timestamp ?? new Date().toISOString()
  return {
    childId: child.childId,
    parentThreadId: child.parentThreadId,
    parentTurnId: child.parentTurnId,
    childSeq: child.childSeq,
    ...(event.seq !== undefined ? { eventSeq: event.seq } : {}),
    ...(child.childLabel ? { label: child.childLabel } : {}),
    ...(child.childProfile ? { profile: child.childProfile } : {}),
    ...(child.childProfileName ? { profileName: child.childProfileName } : {}),
    ...(child.childModel ? { model: child.childModel } : {}),
    ...(child.childProviderId ? { providerId: child.childProviderId } : {}),
    status: child.childStatus,
    ...(child.activity ? { activity: child.activity } : {}),
    ...(child.toolInvocations !== undefined
      ? { toolInvocations: child.toolInvocations }
      : {}),
    ...(child.durationMs !== undefined ? { durationMs: child.durationMs } : {}),
    ...(child.queuedMs !== undefined ? { queuedMs: child.queuedMs } : {}),
    ...(child.totalTokens !== undefined ? { totalTokens: child.totalTokens } : {}),
    ...(child.activity?.startedAt ? { startedAt: child.activity.startedAt } : {}),
    updatedAt
  }
}

export function mergeGraphChildRuntime(
  current: GraphChildRuntime | undefined,
  incoming: GraphChildRuntime
): GraphChildRuntime {
  if (!current) return incoming
  if (
    incoming.eventSeq !== undefined &&
    current.eventSeq !== undefined &&
    incoming.eventSeq <= current.eventSeq
  ) {
    return current
  }
  if (
    incoming.eventSeq === undefined &&
    timestampMs(incoming.updatedAt) < timestampMs(current.updatedAt)
  ) {
    return current
  }
  return {
    ...current,
    ...incoming,
    activity: incoming.activity ?? current.activity,
    startedAt: incoming.startedAt ?? current.startedAt,
    eventSeq: incoming.eventSeq ?? current.eventSeq
  }
}

export function mergeGraphChildDiagnostics(
  current: Record<string, GraphChildRuntime>,
  diagnostics: GraphDelegationDiagnostics | null,
  parentThreadId: string
): Record<string, GraphChildRuntime> {
  const next: Record<string, GraphChildRuntime> = {}
  for (const record of Object.values(current)) {
    if (record.parentThreadId === parentThreadId) next[record.childId] = record
  }
  for (const record of diagnostics?.childRuns ?? []) {
    if (record.parentThreadId !== parentThreadId) continue
    const incoming = graphChildRuntimeFromDiagnostics(record)
    next[incoming.childId] = mergeGraphChildRuntime(next[incoming.childId], incoming)
  }
  return next
}
