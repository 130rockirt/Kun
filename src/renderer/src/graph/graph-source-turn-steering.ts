import { graphRuntimeClient } from './graph-runtime-client'
import type { GraphRun } from './graph-types'

export async function steerGraphSourceTurn(input: {
  threadId: string
  sourceTurnId: string
  text: string
  knownRuns: readonly GraphRun[]
}): Promise<GraphRun | null> {
  let runs = input.knownRuns.filter((run) => run.threadId === input.threadId)
  if (!runs.some((run) => run.sourceTurnId === input.sourceTurnId)) {
    runs = await graphRuntimeClient.listRuns(input.threadId)
  }
  const run = runs
    .filter((candidate) =>
      candidate.sourceTurnId === input.sourceTurnId &&
      !['completed', 'failed', 'cancelled'].includes(candidate.status))
    .sort((left, right) => right.lastEventSeq - left.lastEventSeq)[0]
  return run
    ? graphRuntimeClient.steer(run.id, input.text, { kind: 'lead' })
    : null
}
