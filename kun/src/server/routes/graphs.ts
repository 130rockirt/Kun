import { z } from 'zod'
import {
  GRAPH_CONTRACT_VERSION,
  GraphCommandIdSchema,
  GraphPatchV1Schema,
  GraphPlanV1Schema,
  GraphPlanningDraftViewV1Schema,
  GraphReviewResultV1Schema,
  GraphRunIdSchema,
  GraphRunStatusSchema,
  GraphSteeringV1Schema
} from '../../contracts/graph.js'
import {
  GraphControlService,
  GraphPlanValidationError,
  GraphPlanningDraftConflictError,
  GraphPlanningDraftNotFoundError,
  type FileGraphPlanningDraftStore,
  GraphRunConflictError,
  GraphRunNotFoundError,
  GraphStoreCorruptionError
} from '../../graph/index.js'
import type { TurnService } from '../../services/turn-service.js'
import type { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import { emitPlanningEvent } from '../../adapters/tool/graph-define-plan-tool.js'
import type { GraphEventReplay } from '../../graph/graph-run-store.js'
import {
  isValidArtifactId,
  readArtifactBounded,
  type ArtifactStore,
  type ReadRangeOptions
} from '../../artifacts/artifact-store.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'

const PortableId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

const GraphCommandContextSchema = z.object({
  commandId: GraphCommandIdSchema,
  idempotencyKey: PortableId,
  expectedSeq: z.number().int().nonnegative().optional(),
  expectedRevision: z.number().int().positive().optional()
}).strict()

const CreateGraphRunRequestSchema = z.object({
  runId: GraphRunIdSchema.optional(),
  threadId: PortableId,
  projectId: PortableId,
  sourceTurnId: PortableId,
  plan: GraphPlanV1Schema,
  commandId: GraphCommandIdSchema,
  idempotencyKey: PortableId,
  start: z.boolean().default(false)
}).strict()

const ValidateGraphPlanRequestSchema = z.object({
  plan: z.unknown()
}).strict()

const CancelGraphRunRequestSchema = GraphCommandContextSchema.extend({
  reason: z.string().trim().min(1).max(4_096).optional()
}).strict()

const RetryGraphNodeRequestSchema = GraphCommandContextSchema.extend({
  nodeId: PortableId
}).strict()

const SteerGraphRunRequestSchema = GraphCommandContextSchema.extend({
  steeringId: PortableId.optional(),
  target: GraphSteeringV1Schema.shape.target,
  text: z.string().trim().min(1).max(32_768)
}).strict()

const ApplyGraphPatchRequestSchema = GraphCommandContextSchema.extend({
  expectedSeq: z.number().int().nonnegative(),
  expectedRevision: z.number().int().positive(),
  patch: GraphPatchV1Schema
}).strict()

const RecordGraphReviewRequestSchema = GraphCommandContextSchema.extend({
  expectedSeq: z.number().int().nonnegative(),
  expectedRevision: z.number().int().positive(),
  review: GraphReviewResultV1Schema
}).strict()

const GraphDraftCommandSchema = z.object({
  expectedRevision: z.number().int().positive()
}).strict()

const GraphArtifactQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().optional(),
  length: z.coerce.number().int().positive().optional(),
  start_line: z.coerce.number().int().positive().optional(),
  end_line: z.coerce.number().int().positive().optional()
}).strict().superRefine((value, context) => {
  const byteMode = value.offset !== undefined || value.length !== undefined
  const lineMode = value.start_line !== undefined || value.end_line !== undefined
  if (byteMode && lineMode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'byte and line ranges cannot be combined'
    })
  }
  if (
    value.start_line !== undefined &&
    value.end_line !== undefined &&
    value.end_line < value.start_line
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'end_line must be greater than or equal to start_line'
    })
  }
})

export async function validateGraphPlan(
  graphs: GraphControlService | undefined,
  request: Request
): Promise<JsonResponse | Response> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, ValidateGraphPlanRequestSchema)
  if (!parsed.ok) return parsed.response
  return jsonResponse(graphs.validate(parsed.data.plan))
}

