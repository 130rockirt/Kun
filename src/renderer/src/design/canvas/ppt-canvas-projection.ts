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
import type { CanvasShape } from './canvas-types'
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
  /** Work boards also bind the workflow to its originating child identity. */
  childId?: string
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
  expectedWorkflowId?: string,
  expectedChildId?: string
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
  return (expectedWorkflowId && projection.bundle.workflowId !== expectedWorkflowId) ||
    (expectedChildId && projection.bundle.childId !== expectedChildId)
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
  // Tool-result replay is not guaranteed to arrive in phase or revision order
  // after a reconnect/remount. Direction and slide revisions are independent
  // counters, so compare reviews only with reviews. Once a review exists, a
  // direction is necessarily an earlier workflow phase and must never replace
  // the slide board. Equal review revisions remain replayable for Code canvas
  // recovery; only strictly older reviews are rejected.
  if (shouldRejectPptProjection(bundle, kind, canvasShapes)) {
    return false
  }
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

function shouldRejectPptProjection(
  bundle: PptDirectionBundle | PptReviewBundle,
  kind: 'direction' | 'review',
  shapes: readonly CanvasShape[]
): boolean {
  const workflowRefs = shapes.flatMap((shape) => {
    const ref = shape.pptReviewRef ?? shape.pptDirectionRef
    return ref?.workflowId === bundle.workflowId ? [ref] : []
  })
  // A workflow has one child identity. Letting a delayed result from another
  // child update name-stable shapes would rewrite the current board before the
  // direction/review serializers can fail closed.
  if (workflowRefs.some((ref) => ref.childId !== bundle.childId)) return true

  const reviewRefs = workflowRefs.filter((ref) => 'slideId' in ref)
  if (kind === 'direction') {
    // Direction and slide revisions are independent counters. A review is a
    // later phase, but directions within their own phase still need a revision
    // high-water mark so an old SSE replay cannot replace a newer selection.
    if (reviewRefs.length > 0) return true
    const incomingRevision = Math.max(...(bundle as PptDirectionBundle).directions.map((direction) => direction.revision))
    const currentRevision = Math.max(-1, ...workflowRefs.map((ref) => ref.revision))
    return incomingRevision < currentRevision
  }

  const incomingRevision = Math.max(...(bundle as PptReviewBundle).slides.map((slide) => slide.revision))
  const currentRevision = Math.max(-1, ...reviewRefs.map((ref) => ref.revision))
  return incomingRevision < currentRevision
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
