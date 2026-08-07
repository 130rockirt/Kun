/**
 * Process-local cancellation handles for foreground tool executions.
 *
 * A turn owns the parent abort signal. Each tool gets a child signal so a
 * user can stop one tool while the rest of the model step continues. The
 * registry is intentionally independent from AgentLoop instances because
 * model/provider hot reload replaces the loop while active executions may
 * still belong to the previous instance.
 */

export const TOOL_CANCELLED_BY_USER_CODE = 'tool_cancelled_by_user'

export class ToolExecutionCancelledError extends Error {
  readonly code = TOOL_CANCELLED_BY_USER_CODE

  constructor() {
    super('Tool execution was stopped by the user.')
    this.name = 'ToolExecutionCancelledError'
  }
}

export type ToolCancellationKey = {
  threadId: string
  turnId: string
  callId: string
}

type ActiveToolCancellation = ToolCancellationKey & {
  controller: AbortController
  requestedAt?: string
  detachParent: () => void
}

export type ToolCancellationRegistration = {
  signal: AbortSignal
  wasCancelledByUser: () => boolean
  dispose: () => void
}

export type ToolCancellationRequestStatus =
  | 'cancellation_requested'
  | 'already_requested'
  | 'not_found'
  | 'turn_aborted'

function keyFor(input: ToolCancellationKey): string {
  return `${input.threadId}\u0000${input.turnId}\u0000${input.callId}`
}

function isUserCancellationReason(reason: unknown): boolean {
  return reason instanceof ToolExecutionCancelledError ||
    (reason instanceof Error && reason.name === 'ToolExecutionCancelledError')
}

export class ToolCancellationRegistry {
  private readonly active = new Map<string, ActiveToolCancellation>()

  register(
    input: ToolCancellationKey,
    parentSignal: AbortSignal
  ): ToolCancellationRegistration {
    const controller = new AbortController()
    const key = keyFor(input)
    const onParentAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(parentSignal.reason)
    }
    parentSignal.addEventListener('abort', onParentAbort, { once: true })

    const entry: ActiveToolCancellation = {
      ...input,
      controller,
      detachParent: () => parentSignal.removeEventListener('abort', onParentAbort)
    }
    this.active.set(key, entry)
    if (parentSignal.aborted) onParentAbort()

    let disposed = false
    return {
      signal: controller.signal,
      wasCancelledByUser: () => isUserCancellationReason(controller.signal.reason),
      dispose: () => {
        if (disposed) return
        disposed = true
        entry.detachParent()
        if (this.active.get(key) === entry) this.active.delete(key)
      }
    }
  }

  request(input: ToolCancellationKey, requestedAt: string): ToolCancellationRequestStatus {
    const entry = this.active.get(keyFor(input))
    if (!entry) return 'not_found'
    if (entry.requestedAt) return 'already_requested'
    if (entry.controller.signal.aborted) return 'turn_aborted'
    entry.requestedAt = requestedAt
    entry.controller.abort(new ToolExecutionCancelledError())
    return 'cancellation_requested'
  }

  has(input: ToolCancellationKey): boolean {
    return this.active.has(keyFor(input))
  }

  list(): ToolCancellationKey[] {
    return [...this.active.values()].map(({ threadId, turnId, callId }) => ({
      threadId,
      turnId,
      callId
    }))
  }
}
