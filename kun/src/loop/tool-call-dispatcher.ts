import type { ToolCallLike, ToolHostContext } from '../ports/tool-host.js'
import type { ToolDispatchInput, ToolDispatchOutcome } from './turn-execution-types.js'
import { collectParallelToolDispatchCandidates } from './tool-dispatch-policy.js'
import type { ToolStormBreaker } from './tool-storm-breaker.js'
import type { ToolExecutionService } from './tool-execution-service.js'

export type ToolCallDispatcherInput = {
  dispatch: ToolDispatchInput
  context: ToolHostContext
  stormBreaker?: Pick<ToolStormBreaker, 'inspect'>
  onToolExecuted?: (toolName: string) => void
}

/**
 * Ordered dispatcher for model-ready tool calls. It never emits tool_call
 * records itself: the model round has already persisted those before calling
 * into this boundary. Execution and result persistence live in
 * ToolExecutionService so this class can focus on batching and ordering.
 */
export class ToolCallDispatcher {
  constructor(
    private readonly toolExecution: Pick<
      ToolExecutionService,
      'executeSafely' | 'persistResult' | 'persistSuppressed'
    >
  ) {}

  async suppressAll(dispatch: ToolDispatchInput, reason: string): Promise<void> {
    for (const call of dispatch.calls) {
      await this.toolExecution.persistSuppressed({
        threadId: dispatch.threadId,
        turnId: dispatch.turnId,
        call,
        reason
      })
    }
  }

  async dispatch(input: ToolCallDispatcherInput): Promise<ToolDispatchOutcome> {
    const { dispatch } = input
    let index = 0
    let executedAny = false

    while (index < dispatch.calls.length) {
      if (dispatch.signal.aborted) return 'aborted'
      const call = dispatch.calls[index]
      if (!call) break

      const storm = input.stormBreaker?.inspect(call)
      if (storm?.suppress) {
        await this.toolExecution.persistSuppressed({
          threadId: dispatch.threadId,
          turnId: dispatch.turnId,
          call,
          reason: storm.reason
        })
        index += 1
        continue
      }

      const parallelCandidates = collectParallelToolDispatchCandidates({
        calls: dispatch.calls,
        startIndex: index,
        policy: {
          approvalPolicy: dispatch.approvalPolicy,
          toolProviderKinds: dispatch.toolProviderKinds
        }
      })
      if (!parallelCandidates) {
        const context = contextForSourceCalls(input.context, [call])
        const result = await this.toolExecution.executeSafely({
          threadId: dispatch.threadId,
          turnId: dispatch.turnId,
          call,
          context
        })
        executedAny = true
        input.onToolExecuted?.(call.toolName)
        await this.toolExecution.persistResult(dispatch.threadId, dispatch.turnId, call, result)
        index += 1
        continue
      }

      const batch: ToolCallLike[] = [call]
      index += 1
      let suppressedAfterBatch: { call: ToolCallLike; reason?: string } | undefined
      for (const next of parallelCandidates.calls.slice(1)) {
        const nextStorm = input.stormBreaker?.inspect(next)
        if (nextStorm?.suppress) {
          suppressedAfterBatch = { call: next, reason: nextStorm.reason }
          index += 1
          break
        }
        batch.push(next)
        index += 1
      }

      const settled = await Promise.allSettled(
        batch.map((entry) => this.toolExecution.executeSafely({
          threadId: dispatch.threadId,
          turnId: dispatch.turnId,
          call: entry,
          context: contextForSourceCalls(input.context, batch)
        }))
      )
      executedAny = true
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
        const result = settled[batchIndex]
        const batchCall = batch[batchIndex]
        if (!result || !batchCall) continue
        if (result.status === 'rejected') throw result.reason
        input.onToolExecuted?.(batchCall.toolName)
        await this.toolExecution.persistResult(dispatch.threadId, dispatch.turnId, batchCall, result.value)
      }

      if (suppressedAfterBatch) {
        await this.toolExecution.persistSuppressed({
          threadId: dispatch.threadId,
          turnId: dispatch.turnId,
          call: suppressedAfterBatch.call,
          reason: suppressedAfterBatch.reason
        })
      }
    }

    return executedAny ? 'continue' : 'all_suppressed'
  }
}

const SOURCE_TOOL_NAMES = new Set(['read', 'grep', 'glob', 'find'])

function contextForSourceCalls(context: ToolHostContext, calls: readonly ToolCallLike[]): ToolHostContext {
  const sourceCalls = calls.filter((call) => SOURCE_TOOL_NAMES.has(call.toolName))
  if (!context.sourceResultBudgetTokens || sourceCalls.length === 0) return context
  return {
    ...context,
    sourceResultBudgetTokens: Math.max(1, Math.floor(context.sourceResultBudgetTokens / sourceCalls.length))
  }
}
