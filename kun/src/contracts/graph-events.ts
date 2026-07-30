import { z } from 'zod'
import {
  GRAPH_CONTRACT_VERSION,
  GRAPH_EVENT_VERSION,
  GraphArtifactReferenceV1Schema,
  GraphAttemptIdSchema,
  GraphBoundedSummarySchema,
  GraphBudgetLedgerV1Schema,
  GraphCleanupRecordV1Schema,
  GraphCommandIdSchema,
  GraphIdempotencyKeySchema,
  GraphIdentifierSchema,
  GraphMessageIdSchema,
  GraphMessageV1Schema,
  GraphNodeAttemptV1Schema,
  GraphNodeIdSchema,
  GraphPatchV1Schema,
  GraphPlanV1Schema,
  GraphProgressUpdateV1Schema,
  GraphReviewResultV1Schema,
  GraphRunIdSchema,
  GraphRunSummaryV1Schema,
  GraphRunV1Schema,
  GraphSteeringV1Schema,
  GraphTimestampSchema,
  GraphValidationResultV1Schema,
  GraphWorkerResultV1Schema
} from './graph-core.js'
import {
  GraphAttemptStatusSchema,
  GraphNodeStatusSchema,
  GraphRunStatusSchema
} from './graph-status.js'

const GraphRunCreatedEventPayload = z.object({
  plan: GraphPlanV1Schema,
  projectId: GraphIdentifierSchema,
  sourceTurnId: GraphIdentifierSchema
}).strict()
const GraphPlanValidatedEventPayload = z.object({
  revision: z.number().int().positive(),
  validation: GraphValidationResultV1Schema
}).strict()
const GraphRunStatusEventPayload = z.object({
  from: GraphRunStatusSchema,
  to: GraphRunStatusSchema,
  reason: GraphBoundedSummarySchema.optional()
}).strict()
const GraphPlanRevisedEventPayload = z.object({
  patch: GraphPatchV1Schema,
  plan: GraphPlanV1Schema,
  supersededNodeIds: z.array(GraphNodeIdSchema).default([])
}).strict()
const GraphNodeStatusEventPayload = z.object({
  nodeId: GraphNodeIdSchema,
  from: GraphNodeStatusSchema,
  to: GraphNodeStatusSchema,
  reason: GraphBoundedSummarySchema.optional()
}).strict()
const GraphLoopIterationEventPayload = z.object({
  gateNodeId: GraphNodeIdSchema,
  continueTargetNodeId: GraphNodeIdSchema,
  resetNodeIds: z.array(GraphNodeIdSchema).min(1).max(10_000),
  iteration: z.number().int().positive()
}).strict()
const GraphAttemptCreatedEventPayload = z.object({
  attempt: GraphNodeAttemptV1Schema
}).strict()
const GraphAttemptStatusEventPayload = z.object({
  nodeId: GraphNodeIdSchema,
  attemptId: GraphAttemptIdSchema,
  from: GraphAttemptStatusSchema,
  to: GraphAttemptStatusSchema,
  childThreadId: GraphIdentifierSchema.optional(),
  childTurnId: GraphIdentifierSchema.optional(),
  failureClass: GraphNodeAttemptV1Schema.shape.failureClass,
  normalizedFailure: z.string().max(512).optional()
}).strict()
const GraphProgressEventPayload = z.object({
  progress: GraphProgressUpdateV1Schema
}).strict()
const GraphResultSubmittedEventPayload = z.object({
  nodeId: GraphNodeIdSchema,
  attemptId: GraphAttemptIdSchema,
  result: GraphWorkerResultV1Schema,
  validation: GraphValidationResultV1Schema,
  tokenUsage: z.number().int().nonnegative().default(0),
  elapsedMs: z.number().int().nonnegative().default(0)
}).strict()
const GraphReviewRecordedEventPayload = z.object({
  review: GraphReviewResultV1Schema
}).strict()
const GraphMessageEventPayload = z.object({
  message: GraphMessageV1Schema
}).strict()
const GraphMessageStatusEventPayload = z.object({
  messageId: GraphMessageIdSchema,
  status: GraphMessageV1Schema.shape.status,
  acknowledgedAt: GraphTimestampSchema.optional()
}).strict()
const GraphArtifactEventPayload = z.object({
  artifact: GraphArtifactReferenceV1Schema,
  consumerNodeIds: z.array(GraphNodeIdSchema).max(1_000).default([])
}).strict()
const GraphBudgetEventPayload = z.object({
  ledger: GraphBudgetLedgerV1Schema,
  reason: GraphBoundedSummarySchema.optional()
}).strict()
const GraphSteeringEventPayload = z.object({
  steering: GraphSteeringV1Schema
}).strict()
const GraphSteeringStatusEventPayload = z.object({
  steeringId: GraphIdentifierSchema,
  from: GraphSteeringV1Schema.shape.status,
  to: GraphSteeringV1Schema.shape.status
}).strict()
const GraphCleanupEventPayload = z.object({
  cleanup: GraphCleanupRecordV1Schema
}).strict()
const GraphSupervisionEventPayload = z.object({
  signalId: GraphIdentifierSchema,
  reason: z.enum([
    'submitted',
    'failure',
    'stall',
    'conflict',
    'budget',
    'help',
    'recovery',
    'completion',
    'user_steering',
    'worker_report'
  ]),
  nodeIds: z.array(GraphNodeIdSchema).max(1_000).default([]),
  digest: GraphBoundedSummarySchema
}).strict()
const GraphRunSummaryEventPayload = z.object({
  summary: GraphRunSummaryV1Schema
}).strict()
const GraphPayloadExternalizedEventPayload = z.object({
  originalType: z.string().trim().min(1).max(128),
  summary: GraphBoundedSummarySchema,
  artifact: GraphArtifactReferenceV1Schema
}).strict()

