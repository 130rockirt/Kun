import { createHash } from 'node:crypto'
import type {
  GraphPlanningDraftV1,
  GraphPlanningIssueV1
} from '../../contracts/graph.js'

export const MINIMAL_VALID_PLAN_EXAMPLE = {
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

export function planningEventForStatus(
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

export function taskSummaries(candidate: unknown) {
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

export function toPlanningIssue(
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

export function planningError(
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
      ...(issues[0]?.repairHint ? { repairHint: issues[0].repairHint } : {}),
      validExample: MINIMAL_VALID_PLAN_EXAMPLE,
      ...(draft ? { draft } : {})
    },
    isError: true
  }
}

export function hashCandidate(candidate: unknown): string {
  return createHash('sha256').update(stableJson(candidate)).digest('hex')
}

export function hashIncompleteToolArguments(raw: string): string {
  return createHash('sha256')
    .update('graph_define_plan:incomplete:')
    .update(raw)
    .digest('hex')
}

export function planningRunSummary(run: {
  id: string
  status: unknown
  currentRevision?: number
  lastEventSeq?: number
}): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    ...(run.currentRevision !== undefined
      ? { currentRevision: run.currentRevision }
      : {}),
    ...(run.lastEventSeq !== undefined ? { lastEventSeq: run.lastEventSeq } : {})
  }
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048)
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
