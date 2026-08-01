import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GraphPlanV1Schema,
  GraphPlanningDraftV1Schema,
  type GraphPlanV1,
  type GraphPlanningDraftStatus,
  type GraphPlanningDraftV1,
  type GraphPlanningIssueV1
} from '../contracts/graph.js'
import { AtomicJsonFile } from '../extensions/atomic-json.js'
import { withManagerDataMutex } from '../manager/data-mutex.js'

export type CreateGraphPlanningDraftInput = {
  id: string
  reservedRunId: string
  threadId: string
  sourceTurnId: string
  projectId: string
  goal: string
}

export type UpdateGraphPlanningDraftInput = {
  expectedRevision: number
  status: GraphPlanningDraftStatus
  candidateHash?: string | null
  issues?: GraphPlanningIssueV1[]
  repairCount?: number
  committedRunId?: string | null
}

export class GraphPlanningDraftConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphPlanningDraftConflictError'
  }
}

export class GraphPlanningDraftNotFoundError extends Error {
  constructor(readonly draftId: string) {
    super(`Graph planning draft not found: ${draftId}`)
    this.name = 'GraphPlanningDraftNotFoundError'
  }
}

export class FileGraphPlanningDraftStore {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly options: {
    rootDir: string
    nowIso: () => string
  }) {}

  async create(input: CreateGraphPlanningDraftInput): Promise<GraphPlanningDraftV1> {
    return this.enqueue(`source:${input.sourceTurnId}`, async () => {
      const existing = await this.findBySourceTurn(input.sourceTurnId)
      if (existing) {
        if (existing.threadId !== input.threadId || existing.projectId !== input.projectId) {
          throw new GraphPlanningDraftConflictError(
            `source turn ${input.sourceTurnId} already owns another planning draft`
          )
        }
        return existing
      }
      const timestamp = this.options.nowIso()
      const draft = GraphPlanningDraftV1Schema.parse({
        version: 1,
        id: input.id,
        reservedRunId: input.reservedRunId,
        threadId: input.threadId,
        sourceTurnId: input.sourceTurnId,
        projectId: input.projectId,
        goal: input.goal,
        revision: 1,
        status: 'planning',
        issues: [],
        repairCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      })
      await this.writeDraft(draft)
      return draft
    })
  }

  async get(draftId: string): Promise<GraphPlanningDraftV1 | null> {
    return new AtomicJsonFile<GraphPlanningDraftV1 | null>(
      this.draftPath(draftId),
      (value) => value === null ? null : GraphPlanningDraftV1Schema.parse(value)
    ).read(() => null)
  }

  async require(draftId: string): Promise<GraphPlanningDraftV1> {
    const draft = await this.get(draftId)
    if (!draft) throw new GraphPlanningDraftNotFoundError(draftId)
    return draft
  }

  async findBySourceTurn(sourceTurnId: string): Promise<GraphPlanningDraftV1 | null> {
    const drafts = await this.list()
    return drafts.find((draft) => draft.sourceTurnId === sourceTurnId) ?? null
  }

  async list(filter: {
    threadId?: string
    statuses?: readonly GraphPlanningDraftStatus[]
  } = {}): Promise<GraphPlanningDraftV1[]> {
    await mkdir(this.draftsDir(), { recursive: true, mode: 0o700 })
    const entries = await readdir(this.draftsDir(), { withFileTypes: true })
    const drafts = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const raw = await readFile(join(this.draftsDir(), entry.name), 'utf8')
        return GraphPlanningDraftV1Schema.parse(JSON.parse(raw))
      }))
    const statuses = filter.statuses ? new Set(filter.statuses) : null
    return drafts
      .filter((draft) => !filter.threadId || draft.threadId === filter.threadId)
      .filter((draft) => !statuses || statuses.has(draft.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async update(
    draftId: string,
    input: UpdateGraphPlanningDraftInput
  ): Promise<GraphPlanningDraftV1> {
    return this.enqueue(`draft:${draftId}`, async () => {
      const current = await this.require(draftId)
      if (current.revision !== input.expectedRevision) {
        throw new GraphPlanningDraftConflictError(
          `draft ${draftId} expected revision ${input.expectedRevision}; current is ${current.revision}`
        )
      }
      const next = GraphPlanningDraftV1Schema.parse({
        ...current,
        revision: current.revision + 1,
        status: input.status,
        ...(input.candidateHash === null
          ? { candidateHash: undefined }
          : input.candidateHash
            ? { candidateHash: input.candidateHash }
            : {}),
        ...(input.issues ? { issues: input.issues } : {}),
        ...(input.repairCount !== undefined ? { repairCount: input.repairCount } : {}),
        ...(input.committedRunId === null
          ? { committedRunId: undefined }
          : input.committedRunId
            ? { committedRunId: input.committedRunId }
            : {}),
        updatedAt: this.options.nowIso()
      })
      await this.writeDraft(next)
      return next
    })
  }

  async writeCandidate(draftId: string, candidate: unknown): Promise<void> {
    await this.require(draftId)
    await new AtomicJsonFile(this.candidatePath(draftId), (value) => value).write(candidate)
  }

  async readCandidate(draftId: string): Promise<unknown | null> {
    return new AtomicJsonFile<unknown | null>(
      this.candidatePath(draftId),
      (value) => value
    ).read(() => null)
  }

  async writeCommitPlan(draftId: string, plan: GraphPlanV1): Promise<void> {
    await this.require(draftId)
    const parsed = GraphPlanV1Schema.parse(plan)
    await new AtomicJsonFile(
      this.commitPlanPath(draftId),
      (value) => GraphPlanV1Schema.parse(value)
    ).write(parsed)
  }

  async readCommitPlan(draftId: string): Promise<GraphPlanV1 | null> {
    return new AtomicJsonFile<GraphPlanV1 | null>(
      this.commitPlanPath(draftId),
      (value) => value === null ? null : GraphPlanV1Schema.parse(value)
    ).read(() => null)
  }

  private async writeDraft(draft: GraphPlanningDraftV1): Promise<void> {
    await new AtomicJsonFile(
      this.draftPath(draft.id),
      (value) => GraphPlanningDraftV1Schema.parse(value)
    ).write(draft)
  }

  private draftsDir(): string {
    return join(this.options.rootDir, 'drafts')
  }

  private draftPath(draftId: string): string {
    return join(this.draftsDir(), `${draftId}.json`)
  }

  private candidatePath(draftId: string): string {
    return join(this.options.rootDir, 'candidates', `${draftId}.json`)
  }

  private commitPlanPath(draftId: string): string {
    return join(this.options.rootDir, 'commit-plans', `${draftId}.json`)
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() =>
      withManagerDataMutex(`graph-planning:${key}`, operation))
    const tracked = next.finally(() => {
      if (this.queues.get(key) === tracked) this.queues.delete(key)
    })
    this.queues.set(key, tracked)
    return tracked
  }
}
