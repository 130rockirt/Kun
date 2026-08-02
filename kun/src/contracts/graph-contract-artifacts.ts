import { z } from 'zod'
import { GraphBoundedSummarySchema, GraphIdentifierSchema, GraphTimestampSchema } from './graph-contract-primitives.js'

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const GraphArtifactReferenceV1Schema = z.object({
  version: z.literal(1), artifactId: GraphIdentifierSchema, contentHash: Sha256,
  mimeType: z.string().trim().min(1).max(256), byteLength: z.number().int().nonnegative(),
  summary: GraphBoundedSummarySchema, logicalNames: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
  producerNodeId: GraphIdentifierSchema.optional(), producerAttemptId: GraphIdentifierSchema.optional(),
  visibility: z.enum(['run', 'dependency', 'lead', 'user']),
  retention: z.enum(['run', 'thread', 'project', 'pinned']).default('run'), createdAt: GraphTimestampSchema
}).strict()
export type GraphArtifactReferenceV1 = z.infer<typeof GraphArtifactReferenceV1Schema>

export const GraphCheckResultV1Schema = z.object({
  name: z.string().trim().min(1).max(256), status: z.enum(['passed', 'failed', 'skipped', 'not_run']),
  summary: GraphBoundedSummarySchema, artifactRefs: z.array(GraphArtifactReferenceV1Schema).max(32).default([])
}).strict()
export type GraphCheckResultV1 = z.infer<typeof GraphCheckResultV1Schema>

export const GraphVerifiedCheckResultV1Schema = GraphCheckResultV1Schema.extend({
  command: z.array(z.string().min(1).max(4_096)).min(1).max(64), exitCode: z.number().int().nullable(),
  workspaceRevision: z.string().max(256), outputSummary: GraphBoundedSummarySchema
}).strict()
export type GraphVerifiedCheckResultV1 = z.infer<typeof GraphVerifiedCheckResultV1Schema>
