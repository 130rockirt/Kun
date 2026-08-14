import { makeErrorItem } from '../domain/item.js'
import type { ModelStepServiceDeps } from './model-step-service-types.js'

export async function failRequiredToolConstraint(
  deps: ModelStepServiceDeps,
  input: {
    threadId: string
    turnId: string
    code: 'required_tool_unavailable' | 'required_tool_unsupported'
    message: string
  }
): Promise<'failed'> {
  deps.rememberFailure(input.turnId, {
    error: input.message, code: input.code, severity: 'error'
  })
  await deps.events.record({
    kind: 'error',
    threadId: input.threadId,
    turnId: input.turnId,
    message: input.message,
    code: input.code,
    severity: 'error'
  })
  await deps.turns.applyItem(input.threadId, makeErrorItem({
    id: deps.ids.next('item_error'),
    threadId: input.threadId,
    turnId: input.turnId,
    message: input.message,
    code: input.code,
    severity: 'error'
  }))
  return 'failed'
}
