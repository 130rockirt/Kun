import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  GraphRunIdSchema,
  GraphRunStatusSchema,
  GraphRunV1Schema,
  type GraphRunStatus,
  type GraphRunV1
} from '../contracts/graph.js'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'

const EntrySchema = z.object({
  runId: GraphRunIdSchema,
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  status: GraphRunStatusSchema,
  updatedAt: z.string().datetime({ offset: true })
}).strict()
const IndexSchema = z.array(EntrySchema)
const SnapshotStateSchema = z.object({ state: GraphRunV1Schema }).passthrough()
type Entry = z.infer<typeof EntrySchema>

export class FileGraphRunIndex {
  private readonly entries = new Map<string, Entry>()
  private writeQueue = Promise.resolve()

  constructor(private readonly rootDir: string) {}

  async initialize(): Promise<void> {
    try {
      const parsed = IndexSchema.parse(JSON.parse(await readFile(this.path(), 'utf8')))
      for (const entry of parsed) this.entries.set(entry.runId, entry)
      return
    } catch {
      // Rebuild once from bounded snapshot metadata.
    }
    const directories = await readdir(this.rootDir, { withFileTypes: true })
    for (const directory of directories) {
      if (!directory.isDirectory() || !GraphRunIdSchema.safeParse(directory.name).success) continue
      try {
        const snapshot = SnapshotStateSchema.parse(JSON.parse(
          await readFile(join(this.rootDir, directory.name, 'snapshot.json'), 'utf8')
        ))
        this.entries.set(directory.name, entryFor(snapshot.state))
      } catch {
        // A direct read will surface corruption diagnostics for this run.
      }
    }
    await this.persist()
  }

  candidates(filter: {
    threadId?: string
    projectId?: string
    statuses?: GraphRunStatus[]
  }): Entry[] {
    return [...this.entries.values()]
      .filter((entry) => !filter.threadId || entry.threadId === filter.threadId)
      .filter((entry) => !filter.projectId || entry.projectId === filter.projectId)
      .filter((entry) => !filter.statuses || filter.statuses.includes(entry.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId))
  }

  async update(state: GraphRunV1): Promise<void> {
    this.entries.set(state.id, entryFor(state))
    await this.persist()
  }

  async remove(runId: string): Promise<void> {
    this.entries.delete(runId)
    await this.persist()
  }

  private async persist(): Promise<void> {
    const operation = this.writeQueue.catch(() => undefined).then(() =>
      atomicWriteFile(this.path(), `${JSON.stringify(IndexSchema.parse([...this.entries.values()]))}\n`))
    this.writeQueue = operation.then(() => undefined, () => undefined)
    await operation
  }

  private path(): string {
    return join(this.rootDir, 'index.json')
  }
}

function entryFor(state: GraphRunV1): Entry {
  return EntrySchema.parse({
    runId: state.id,
    threadId: state.threadId,
    projectId: state.projectId,
    status: state.status,
    updatedAt: state.updatedAt
  })
}
