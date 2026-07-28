import { z } from 'zod'
import type { ArtifactStore } from '../../artifacts/artifact-store.js'
import {
  GRAPH_CONTRACT_VERSION,
  GraphPlanV1Schema
} from '../../contracts/index.js'
import {
  GraphPlanValidationError,
  type GraphControlService,
  type ProjectAgentRegistry
} from '../../graph/index.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'

const MAX_GRAPH_CREATE_RUN_ISSUES = 64

export const GraphCreateRunPlanInputSchema = GraphPlanV1Schema.omit({
  version: true,
  revision: true,
  workspaceRoot: true,
  autoStart: true,
  createdBy: true,
  createdAt: true
}).describe(
  'Model-authored Graph plan. The host supplies version, revision, workspaceRoot, autoStart, createdBy, and createdAt.'
)

export const GraphCreateRunInputSchema = z.object({
  plan: GraphCreateRunPlanInputSchema,
  start: z.boolean().default(true).describe(
    'Start the GraphRun immediately after validation. Defaults to true.'
  )
}).strict()

export const GRAPH_CREATE_RUN_INPUT_JSON_SCHEMA = (() => {
  const schema = z.toJSONSchema(GraphCreateRunInputSchema, {
    io: 'input',
    // Model providers accept JSON Schema, where exclusive bounds are numeric.
    // OpenAPI 3.0 emits the legacy boolean form (`exclusiveMinimum: true`),
    // which the OpenAI Responses API rejects before the model can run.
    target: 'draft-07',
    reused: 'inline'
  }) as Record<string, unknown>
  // Function-tool parameter objects are embedded schemas, not standalone
  // documents. Keep the dialect marker out of every provider wire format.
  delete schema.$schema
  return schema
})()

export function buildGraphCreateRunTool(options: {
  control: GraphControlService
  registry: ProjectAgentRegistry
  shouldAdvertise: (context: ToolHostContext) => boolean
  nowIso: () => string
  nextId: (prefix: string) => string
}): LocalTool {
  return LocalToolHost.defineTool({
    name: 'graph_create_run',
    description:
      'Create and start a durable GraphRun after thinking through the user request. ' +
      'Provide only the model-owned plan fields described by the schema; the host supplies identity, provenance, revision, and timestamps. ' +
      'The plan must define phases, bounded nodes, typed edges, budgets, completion nodes, ' +
      'acceptance criteria, review policy, explicit read/write scopes, and bounded LoopGates. ' +
      'Omit node.assignment by default for host routing; use an existing assignment only with an exact Graph registry profile id. ' +
      'Use this exactly once for a Graph-mode user turn; the host validates all authority and graph invariants.',
    inputSchema: GRAPH_CREATE_RUN_INPUT_JSON_SCHEMA,
    policy: 'auto',
    toolKind: 'tool_call',
    sideEffect: 'unknown',
    shouldAdvertise: options.shouldAdvertise,
    execute: async (args, context) => {
      const parsed = GraphCreateRunInputSchema.safeParse(args)
      if (!parsed.success) {
        return graphCreateRunError({
          code: 'graph_create_run_schema_invalid',
          error: 'Graph creation arguments do not match the advertised schema.',
          issues: parsed.error.issues,
          guidance:
            'Correct the listed fields against the graph_create_run schema and retry without legacy or invented fields.',
          retryable: true
        })
      }
      try {
        const identity = await options.registry.identify(context.workspace)
        const { plan: modelPlan, start } = parsed.data
        const plan = GraphPlanV1Schema.parse({
          ...modelPlan,
          version: GRAPH_CONTRACT_VERSION,
          revision: 1,
          workspaceRoot: identity.canonicalWorkspaceRoot,
          autoStart: start,
          createdBy: 'lead',
          createdAt: options.nowIso()
        })
        const runId = options.control.allocateId('graph_run')
        const result = await options.control.create({
          runId,
          threadId: context.threadId,
          projectId: identity.projectId,
          sourceTurnId: context.turnId,
          plan,
          commandId: options.nextId('graph_command'),
          idempotencyKey: `graph-create:${context.turnId}`,
          start
        })
        return { output: { run: result.run, validation: result.validation } }
      } catch (error) {
        if (error instanceof GraphPlanValidationError) {
          return graphCreateRunError({
            code: 'graph_create_run_validation_failed',
            error: 'Graph plan validation failed.',
            issues: error.result.issues,
            guidance:
              'Correct the listed graph invariants and retry graph_create_run with the advertised schema.',
            retryable: true
          })
        }
        return graphCreateRunError({
          code: 'graph_create_run_failed',
          error: errorMessage(error),
          guidance:
            'Graph creation failed outside model-correctable validation. Do not retry the same call.',
          retryable: false
        })
      }
    }
  })
}

type GraphCreateRunIssueLike = {
  path: readonly PropertyKey[]
  code: string
  message: string
}

function graphCreateRunError(input: {
  code:
    | 'graph_create_run_schema_invalid'
    | 'graph_create_run_validation_failed'
    | 'graph_create_run_failed'
  error: string
  issues?: readonly GraphCreateRunIssueLike[]
  guidance: string
  retryable: boolean
}): { output: Record<string, unknown>; isError: true } {
  const issues = input.issues?.slice(0, MAX_GRAPH_CREATE_RUN_ISSUES).map((issue) => ({
    path: issue.path
      .filter((part): part is string | number =>
        typeof part === 'string' || typeof part === 'number')
      .slice(0, 32),
    code: issue.code.slice(0, 128),
    message: issue.message.slice(0, 2_048)
  }))
  return {
    output: {
      code: input.code,
      error: input.error.slice(0, 2_048),
      ...(issues?.length ? { issues } : {}),
      guidance: input.guidance.slice(0, 2_048),
      retryable: input.retryable
    },
    isError: true
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048)
}
