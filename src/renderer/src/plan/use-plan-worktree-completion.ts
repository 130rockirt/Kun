import { useEffect } from 'react'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import { useGraphStore } from '../graph/graph-store'
import { useChatStore } from '../store/chat-store'
import {
  planWorktreeCompletionIsSuccessful,
  projectPlanWorktreeCompletion
} from './plan-worktree-completion'
import { usePlanWorktreeStore } from './plan-worktree-store'

const finalizingRuns = new Set<string>()

export function usePlanWorktreeCompletion(run: PlanWorktreeRunRecord | undefined): void {
  const activeThreadId = useChatStore((state) => state.activeThreadId)
  const threads = useChatStore((state) => state.threads)
  const goal = useChatStore((state) => state.activeThreadGoal)
  const blocks = useChatStore((state) => state.blocks)
  const busy = useChatStore((state) => state.busy)
  const currentTurnId = useChatStore((state) => state.currentTurnId)
  const graphThreadId = useGraphStore((state) => state.threadId)
  const graphRuns = useGraphStore((state) => state.runs)
  const upsertRun = usePlanWorktreeStore((state) => state.upsertRun)

  useEffect(() => {
    if (
      !run ||
      run.status !== 'executing' ||
      !run.executionThreadId ||
      activeThreadId !== run.executionThreadId
    ) return
    const snapshot = projectPlanWorktreeCompletion({
      run,
      thread: threads.find((thread) => thread.id === run.executionThreadId),
      goal,
      blocks,
      busy,
      currentTurnId,
      graphRuns: graphThreadId === run.executionThreadId ? graphRuns : []
    })
    if (!snapshot || !planWorktreeCompletionIsSuccessful(snapshot, run.orchestration)) return
    if (finalizingRuns.has(run.runId)) return
    finalizingRuns.add(run.runId)
    void window.kunGui.planWorktree.finalize({
      runId: run.runId,
      completion: snapshot
    }).then(upsertRun).catch(() => undefined).finally(() => {
      finalizingRuns.delete(run.runId)
    })
  }, [
    activeThreadId,
    blocks,
    busy,
    currentTurnId,
    goal,
    graphRuns,
    graphThreadId,
    run,
    threads,
    upsertRun
  ])
}

export function resetPlanWorktreeCompletionForTests(): void {
  finalizingRuns.clear()
}
