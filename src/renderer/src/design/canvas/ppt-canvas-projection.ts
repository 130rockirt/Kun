import {
  isPptDirectionBundle,
  pptDirectionBoardOps,
  pptDirectionCleanupOps,
  type PptDirectionBundle
} from './ppt-direction-board'
import { isPptReviewBundle, pptReviewBoardOps, type PptReviewBundle } from './ppt-review-board'
import { applyCanvasOpBlocks } from './apply-shape-ops'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { useDesignAssistantStore } from '../design-assistant-store'
import { useChatStore } from '../../store/chat-store'
import { requestCodeCanvasPanelOpen } from '../../lib/code-canvas-panel-event'
import type { ExecuteOpsOptions, OpError } from './shape-ops'

export type PptCanvasProjectionOpenRequest = {
  blockId: string
  childId: string
  workflowId: string
  phase: 'direction' | 'review'
}

export type PptCanvasProjectionOptions = {
  /** Restricts this canvas document to one canonical PPT workflow. */
  workflowId?: string
  /** Work surfaces keep their own central whiteboard open instead of opening Code's panel. */
  onOpenRequested?: (request: PptCanvasProjectionOpenRequest) => void
}

export type PptCanvasProjection =
  | { kind: 'direction'; bundle: PptDirectionBundle }
  | { kind: 'review'; bundle: PptReviewBundle }
  | { kind: 'filtered' }

export function resolvePptCanvasProjection(
  toolName: string | undefined,
  value: unknown,
  expectedWorkflowId?: string
): PptCanvasProjection | null {
  if (toolName !== 'ppt_agent' || !isRecord(value)) return null
  const reviewBundle = value.reviewBundle
  const directionBundle = value.directionBundle
  const projection: Exclude<PptCanvasProjection, { kind: 'filtered' }> | null =
    isPptReviewBundle(reviewBundle)
      ? { kind: 'review', bundle: reviewBundle }
      : isPptDirectionBundle(directionBundle)
        ? { kind: 'direction', bundle: directionBundle }
        : null
  if (!projection) return null
  return expectedWorkflowId && projection.bundle.workflowId !== expectedWorkflowId
    ? { kind: 'filtered' }
    : projection
}

export function projectPptCanvasBundle(input: {
  blockId: string
  projection: Exclude<PptCanvasProjection, { kind: 'filtered' }>
  targetThreadId?: string | null
  executeOptions?: ExecuteOpsOptions
  affectedThisTurn: Set<string>
  errorsThisTurn: OpError[]
  onOpenRequested?: (request: PptCanvasProjectionOpenRequest) => void
}): boolean {
  const { bundle, kind } = input.projection
  const canvasShapes = Object.values(useCanvasShapeStore.getState().document.objects)
  const parentThreadId = input.targetThreadId ?? useChatStore.getState().activeThreadId ?? undefined
  const boardOps = kind === 'review'
    ? [
        ...pptDirectionCleanupOps(bundle.workflowId, bundle.childId, canvasShapes),
        ...pptReviewBoardOps(bundle, canvasShapes, parentThreadId)
      ]
    : pptDirectionBoardOps(bundle, canvasShapes, parentThreadId)
  const { affectedIds, errors } = applyCanvasOpBlocks(
    [boardOps], `ppt-${kind}:${input.blockId}`, input.executeOptions)
  if (errors.length > 0) input.errorsThisTurn.push(...errors)
  if (affectedIds.length === 0) return false
  for (const id of affectedIds) input.affectedThisTurn.add(id)
  if (kind === 'direction') useCanvasSelectionStore.getState().clearSelection()
  else useCanvasSelectionStore.getState().select([...input.affectedThisTurn])
  useDesignAssistantStore.getState().markAiAffected(affectedIds)
  const openRequest = {
    blockId: input.blockId,
    childId: bundle.childId,
    workflowId: bundle.workflowId,
    phase: kind
  }
  if (input.onOpenRequested) input.onOpenRequested(openRequest)
  else requestCodeCanvasPanelOpen()
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
