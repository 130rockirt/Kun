import { graphRuntimeClient } from './graph-runtime-client'
import type { GraphViewState } from './graph-store-types'
import { mergeGraphRunSnapshots } from './graph-supervision-store'
import { mergeGraphChildDiagnostics } from './graph-child-runtime'

export type ThreadRefreshGate = {
  inFlight: Promise<void> | null
  pending: boolean
  /** Pending refresh is silent only when every coalesced request asked for silent. */
  pendingSilent: boolean
}

/** One in-flight HTTP snapshot per thread; later requests mark pending. */
const threadRefreshGates = new Map<string, ThreadRefreshGate>()

export function refreshGateFor(threadId: string): ThreadRefreshGate {
  const existing = threadRefreshGates.get(threadId)
  if (existing) return existing
  const created: ThreadRefreshGate = {
    inFlight: null,
    pending: false,
    pendingSilent: true
  }
  threadRefreshGates.set(threadId, created)
  return created
}

export function graphErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function applyThreadSnapshot(
  get: () => GraphViewState,
  set: (
    partial:
      | Partial<GraphViewState>
      | ((state: GraphViewState) => Partial<GraphViewState>)
  ) => void,
  threadId: string,
  silent: boolean
): Promise<void> {
  if (!silent) set({ loading: true, error: null })
  try {
    const [runs, drafts, diagnostics] = await Promise.all([
      graphRuntimeClient.listRuns(threadId),
      graphRuntimeClient.listDrafts(threadId),
      graphRuntimeClient.delegationDiagnostics(threadId).catch(() => null)
    ])
    if (get().threadId !== threadId) return
    const current = get()
    const mergedRuns = mergeGraphRunSnapshots(current.runs, runs)
    const previousRunId = current.selectedRunId
    const previousNodeId = current.selectedNodeId
    const selectedRunId = mergedRuns.some((run) => run.id === previousRunId)
      ? previousRunId
      : mergedRuns[0]?.id ?? null
    const selectedRun = mergedRuns.find((run) => run.id === selectedRunId)
    const selectedNodeId = previousNodeId && selectedRun?.nodes[previousNodeId]
      ? previousNodeId
      : null
    set({
      runs: mergedRuns,
      drafts,
      childRuns: mergeGraphChildDiagnostics(current.childRuns, diagnostics, threadId),
      selectedRunId,
      selectedNodeId,
      artifactPage: null,
      artifactContent: '',
      artifactLoading: false,
      loading: false,
      ...(silent ? {} : { error: null })
    })
  } catch (error) {
    if (get().threadId !== threadId) return
    if (!silent) set({ loading: false, error: graphErrorMessage(error) })
    else if (get().loading) set({ loading: false })
  }
}
