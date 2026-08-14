import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  INTERNAL_RUNTIME_CONTEXT_MAX_CHARS,
  type RuntimeContextSourceTurnItem
} from '../contracts/items.js'

export const InternalTurnRuntimeContext = z.object({
  kind: z.literal('host-control'),
  content: z.string().trim().min(1).max(INTERNAL_RUNTIME_CONTEXT_MAX_CHARS)
}).strict()
export type InternalTurnRuntimeContext = z.infer<typeof InternalTurnRuntimeContext>

/**
 * Create a private source consumed by model-step preparation. It is never
 * part of StartTurnRequest, a public Turn projection, or model history.
 */
export function makeInternalTurnRuntimeContextSource(input: {
  threadId: string
  turnId: string
  context: InternalTurnRuntimeContext
  createdAt: string
}): RuntimeContextSourceTurnItem {
  const context = InternalTurnRuntimeContext.parse(input.context)
  const contentDigest = createHash('sha256').update(context.content).digest('hex')
  return {
    id: `item_${input.turnId}_runtime_context_source_${contentDigest.slice(0, 16)}`,
    threadId: input.threadId,
    turnId: input.turnId,
    role: 'system',
    status: 'completed',
    createdAt: input.createdAt,
    finishedAt: input.createdAt,
    kind: 'runtime_context_source',
    contextKind: context.kind,
    content: context.content
  }
}
