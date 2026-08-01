import { emitPlanningEvent } from '../adapters/tool/graph-define-plan-tool.js'
import type { GraphRuntimeConfig } from '../config/kun-config.js'
import type { GraphRunV1 } from '../contracts/graph.js'
import type {
  FileGraphPlanningDraftStore,
  GraphControlService,
  GraphSupervisor,
  GraphRunStore
} from '../graph/index.js'
import { terminalRequiredFailure } from '../graph/graph-scheduler-policy.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'

type PlanningCommitRecoveryContext = {
  store: GraphRunStore
  drafts: FileGraphPlanningDraftStore
  control: GraphControlService
  runtimeEvents: Pick<RuntimeEventRecorder, 'record'>
  ids: IdGenerator
}

type LeadOwnershipRecoveryContext = {
  store: GraphRunStore
  drafts: FileGraphPlanningDraftStore
  supervisor: GraphSupervisor
  config: () => GraphRuntimeConfig
  threadStore: Pick<ThreadStore, 'get'>
  handleSourceTurnTerminal: (
    threadId: string,
    sourceTurnId: string,
    status: 'completed' | 'failed' | 'aborted'
  ) => Promise<void>
}

export async function recoverGraphPlanningCommits(
  context: PlanningCommitRecoveryContext
): Promise<string[]> {
  const readyRunIds: string[] = []
  const drafts = await context.drafts.list({
    statuses: ['committing', 'committed', 'cancelled', 'host_error']
  })
  for (const draft of drafts) {
    const runId = draft.committedRunId ?? draft.reservedRunId
    let run = await context.store.get(runId)
    if (draft.status === 'cancelled' || draft.status === 'host_error') {
      if (run && !isTerminal(run)) {
        await cancelRecoveredRun(
          context,
          run,
          `planning draft recovered as ${draft.status}`,
          `draft-terminal:${draft.id}:${draft.revision}`
        )
      }
      continue
    }
    if (draft.status === 'committed' && !run) {
      const failed = await context.drafts.update(draft.id, {
        expectedRevision: draft.revision,
        status: 'host_error',
        issues: [{
          code: 'graph_committed_run_missing',
          path: [],
          message: `Committed GraphRun ${runId} is missing from durable storage.`,
          repairHint: 'Cancel this draft and start a new Graph turn.'
        }]
      })
      await projectPlanningState(context, failed)
      continue
    }
    if (!run) {
      const plan = await context.drafts.readCommitPlan(draft.id)
      if (!plan) {
        const failed = await context.drafts.update(draft.id, {
          expectedRevision: draft.revision,
          status: 'host_error',
          issues: [{
            code: 'graph_commit_plan_missing',
            path: [],
            message: 'The persisted commit plan is missing.',
            repairHint: 'Cancel this draft and start a new Graph turn.'
          }]
        })
        await projectPlanningState(context, failed)
        continue
      }
      run = (await context.control.create({
        runId: draft.reservedRunId,
        threadId: draft.threadId,
        projectId: draft.projectId,
        sourceTurnId: draft.sourceTurnId,
        plan,
        commandId: context.ids.next('graph_plan_recovery'),
        idempotencyKey: `graph-plan-commit:${draft.sourceTurnId}`,
        start: false
      })).run
    }
    if (draft.status === 'committing') {
      const committed = await context.drafts.update(draft.id, {
        expectedRevision: draft.revision,
        status: 'committed',
        issues: [],
        committedRunId: run.id
      })
      await projectPlanningState(context, committed)
    }
    if (run.status === 'ready') readyRunIds.push(run.id)
  }
  return [...new Set(readyRunIds)]
}

