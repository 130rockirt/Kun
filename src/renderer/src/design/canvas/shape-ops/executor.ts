import { useCanvasSelectionStore } from '../canvas-selection-store'
import { useCanvasShapeStore } from '../canvas-shape-store'
import { useCanvasUndoStore } from '../canvas-undo-store'
import { executeAdvancedShapeOp } from './handlers-advanced'
import { executeBasicShapeOp } from './handlers-basic'
import { executeDesignSystemShapeOp } from './handlers-system'
import { type ExecuteOpsOptions, type ExecuteResult, type OpError, type ShapeOp, ShapeOpSchema } from './schema'
import {
  appendDesignOperationJournalEntry,
  shapeOpToDesignOperation
} from '../../graph/design-operation-journal'
import { canvasReplayOperationId, canvasReplayResult } from '../canvas-replay-receipt'

function executeOne(
  op: ShapeOp,
  affectedIds: Set<string>,
  errors: OpError[],
  options: ExecuteOpsOptions = {}
): void {
  if (executeBasicShapeOp(op, affectedIds, errors, options)) return
  if (executeDesignSystemShapeOp(op, affectedIds, errors)) return
  if (executeAdvancedShapeOp(op, affectedIds, errors, options)) return

  errors.push({ code: 'INVALID_OP', message: `Unknown op: ${JSON.stringify(op)}` })
}

/** Execute a batch of operations atomically. Returns affected ids + structured errors. */
export function executeOps(
  rawOps: unknown[],
  label = 'shape-ops',
  options?: ExecuteOpsOptions
): ExecuteResult {
  const replayKey = options?.replayKey?.trim()
  if (replayKey) {
    const replayed = canvasReplayResult(useCanvasShapeStore.getState().document, replayKey)
    if (replayed) return replayed
  }
  const affectedIds = new Set<string>()
  const errors: OpError[] = []

  // Validate every op first; collect errors but don't abort — let the user see all problems.
  const validatedOps: ShapeOp[] = []
  for (let i = 0; i < rawOps.length; i++) {
    const parsed = ShapeOpSchema.safeParse(rawOps[i])
    if (!parsed.success) {
      errors.push({
        code: 'INVALID_OP',
        message: `Op #${i}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
      })
      continue
    }
    validatedOps.push(parsed.data)
  }

  if (validatedOps.length === 0) {
    if (replayKey) useCanvasShapeStore.getState().recordRendererReplayKey(replayKey)
    return { ok: errors.length === 0, affectedIds: [], errors }
  }

  useCanvasUndoStore.getState().withGroup(label, () => {
    for (const op of validatedOps) {
      executeOne(op, affectedIds, errors, options)
    }
    const selectedAfter = options?.selectAfter?.(Array.from(affectedIds))
    if (selectedAfter) {
      useCanvasSelectionStore.getState().select(
        selectedAfter.filter((id) => Boolean(useCanvasShapeStore.getState().document.objects[id]))
      )
    }
  })

  const operations = validatedOps.map((op, index) => {
    const operation = shapeOpToDesignOperation(op, label)
    if (replayKey) operation.id = canvasReplayOperationId(replayKey, index)
    return operation
  })
  const journalEntry = appendDesignOperationJournalEntry({
    label,
    status: errors.length === 0 ? 'applied' : 'partial',
    operations,
    affectedIds: Array.from(affectedIds),
    errors: errors.map((error) => ({ ...error }))
  })
  useCanvasShapeStore.getState().appendOperationJournalEntry(journalEntry)
  if (replayKey) useCanvasShapeStore.getState().recordRendererReplayKey(replayKey)

  return {
    ok: errors.length === 0,
    affectedIds: Array.from(affectedIds),
    errors
  }
}
