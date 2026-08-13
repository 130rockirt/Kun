import { rendererRuntimeClient } from '../../agent/runtime-client'
import type { OpError } from './shape-ops'

/**
 * Two-phase design tool receipt: after a canvas turn is applied, tell the
 * Kun loop whether the renderer actually applied (or rejected) the design
 * operations so the model sees the real outcome on its next request.
 *
 * The loop waits for this receipt (up to CANVAS_RECEIPT_TIMEOUT_MS) and
 * finalizes the accepted tool result as applied/failed, or `unverified` on
 * timeout. Fire-and-forget: a missing bridge or failed POST is non-fatal.
 */
export function sendCanvasTurnReceipt(input: {
  threadId: string
  turnId: string
  affectedIds: readonly string[]
  errors: readonly OpError[]
}): void {
  const { threadId, turnId } = input
  if (!threadId || !turnId) return
  const affectedIds = [...input.affectedIds]
  const errors = [...input.errors]
  if (affectedIds.length === 0 && errors.length === 0) return
  // Test/headless environments do not expose the preload bridge.
  if (typeof window === 'undefined' || !window.kunGui) return
  void rendererRuntimeClient.runtimeRequest(
    `/v1/threads/${encodeURIComponent(threadId)}/canvas-receipts`,
    'POST',
    JSON.stringify({
      turnId,
      status: errors.length > 0 ? 'failed' : 'applied',
      ...(errors.length > 0 ? { errors } : {}),
      ...(affectedIds.length > 0 ? { affectedIds } : {})
    })
  ).catch(() => undefined)
}