export async function recoverGraphLeadOwnership(
  context: LeadOwnershipRecoveryContext
): Promise<void> {
  const runs = await context.store.list()
  for (const run of runs) {
    const thread = await context.threadStore.get(run.threadId)
    const sourceTurn = thread?.turns.find((turn) => turn.id === run.sourceTurnId)
    if (!sourceTurn) continue
    const terminal = isTerminal(run)
    if (sourceTurn.status !== 'running') {
      // Older runtimes persisted host-shutdown aborts before stopping. Once all
      // completion gates pass, the idempotent scheduler may finish synthesis.
      if (sourceTurn.status === 'aborted' && run.status === 'completing') continue
      if (
        !terminal &&
        (sourceTurn.status === 'completed' ||
          sourceTurn.status === 'failed' ||
          sourceTurn.status === 'aborted')
      ) {
        await context.handleSourceTurnTerminal(
          run.threadId,
          run.sourceTurnId,
          sourceTurn.status
        )
      }
      continue
    }
    const lifecycle = sourceTurn.graphLeadLifecycle
    const lastDeliveredSeq = lifecycle?.runId === run.id
      ? lifecycle.lastDeliveredSeq
      : 0
    const unseenSignals = (await context.store.events(run.id, lastDeliveredSeq))
      .flatMap((event) => event.event.type === 'supervision_requested'
        ? [{
            reason: event.event.payload.reason,
            nodeIds: event.event.payload.nodeIds,
            digest: event.event.payload.digest
          }]
        : [])
    const resumedAt = lifecycle?.resumedAt ? Date.parse(lifecycle.resumedAt) : 0
    const suspendedAt = lifecycle?.suspendedAt ? Date.parse(lifecycle.suspendedAt) : 0
    const interruptedContinuation =
      lifecycle?.runId === run.id &&
      Number.isFinite(resumedAt) &&
      resumedAt > 0 &&
      (!Number.isFinite(suspendedAt) || resumedAt > suspendedAt)
    const pendingReviewNodeIds = Object.values(run.nodes)
      .filter((node) => node.status === 'submitted' || node.status === 'reviewing')
      .map((node) => node.node.id)
    const exhaustedRequiredNode = terminalRequiredFailure(run, context.config())
    const exhaustedNodeIds = exhaustedRequiredNode
      ? [exhaustedRequiredNode.node.id]
      : []
    const durableSupervisionPending =
      run.status === 'awaiting_supervision' ||
      pendingReviewNodeIds.length > 0 ||
      exhaustedNodeIds.length > 0
    const planningDraft = await context.drafts.findBySourceTurn(run.sourceTurnId)
    const planningLifecycleNeedsRecovery =
      planningDraft !== null &&
      (
        sourceTurn.graphPlanningLifecycle?.draftId !== planningDraft.id ||
        sourceTurn.graphPlanningLifecycle.reservedRunId !== planningDraft.reservedRunId ||
        sourceTurn.graphPlanningLifecycle.state !== planningDraft.status ||
        sourceTurn.graphPlanningLifecycle.draftRevision < planningDraft.revision
      )
    if (
      !terminal &&
      unseenSignals.length === 0 &&
      !interruptedContinuation &&
      !planningLifecycleNeedsRecovery &&
      !durableSupervisionPending
    ) continue
    const latestSignals = unseenSignals.slice(-32)
    await context.supervisor.redeliverNow({
      runId: run.id,
      reason: recoveredReason(
        terminal,
        exhaustedNodeIds,
        latestSignals.at(-1)?.reason,
        durableSupervisionPending
      ),
      nodeIds: [...new Set([
        ...latestSignals.flatMap((signal) => signal.nodeIds),
        ...pendingReviewNodeIds,
        ...exhaustedNodeIds
      ])],
      digest: recoveredDigest({
        run,
        terminal,
        exhaustedNodeIds,
        latestSignals,
        planningDraft,
        planningLifecycleNeedsRecovery,
        durableSupervisionPending
      })
    })
  }
}

async function cancelRecoveredRun(
  context: PlanningCommitRecoveryContext,
  run: GraphRunV1,
  reason: string,
  idempotencyKey: string
): Promise<void> {
  try {
    await context.control.cancel(run.id, {
      commandId: context.ids.next('graph_recovery_cancel'),
      idempotencyKey,
      reason
    })
  } catch (error) {
    const latest = await context.store.get(run.id)
    if (latest && isTerminal(latest)) return
    throw error
  }
}

async function projectPlanningState(
  context: PlanningCommitRecoveryContext,
  draft: Parameters<typeof emitPlanningEvent>[1]
): Promise<void> {
  await emitPlanningEvent({
    drafts: context.drafts,
    events: context.runtimeEvents
  }, draft).catch(() => undefined)
}

function isTerminal(run: GraphRunV1): boolean {
  return (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled'
  )
}

function recoveredReason(
  terminal: boolean,
  exhaustedNodeIds: string[],
  latestReason: Parameters<GraphSupervisor['redeliver']>[0]['reason'] | undefined,
  durableSupervisionPending: boolean
): Parameters<GraphSupervisor['redeliver']>[0]['reason'] {
  if (terminal) return 'completion'
  if (exhaustedNodeIds.length > 0) return 'failure'
  if (latestReason) return latestReason
  return durableSupervisionPending ? 'submitted' : 'recovery'
}

function recoveredDigest(input: {
  run: GraphRunV1
  terminal: boolean
  exhaustedNodeIds: string[]
  latestSignals: Array<{ digest: string }>
  planningDraft: Awaited<ReturnType<FileGraphPlanningDraftStore['findBySourceTurn']>>
  planningLifecycleNeedsRecovery: boolean
  durableSupervisionPending: boolean
}): string {
  if (input.exhaustedNodeIds.length > 0 && !input.terminal) {
    return `Recovered exhausted required work for GraphRun ${input.run.id}. ` +
      'Inspect the failed or repair-required node and use graph_patch_run ' +
      'to create a semantic replacement.'
  }
  if (input.planningLifecycleNeedsRecovery && input.planningDraft) {
    return `Recovered stale Graph planning lifecycle for GraphRun ${input.run.id}; ` +
      `durable draft ${input.planningDraft.id} is ${input.planningDraft.status} at revision ` +
      `${input.planningDraft.revision}.`
  }
  if (input.latestSignals.length > 0) {
    return input.latestSignals
      .map((signal) => signal.digest)
      .filter(Boolean)
      .join('\n')
      .slice(0, 16_384)
  }
  if (input.terminal) {
    return `Recovered terminal GraphRun ${input.run.id} with status ${input.run.status}.`
  }
  return input.durableSupervisionPending
    ? `Recovered pending Lead supervision for GraphRun ${input.run.id}.`
    : `Recovered interrupted Lead continuation for GraphRun ${input.run.id}.`
}
