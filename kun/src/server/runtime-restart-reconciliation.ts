import type { ServerRuntime } from './routes/server-runtime.js'

export type RestartReconciliationReport = {
  orphanedChildren: number
  orphanedThreadIds: string[]
  resumeCandidateIds: string[]
  resumedGoals: number
  resumedTurns: number
}

type RestartRuntime = Pick<
  ServerRuntime,
  'delegationRuntime' | 'resumeInterruptedGoals' | 'resumeInterruptedTurns' | 'threadStore' | 'turnService'
>

/**
 * Settle child records before parent turns so restart recovery can distinguish
 * an ordinary interrupted task from a parent waiting on a resumable child.
 */
export async function reconcileRuntimeAfterRestart(
  runtime: RestartRuntime
): Promise<RestartReconciliationReport> {
  let orphanedChildren = 0
  let childReconciliationFailed = false
  try {
    orphanedChildren = await runtime.delegationRuntime?.reconcileOrphanedChildRuns() ?? 0
    if (orphanedChildren > 0) {
      console.warn(`[kun] marked ${orphanedChildren} orphaned subagent run(s) as failed after restart`)
    }
  } catch (error) {
    childReconciliationFailed = true
    console.warn('[kun] orphaned child-run reconciliation failed:', error)
  }

  const orphanedThreadIds = await runtime.turnService.reconcileOrphanedTurns()
  if (orphanedThreadIds.length > 0) {
    console.warn(`[kun] marked orphaned turn(s) on ${orphanedThreadIds.length} thread(s) as failed after restart`)
  }

  let resumableParents = new Set<string>()
  if (runtime.delegationRuntime) {
    try {
      resumableParents = new Set(await runtime.delegationRuntime.resumableParentThreadIds())
    } catch (error) {
      childReconciliationFailed = true
      console.warn('[kun] resumable child-run lookup failed:', error)
    }
  }
  const resumeCandidateIds: string[] = []
  if (!childReconciliationFailed && runtime.threadStore) {
    for (const threadId of orphanedThreadIds) {
      if (resumableParents.has(threadId)) continue
      const thread = await runtime.threadStore.get(threadId).catch(() => null)
      if (!thread || thread.relation === 'side') continue
      resumeCandidateIds.push(threadId)
    }
  }

  const resumedGoals = resumeCandidateIds.length > 0 && runtime.resumeInterruptedGoals
    ? await runtime.resumeInterruptedGoals(resumeCandidateIds)
    : 0
  if (resumedGoals > 0) {
    console.warn(`[kun] auto-resumed ${resumedGoals} interrupted goal(s) after restart`)
  }
  const resumedTurns = resumeCandidateIds.length > 0 && runtime.resumeInterruptedTurns
    ? await runtime.resumeInterruptedTurns(resumeCandidateIds)
    : 0
  if (resumedTurns > 0) {
    console.warn(`[kun] auto-resumed ${resumedTurns} interrupted turn(s) after restart`)
  }
  return { orphanedChildren, orphanedThreadIds, resumeCandidateIds, resumedGoals, resumedTurns }
}