export const GraphDomainEventV1Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_created'), payload: GraphRunCreatedEventPayload }).strict(),
  z.object({ type: z.literal('plan_validated'), payload: GraphPlanValidatedEventPayload }).strict(),
  z.object({ type: z.literal('run_status_changed'), payload: GraphRunStatusEventPayload }).strict(),
  z.object({ type: z.literal('plan_revised'), payload: GraphPlanRevisedEventPayload }).strict(),
  z.object({ type: z.literal('node_status_changed'), payload: GraphNodeStatusEventPayload }).strict(),
  z.object({ type: z.literal('loop_iteration_advanced'), payload: GraphLoopIterationEventPayload }).strict(),
  z.object({ type: z.literal('attempt_created'), payload: GraphAttemptCreatedEventPayload }).strict(),
  z.object({ type: z.literal('attempt_status_changed'), payload: GraphAttemptStatusEventPayload }).strict(),
  z.object({ type: z.literal('progress_reported'), payload: GraphProgressEventPayload }).strict(),
  z.object({ type: z.literal('result_submitted'), payload: GraphResultSubmittedEventPayload }).strict(),
  z.object({ type: z.literal('review_recorded'), payload: GraphReviewRecordedEventPayload }).strict(),
  z.object({ type: z.literal('message_created'), payload: GraphMessageEventPayload }).strict(),
  z.object({ type: z.literal('message_status_changed'), payload: GraphMessageStatusEventPayload }).strict(),
  z.object({ type: z.literal('artifact_published'), payload: GraphArtifactEventPayload }).strict(),
  z.object({ type: z.literal('budget_updated'), payload: GraphBudgetEventPayload }).strict(),
  z.object({ type: z.literal('budget_warning'), payload: GraphBudgetEventPayload }).strict(),
  z.object({ type: z.literal('steering_recorded'), payload: GraphSteeringEventPayload }).strict(),
  z.object({ type: z.literal('steering_status_changed'), payload: GraphSteeringStatusEventPayload }).strict(),
  z.object({ type: z.literal('cleanup_updated'), payload: GraphCleanupEventPayload }).strict(),
  z.object({ type: z.literal('supervision_requested'), payload: GraphSupervisionEventPayload }).strict(),
  z.object({ type: z.literal('run_summary_recorded'), payload: GraphRunSummaryEventPayload }).strict(),
  z.object({ type: z.literal('payload_externalized'), payload: GraphPayloadExternalizedEventPayload }).strict()
])
export type GraphDomainEventV1 = z.infer<typeof GraphDomainEventV1Schema>

export const GraphEventEnvelopeV1Schema = z.object({
  version: z.literal(GRAPH_EVENT_VERSION),
  eventId: GraphIdentifierSchema,
  runId: GraphRunIdSchema,
  threadId: GraphIdentifierSchema,
  graphSeq: z.number().int().positive(),
  graphRevision: z.number().int().positive(),
  timestamp: GraphTimestampSchema,
  commandId: GraphCommandIdSchema.optional(),
  idempotencyKey: GraphIdempotencyKeySchema.optional(),
  event: GraphDomainEventV1Schema
}).strict()
export type GraphEventEnvelopeV1 = z.infer<typeof GraphEventEnvelopeV1Schema>

export const GraphCommandResultV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  commandId: GraphCommandIdSchema,
  applied: z.boolean(),
  duplicate: z.boolean().default(false),
  run: GraphRunV1Schema,
  validation: GraphValidationResultV1Schema.optional()
}).strict()
export type GraphCommandResultV1 = z.infer<typeof GraphCommandResultV1Schema>
