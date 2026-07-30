import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  GRAPH_CONTRACT_VERSION,
  GraphNodeIdSchema,
  GraphNodeV1Schema,
  GraphPatchOperationV1Schema,
  GraphPatchV1Schema,
  GraphRelativePathSchema,
  GraphRunIdSchema,
  type GraphPatchOperationV1,
  type GraphRunV1
} from '../../contracts/index.js'
import type { GraphRuntimeConfig } from '../../config/kun-config.js'
import {
  graphHostRelativePathCovers,
  graphPhysicalPathsEqual,
  type GraphControlService,
  type GraphRunStore,
  type ProjectAgentRegistry
} from '../../graph/index.js'
import {
  currentIterationAttemptCount,
  effectiveNodeMaxAttempts
} from '../../graph/graph-scheduler-policy.js'
import { GRAPH_LEAD_TOOL_NAMES } from '../../graph/graph-tool-boundary.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'

const GraphLeadSupersedeNodeOperationSchema = z.object({
  op: z.literal('supersede_node'),
  nodeId: GraphNodeIdSchema,
  title: z.string().trim().min(1).max(256).optional(),
  objective: z.string().max(32_768).optional(),
  acceptanceCriteria: z.array(
    z.string().trim().min(1).max(2_048)
  ).min(1).max(128).optional(),
  readScopes: z.array(GraphRelativePathSchema).max(1_000).optional(),
  writeScopes: z.array(GraphRelativePathSchema).max(1_000).optional()
}).strict()

export const GraphLeadPatchInputSchema = z.object({
  runId: GraphRunIdSchema,
  reason: z.string().trim().min(1).max(32_768),
  operations: z.array(GraphLeadSupersedeNodeOperationSchema).min(1).max(1_000)
}).strict()

export const GRAPH_LEAD_PATCH_INPUT_JSON_SCHEMA = (() => {
  const schema = z.toJSONSchema(GraphLeadPatchInputSchema, {
    io: 'input',
    target: 'draft-07',
    reused: 'inline'
  }) as Record<string, unknown>
  delete schema.$schema
  return schema
})()

type GraphLeadPatchInput = z.infer<typeof GraphLeadPatchInputSchema>
type GraphLeadSupersedeNodeOperation =
  z.infer<typeof GraphLeadSupersedeNodeOperationSchema>

