import { z } from 'zod'
import {
  GRAPH_CONTRACT_VERSION,
  GraphIdentifierSchema,
  GraphRunIdSchema,
  GraphTimestampSchema
} from './graph-core.js'

export const GRAPH_PLANNING_CONTRACT_VERSION = 1 as const

export const GraphPlanningEventTypeSchema = z.enum([
  'draft_created',
  'inspection_started',
  'validation_started',
  'repair_requested',
  'needs_correction',
  'run_committed',
  'draft_cancelled',
  'host_error'
])
export type GraphPlanningEventType = z.infer<typeof GraphPlanningEventTypeSchema>

export const GraphPlanningDraftStatusSchema = z.enum([
  'planning',
  'validating',
  'repairing',
  'needs_correction',
  'committing',
  'committed',
  'cancelled',
  'host_error'
])
export type GraphPlanningDraftStatus = z.infer<typeof GraphPlanningDraftStatusSchema>

export const GraphPlanningIssueV1Schema = z.object({
  code: z.string().trim().min(1).max(128),
  path: z.array(z.union([
    z.string().max(256),
    z.number().int().nonnegative()
  ])).max(32).default([]),
  message: z.string().trim().min(1).max(2_048),
  repairHint: z.string().trim().min(1).max(2_048),
  validExample: z.unknown().optional()
}).strict()
export type GraphPlanningIssueV1 = z.infer<typeof GraphPlanningIssueV1Schema>

export const GraphPlanningDraftV1Schema = z.object({
  version: z.literal(GRAPH_PLANNING_CONTRACT_VERSION),
  id: GraphIdentifierSchema,
  reservedRunId: GraphRunIdSchema,
  threadId: GraphIdentifierSchema,
  sourceTurnId: GraphIdentifierSchema,
  projectId: GraphIdentifierSchema,
  goal: z.string().trim().min(1).max(32_768),
  revision: z.number().int().positive(),
  status: GraphPlanningDraftStatusSchema,
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  issues: z.array(GraphPlanningIssueV1Schema).max(64).default([]),
  repairCount: z.number().int().nonnegative().max(1),
  createdAt: GraphTimestampSchema,
  updatedAt: GraphTimestampSchema,
  committedRunId: GraphRunIdSchema.optional()
}).strict()
export type GraphPlanningDraftV1 = z.infer<typeof GraphPlanningDraftV1Schema>

export const GraphPlanningTaskSummaryV1Schema = z.object({
  key: GraphIdentifierSchema,
  kind: z.enum(['work', 'review', 'integration', 'loop_gate']),
  title: z.string().trim().min(1).max(256)
}).strict()
export type GraphPlanningTaskSummaryV1 = z.infer<typeof GraphPlanningTaskSummaryV1Schema>

export const GraphPlanningDraftViewV1Schema = z.object({
  draft: GraphPlanningDraftV1Schema,
  tasks: z.array(GraphPlanningTaskSummaryV1Schema).max(10_000).default([])
}).strict()
export type GraphPlanningDraftViewV1 = z.infer<typeof GraphPlanningDraftViewV1Schema>

export const GraphPlanningLifecycleEventV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  event: GraphPlanningEventTypeSchema,
  draftId: GraphIdentifierSchema,
  reservedRunId: GraphRunIdSchema,
  sourceTurnId: GraphIdentifierSchema,
  revision: z.number().int().positive(),
  state: GraphPlanningDraftStatusSchema,
  issues: z.array(GraphPlanningIssueV1Schema).max(64).default([]),
  tasks: z.array(GraphPlanningTaskSummaryV1Schema).max(10_000).default([]),
  committedRunId: GraphRunIdSchema.optional()
}).strict()
export type GraphPlanningLifecycleEventV1 =
  z.infer<typeof GraphPlanningLifecycleEventV1Schema>
