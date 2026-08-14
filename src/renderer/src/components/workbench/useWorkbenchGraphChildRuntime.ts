import { useCallback, useMemo } from 'react'
import { useChatStore } from '../../store/chat-store'
import { useGraphStore } from '../../graph/graph-store'
import { graphNodeLiveness } from '../../graph/graph-liveness'
import { openGraphChildThread } from '../../graph/graph-child-navigation'
import { BUILTIN_RIGHT_PANEL_IDS, type RightPanelContributionId } from '../../extensions/contribution-ids'
import { formatSubagentElapsed } from '../subagents/SubagentLiveness'

type GraphState = ReturnType<typeof useGraphStore.getState>

type Params = {
  t: (key: string, options?: Record<string, unknown>) => string
  graphEnabled: boolean
  graphChildReturnTarget: GraphState['childReturnTarget']
  graphRuns: GraphState['runs']
  graphChildRuns: GraphState['childRuns']
  graphChildNow: number
  activeThreadId: string | null
  activeThreadParentId: string | null
  selectThread: (threadId: string) => Promise<unknown> | unknown
  openRightPanelTab: (id: RightPanelContributionId) => void
}

export function useWorkbenchGraphChildRuntime({
  t,
  graphEnabled,
  graphChildReturnTarget,
  graphRuns,
  graphChildRuns,
  graphChildNow,
  activeThreadId,
  activeThreadParentId,
  selectThread,
  openRightPanelTab
}: Params) {
  const openComposerGraph = useCallback((runId: string, nodeId?: string): void => {
    if (!graphEnabled) return
    const graph = useGraphStore.getState()
    graph.selectRun(runId)
    graph.selectNode(nodeId ?? null)
    openRightPanelTab(BUILTIN_RIGHT_PANEL_IDS.graph)
  }, [graphEnabled, openRightPanelTab])

  const openComposerGraphChild = useCallback((
    runId: string,
    nodeId: string,
    attemptId: string,
    childThreadId: string
  ): void => {
    const graph = useGraphStore.getState()
    const run = graph.runs.find((candidate) => candidate.id === runId)
    if (!run) return
    graph.setChildReturnTarget({
      parentThreadId: run.threadId,
      childThreadId,
      runId,
      nodeId,
      attemptId,
      parentEventSeq: useChatStore.getState().lastSeq,
      childSessionStatus: 'creating',
      observerStatus: 'connecting',
      openedAt: new Date().toISOString()
    })
    void openGraphChildThread(childThreadId)
  }, [])

  const graphChildContext = useMemo(() => {
    if (!graphEnabled) return undefined
    const target = graphChildReturnTarget
    if (!target || activeThreadId !== target.childThreadId) return undefined
    const run = graphRuns.find((candidate) => candidate.id === target.runId)
    const node = run?.nodes[target.nodeId]
    const attempt = node?.attempts.find((candidate) => candidate.id === target.attemptId)
    if (!run || !node || !attempt) return undefined
    const liveness = graphNodeLiveness(node, graphChildRuns, graphChildNow, run.supervision)
    return {
      runTitle: run.plans.at(-1)?.title ?? t('graphPanelTitle'),
      nodeTitle: node.node.title,
      attemptNumber: attempt.attemptNumber,
      agentName: attempt.assignment.name,
      statusLabel: t(`graphLiveness_${liveness.kind}`),
      activityLabel: liveness.quiet
        ? t('graphStillWaiting', {
            seconds: Math.floor((liveness.lastActivityAgeMs ?? 0) / 1_000)
          })
        : liveness.activityLabel ??
          (liveness.child?.status === 'queued'
            ? t('graphCreatingChildSession')
            : t(`graphStatus_${node.status}`, { defaultValue: node.status })),
      elapsedLabel: liveness.elapsedMs ? formatSubagentElapsed(liveness.elapsedMs) : '',
      observerStatus: target.observerStatus
    }
  }, [activeThreadId, graphEnabled, graphChildNow, graphChildReturnTarget, graphChildRuns, graphRuns, t])

  const returnFromSubagent = useCallback((): void => {
    const target = useGraphStore.getState().childReturnTarget
    if (!target || activeThreadId !== target.childThreadId) {
      if (activeThreadParentId) void selectThread(activeThreadParentId)
      return
    }
    void (async () => {
      await selectThread(target.parentThreadId)
      const graph = useGraphStore.getState()
      await graph.refreshThread(target.parentThreadId)
      graph.selectRun(target.runId)
      graph.selectNode(target.nodeId)
      openRightPanelTab(BUILTIN_RIGHT_PANEL_IDS.graph)
      graph.clearChildReturnTarget()
    })()
  }, [activeThreadId, activeThreadParentId, openRightPanelTab, selectThread])

  return { graphChildContext, openComposerGraph, openComposerGraphChild, returnFromSubagent }
}
