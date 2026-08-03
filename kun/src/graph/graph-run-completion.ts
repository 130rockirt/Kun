import type { GraphDomainEventV1, GraphRunSummaryV1, GraphRunV1 } from '../contracts/graph.js'
import type { GraphMailbox } from './graph-mailbox.js'
import { loopGateWaivesIncompleteNode } from './graph-loop-policy.js'
import { deterministicSummary } from './graph-scheduler-policy.js'
import type { GraphSupervisionPort } from './graph-scheduler-types.js'

type CompletionOptions = {
  mailbox: GraphMailbox
  supervision: () => GraphSupervisionPort | undefined
  nowIso: () => string
  nextId: (prefix: string) => string
  append: (run: GraphRunV1, event: GraphDomainEventV1, idempotencyKey: string) => Promise<GraphRunV1>
  transitionRun: (run: GraphRunV1, to: GraphRunV1['status'], reason: string) => Promise<GraphRunV1>
  recordTerminalCleanup: (run: GraphRunV1) => Promise<GraphRunV1>
  requestSupervision: (runId: string, reason: 'completion', nodeIds: string[], digest: string) => Promise<void>
  onTerminal?: (run: GraphRunV1) => Promise<void> | void
}

export async function tryCompleteGraphRun(initialRun: GraphRunV1, options: CompletionOptions): Promise<GraphRunV1> {
  let run = initialRun
  if (!graphRunCompletionGatesPassed(run)) return run
  if (options.mailbox.unresolvedBlockers(run).length) return run
  run = await options.transitionRun(run, 'completing', 'all completion gates passed')
  return finishGraphRun(run, options)
}

export function graphRunCompletionGatesPassed(run: GraphRunV1): boolean {
  const required = Object.values(run.nodes).filter((node) => node.node.required && node.node.kind !== 'loop_gate')
  if (!required.length || !required.every((node) =>
    node.status === 'accepted' ||
    node.status === 'superseded' ||
    loopGateWaivesIncompleteNode(run, node.node.id))) return false
  if (!run.plans.at(-1)!.completionNodeIds.every((id) =>
    run.nodes[id]?.status === 'accepted' ||
    run.nodes[id]?.status === 'superseded' ||
    loopGateWaivesIncompleteNode(run, id))) return false
  return !Object.values(run.nodes).some((node) =>
    ['pending', 'blocked', 'ready', 'queued', 'running', 'submitted', 'reviewing'].includes(node.status))
}

export async function finishGraphRun(initialRun: GraphRunV1, options: CompletionOptions): Promise<GraphRunV1> {
  let run = initialRun
  if (run.status !== 'completing') return run
  if (!run.summary) {
    const summary: GraphRunSummaryV1 = options.supervision()?.synthesize
      ? await options.supervision()!.synthesize!(run)
      : deterministicSummary(run, options.nowIso())
    run = await options.append(
      run,
      { type: 'run_summary_recorded', payload: { summary } },
      `summary:${run.id}:${run.currentRevision}`
    )
  }
  run = await options.recordTerminalCleanup(run)
  run = await options.transitionRun(run, 'completed', 'final synthesis recorded')
  await options.requestSupervision(run.id, 'completion', [], run.summary!.finalAnswer.slice(0, 4_096))
  await options.onTerminal?.(run)
  return run
}

/**
 * Summary persistence is the first durable step of terminal finalization.
 * A later cleanup or status-transition failure may temporarily move the run
 * back to supervision. Only summaries whose current revision still satisfies
 * the normal completion gates receive that protection.
 */
export function isGraphRunCompletionFinalizing(
  run: GraphRunV1,
  mailbox: Pick<GraphMailbox, 'unresolvedBlockers'>
): boolean {
  return run.status === 'completing' || (
    run.summary !== undefined &&
    graphRunCompletionGatesPassed(run) &&
    mailbox.unresolvedBlockers(run).length === 0
  )
}
