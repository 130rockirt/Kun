import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  GraphPlanningDraftViewV1Schema,
  type GraphPlanningDraftV1,
  type GraphPlanningIssueV1
} from '../../contracts/graph.js'
import {
  DEFAULT_GRAPH_RUNTIME_CONFIG,
  type GraphRuntimeConfig
} from '../../config/kun-config.js'
import {
  compileGraphPlanIntentV2,
  GraphPlanIntentV2Schema,
  GraphPlanValidationError,
  GraphPlanningDraftConflictError,
  type FileGraphPlanningDraftStore,
  type GraphControlService,
  type ProjectAgentRegistry
} from '../../graph/index.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import { graphCreateBudgetDefaults } from './graph-create-run-tool.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'

export const GRAPH_DEFINE_PLAN_TOOL_NAME = 'graph_define_plan'

export const GraphDefinePlanInputSchema = z.object({
  plan: GraphPlanIntentV2Schema.describe(
    'A small task graph. Use only task keys, purpose, dependencies, acceptance criteria, and repository-relative scopes; the host supplies all execution mechanics.'
  )
}).strict()

export const GRAPH_DEFINE_PLAN_INPUT_JSON_SCHEMA = (() => {
  const schema = z.toJSONSchema(GraphDefinePlanInputSchema, {
    io: 'input',
    target: 'draft-07',
    reused: 'inline'
  }) as Record<string, unknown>
  delete schema.$schema
  return schema
})()

const MINIMAL_VALID_PLAN_EXAMPLE = {
  plan: {
    title: 'Update project documentation',
    tasks: [{
      key: 'update_docs',
      kind: 'work',
      title: 'Update the documentation',
      objective: 'Inspect the current documentation and make the requested corrections.',
      dependsOn: [],
      dataFrom: [],
      acceptanceCriteria: ['The requested behavior is documented with a concrete example.'],
      readScopes: ['.'],
      writeScopes: ['docs']
    }],
    completionTaskKeys: ['update_docs']
  }
} as const

