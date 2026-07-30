import {
  GRAPH_CONTRACT_VERSION,
  type GraphDomainEventV1,
  type GraphRunV1
} from '../contracts/graph.js'
import type { FileGraphWriteCoordinator } from './graph-write-coordinator.js'

export async function recordGraphTerminalCleanup(input: {
  run: GraphRunV1
  writes: FileGraphWriteCoordinator
  nextId: (prefix: string) => string
  nowIso: () => string
  append: (
    run: GraphRunV1,
    event: GraphDomainEventV1,
    idempotencyKey: string
  ) => Promise<GraphRunV1>
}): Promise<GraphRunV1> {
  let run = input.run
  const resources = await input.writes.cleanupRun(run.id)
  const cleanupInputs = [
    ...resources,
    {
      resourceKind: 'journal' as const,
      resourceId: run.id,
      state: 'completed' as const
    }
  ]
  for (const cleanupInput of cleanupInputs) {
    if (run.cleanup.some((entry) =>
      entry.resourceKind === cleanupInput.resourceKind &&
      entry.resourceId === cleanupInput.resourceId &&
      entry.state === cleanupInput.state
    )) continue
    run = await input.append(run, {
      type: 'cleanup_updated',
      payload: {
        cleanup: {
          version: GRAPH_CONTRACT_VERSION,
          id: input.nextId('graph_cleanup'),
          runId: run.id,
          ...cleanupInput,
          retryCount: 0,
          updatedAt: input.nowIso()
        }
      }
    }, `terminal-cleanup:${run.id}:${cleanupInput.resourceKind}:` +
      `${cleanupInput.resourceId}:${cleanupInput.state}`)
  }
  return run
}
