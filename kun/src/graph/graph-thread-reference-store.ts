import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
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
  private readonly nowIso: () => string
  private readonly nextId: (prefix: string) => string

  constructor(private readonly options: {
    path: string
    runs: GraphRunStore
    nowIso?: () => string
    nextId?: (prefix: string) => string
  }) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    let next = 0
    this.nextId = options.nextId ?? ((prefix) => `${prefix}_${Date.now()}_${++next}`)
  }

  fork(sourceThreadId: string, targetThreadId: string): Promise<GraphThreadReference[]> {
    return this.enqueue(async () => {
      const state = await this.load()
      const runs = await this.options.runs.list({ threadId: sourceThreadId })
      const created: GraphThreadReference[] = []
      for (const run of runs) {
        const duplicate = state.references.find((reference) =>
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
        state.references.push(reference)
        created.push(reference)
      }
      await this.persist(state)
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
      const state = await this.load()
      const before = state.references.length
      state.references = state.references.filter((reference) =>
        reference.createdAt >= olderThan)
      await this.persist(state)
      return before - state.references.length
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async load(): Promise<z.infer<typeof StateSchema>> {
    const text = await readFile(this.options.path, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    return text ? StateSchema.parse(JSON.parse(text)) : { references: [] }
  }

  private async persist(state: z.infer<typeof StateSchema>): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
    await atomicWriteFile(this.options.path, `${JSON.stringify(StateSchema.parse(state))}\n`)
  }
}