export function buildGraphDefinePlanTool(options: {
  control: GraphControlService
  drafts: FileGraphPlanningDraftStore
  registry: ProjectAgentRegistry
  events: Pick<RuntimeEventRecorder, 'record'>
  shouldAdvertise: (context: ToolHostContext) => boolean
  nowIso: () => string
  nextId: (prefix: string) => string
  config?: () => GraphRuntimeConfig
}): LocalTool {
  return LocalToolHost.defineTool({
    name: GRAPH_DEFINE_PLAN_TOOL_NAME,
    description: [
      'Validate and commit the durable planning draft that already belongs to this Graph turn.',
      'First inspect the repository with read-only tools. Then submit focused tasks using only the advertised fields.',
      'dependsOn creates a control dependency; dataFrom names an accepted predecessor result consumed by this task.',
      'Every scope is repository-relative. Use "." for the repository root and an empty writeScopes array for read-only work.',
      'Ordinary work/review/integration tasks never contain loop. Only kind "loop_gate" contains the required bounded loop object.',
      'The host owns run identity, phases, strategy, budgets, model/provider routing, retries, timeouts, reviews, revisions, workspace, and timestamps.',
      `Minimal valid call: ${JSON.stringify(MINIMAL_VALID_PLAN_EXAMPLE)}`,
      'If validation returns issues, change the exact paths once. Never repeat unchanged invalid arguments and never claim a GraphRun exists until this tool returns committed.'
    ].join(' '),
    inputSchema: GRAPH_DEFINE_PLAN_INPUT_JSON_SCHEMA,
    policy: 'auto',
    toolKind: 'tool_call',
    sideEffect: 'unknown',
    shouldAdvertise: options.shouldAdvertise,
    execute: async (args, context) => {
      let draft: GraphPlanningDraftV1 | null = null
      try {
        draft = await options.drafts.findBySourceTurn(context.turnId)
        if (!draft || draft.threadId !== context.threadId) {
          return planningError(
            'graph_planning_draft_missing',
            'This Graph turn has no durable planning draft.',
            [],
            false
          )
        }
        if (draft.status === 'committed' && draft.committedRunId) {
          return {
            output: {
              status: 'committed',
              draft,
              run: await options.control.get(draft.committedRunId)
            }
          }
        }
        if (draft.status === 'cancelled' || draft.status === 'host_error') {
          return planningError(
            'graph_planning_draft_inactive',
            `The planning draft is ${draft.status}.`,
            draft.issues,
            false
          )
        }

        const candidate = typeof args === 'object' && args !== null && 'plan' in args
          ? (args as { plan?: unknown }).plan
          : undefined
        const candidateHash = hashCandidate(candidate)
        if (draft.candidateHash === candidateHash && draft.issues.length > 0) {
          draft = await transitionDraft(options, draft, {
            status: 'needs_correction',
            candidateHash,
            issues: draft.issues,
            repairCount: draft.repairCount
          })
          return planningError(
            'unchanged_invalid_plan',
            'The submitted plan is identical to the previous invalid plan. The draft is waiting for user correction.',
            draft.issues,
            false,
            draft
          )
        }

        await options.drafts.writeCandidate(draft.id, candidate)
        draft = await transitionDraft(options, draft, {
          status: 'validating',
          candidateHash,
          issues: []
        })
        const parsed = GraphDefinePlanInputSchema.safeParse(args)
        if (!parsed.success) {
          return recordInvalidCandidate(options, draft, candidateHash, parsed.error.issues)
        }

        const identity = await options.registry.identify(context.workspace)
        const config = options.config?.() ?? DEFAULT_GRAPH_RUNTIME_CONFIG
        let plan
        try {
          plan = compileGraphPlanIntentV2({
            intent: parsed.data.plan,
            goal: draft.goal,
            workspaceRoot: identity.canonicalWorkspaceRoot,
            nowIso: options.nowIso(),
            budgetDefaults: graphCreateBudgetDefaults(config),
            config
          })
        } catch (error) {
          if (error instanceof z.ZodError) {
            return recordInvalidCandidate(options, draft, candidateHash, error.issues)
          }
          throw error
        }

        await options.drafts.writeCommitPlan(draft.id, plan)
        draft = await transitionDraft(options, draft, {
          status: 'committing',
          candidateHash,
          issues: []
        })
        const result = await options.control.create({
          runId: draft.reservedRunId,
          threadId: draft.threadId,
          projectId: draft.projectId,
          sourceTurnId: draft.sourceTurnId,
          plan,
          commandId: options.nextId('graph_plan_commit'),
          idempotencyKey: `graph-plan-commit:${draft.sourceTurnId}`,
          start: true
        })
        draft = await transitionDraft(options, draft, {
          status: 'committed',
          candidateHash,
          issues: [],
          committedRunId: result.run.id
        })
        return {
          output: {
            status: 'committed',
            draft,
            run: result.run,
            validation: result.validation,
            nextAction:
              'Inspect the running Graph, supervise submitted worker results, and explicitly accept or request repair before delivering the final answer.'
          }
        }
      } catch (error) {
        if (error instanceof GraphPlanValidationError && draft) {
          return recordInvalidCandidate(
            options,
            draft,
            draft.candidateHash ?? hashCandidate(args),
            error.result.issues
          )
        }
        if (error instanceof GraphPlanningDraftConflictError) {
          return planningError(
            'graph_planning_revision_conflict',
            error.message,
            [],
            true
          )
        }
        if (draft) {
          const issue = toPlanningIssue(error, [])
          await transitionDraft(options, draft, {
            status: 'host_error',
            issues: [issue]
          }).catch(() => undefined)
        }
        return planningError(
          'graph_planning_host_error',
          errorMessage(error),
          [],
          false,
          draft ?? undefined
        )
      }
    }
  })
}

async function recordInvalidCandidate(
  options: Parameters<typeof buildGraphDefinePlanTool>[0],
  draft: GraphPlanningDraftV1,
  candidateHash: string,
  rawIssues: readonly {
    code?: unknown
    path?: readonly PropertyKey[]
    message?: unknown
  }[]
): Promise<{ output: Record<string, unknown>; isError: true }> {
  const issues = rawIssues.slice(0, 64).map((issue) =>
    toPlanningIssue(issue, issue.path ?? []))
  const firstRepair = draft.repairCount === 0
  const next = await transitionDraft(options, draft, {
    status: firstRepair ? 'repairing' : 'needs_correction',
    candidateHash,
    issues,
    repairCount: firstRepair ? 1 : draft.repairCount
  })
  return planningError(
    firstRepair ? 'graph_plan_invalid' : 'graph_plan_needs_correction',
    firstRepair
      ? 'The plan is invalid. Change every listed path and submit one corrected plan.'
      : 'The corrected plan is still invalid. The draft is waiting for user correction.',
    issues,
    firstRepair,
    next
  )
}

