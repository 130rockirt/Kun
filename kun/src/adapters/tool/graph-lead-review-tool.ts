import { z } from 'zod'
import {
  GRAPH_CONTRACT_VERSION,
  GraphArtifactReferenceV1Schema,
  GraphAttemptIdSchema,
  GraphNodeIdSchema,
  GraphReviewOutcomeSchema,
  GraphReviewResultV1Schema,
  GraphRunIdSchema,
  type GraphRunV1
} from '../../contracts/index.js'
import {
  graphPhysicalPathsEqual,
  graphReviewSemanticKey,
  type GraphControlService,
  type GraphRunStore,
  type ProjectAgentRegistry
} from '../../graph/index.js'
import { GRAPH_LEAD_TOOL_NAMES } from '../../graph/graph-tool-boundary.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'

const GraphLeadReviewInputSchema = z.object({
  runId: GraphRunIdSchema,
  nodeId: GraphNodeIdSchema,
  attemptId: GraphAttemptIdSchema.optional().describe(
    'Optional explicit attempt. Omit to review the latest submitted or reviewing attempt.'
  ),
  outcome: GraphReviewOutcomeSchema,
  summary: z.string().max(4_096),
  evidence: z.array(z.string().max(4_096)).max(128).default([]),
  artifactRefs: z.array(GraphArtifactReferenceV1Schema).max(64).default([]),
  repairInstructions: z.string().max(32_768).optional()
}).strict()

const GRAPH_LEAD_REVIEW_INPUT_JSON_SCHEMA = (() => {
  const schema = z.toJSONSchema(GraphLeadReviewInputSchema, {
    io: 'input',
    target: 'draft-07',
    reused: 'inline'
  }) as Record<string, unknown>
  delete schema.$schema
  return schema
})()

export function buildGraphLeadReviewTool(options: {
  control: GraphControlService
  store: GraphRunStore
  registry: ProjectAgentRegistry
  shouldAdvertise: (context: ToolHostContext) => boolean
  nowIso: () => string
  nextId: (prefix: string) => string
}): LocalTool {
  return LocalToolHost.defineTool({
    name: GRAPH_LEAD_TOOL_NAMES[4],
    description:
      'Record the source Lead decision for a submitted Graph node. Provide only the node, ' +
      'outcome (pass, fail, revise, or needs_human), summary, and optional evidence, artifact ' +
      'references, repair instructions, or explicit attempt id. Kun supplies review identity, ' +
      'Lead provenance, timestamps, the latest eligible attempt, and current CAS state.',
    inputSchema: GRAPH_LEAD_REVIEW_INPUT_JSON_SCHEMA,
    policy: 'auto',
    toolKind: 'tool_call',
    sideEffect: 'unknown',
    shouldAdvertise: options.shouldAdvertise,
    execute: async (args, context) => {
      try {
        const input = GraphLeadReviewInputSchema.parse(
          normalizeGraphLeadReviewInput(args)
        )
        const run = await authorizedLead(
          options.store,
          options.registry,
          input.runId,
          context
        )
        const node = run.nodes[input.nodeId]
        if (!node) throw new Error(`Graph node not found: ${input.nodeId}`)
        const attempt = input.attemptId
          ? node.attempts.find((candidate) => candidate.id === input.attemptId)
          : node.attempts.at(-1)
        if (!attempt) {
          throw new Error(`Graph node ${input.nodeId} has no attempt to review`)
        }
        const existingReview = run.reviews.find((candidate) =>
          candidate.nodeId === input.nodeId &&
          candidate.attemptId === attempt.id &&
          candidate.reviewerKind === 'lead')
        if (
          !existingReview &&
          (
            node.attempts.at(-1)?.id !== attempt.id ||
            !['submitted', 'reviewing'].includes(node.status) ||
            !['submitted', 'reviewing'].includes(attempt.status)
          )
        ) {
          throw new Error(`attempt ${attempt.id} is not a submitted result awaiting review`)
        }
        if (
          !existingReview &&
          input.outcome === 'pass' &&
          attempt.validation?.valid !== true
        ) {
          throw new Error(`cannot pass invalid attempt ${attempt.id}`)
        }
        const review = GraphReviewResultV1Schema.parse({
          version: GRAPH_CONTRACT_VERSION,
          reviewId: options.nextId('graph_review'),
          nodeId: input.nodeId,
          attemptId: attempt.id,
          reviewerKind: 'lead',
          outcome: input.outcome,
          summary: input.summary,
          evidence: input.evidence,
          artifactRefs: canonicalLeadReviewArtifactRefs(
            input.artifactRefs,
            attempt.result?.artifactRefs ?? []
          ),
          ...(input.repairInstructions
            ? { repairInstructions: input.repairInstructions }
            : {}),
          createdAt: options.nowIso()
        })
        return {
          output: await options.control.recordReview(input.runId, review, {
            commandId: options.nextId('graph_command'),
            idempotencyKey: graphReviewSemanticKey(input.runId, attempt.id, 'lead'),
            expectedRevision: run.currentRevision
          }, 'lead')
        }
      } catch (error) {
        return {
          output: { error: errorMessage(error) },
          isError: true
        }
      }
    }
  })
}

