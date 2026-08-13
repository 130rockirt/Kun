import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../../../kun/src/adapters/file/atomic-write.js'
import {
  PlanWorktreeRunRecordSchema,
  type PlanWorktreeRunRecord
} from '../../shared/plan-worktree'

const STORE_DIRECTORY = 'plan-worktree-runs'

const PlanWorktreeRunScopeSchema = z.object({
  version: z.literal(1),
  runId: PlanWorktreeRunRecordSchema.shape.runId,
  operationId: PlanWorktreeRunRecordSchema.shape.operationId,
  planId: PlanWorktreeRunRecordSchema.shape.planId,
  sourceThreadId: PlanWorktreeRunRecordSchema.shape.sourceThreadId,
  sourceWorkspaceRoot: PlanWorktreeRunRecordSchema.shape.sourceWorkspaceRoot,
  sourceCheckoutRoot: PlanWorktreeRunRecordSchema.shape.sourceCheckoutRoot,
  repositoryIdentity: PlanWorktreeRunRecordSchema.shape.repositoryIdentity,
  worktreePath: PlanWorktreeRunRecordSchema.shape.worktreePath.optional(),
  status: PlanWorktreeRunRecordSchema.shape.status,
  updatedAt: PlanWorktreeRunRecordSchema.shape.updatedAt
}).strict()
type PlanWorktreeRunScope = z.infer<typeof PlanWorktreeRunScopeSchema>

export type UnreadablePlanWorktreeRecord = {
  fileName: string
  message: string
}

export class PlanWorktreeRunStoreCorruptionError extends Error {
  readonly reason = 'record_unreadable' as const

  constructor(readonly unreadable: UnreadablePlanWorktreeRecord[]) {
    super(`Unreadable plan-worktree record(s): ${unreadable.map((item) => item.fileName).join(', ')}`)
    this.name = 'PlanWorktreeRunStoreCorruptionError'
  }
}

/** Shared in-process serialization for coordinator and integration handlers. */
export class PlanWorktreeLockManager {
  private readonly locks = new Map<string, Promise<void>>()

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.locks.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }
}

export class PlanWorktreeRunStore {
  readonly directory: string

