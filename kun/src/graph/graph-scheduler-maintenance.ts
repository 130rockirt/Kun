import type { GraphDomainEventV1, GraphRunV1 } from '../contracts/graph.js'
import { budgetWarningKinds, errorMessage, maxBudgetRatio } from './graph-scheduler-policy.js'
import type { GraphSupervisionPort } from './graph-scheduler-types.js'

export async function recordGraphReconcileFailure(
  run: GraphRunV1,
  error: unknown,
  options: {
    withRunQueue: <T>(runId: string, operation: () => Promise<T>) => Promise<T>
    requireRun: (runId: string) => Promise<GraphRunV1>
    transitionRun: (run: GraphRunV1, to: GraphRunV1['status'], reason: string) => Promise<GraphRunV1>
    requestSupervision: (runId: string, reason: 'scheduler_error', nodeIds: string[], digest: string) => Promise<void>
  }
): Promise<void> {
  const message = errorMessage(error).slice(0, 4_096)
  console.warn(`[kun] Graph scheduler reconcile failed for ${run.id}: ${message}`)
  let failedRun = run
  try {
    failedRun = await options.withRunQueue(run.id, async () => {
      const latest = await options.requireRun(run.id)
      return latest.status === 'running' || latest.status === 'completing'
        ? options.transitionRun(latest, 'awaiting_supervision', `scheduler reconciliation failed: ${message}`.slice(0, 4_096))
        : latest
    })
    await options.requestSupervision(
      failedRun.id,
      'scheduler_error',
      Object.values(failedRun.nodes).filter((node) => node.status === 'submitted' || node.status === 'reviewing').map((node) => node.node.id),
      `Graph scheduler reconciliation failed and requires recovery: ${message}`
    )
  } catch (signalError) {
    console.warn(`[kun] Graph scheduler could not persist recovery for ${run.id}: ${errorMessage(signalError).slice(0, 512)}`)
  }
}

export async function enforceGraphBudgets(
  initialRun: GraphRunV1,
  options: {
    nowIso: () => string
    updateBudget: (run: GraphRunV1, fields: { elapsedMs: number }, reason: string) => Promise<GraphRunV1>
    failForBudget: (run: GraphRunV1, reason: string) => Promise<GraphRunV1>
    append: (run: GraphRunV1, event: GraphDomainEventV1, idempotencyKey: string) => Promise<GraphRunV1>
    requestSupervision: (runId: string, reason: 'budget', nodeIds: string[], digest: string) => Promise<void>
  }
): Promise<GraphRunV1> {
  let run = initialRun
  const elapsedMs = Math.max(run.budget.elapsedMs, Date.parse(options.nowIso()) - Date.parse(run.createdAt))
  if (elapsedMs >= run.budget.limits.maxWallTimeMs || elapsedMs - run.budget.elapsedMs >= 1_000) {
    run = await options.updateBudget(run, { elapsedMs }, 'scheduler wall time accounting')
  }
  if (run.budget.elapsedMs >= run.budget.limits.maxWallTimeMs || run.budget.artifactBytes > run.budget.limits.maxArtifactBytes) {
    return options.failForBudget(run, 'GraphRun hard budget exhausted')
  }
  const warningKinds = maxBudgetRatio(run) >= run.budget.limits.warningRatio ? budgetWarningKinds(run) : []
  if (warningKinds.some((kind) => !run.budget.warningKinds.includes(kind))) {
    const ledger = { ...run.budget, warningKinds: [...new Set([...run.budget.warningKinds, ...warningKinds])] }
    run = await options.append(run, {
      type: 'budget_warning', payload: { ledger, reason: 'GraphRun budget warning threshold reached' }
    }, `budget-warning:${run.id}:${warningKinds.join(',')}`)
    await options.requestSupervision(run.id, 'budget', [], 'GraphRun budget warning threshold reached.')
  }
  return run
}