/**
 * Keep model-authored prose inside the durable review contract without
 * turning an otherwise valid Lead decision into a failed tool call. The tool
 * schema still advertises the exact limits; this is the host-side safety net
 * for providers that emit an oversized argument anyway.
 */
function normalizeGraphLeadReviewInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const input = value as Record<string, unknown>
  return {
    ...input,
    ...(typeof input.summary === 'string'
      ? { summary: input.summary.slice(0, 4_096) }
      : {}),
    ...(Array.isArray(input.evidence)
      ? {
          evidence: input.evidence
            .slice(0, 128)
            .map((entry) => typeof entry === 'string' ? entry.slice(0, 4_096) : entry)
        }
      : {}),
    ...(Array.isArray(input.artifactRefs)
      ? { artifactRefs: input.artifactRefs.slice(0, 64) }
      : {}),
    ...(typeof input.repairInstructions === 'string'
      ? { repairInstructions: input.repairInstructions.slice(0, 32_768) }
      : {})
  }
}

function canonicalLeadReviewArtifactRefs(
  requested: readonly z.infer<typeof GraphArtifactReferenceV1Schema>[],
  published: readonly z.infer<typeof GraphArtifactReferenceV1Schema>[]
): Array<z.infer<typeof GraphArtifactReferenceV1Schema>> {
  const publishedById = new Map(published.map((artifact) => [
    artifact.artifactId,
    artifact
  ]))
  const accepted = new Map<string, z.infer<typeof GraphArtifactReferenceV1Schema>>()
  for (const candidate of requested) {
    const artifact = publishedById.get(candidate.artifactId)
    if (!artifact || artifact.contentHash !== candidate.contentHash) continue
    accepted.set(artifact.artifactId, artifact)
  }
  return [...accepted.values()]
}

async function authorizedLead(
  store: GraphRunStore,
  registry: ProjectAgentRegistry,
  runId: string,
  context: ToolHostContext
): Promise<GraphRunV1> {
  const run = await store.get(runId)
  if (!run) throw new Error(`GraphRun not found: ${runId}`)
  if (run.threadId !== context.threadId || run.sourceTurnId !== context.turnId) {
    throw new Error('current Lead turn does not own this GraphRun')
  }
  const identity = await registry.identify(context.workspace)
  const planIdentity = await registry.identify(run.plans.at(-1)!.workspaceRoot)
  if (
    identity.projectId !== run.projectId ||
    identity.projectId !== planIdentity.projectId ||
    !graphPhysicalPathsEqual(
      identity.canonicalWorkspaceRoot,
      planIdentity.canonicalWorkspaceRoot
    )
  ) {
    throw new Error('current workspace does not own this GraphRun')
  }
  return run
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048)
}