export async function createGraphRun(
  graphs: GraphControlService | undefined,
  request: Request
): Promise<JsonResponse | Response> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, CreateGraphRunRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    const result = await graphs.create({
      ...parsed.data,
      runId: parsed.data.runId ?? graphs.allocateId('graph_run')
    })
    return jsonResponse(result, 202)
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function listGraphRuns(
  graphs: GraphControlService | undefined,
  request: Request
): Promise<JsonResponse> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const url = new URL(request.url)
  const rawStatuses = url.searchParams.get('status')
    ?.split(',')
    .map((status) => status.trim())
    .filter(Boolean)
  const parsedStatuses = rawStatuses
    ? z.array(GraphRunStatusSchema).safeParse(rawStatuses)
    : undefined
  if (parsedStatuses && !parsedStatuses.success) {
    return ERRORS.validation('invalid Graph run status filter', parsedStatuses.error.issues)
  }
  const statuses = parsedStatuses?.data
  const limit = Number(url.searchParams.get('limit') ?? 20)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return ERRORS.validation('limit must be an integer from 1 to 100', [])
  }
  const cursor = decodeListCursor(url.searchParams.get('cursor'))
  if (cursor === null) return ERRORS.validation('invalid Graph run cursor', [])
  try {
    const runs = await graphs.list({
      ...(url.searchParams.get('thread_id') ? { threadId: url.searchParams.get('thread_id')! } : {}),
      ...(url.searchParams.get('project_id') ? { projectId: url.searchParams.get('project_id')! } : {}),
      ...(statuses?.length ? { statuses } : {})
    })
    const page = runs.slice(cursor, cursor + limit)
    return jsonResponse({
      runs: page.map((run) => ({
        id: run.id,
        threadId: run.threadId,
        projectId: run.projectId,
        sourceTurnId: run.sourceTurnId,
        status: run.status,
        currentRevision: run.currentRevision,
        lastEventSeq: run.lastEventSeq,
        title: run.plans.at(-1)?.title ?? '',
        goal: run.plans.at(-1)?.goal ?? '',
        nodeCount: Object.keys(run.nodes).length,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      })),
      ...(cursor + page.length < runs.length
        ? { nextCursor: encodeListCursor(cursor + page.length) }
        : {})
    })
  } catch (error) {
    return graphErrorResponse(error)
  }
}

function encodeListCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

function decodeListCursor(value: string | null): number | null {
  if (value === null) return 0
  try {
    const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!raw || typeof raw !== 'object') return null
    const offset = (raw as { offset?: unknown }).offset
    return Number.isInteger(offset) && Number(offset) >= 0 ? Number(offset) : null
  } catch {
    return null
  }
}

export async function getGraphRun(
  graphs: GraphControlService | undefined,
  runId: string
): Promise<JsonResponse> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    return jsonResponse(await graphs.get(runId))
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function listGraphPlanningDrafts(
  drafts: FileGraphPlanningDraftStore | undefined,
  request: Request
): Promise<JsonResponse> {
  if (!drafts) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const threadId = new URL(request.url).searchParams.get('thread_id')?.trim()
  const records = await drafts.list({
    ...(threadId ? { threadId } : {})
  })
  return jsonResponse({
    drafts: await Promise.all(records.map((draft) => graphDraftView(drafts, draft.id)))
  })
}

