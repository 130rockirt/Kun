import { graphRuntimeClient } from './graph-runtime-client'
import type { GraphRun } from './graph-types'

export function mergeGraphRunSnapshots(
  current: readonly GraphRun[],
  incoming: readonly GraphRun[]
): GraphRun[] {
  const currentById = new Map(current.map((run) => [run.id, run]))
  return incoming.map((run) => {
    const previous = currentById.get(run.id)
    if (previous && previous.lastEventSeq > run.lastEventSeq) return previous
    if (
      previous?.supervision &&
      (!run.supervision || previous.supervision.lastEventSeq > run.supervision.lastEventSeq)
    ) {
      return { ...run, supervision: previous.supervision }
    }
    return run
  })
}

type GraphLeadWakeState = {
  selectedRunId: string | null
  runs: GraphRun[]
  wakingObligationId: string | null
  error: string | null
}

export function createGraphLeadWakeAction(input: {
  get: () => GraphLeadWakeState
  update: (
    updater: (state: GraphLeadWakeState) => Partial<GraphLeadWakeState>
  ) => void
}): (obligationId?: string) => Promise<void> {
  return async (obligationId) => {
    const runId = input.get().selectedRunId
    if (!runId) return
    const marker = obligationId ?? '*'
    input.update(() => ({ wakingObligationId: marker, error: null }))
    try {
      const supervision = await graphRuntimeClient.wakeLead(runId, obligationId)
      input.update((state) => ({
        runs: state.runs.map((run) => {
          if (run.id !== runId) return run
          if (run.supervision && run.supervision.lastEventSeq > supervision.lastEventSeq) {
            return run
          }
          return { ...run, supervision }
        }),
        ...(state.wakingObligationId === marker ? { wakingObligationId: null } : {}),
        error: null
      }))
    } catch (error) {
      input.update((state) => ({
        ...(state.wakingObligationId === marker ? { wakingObligationId: null } : {}),
        error: error instanceof Error ? error.message : String(error)
      }))
    }
  }
}
