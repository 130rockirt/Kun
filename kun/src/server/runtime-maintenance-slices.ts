import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { ThreadService } from '../services/thread-service.js'
import type { SessionGuardian } from '../services/session-guardian.js'
import type { ThreadHealthReport } from '../services/session-guardian.js'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { optionalRuntimeWorkPaused } from './runtime-load-shedder.js'

export const MAINTENANCE_SLICE_MAX_THREADS = 8
export const MAINTENANCE_SLICE_MAX_MS = 50

const ScanStateSchema = z.object({
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

export type RuntimeMaintenanceSliceStats = {
  slices: number
  paused: number
  maxDurationMs: number
  processedThreads: number
}

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

  const readState = (): Promise<ScanState> => {
    if (!statePromise) statePromise = readFile(statePath, 'utf8')
      .then((text) => ScanStateSchema.parse(JSON.parse(text)))
      .catch(() => freshState())
    return statePromise
  }
  const saveState = async (state: ScanState): Promise<void> => {
    await atomicWriteFile(statePath, JSON.stringify(state))
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
    const page = await input.threads.listPage({
      limit: MAINTENANCE_SLICE_MAX_THREADS,
      includeArchived: true,
      includeSide: true,
      cursor: state.attachments.cursor
    })
    const references = new Set(state.attachments.references)
    let processed = 0
    const pageOffset = Math.min(state.attachments.pageOffset ?? 0, page.threads.length)
    for (const summary of page.threads.slice(pageOffset)) {
      if (Date.now() - startedAt >= MAINTENANCE_SLICE_MAX_MS && processed > 0) break
      const thread = await input.threads.get(summary.id)
      for (const turn of thread?.turns ?? []) {
        for (const id of turn.attachmentIds ?? []) references.add(id)
      }
      processed += 1
    }
    const consumedPage = pageOffset + processed === page.threads.length
    if (page.hasMore && consumedPage && page.nextCursor) {
      state.attachments.cursor = page.nextCursor
      state.attachments.pageOffset = 0
      state.attachments.references = [...references]
      await saveState(state)
      recordSlice(startedAt, processed)
      return false
    }
    if (!consumedPage) {
      state.attachments.pageOffset = pageOffset + processed
      state.attachments.references = [...references]
      await saveState(state)
      recordSlice(startedAt, processed)
      return false
    }

    const previous = state.attachments.previousReferences
    if (previous) {
      const safeReferences = new Set([...previous, ...references])
      const now = Date.parse(input.nowIso())
      if (Number.isFinite(now)) {
        await attachmentStore.pruneExpiredLeases(
          safeReferences,
          new Date(now - 24 * 60 * 60 * 1_000).toISOString()
        )
      }
    }
    state.attachments = {
      generation: state.attachments.generation + 1,
      references: [],
      previousReferences: [...references]
    }
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
    const warnings: string[] = []
    let processed = 0
    const pageOffset = Math.min(state.guardian.pageOffset ?? 0, page.threads.length)
    for (const summary of page.threads.slice(pageOffset)) {
      if (Date.now() - startedAt >= MAINTENANCE_SLICE_MAX_MS && processed > 0) break
      const report = await input.guardian.scanThread(summary.id)
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
      processedThreads
    })
  }
}

function freshState(): ScanState {
  return {
    version: 1,
    attachments: { generation: 0, references: [] },
    guardian: {}
  }
}