export async function getGraphPlanningDraft(
  drafts: FileGraphPlanningDraftStore | undefined,
  draftId: string
): Promise<JsonResponse> {
  if (!drafts) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  try {
    return jsonResponse(await graphDraftView(drafts, draftId))
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function resumeGraphPlanningDraft(
  drafts: FileGraphPlanningDraftStore | undefined,
  turns: TurnService,
  events: Pick<RuntimeEventRecorder, 'record'>,
  runTurn: (threadId: string, turnId: string) => Promise<unknown> | void,
  draftId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!drafts) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, GraphDraftCommandSchema)
  if (!parsed.ok) return parsed.response
  try {
    const current = await drafts.require(draftId)
    if (current.revision !== parsed.data.expectedRevision) {
      throw new GraphPlanningDraftConflictError(
        `draft ${draftId} expected revision ${parsed.data.expectedRevision}; current is ${current.revision}`
      )
    }
    if (current.status !== 'needs_correction' && current.status !== 'repairing') {
      throw new GraphPlanningDraftConflictError(
        `draft ${draftId} cannot resume from ${current.status}`
      )
    }
    const draft = await drafts.update(draftId, {
      expectedRevision: current.revision,
      status: 'planning',
      issues: current.issues
    })
    await emitPlanningEvent({ drafts, events }, draft)
    await turns.resumeGraphPlanningTurn({
      threadId: draft.threadId,
      turnId: draft.sourceTurnId
    })
    void runTurn(draft.threadId, draft.sourceTurnId)
    return jsonResponse(await graphDraftView(drafts, draft.id), 202)
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function cancelGraphPlanningDraft(
  drafts: FileGraphPlanningDraftStore | undefined,
  turns: TurnService,
  events: Pick<RuntimeEventRecorder, 'record'>,
  draftId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!drafts) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, GraphDraftCommandSchema)
  if (!parsed.ok) return parsed.response
  try {
    const current = await drafts.require(draftId)
    if (current.revision !== parsed.data.expectedRevision) {
      throw new GraphPlanningDraftConflictError(
        `draft ${draftId} expected revision ${parsed.data.expectedRevision}; current is ${current.revision}`
      )
    }
    if (current.status === 'committed' || current.status === 'cancelled') {
      throw new GraphPlanningDraftConflictError(
        `draft ${draftId} cannot cancel from ${current.status}`
      )
    }
    const draft = await drafts.update(draftId, {
      expectedRevision: current.revision,
      status: 'cancelled',
      issues: current.issues
    })
    await emitPlanningEvent({ drafts, events }, draft)
    await turns.interruptTurn({
      threadId: draft.threadId,
      turnId: draft.sourceTurnId
    })
    return jsonResponse(await graphDraftView(drafts, draft.id))
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function graphRunEvents(
  graphs: GraphControlService | undefined,
  storeEvents: ((runId: string, sinceSeq?: number) => Promise<GraphEventReplay>) | undefined,
  runId: string,
  request: Request
): Promise<JsonResponse> {
  if (!graphs || !storeEvents) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const rawSince = new URL(request.url).searchParams.get('since_seq')
  const sinceSeq = rawSince === null ? 0 : Number(rawSince)
  if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
    return ERRORS.validation('since_seq must be a non-negative integer', [])
  }
  try {
    await graphs.get(runId)
    return jsonResponse(await storeEvents(runId, sinceSeq))
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function readGraphArtifact(
  graphs: GraphControlService | undefined,
  artifacts: ArtifactStore | undefined,
  runId: string,
  artifactId: string,
  request: Request
): Promise<JsonResponse> {
  if (!graphs || !artifacts) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  if (!isValidArtifactId(artifactId)) return ERRORS.notFound('Graph artifact not found')
  const url = new URL(request.url)
  const allowed = new Set(['offset', 'length', 'start_line', 'end_line'])
  const unknown = [...url.searchParams.keys()].filter((key) => !allowed.has(key))
  const duplicated = [...allowed].filter((key) => url.searchParams.getAll(key).length > 1)
  if (unknown.length > 0 || duplicated.length > 0) {
    return ERRORS.validation('invalid Graph artifact range', [
      ...unknown.map((key) => ({
        code: 'unrecognized_key',
        path: [key],
        message: 'unknown query parameter'
      })),
      ...duplicated.map((key) => ({
        code: 'custom',
        path: [key],
        message: 'query parameter must appear once'
      }))
    ])
  }
  const parsed = GraphArtifactQuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) {
    return ERRORS.validation('invalid Graph artifact range', parsed.error.issues)
  }
  try {
    const run = await graphs.get(runId)
    const reference = run.artifacts.find((entry) => entry.artifactId === artifactId)
    if (!reference) return ERRORS.notFound('Graph artifact not found')
    const meta = await artifacts.stat(artifactId)
    if (!meta) return ERRORS.notFound('Graph artifact content is unavailable')
    const range: ReadRangeOptions = parsed.data.start_line !== undefined ||
      parsed.data.end_line !== undefined
      ? {
          ...(parsed.data.start_line !== undefined ? { startLine: parsed.data.start_line } : {}),
          ...(parsed.data.end_line !== undefined ? { endLine: parsed.data.end_line } : {})
        }
      : {
          ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
          ...(parsed.data.length !== undefined ? { length: parsed.data.length } : {})
        }
    const page = await readArtifactBounded(artifacts, artifactId, meta, range)
    if (!page) return ERRORS.notFound('Graph artifact content is unavailable')
    return jsonResponse({
      reference,
      meta: {
        byteSize: meta.byteSize,
        lineCount: meta.lineCount,
        mimeType: meta.mimeType ?? reference.mimeType
      },
      ...page
    })
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function graphRunCommand(
  graphs: GraphControlService | undefined,
  runId: string,
  action: 'start' | 'pause' | 'resume' | 'cleanup',
  request: Request
): Promise<JsonResponse | Response> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, GraphCommandContextSchema)
  if (!parsed.ok) return parsed.response
  try {
    const run = await graphs[action](runId, parsed.data)
    return jsonResponse(run)
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function cancelGraphRun(
  graphs: GraphControlService | undefined,
  runId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, CancelGraphRunRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    return jsonResponse(await graphs.cancel(runId, parsed.data))
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function retryGraphNode(
  graphs: GraphControlService | undefined,
  runId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, RetryGraphNodeRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    return jsonResponse(await graphs.retryNode(runId, parsed.data.nodeId, parsed.data))
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function steerGraphRun(
  graphs: GraphControlService | undefined,
  runId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, SteerGraphRunRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    return jsonResponse(await graphs.steer(
      runId,
      {
        version: GRAPH_CONTRACT_VERSION,
        steeringId: parsed.data.steeringId ?? graphs.allocateId('steering'),
        runId,
        target: parsed.data.target,
        text: parsed.data.text,
        status: 'persisted',
        createdAt: new Date().toISOString()
      },
      parsed.data
    ))
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function patchGraphRun(
  graphs: GraphControlService | undefined,
  runId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, ApplyGraphPatchRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    return jsonResponse(await graphs.applyPatch(runId, parsed.data.patch, parsed.data))
  } catch (error) {
    return graphErrorResponse(error)
  }
}

export async function reviewGraphNode(
  graphs: GraphControlService | undefined,
  runId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!graphs) return ERRORS.unavailable('Graph Mode runtime is unavailable')
  const parsed = await parseBody(request, RecordGraphReviewRequestSchema)
  if (!parsed.ok) return parsed.response
  try {
    return jsonResponse(await graphs.recordReview(runId, parsed.data.review, parsed.data))
  } catch (error) {
    return graphErrorResponse(error)
  }
}

async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<
  | { ok: true; data: z.output<T> }
  | { ok: false; response: JsonResponse | Response }
> {
  const body = await readJsonBody(request)
  if (!body.ok) return body
  const parsed = schema.safeParse(body.value)
  if (!parsed.success) {
    return {
      ok: false,
      response: ERRORS.validation('invalid Graph request body', parsed.error.issues)
    }
  }
  return { ok: true, data: parsed.data }
}

function graphErrorResponse(error: unknown): JsonResponse {
  if (error instanceof GraphPlanningDraftNotFoundError) return ERRORS.notFound(error.message)
  if (error instanceof GraphPlanningDraftConflictError) return ERRORS.conflict(error.message)
  if (error instanceof GraphRunNotFoundError) return ERRORS.notFound(error.message)
  if (error instanceof GraphRunConflictError) return ERRORS.conflict(error.message)
  if (error instanceof GraphPlanValidationError) {
    return ERRORS.validation('GraphPlan validation failed', error.result.issues)
  }
  if (error instanceof GraphStoreCorruptionError) {
    return jsonResponse({
      code: 'graph_store_corruption',
      message: error.message
    }, 500)
  }
  if (error instanceof z.ZodError) {
    return ERRORS.validation('invalid Graph request', error.issues)
  }
  throw error
}

async function graphDraftView(
  drafts: FileGraphPlanningDraftStore,
  draftId: string
) {
  const draft = await drafts.require(draftId)
  const candidate = await drafts.readCandidate(draftId)
  const tasks = candidate && typeof candidate === 'object' &&
      Array.isArray((candidate as { tasks?: unknown }).tasks)
    ? (candidate as { tasks: unknown[] }).tasks.flatMap((task) => {
        if (!task || typeof task !== 'object') return []
        const record = task as Record<string, unknown>
        return typeof record.key === 'string' &&
          typeof record.kind === 'string' &&
          typeof record.title === 'string'
          ? [{ key: record.key, kind: record.kind, title: record.title }]
          : []
      })
    : []
  return GraphPlanningDraftViewV1Schema.parse({ draft, tasks })
}
