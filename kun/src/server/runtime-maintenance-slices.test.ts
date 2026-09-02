import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadService } from '../services/thread-service.js'
import type { SessionGuardian } from '../services/session-guardian.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import {
  createRuntimeMaintenanceSlices,
  MAINTENANCE_SLICE_MAX_THREADS
} from './runtime-maintenance-slices.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function threadHarness(count: number) {
  const ids = Array.from({ length: count }, (_, index) => `thread-${index}`)
  const listPage = vi.fn(async (options?: { cursor?: string; limit?: number }) => {
    const start = Number(options?.cursor ?? 0)
    const limit = options?.limit ?? MAINTENANCE_SLICE_MAX_THREADS
    const page = ids.slice(start, start + limit)
    const next = start + page.length
    return {
      threads: page.map((id) => ({ id, status: 'idle', updatedAt: id })),
      hasMore: next < ids.length,
      ...(next < ids.length ? { nextCursor: String(next) } : {})
    }
  })
  const get = vi.fn(async (id: string) => ({
    id,
    turns: [{ attachmentIds: [`attachment-${id}`] }]
  }))
  return { ids, listPage, get, service: { listPage, get } as unknown as ThreadService }
}

describe('runtime maintenance slices', () => {
  it('persists progress and waits for two complete reference generations before pruning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-maintenance-resume-'))
    roots.push(root)
    const threads = threadHarness(10)
    const pruneExpiredLeases = vi.fn(async (
      _references: ReadonlySet<string>,
      _expiresBeforeIso: string
    ) => undefined)
    const attachmentStore = { pruneExpiredLeases } as unknown as AttachmentStore
    const guardian = { scanThread: vi.fn(async () => ({ warnings: [] })) } as unknown as SessionGuardian
    const create = () => createRuntimeMaintenanceSlices({
      dataDir: root,
      threads: threads.service,
      attachments: () => attachmentStore,
      guardian,
      nowIso: () => '2026-09-03T00:00:00.000Z'
    })

    const first = create()
    await expect(first.runAttachmentSlice()).resolves.toBe(false)
    expect(pruneExpiredLeases).not.toHaveBeenCalled()
    const resumed = create()
    await expect(resumed.runAttachmentSlice()).resolves.toBe(true)
    expect(pruneExpiredLeases).not.toHaveBeenCalled()
    await expect(resumed.runAttachmentSlice()).resolves.toBe(false)
    await expect(resumed.runAttachmentSlice()).resolves.toBe(true)

    expect(pruneExpiredLeases).toHaveBeenCalledOnce()
    const references = pruneExpiredLeases.mock.calls[0]![0] as Set<string>
    expect(references.size).toBe(10)
    expect(threads.get).toHaveBeenCalledTimes(20)
  })

  it('pauses without touching the inventory while a turn is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-maintenance-paused-'))
    roots.push(root)
    const threads = threadHarness(20)
    const slices = createRuntimeMaintenanceSlices({
      dataDir: root,
      threads: threads.service,
      attachments: () => ({ pruneExpiredLeases: vi.fn() }) as unknown as AttachmentStore,
      guardian: { scanThread: vi.fn() } as unknown as SessionGuardian,
      nowIso: () => '2026-09-03T00:00:00.000Z',
      hasActiveTurns: async () => true
    })

    await expect(slices.runAttachmentSlice()).resolves.toBe(false)
    await expect(slices.runGuardianSlice()).resolves.toBe(false)
    expect(threads.listPage).not.toHaveBeenCalled()
    expect(slices.stats()).toMatchObject({ paused: 2, processedThreads: 0 })
  })
})