  constructor(userDataPath: string) {
    this.directory = join(userDataPath, STORE_DIRECTORY)
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

  private recordPath(runId: string): string {
    const parsed = PlanWorktreeRunRecordSchema.shape.runId.parse(runId)
    return join(this.directory, `${parsed}.json`)
  }

  private backupPath(runId: string): string {
    const parsed = PlanWorktreeRunRecordSchema.shape.runId.parse(runId)
    return join(this.directory, `${parsed}.backup.json`)
  }

  private scopePath(runId: string): string {
    const parsed = PlanWorktreeRunRecordSchema.shape.runId.parse(runId)
    return join(this.directory, `${parsed}.scope.json`)
  }

  async get(runId: string): Promise<PlanWorktreeRunRecord | null> {
    try {
      const raw = await readFile(this.recordPath(runId), 'utf8')
      return PlanWorktreeRunRecordSchema.parse(JSON.parse(raw))
    } catch (error) {
      try {
        const raw = await readFile(this.backupPath(runId), 'utf8')
        return PlanWorktreeRunRecordSchema.parse(JSON.parse(raw))
      } catch (backupError) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT'
          && (backupError as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw new PlanWorktreeRunStoreCorruptionError([{
          fileName: `${runId}.json`,
          message: error instanceof Error ? error.message : String(error)
        }])
      }
    }
  }

  async save(record: PlanWorktreeRunRecord): Promise<PlanWorktreeRunRecord> {
    const parsed = PlanWorktreeRunRecordSchema.parse(record)
    await this.ensureDirectory()
    const destination = this.recordPath(parsed.runId)
    let previous: string | null
    try {
      previous = await readFile(destination, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      previous = null
    }
    if (previous !== null) {
      try {
        PlanWorktreeRunRecordSchema.parse(JSON.parse(previous))
        await atomicWriteFile(this.backupPath(parsed.runId), previous)
      } catch {
        // A malformed primary must not overwrite its last valid backup. The
        // new validated record can still repair the primary atomically.
      }
    }
    const serialized = `${JSON.stringify(parsed, null, 2)}\n`
    await atomicWriteFile(destination, serialized)
    if (previous === null) await atomicWriteFile(this.backupPath(parsed.runId), serialized)
    const scope: PlanWorktreeRunScope = {
      version: 1,
      runId: parsed.runId,
      operationId: parsed.operationId,
      planId: parsed.planId,
      sourceThreadId: parsed.sourceThreadId,
      sourceWorkspaceRoot: parsed.sourceWorkspaceRoot,
      sourceCheckoutRoot: parsed.sourceCheckoutRoot,
      repositoryIdentity: parsed.repositoryIdentity,
      worktreePath: parsed.worktreePath,
      status: parsed.status,
      updatedAt: parsed.updatedAt
    }
    await atomicWriteFile(this.scopePath(parsed.runId), `${JSON.stringify(scope, null, 2)}\n`)
    return parsed
  }

  async list(): Promise<PlanWorktreeRunRecord[]> {
    return (await this.scan()).records
  }

  async findByOperationId(operationId: string): Promise<PlanWorktreeRunRecord | null> {
    const result = await this.scan()
    const record = result.records.find((candidate) => candidate.operationId === operationId)
    if (record) return record
    const matchingUnreadable = await this.matchingUnreadableScopes(
      result.unreadable,
      (scope) => scope.operationId === operationId
    )
    if (matchingUnreadable.length > 0) {
      throw new PlanWorktreeRunStoreCorruptionError(matchingUnreadable)
    }
    return null
  }

  async assertNoUnreadableScope(input: {
    planId: string
    sourceThreadId: string
    sourceCheckoutRoot: string
    repositoryIdentity: string
  }): Promise<void> {
    const result = await this.scan()
    const matching = await this.matchingUnreadableScopes(result.unreadable, (scope) =>
      scope.status !== 'completed' && scope.status !== 'cancelled'
      && scope.planId === input.planId
      && scope.sourceThreadId === input.sourceThreadId
      && scope.sourceCheckoutRoot === input.sourceCheckoutRoot
      && scope.repositoryIdentity === input.repositoryIdentity
    )
    if (matching.length > 0) throw new PlanWorktreeRunStoreCorruptionError(matching)
  }

  async diagnostics(): Promise<UnreadablePlanWorktreeRecord[]> {
    return (await this.scan()).unreadable
  }

  async protectsWorktreePath(worktreePath: string): Promise<boolean> {
    const target = resolve(worktreePath)
    const scan = await this.scan()
    if (scan.records.some((record) => resolve(record.worktreePath) === target)) return true
    for (const diagnostic of scan.unreadable) {
      const runId = diagnostic.fileName.slice(0, -'.json'.length)
      try {
        const scope = PlanWorktreeRunScopeSchema.parse(
          JSON.parse(await readFile(this.scopePath(runId), 'utf8'))
        )
        if (scope.worktreePath && resolve(scope.worktreePath) === target) return true
        if (!scope.worktreePath && target.split(/[\\/]/).includes(runId)) return true
      } catch {
        // Unknown corrupt coordinator records are conservatively protected by
        // their deterministic managed run-directory segment.
        if (target.split(/[\\/]/).includes(runId)) return true
      }
    }
    return false
  }

  async scan(): Promise<{
    records: PlanWorktreeRunRecord[]
    unreadable: UnreadablePlanWorktreeRecord[]
  }> {
    await this.ensureDirectory()
    const names = await readdir(this.directory)
    const runIds = [...new Set(names.flatMap((name) => {
      if (name.endsWith('.backup.json')) return [name.slice(0, -'.backup.json'.length)]
      if (name.endsWith('.scope.json')) return []
      if (name.endsWith('.json')) return [name.slice(0, -'.json'.length)]
      return []
    }))].sort()
    const records: PlanWorktreeRunRecord[] = []
    const unreadable: UnreadablePlanWorktreeRecord[] = []
    for (const runId of runIds) {
      const fileName = `${runId}.json`
      try {
        const record = await this.get(runId)
        if (record) records.push(record)
      } catch (error) {
        unreadable.push({
          fileName,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return {
      records: records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      unreadable
    }
  }

  private async matchingUnreadableScopes(
    unreadable: UnreadablePlanWorktreeRecord[],
    predicate: (scope: PlanWorktreeRunScope) => boolean
  ): Promise<UnreadablePlanWorktreeRecord[]> {
    const matching: UnreadablePlanWorktreeRecord[] = []
    for (const diagnostic of unreadable) {
      const runId = diagnostic.fileName.slice(0, -'.json'.length)
      try {
        const scope = PlanWorktreeRunScopeSchema.parse(
          JSON.parse(await readFile(this.scopePath(runId), 'utf8'))
        )
        if (predicate(scope)) matching.push(diagnostic)
      } catch {
        // A missing/corrupt sidecar remains visible in diagnostics. It cannot
        // be attributed to an unrelated healthy scope, so healthy APIs stay
        // available while exact get(runId) remains fail-closed.
      }
    }
    return matching
  }
}