async function transitionDraft(
  options: Pick<
    Parameters<typeof buildGraphDefinePlanTool>[0],
    'drafts' | 'events'
  >,
  draft: GraphPlanningDraftV1,
  patch: Omit<
    Parameters<FileGraphPlanningDraftStore['update']>[1],
    'expectedRevision'
  >
): Promise<GraphPlanningDraftV1> {
  const next = await options.drafts.update(draft.id, {
    ...patch,
    expectedRevision: draft.revision
  })
  await emitPlanningEvent(options, next)
  return next
}

export async function emitPlanningEvent(
  options: Pick<
    Parameters<typeof buildGraphDefinePlanTool>[0],
    'drafts' | 'events'
  >,
  draft: GraphPlanningDraftV1,
  event = planningEventForStatus(draft.status)
): Promise<void> {
  const candidate = await options.drafts.readCandidate(draft.id)
  const tasks = taskSummaries(candidate)
  const view = GraphPlanningDraftViewV1Schema.parse({ draft, tasks })
  await options.events.record({
    kind: 'graph_planning',
    threadId: draft.threadId,
    turnId: draft.sourceTurnId,
    planning: {
      version: 1,
      event,
      draftId: draft.id,
      reservedRunId: draft.reservedRunId,
      sourceTurnId: draft.sourceTurnId,
      revision: draft.revision,
      state: draft.status,
      issues: draft.issues,
      tasks: view.tasks,
      ...(draft.committedRunId ? { committedRunId: draft.committedRunId } : {})
    }
  })
}

function planningEventForStatus(
  status: GraphPlanningDraftV1['status']
):
  | 'draft_created'
  | 'inspection_started'
  | 'validation_started'
  | 'repair_requested'
  | 'needs_correction'
  | 'run_committed'
  | 'draft_cancelled'
  | 'host_error' {
  switch (status) {
    case 'planning':
      return 'inspection_started'
    case 'validating':
    case 'committing':
      return 'validation_started'
    case 'repairing':
      return 'repair_requested'
    case 'needs_correction':
      return 'needs_correction'
    case 'committed':
      return 'run_committed'
    case 'cancelled':
      return 'draft_cancelled'
    case 'host_error':
      return 'host_error'
  }
}

function taskSummaries(candidate: unknown) {
  if (!candidate || typeof candidate !== 'object') return []
  const tasks = (candidate as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) return []
  return tasks.slice(0, 10_000).flatMap((task) => {
    if (!task || typeof task !== 'object') return []
    const value = task as { key?: unknown; kind?: unknown; title?: unknown }
    if (
      typeof value.key !== 'string' ||
      typeof value.kind !== 'string' ||
      typeof value.title !== 'string'
    ) return []
    return [{ key: value.key, kind: value.kind, title: value.title }]
  })
}

function toPlanningIssue(
  issueOrError: unknown,
  path: readonly PropertyKey[]
): GraphPlanningIssueV1 {
  const issue = issueOrError && typeof issueOrError === 'object'
    ? issueOrError as { code?: unknown; message?: unknown }
    : {}
  const message = typeof issue.message === 'string'
    ? issue.message
    : errorMessage(issueOrError)
  const normalizedPath = path
    .filter((part): part is string | number =>
      typeof part === 'string' || typeof part === 'number')
    .slice(0, 32)
  return {
    code: typeof issue.code === 'string'
      ? issue.code.slice(0, 128)
      : 'invalid_plan',
    path: normalizedPath,
    message: message.slice(0, 2_048),
    repairHint: normalizedPath.length
      ? `Correct ${normalizedPath.join('.')} using only the advertised graph_define_plan fields.`
      : 'Correct the plan using only the advertised graph_define_plan fields.',
    validExample: MINIMAL_VALID_PLAN_EXAMPLE
  }
}

function planningError(
  code: string,
  error: string,
  issues: readonly GraphPlanningIssueV1[],
  retryable: boolean,
  draft?: GraphPlanningDraftV1
): { output: Record<string, unknown>; isError: true } {
  return {
    output: {
      code,
      error: error.slice(0, 2_048),
      issues: issues.slice(0, 64),
      retryable,
      validExample: MINIMAL_VALID_PLAN_EXAMPLE,
      ...(draft ? { draft } : {})
    },
    isError: true
  }
}

function hashCandidate(candidate: unknown): string {
  return createHash('sha256').update(stableJson(candidate)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048)
}
