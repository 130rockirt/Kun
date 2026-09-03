import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { ThreadService } from '../services/thread-service.js'
import type { SessionGuardian } from '../services/session-guardian.js'
import type { ThreadHealthReport } from '../services/session-guardian.js'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { optionalRuntimeWorkPaused } from './runtime-load-shedder.js'
import {
  appendReferencesChunk,
  readCompactedReferences,
  readReferencesChunk,
  removeGenerationFiles,
  writeCompactedReferences
} from './runtime-maintenance-reference-store.js'

export const MAINTENANCE_SLICE_MAX_THREADS = 8
export const MAINTENANCE_SLICE_MAX_MS = 50

const ScanStateSchema = z.object({
  version: z.literal(2),
  attachments: z.object({
    generation: z.number().int().nonnegative(),
    cursor: z.string().optional(),
    pageOffset: z.number().int().nonnegative().optional()
  }),
  guardian: z.object({
    cursor: z.string().optional(),
    pageOffset: z.number().int().nonnegative().optional()
  })
}).strict()

const ScanStateV1Schema = z.object({
  version: z.literal(1),
  attachments: z.object({
    generation: z.number().int().nonnegative(),
    cursor: z.string().optional(),
    pageOffset: z.number().int().nonnegative().optional(),
    references: z.array(z.string()),
    previousReferences: z.array(z.string()).optional()
  }),
  guardian: z.object({
    cursor: z.string().optional(),
    pageOffset: z.number().int().nonnegative().optional()
  })
}).strict()

type ScanState = z.infer<typeof ScanStateSchema>
type ScanStateV1 = z.infer<typeof ScanStateV1Schema>

export type RuntimeMaintenanceSliceStats = {
  slices: number
  paused: number
  maxDurationMs: number
  processedThreads: number
  bytesWritten: number
  overshoots: number
}

type DeadlineResult<T> = { timedOut: true } | { timedOut: false; value: T }

