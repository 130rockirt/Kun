import { z } from 'zod'

export const GraphOrchestrationStrategySchema = z.enum(['direct', 'graph'])
export type GraphOrchestrationStrategy = z.infer<typeof GraphOrchestrationStrategySchema>

export const GraphExecutionStrategyKindSchema = z.enum([
  'fanout_join',
  'pipeline',
  'bounded_loop',
  'state_machine',
  'hybrid'
])
export type GraphExecutionStrategyKind = z.infer<typeof GraphExecutionStrategyKindSchema>

export const GraphExecutionStrategyV1Schema = z.object({
  kind: GraphExecutionStrategyKindSchema,
  selectedBy: z.enum(['lead', 'user', 'host']),
  rationale: z.string().trim().min(1).max(2_048).optional()
}).strict()
export type GraphExecutionStrategyV1 = z.infer<typeof GraphExecutionStrategyV1Schema>

export const GraphRunStatusSchema = z.enum([
  'draft',
  'validating',
  'ready',
  'running',
  'pausing',
  'paused',
  'awaiting_supervision',
  'awaiting_human',
  'completing',
  'completed',
  'failed',
  'cancelled'
])
export type GraphRunStatus = z.infer<typeof GraphRunStatusSchema>

export const GraphNodeStatusSchema = z.enum([
  'pending',
  'blocked',
  'ready',
  'queued',
  'running',
  'submitted',
  'reviewing',
  'accepted',
  'repair_required',
  'failed',
  'cancelled',
  'skipped',
  'superseded'
])
export type GraphNodeStatus = z.infer<typeof GraphNodeStatusSchema>

export const GraphAttemptStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'submitted',
  'reviewing',
  'accepted',
  'repair_required',
  'failed',
  'interrupted',
  'cancelled',
  'orphaned'
])
export type GraphAttemptStatus = z.infer<typeof GraphAttemptStatusSchema>

export const GraphReviewOutcomeSchema = z.enum([
  'pass',
  'fail',
  'revise',
  'needs_human'
])
export type GraphReviewOutcome = z.infer<typeof GraphReviewOutcomeSchema>

export const GraphRiskClassSchema = z.enum(['low', 'medium', 'high', 'critical'])
export type GraphRiskClass = z.infer<typeof GraphRiskClassSchema>
