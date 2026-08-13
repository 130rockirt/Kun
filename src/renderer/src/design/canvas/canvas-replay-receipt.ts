import type { CanvasDocument } from './canvas-types'
import type { ExecuteResult } from './shape-ops'

const REPLAY_OPERATION_PREFIX = 'renderer_replay:'

export function canvasReplayOperationId(replayKey: string, index: number): string {
  return `${REPLAY_OPERATION_PREFIX}${replayKey}:${index}`
}

export function canvasReplayResult(
  document: CanvasDocument,
  replayKey: string
): ExecuteResult | null {
  const operationId = canvasReplayOperationId(replayKey, 0)
  const entry = document.operationJournal?.find((candidate) =>
    candidate.operations.some((operation) => operation.id === operationId)
  )
  if (!entry) {
    return document.rendererReplayKeys?.includes(replayKey)
      ? { ok: true, affectedIds: [], errors: [] }
      : null
  }
  return {
    ok: entry.errors.length === 0,
    affectedIds: [...entry.affectedIds],
    errors: entry.errors.map((error) => ({ ...error })) as ExecuteResult['errors']
  }
}