export function createRuntimeMaintenanceSlices(input: {
  dataDir: string
  threads: ThreadService
  attachments: () => AttachmentStore | undefined
  guardian: SessionGuardian
  nowIso: () => string
  hasActiveTurns?: () => Promise<boolean>
  onGuardianReport?: (report: ThreadHealthReport) => Promise<void> | void
  log?: (message: string) => void
}) {
  const statePath = join(input.dataDir, 'maintenance-state.json')
  let statePromise: Promise<ScanState> | undefined
  let slices = 0
  let paused = 0
  let maxDurationMs = 0
  let processedThreads = 0
  let bytesWritten = 0
  let overshoots = 0

  const freshState = (): ScanState => ({
    version: 2,
    attachments: { generation: 0 },
    guardian: {}
  })

  const migrateV1 = async (v1: ScanStateV1): Promise<ScanState> => {
    const generation = v1.attachments.generation
    if (v1.attachments.references.length > 0) {
      bytesWritten += await appendReferencesChunk(input.dataDir, generation, v1.attachments.references)
    }
    if (v1.attachments.previousReferences && v1.attachments.previousReferences.length > 0) {
      bytesWritten += await writeCompactedReferences(
        input.dataDir,
        generation - 1,
        v1.attachments.previousReferences
      )
    }
    return {
      version: 2,
      attachments: {
        generation,
        cursor: v1.attachments.cursor,
        pageOffset: v1.attachments.pageOffset
      },
      guardian: v1.guardian
    }
  }

  const readState = (): Promise<ScanState> => {
    if (!statePromise) {
      statePromise = readFile(statePath, 'utf8')
        .then(async (text) => {
          const raw: unknown = JSON.parse(text)
          const v2 = ScanStateSchema.safeParse(raw)
          if (v2.success) return v2.data
          const v1 = ScanStateV1Schema.safeParse(raw)
          if (v1.success) return await migrateV1(v1.data)
          return freshState()
        })
        .catch(() => freshState())
    }
    return statePromise
  }

  const saveState = async (state: ScanState): Promise<void> => {
    const contents = JSON.stringify(state)
    bytesWritten += Buffer.byteLength(contents, 'utf8')
    await atomicWriteFile(statePath, contents)
    statePromise = Promise.resolve(state)
  }

  const shouldPause = async (): Promise<boolean> => {
    if (optionalRuntimeWorkPaused()) return true
    return await input.hasActiveTurns?.() ?? false
  }

  const recordSlice = (startedAt: number, processed: number): void => {
    slices += 1
    processedThreads += processed
    maxDurationMs = Math.max(maxDurationMs, Date.now() - startedAt)
  }

  const runAttachmentSlice = async (): Promise<boolean> => {
    const attachmentStore = input.attachments()
    if (!attachmentStore?.pruneExpiredLeases) return true
    if (await shouldPause()) {
      paused += 1
      return false
    }
    const startedAt = Date.now()
    const state = await readState()
    const generation = state.attachments.generation
    const page = await input.threads.listPage({
      limit: MAINTENANCE_SLICE_MAX_THREADS,
      includeArchived: true,
      includeSide: true,
      cursor: state.attachments.cursor
    })
    // The soft deadline only budgets the per-thread work; state load and page
    // listing are bounded setup costs that must not starve the first thread.
    const loopStartedAt = Date.now()
    const sliceIds: string[] = []
    let processed = 0
    const pageOffset = Math.min(state.attachments.pageOffset ?? 0, page.threads.length)
    for (const summary of page.threads.slice(pageOffset)) {
      const remaining = MAINTENANCE_SLICE_MAX_MS - (Date.now() - loopStartedAt)
      if (processed > 0 && remaining <= 0) break
      const result = await withDeadline(input.threads.get(summary.id), Math.max(0, remaining))
      if (result.timedOut) {
        overshoots += 1
        break
      }
      const thread = result.value
      let complete = true
      for (const turn of thread?.turns ?? []) {
        if (Date.now() - loopStartedAt >= MAINTENANCE_SLICE_MAX_MS) {
          complete = false
          break
        }
        for (const id of turn.attachmentIds ?? []) sliceIds.push(id)
      }
      if (!complete) break
      processed += 1
    }
    if (sliceIds.length > 0) {
      bytesWritten += await appendReferencesChunk(input.dataDir, generation, sliceIds)
    }
    const consumedPage = pageOffset + processed === page.threads.length
    if (page.hasMore && consumedPage && page.nextCursor) {
      state.attachments.cursor = page.nextCursor
      state.attachments.pageOffset = 0
      await saveState(state)
      recordSlice(startedAt, processed)
      return false
    }
    if (!consumedPage) {
      state.attachments.pageOffset = pageOffset + processed
      await saveState(state)
      recordSlice(startedAt, processed)
      return false
    }

    // Full pass over the current generation: dedupe the appended chunks, keep
    // the previous generation as the prune safety set, and compact once.
    const current = [...new Set(await readReferencesChunk(input.dataDir, generation))].sort()
    const previous = await readCompactedReferences(input.dataDir, generation - 1)
    if (previous.length > 0) {
      const safeReferences = new Set([...previous, ...current])
      const now = Date.parse(input.nowIso())
      if (Number.isFinite(now)) {
        await attachmentStore.pruneExpiredLeases(
          safeReferences,
          new Date(now - 24 * 60 * 60 * 1_000).toISOString()
        )
      }
    }
    bytesWritten += await writeCompactedReferences(input.dataDir, generation, current)
    await removeGenerationFiles(input.dataDir, generation - 1)
    await removeGenerationFiles(input.dataDir, generation, { json: false, jsonl: true })
    state.attachments = { generation: generation + 1 }
    await saveState(state)
    recordSlice(startedAt, processed)
    return true
  }

  const runGuardianSlice = async (): Promise<boolean> => {
    if (await shouldPause()) {
      paused += 1
      return false
    }
    const startedAt = Date.now()
    const state = await readState()
    const page = await input.threads.listPage({
      limit: MAINTENANCE_SLICE_MAX_THREADS,
      includeArchived: true,
      includeSide: true,
      cursor: state.guardian.cursor
    })
    const loopStartedAt = Date.now()
    const warnings: string[] = []
    let processed = 0
    const pageOffset = Math.min(state.guardian.pageOffset ?? 0, page.threads.length)
    for (const summary of page.threads.slice(pageOffset)) {
      const remaining = MAINTENANCE_SLICE_MAX_MS - (Date.now() - loopStartedAt)
      if (processed > 0 && remaining <= 0) break
      const result = await withDeadline(input.guardian.scanThread(summary.id), Math.max(0, remaining))
      if (result.timedOut) {
        overshoots += 1
        break
      }
      const report = result.value
      await input.onGuardianReport?.(report)
      if (report.warnings.length > 0) warnings.push(`${summary.id}:${report.warnings.join(',')}`)
      processed += 1
    }
    if (warnings.length > 0) input.log?.(`[kun] quick guardian warnings: ${warnings.length}`)
    const consumedPage = pageOffset + processed === page.threads.length
    if (page.hasMore && consumedPage && page.nextCursor) {
      state.guardian.cursor = page.nextCursor
      state.guardian.pageOffset = 0
    } else if (!consumedPage) state.guardian.pageOffset = pageOffset + processed
    else if (consumedPage) state.guardian = {}
    await saveState(state)
    recordSlice(startedAt, processed)
    return consumedPage && !page.hasMore
  }

  return {
    runAttachmentSlice,
    runGuardianSlice,
    stats: (): RuntimeMaintenanceSliceStats => ({
      slices,
      paused,
      maxDurationMs,
      processedThreads,
      bytesWritten,
      overshoots
    })
  }
}

/**
 * Wait for a read-only operation but abandon it after `timeoutMs`. On timeout
 * the underlying promise is left to settle in the background (a `.catch` is
 * attached to suppress any unhandled rejection); genuine rejections before the
 * deadline still propagate so callers see real failures.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<DeadlineResult<T>> {
  if (timeoutMs <= 0) {
    promise.catch(() => undefined)
    return Promise.resolve({ timedOut: true })
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      promise.catch(() => undefined)
      resolve({ timedOut: true })
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ timedOut: false, value })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
