import type { GraphRuntimeConfig } from '../config/kun-config.js'
import {
  GRAPH_CONTRACT_VERSION,
  type GraphRunSummaryV1,
  type GraphRunV1
} from '../contracts/graph.js'
import type { ChildRunRecord, DelegationRuntime } from '../delegation/delegation-runtime.js'
import type { GraphSupervisionPort } from './graph-scheduler-types.js'
import type { GraphRunStore } from './graph-run-store.js'
import { projectGraphVerifiedCheckResult } from './graph-scheduler-policy.js'

export async function replayGraphDeferredWithRetry(options: {
  replay: () => Promise<void>
  enabled: () => boolean
  stopped: () => boolean
  preserve: () => void
}): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.stopped()) return
    if (!options.enabled()) {
      options.preserve()
      return
    }
    try {
      await options.replay()
      return
    } catch (error) {
      failure = error
    }
  }
  options.preserve()
  throw failure
}

export async function acknowledgeGraphLeadSteering(options: {
  store: Pick<GraphRunStore, 'get' | 'append'>
  runId: string
  steeringIds: readonly string[]
  nextId: (prefix: string) => string
}): Promise<void> {
  let run = await options.store.get(options.runId)
  if (!run) return
  for (const steeringId of options.steeringIds) {
    run = await options.store.get(options.runId)
    if (!run) return
    const steering = run.steering.find((entry) => entry.steeringId === steeringId)
    if (!steering || steering.status === 'handled' || steering.status === 'superseded') continue
    run = (await options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: options.nextId('graph_supervision'),
      idempotencyKey: `steering-handled:lead:${run.id}:${steering.steeringId}`,
      event: {
        type: 'steering_status_changed',
        payload: { steeringId, from: steering.status, to: 'handled' }
      }
    })).state
  }
}

export function futureGraphTimestamp(value: string | undefined, nowMs: number): boolean {
  if (!value) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > nowMs
}

export function synthesizeGraphRunSummary(
  run: GraphRunV1,
  completedAt: string
): GraphRunSummaryV1 {
  const accepted = Object.values(run.nodes).flatMap((node) =>
    node.attempts.filter((attempt) => attempt.id === node.acceptedAttemptId))
  const summaries = run.plans.at(-1)!.completionNodeIds.flatMap((nodeId) => {
    const node = run.nodes[nodeId]
    return node?.attempts
      .filter((attempt) => attempt.id === node.acceptedAttemptId)
      .map((attempt) => attempt.result?.summary)
      .filter((summary): summary is string => Boolean(summary)) ?? []
  })
  return {
    version: GRAPH_CONTRACT_VERSION,
    finalAnswer: (summaries.join('\n\n') || 'GraphRun completed.').slice(0, 32_768),
    evidenceRefs: accepted.flatMap((attempt) => attempt.result?.artifactRefs ?? []).slice(0, 256),
    unresolvedRisks: accepted.flatMap((attempt) => attempt.result?.risks ?? []).slice(0, 128),
    changedFiles: [...new Set(accepted.flatMap((attempt) =>
      attempt.result?.changedFiles ?? []))].slice(0, 10_000),
    validationResults: accepted.flatMap((attempt) =>
      attempt.result?.verifiedChecks?.map(projectGraphVerifiedCheckResult) ?? []).slice(0, 512),
    totalTokens: run.budget.totalTokens,
    totalElapsedMs: run.budget.elapsedMs,
    completedAt
  }
}

export async function sweepGraphStalls(options: {
  store: Pick<GraphRunStore, 'list'>
  config: () => GraphRuntimeConfig
  delegation: () => DelegationRuntime | undefined
  nowMs: () => number
  signal: (input: Parameters<GraphSupervisionPort['signal']>[0]) => Promise<void>
}): Promise<number> {
  const runs = await options.store.list({ statuses: ['running', 'awaiting_supervision'] })
  let signaled = 0
  const now = options.nowMs()
  const childRunsByThread = new Map<string, Map<string, ChildRunRecord>>()
  for (const run of runs) {
    let childRunsById = childRunsByThread.get(run.threadId)
    if (!childRunsById) {
      childRunsById = await loadChildRunsById(options.delegation(), run.threadId)
      childRunsByThread.set(run.threadId, childRunsById)
    }
    const stalled = Object.values(run.nodes).filter((node) => {
      const attempt = node.attempts.at(-1)
      if (node.status !== 'running' || !attempt?.startedAt) return false
      const child = attempt.childThreadId
        ? childRunsById.get(attempt.childThreadId)
        : undefined
      const latestActivityAt = child?.activity?.updatedAt ??
        child?.updatedAt ??
        attempt.startedAt
      const latestActivityMs = Date.parse(latestActivityAt)
      return Number.isFinite(latestActivityMs) &&
        now - latestActivityMs >= options.config().supervision.stallTimeoutMs
    })
    if (!stalled.length) continue
    await options.signal({
      runId: run.id,
      reason: 'stall',
      nodeIds: stalled.map((node) => node.node.id),
      digest:
        `${stalled.length} running node attempt(s) had no safe child activity within the ` +
        'supervision quiet threshold. Attempts remain running; inspect durable state before acting.'
    })
    signaled += 1
  }
  return signaled
}

async function loadChildRunsById(
  delegation: DelegationRuntime | undefined,
  threadId: string
): Promise<Map<string, ChildRunRecord>> {
  if (!delegation) return new Map()
  try {
    const diagnostics = await delegation.diagnostics(threadId)
    return new Map(diagnostics.childRuns.map((child) => [child.id, child]))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `[kun] Graph supervisor could not read child activity for ${threadId}: ` +
      message.slice(0, 512)
    )
    return new Map()
  }
}
