import { z } from 'zod'
import { AtomicJsonFile } from '../extensions/atomic-json.js'
import type { GraphRunStore } from './graph-run-store.js'

const ReferenceSchema = z.object({
  referenceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  sourceRunId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  sourceThreadId: z.string().min(1),
  targetThreadId: z.string().min(1),
  graphRevision: z.number().int().positive(),
  graphSeq: z.number().int().positive(),
  statusAtFork: z.string().min(1),
  title: z.string().min(1).max(256),
  summary: z.string().max(4_096).optional(),
  createdAt: z.string().datetime({ offset: true })
}).strict()
export type GraphThreadReference = z.infer<typeof ReferenceSchema>

const StateSchema = z.object({
  references: z.array(ReferenceSchema).max(1_000_000)
}).strict()

export class FileGraphThreadReferenceStore {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly file: AtomicJsonFile<z.infer<typeof StateSchema>>
  private readonly nowIso: () => string
  private readonly nextId: (prefix: string) => string

  constructor(private readonly options: {
    path: string
    runs: GraphRunStore
    nowIso?: () => string
    nextId?: (prefix: string) => string
  }) {
    this.file = new AtomicJsonFile(options.path, (value) => StateSchema.parse(value))
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    let next = 0
    this.nextId = options.nextId ?? ((prefix) => `${prefix}_${Date.now()}_${++next}`)
  }

  fork(sourceThreadId: string, targetThreadId: string): Promise<GraphThreadReference[]> {
    return this.enqueue(async () => {
      const runs = await this.options.runs.list({ threadId: sourceThreadId })
      let created: GraphThreadReference[] = []
      await this.file.update(() => ({ references: [] }), (state) => {
        created = []
        const references = [...state.references]
        for (const run of runs) {
          const duplicate = references.find((reference) =>
            reference.sourceRunId === run.id &&
            reference.targetThreadId === targetThreadId &&
            reference.graphSeq === run.lastEventSeq)
          if (duplicate) {
            created.push(duplicate)
            continue
          }
          const reference = ReferenceSchema.parse({
            referenceId: this.nextId('graph_reference'),
            sourceRunId: run.id,
            sourceThreadId,
            targetThreadId,
            graphRevision: run.currentRevision,
            graphSeq: run.lastEventSeq,
            statusAtFork: run.status,
            title: run.plans.at(-1)!.title,
            ...(run.summary ? { summary: run.summary.finalAnswer.slice(0, 4_096) } : {}),
            createdAt: this.nowIso()
          })
          references.push(reference)
          created.push(reference)
        }
        return { references }
      })
      return created
    })
  }

  async list(threadId: string): Promise<GraphThreadReference[]> {
    return (await this.load()).references
      .filter((reference) =>
        reference.targetThreadId === threadId || reference.sourceThreadId === threadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async referencedRunIds(): Promise<Set<string>> {
    return new Set((await this.load()).references.map((reference) => reference.sourceRunId))
  }

  async compact(olderThan: string): Promise<number> {
    return this.enqueue(async () => {
      let removed = 0
      await this.file.update(() => ({ references: [] }), (state) => {
        const references = state.references.filter((reference) => reference.createdAt >= olderThan)
        removed = state.references.length - references.length
        return { references }
      })
      return removed
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async load(): Promise<z.infer<typeof StateSchema>> {
    return this.file.read(() => ({ references: [] }))
  }
}
