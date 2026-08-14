import type { PptBoardOp } from './pptd-to-canvas.js'

export const PPT_TO_BOARD_BATCH_SIZE = 100

export type PptBoardBatch = {
  ops: PptBoardOp[]
  batch: number
  batchCount: number
  more: boolean
}

/**
 * Deterministic batch slicing over a converted op list. The tool calls this
 * with an explicit `batch` index (0-based) so the agent can page through
 * large decks without the renderer ever receiving more than 100 ops at once.
 */
export function sliceOpsForBatch(
  ops: PptBoardOp[],
  batch: number,
  batchSize: number = PPT_TO_BOARD_BATCH_SIZE
): PptBoardBatch {
  const safeBatch = Number.isInteger(batch) && batch >= 0 ? batch : 0
  const safeSize = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : PPT_TO_BOARD_BATCH_SIZE
  const batchCount = Math.max(1, Math.ceil(ops.length / safeSize))
  const start = safeBatch * safeSize
  return {
    ops: ops.slice(start, start + safeSize),
    batch: safeBatch,
    batchCount,
    more: start + safeSize < ops.length
  }
}
