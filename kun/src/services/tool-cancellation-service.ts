import type { ToolCallTurnItem } from '../contracts/items.js'
import type { TurnService } from './turn-service.js'
import {
  ToolCancellationRegistry,
  type ToolCancellationRequestStatus
} from '../loop/tool-cancellation-registry.js'

export type ToolCancellationServiceResult = {
  threadId: string
  turnId: string
  callId: string
  status: Extract<ToolCancellationRequestStatus, 'cancellation_requested' | 'already_requested'>
}

/** Coordinates durable request state with the process-local tool signal. */
export class ToolCancellationService {
  constructor(
    private readonly turns: Pick<TurnService, 'getTurn' | 'updateItem'>,
    private readonly registry: ToolCancellationRegistry,
    private readonly nowIso: () => string
  ) {}

  async cancel(input: {
    threadId: string
    turnId: string
    callId: string
  }): Promise<ToolCancellationServiceResult> {
    const turn = await this.turns.getTurn(input.threadId, input.turnId)
    if (!turn) throw new Error(`turn not found: ${input.turnId}`)
    if (turn.status !== 'queued' && turn.status !== 'running') {
      throw new Error(`turn is no longer active: ${input.turnId}`)
    }
    const call = turn.items.find(
      (item): item is ToolCallTurnItem => item.kind === 'tool_call' && item.callId === input.callId
    )
    if (!call) throw new Error(`tool call not found: ${input.callId}`)

    const status = this.registry.request(input, this.nowIso())
    // The registry is process-local and removes a handle in `finally` as soon
    // as the tool settles. Keep a durable marker as the idempotency record so
    // a retry that races just after completion still reports success rather
    // than turning an already accepted cancellation into a 409.
    if (status === 'not_found' && call.cancelRequestedAt) {
      return { ...input, status: 'already_requested' }
    }
    if (status === 'not_found') {
      throw new Error(`tool call is not currently executing: ${input.callId}`)
    }
    if (status === 'turn_aborted') {
      throw new Error(`turn is already being interrupted: ${input.turnId}`)
    }

    if (!call.cancelRequestedAt) {
      await this.turns.updateItem(input.threadId, call.id, {
        cancelRequestedAt: this.nowIso()
      })
    }
    return {
      ...input,
      status
    }
  }
}