export function buildGraphLeadPatchTool(options: {
  control: GraphControlService
  store: GraphRunStore
  registry: ProjectAgentRegistry
  shouldAdvertise: (context: ToolHostContext) => boolean
  nowIso: () => string
  nextId: (prefix: string) => string
  config?: () => GraphRuntimeConfig
}): LocalTool {
  const pendingIntents = new Map<string, Promise<GraphRunV1>>()
  return LocalToolHost.defineTool({
    name: GRAPH_LEAD_TOOL_NAMES[3],
    description:
      'Apply semantic changes to the current durable GraphRun. Provide only runId, reason, ' +
      'and operations; Kun supplies patch/command ids, Lead provenance, current revision and ' +
      'sequence, and timestamp. To recover exhausted work, copy this shape: ' +
      '{"runId":"graph_run_...","reason":"Replace exhausted work","operations":[' +
      '{"op":"supersede_node","nodeId":"failed_task","objective":"Retry the bounded task"}]}. ' +
      'supersede_node preserves failed history, creates a zero-attempt replacement, and ' +
      'atomically redirects the old node graph role. When an exhausted read-only review found ' +
      'defects in an accepted direct predecessor, its replacement inherits only that ' +
      'predecessor\'s already-authorized write scopes so it can perform the bounded repair.',
    inputSchema: GRAPH_LEAD_PATCH_INPUT_JSON_SCHEMA,
    policy: 'auto',
    toolKind: 'tool_call',
    sideEffect: 'unknown',
    shouldAdvertise: options.shouldAdvertise,
    execute: async (args, context) => {
      try {
        const input = GraphLeadPatchInputSchema.parse(args)
        const run = await authorizedLead(
          options.store,
          options.registry,
          input.runId,
          context
        )
        assertUniqueSupersedeTargets(input)
        const intentHash = hashIntent(input)
        const existingReplacementNodeIds = appliedReplacementNodeIds(
          run,
          input,
          intentHash
        )
        if (existingReplacementNodeIds) {
          return {
            output: patchOutcome(run, intentHash, existingReplacementNodeIds, true)
          }
        }
        const operations = compileLeadPatchOperations(
          run,
          input,
          intentHash,
          options.config
        )
        const patchId = `graph_patch_${intentHash.slice(0, 24)}`
        const commandId = `graph_command_${intentHash.slice(0, 24)}`
        const patch = GraphPatchV1Schema.parse({
          version: GRAPH_CONTRACT_VERSION,
          patchId,
          commandId,
          runId: run.id,
          baseRevision: run.currentRevision,
          requester: { kind: 'lead', id: run.sourceTurnId },
          reason: input.reason,
          operations,
          createdAt: options.nowIso()
        })
        const pending = pendingIntents.get(intentHash)
        if (pending) {
          const revised = await pending
          return {
            output: patchOutcome(
              revised,
              intentHash,
              replacementNodeIds(revised, input),
              true
            )
          }
        }
        const commit = Promise.resolve().then(() =>
          options.control.applyPatch(run.id, patch, {
            commandId,
            idempotencyKey: `graph-patch:${intentHash}`,
            expectedSeq: run.lastEventSeq,
            expectedRevision: run.currentRevision
          }))
        pendingIntents.set(intentHash, commit)
        try {
          const revised = await commit
          return {
            output: patchOutcome(
              revised,
              intentHash,
              replacementNodeIds(revised, input),
              false
            )
          }
        } catch (error) {
          const latest = await options.store.get(run.id)
          const duplicateReplacementNodeIds = latest
            ? appliedReplacementNodeIds(latest, input, intentHash)
            : undefined
          if (latest && duplicateReplacementNodeIds) {
            return {
              output: patchOutcome(
                latest,
                intentHash,
                duplicateReplacementNodeIds,
                true
              )
            }
          }
          throw error
        } finally {
          if (pendingIntents.get(intentHash) === commit) {
            pendingIntents.delete(intentHash)
          }
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

function compileLeadPatchOperations(
  run: GraphRunV1,
  input: GraphLeadPatchInput,
  intentHash: string,
  config?: () => GraphRuntimeConfig
): GraphPatchOperationV1[] {
  return input.operations.map((operation, index) =>
    compileSupersedeNode(run, operation, intentHash, index, config))
}

function compileSupersedeNode(
  run: GraphRunV1,
  operation: GraphLeadSupersedeNodeOperation,
  intentHash: string,
  operationIndex: number,
  config?: () => GraphRuntimeConfig
): GraphPatchOperationV1 {
  const projection = run.nodes[operation.nodeId]
  if (!projection) throw new Error(`Graph node not found: ${operation.nodeId}`)
  if (!['failed', 'repair_required'].includes(projection.status)) {
    throw new Error(
      `supersede_node requires failed or repair_required work; ` +
      `${operation.nodeId} is ${projection.status}`
    )
  }
  const completionNodeIds = new Set(run.plans.at(-1)!.completionNodeIds)
  if (!projection.node.required && !completionNodeIds.has(operation.nodeId)) {
    throw new Error(`supersede_node requires required or completion work: ${operation.nodeId}`)
  }
  const maximumAttempts = effectiveNodeMaxAttempts(run, projection, config?.())
  const attemptsUsed = currentIterationAttemptCount(projection)
  if (attemptsUsed < maximumAttempts) {
    throw new Error(
      `supersede_node requires exhausted work; ${operation.nodeId} used ` +
      `${attemptsUsed} of ${maximumAttempts} attempts`
    )
  }
  if (projection.node.kind === 'loop_gate') {
    throw new Error('supersede_node does not support loop_gate nodes')
  }
  assertDownstreamCanBeRedirected(run, operation.nodeId)
  const readScopes = narrowedScopes(
    operation.readScopes,
    projection.node.readScopes,
    'readScopes'
  )
  const repairWriteScopes = inheritedReviewRepairWriteScopes(run, operation.nodeId)
  const writeScopes = narrowedScopes(
    operation.writeScopes,
    repairWriteScopes.length
      ? repairWriteScopes
      : projection.node.writeScopes,
    'writeScopes'
  )
  const replacement = GraphNodeV1Schema.parse({
    ...projection.node,
    id: `graph_node_${intentHash.slice(0, 20)}_${operationIndex + 1}`,
    ...(operation.title ? { title: operation.title } : {}),
    ...(operation.objective ? { objective: operation.objective } : {}),
    completion: {
      ...projection.node.completion,
      ...(operation.acceptanceCriteria
        ? { acceptanceCriteria: operation.acceptanceCriteria }
        : {})
    },
    readScopes,
    writeScopes,
    metadata: {
      ...projection.node.metadata,
      supersedes: operation.nodeId,
      leadPatchIntentHash: intentHash
    }
  })
  return GraphPatchOperationV1Schema.parse({
    op: 'replace_node',
    nodeId: operation.nodeId,
    replacement,
    supersedesAcceptedWork: false
  })
}

function assertDownstreamCanBeRedirected(run: GraphRunV1, nodeId: string): void {
  const plan = run.plans.at(-1)!
  const downstreamIds = new Set(
    plan.edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to)
  )
  for (const downstreamId of downstreamIds) {
    const status = run.nodes[downstreamId]?.status
    if (status && !['pending', 'blocked', 'ready'].includes(status)) {
      throw new Error(
        `cannot supersede ${nodeId} after downstream node ${downstreamId} reached ${status}`
      )
    }
  }
}

function narrowedScopes(
  requested: readonly string[] | undefined,
  current: readonly string[],
  field: string
): string[] {
  if (requested === undefined) return [...current]
  for (const scope of requested) {
    if (!current.some((allowed) => graphHostRelativePathCovers(allowed, scope))) {
      throw new Error(`${field} may only preserve or narrow the original node scopes: ${scope}`)
    }
  }
  return [...requested]
}

/**
 * A read-only review can accurately discover that accepted upstream work
 * still needs a narrow file repair, but retrying that same reviewer cannot
 * make the change. For this one recovery case, preserve the Graph's existing
 * authority by borrowing only write scopes that were already granted to a
 * directly connected, accepted predecessor. No new project path is exposed.
 */
function inheritedReviewRepairWriteScopes(
  run: GraphRunV1,
  reviewNodeId: string
): string[] {
  const review = run.nodes[reviewNodeId]
  if (
    review?.node.kind !== 'review' ||
    review.node.writeScopes.length > 0
  ) return []
  const plan = run.plans.at(-1)
  if (!plan) return []
  const inherited = plan.edges
    .filter((edge) => edge.kind !== 'message' && edge.to === reviewNodeId)
    .flatMap((edge) => {
      const source = run.nodes[edge.from]
      if (!source || !['accepted', 'superseded'].includes(source.status)) return []
      return source.node.writeScopes
    })
  return [...new Set(inherited)]
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

function assertUniqueSupersedeTargets(input: GraphLeadPatchInput): void {
  const seen = new Set<string>()
  for (const operation of input.operations) {
    if (seen.has(operation.nodeId)) {
      throw new Error(`supersede_node target appears more than once: ${operation.nodeId}`)
    }
    seen.add(operation.nodeId)
  }
}

function hashIntent(input: GraphLeadPatchInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function appliedReplacementNodeIds(
  run: GraphRunV1,
  input: GraphLeadPatchInput,
  intentHash: string
): string[] | undefined {
  const replacements = input.operations.map((operation) => {
    const replacementId = run.nodes[operation.nodeId]?.supersededByNodeId
    const replacement = replacementId ? run.nodes[replacementId] : undefined
    return replacement?.node.metadata.leadPatchIntentHash === intentHash &&
      replacement.node.metadata.supersedes === operation.nodeId
      ? replacement.node.id
      : undefined
  })
  return replacements.every((nodeId): nodeId is string => Boolean(nodeId))
    ? replacements
    : undefined
}

function replacementNodeIds(
  run: GraphRunV1,
  input: GraphLeadPatchInput
): string[] {
  return input.operations.flatMap((operation) => {
    const replacementId = run.nodes[operation.nodeId]?.supersededByNodeId
    return replacementId ? [replacementId] : []
  })
}

function patchOutcome(
  run: GraphRunV1,
  intentHash: string,
  replacementNodeIds: string[],
  duplicate: boolean
): Record<string, unknown> {
  return {
    runId: run.id,
    status: run.status,
    currentRevision: run.currentRevision,
    lastEventSeq: run.lastEventSeq,
    applied: true,
    duplicate,
    intentHash,
    replacementNodeIds
  }
}
