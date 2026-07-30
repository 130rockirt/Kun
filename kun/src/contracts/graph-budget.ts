import { z } from 'zod'

export const GraphBudgetV1InputSchema = z.object({
  maxNodes: z.number().int().positive().max(10_000),
  maxEdges: z.number().int().positive().max(50_000),
  maxConcurrentNodes: z.number().int().positive().max(256),
  maxAttemptsPerNode: z.number().int().positive().max(20),
  maxRevisions: z.number().int().positive().max(128),
  maxLoopIterations: z.number().int().nonnegative().max(128),
  maxWallTimeMs: z.number().int().positive().max(30 * 24 * 60 * 60 * 1_000),
  maxNodeWallTimeMs: z.number().int().positive().max(24 * 60 * 60 * 1_000),
  maxTotalTokens: z.number().int().positive().max(1_000_000_000).optional(),
  maxMessages: z.number().int().nonnegative().max(100_000),
  maxArtifactBytes: z.number().int().nonnegative().max(100_000_000_000),
  warningRatio: z.number().positive().max(1)
}).strict()

export const GraphBudgetV1Schema = GraphBudgetV1InputSchema.transform((budget) => {
  const { maxTotalTokens, ...activeLimits } = budget
  void maxTotalTokens
  return activeLimits
})
export type GraphBudgetV1 = z.infer<typeof GraphBudgetV1Schema>

export const GraphBudgetLedgerV1Schema = z.object({
  version: z.literal(1),
  limits: GraphBudgetV1Schema,
  attempts: z.number().int().nonnegative(),
  revisions: z.number().int().nonnegative(),
  loopIterations: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  artifactBytes: z.number().int().nonnegative(),
  warningKinds: z.array(z.enum([
    'time', 'tokens', 'attempts', 'revisions', 'loops', 'messages', 'artifacts'
  ])).default([]).transform((kinds) =>
    kinds.filter((kind): kind is Exclude<(typeof kinds)[number], 'tokens'> => kind !== 'tokens')
  ),
  closed: z.boolean().default(false)
}).strict()
export type GraphBudgetLedgerV1 = z.infer<typeof GraphBudgetLedgerV1Schema>
