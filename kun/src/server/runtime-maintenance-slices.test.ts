import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadService } from '../services/thread-service.js'
import type { SessionGuardian } from '../services/session-guardian.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import {
  createRuntimeMaintenanceSlices,
  MAINTENANCE_SLICE_MAX_MS,
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

  it('migrates a v1 state file without losing the prune safety set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-maintenance-migrate-'))
    roots.push(root)
    const threads = threadHarness(10)
    const pruneExpiredLeases = vi.fn(async (
      _references: ReadonlySet<string>,
      _expiresBeforeIso: string
    ) => undefined)
    const attachmentStore = { pruneExpiredLeases } as unknown as AttachmentStore
    const guardian = { scanThread: vi.fn(async () => ({ warnings: [] })) } as unknown as SessionGuardian
    await writeFile(join(root, 'maintenance-state.json'), JSON.stringify({
      version: 1,
      attachments: {
        generation: 2,
        references: ['attachment-thread-0'],
        previousReferences: ['attachment-thread-0', 'attachment-thread-1']
      },
      guardian: {}
    }))

    const maintenance = createRuntimeMaintenanceSlices({
      dataDir: root,
      threads: threads.service,
      attachments: () => attachmentStore,
      guardian,
      nowIso: () => '2026-09-03T00:00:00.000Z'
    })

    let complete = false
    while (!complete) complete = await maintenance.runAttachmentSlice()

    // The migrated previousReferences become generation 1's compacted file, so
    // a single full pass over generation 2 is enough to trigger prune.
    expect(pruneExpiredLeases).toHaveBeenCalledOnce()
    const safeReferences = pruneExpiredLeases.mock.calls[0]![0] as Set<string>
    expect(safeReferences.has('attachment-thread-0')).toBe(true)
    expect(safeReferences.has('attachment-thread-1')).toBe(true)
    expect(safeReferences.size).toBe(10)

    const persisted = JSON.parse(await readFile(join(root, 'maintenance-state.json'), 'utf8')) as {
      version: number
      attachments: { references?: unknown }
    }
    expect(persisted.version).toBe(2)
    expect(persisted.attachments.references).toBeUndefined()
  })

  it('dedupes duplicate and malformed chunk lines across a crash recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-maintenance-dedupe-'))
    roots.push(root)
    const threads = threadHarness(10)
    const pruneExpiredLeases = vi.fn(async (
      _references: ReadonlySet<string>,
      _expiresBeforeIso: string
    ) => undefined)
    const attachmentStore = { pruneExpiredLeases } as unknown as AttachmentStore
    const guardian = { scanThread: vi.fn(async () => ({ warnings: [] })) } as unknown as SessionGuardian
    await mkdir(join(root, 'maintenance-attachments'), { recursive: true })
    await writeFile(join(root, 'maintenance-attachments', 'gen-0.jsonl'), [
      JSON.stringify(['attachment-thread-0', 'attachment-thread-0', 'stale-extra']),
      'not-a-json-line',
      JSON.stringify(['attachment-thread-1'])
    ].join('\n') + '\n')

    const maintenance = createRuntimeMaintenanceSlices({
      dataDir: root,
      threads: threads.service,
      attachments: () => attachmentStore,
      guardian,
      nowIso: () => '2026-09-03T00:00:00.000Z'
    })

    let complete = false
    while (!complete) complete = await maintenance.runAttachmentSlice()
    const compacted = JSON.parse(
      await readFile(join(root, 'maintenance-attachments', 'gen-0.json'), 'utf8')
    ) as string[]
    expect(new Set(compacted).size).toBe(compacted.length)
    expect(compacted).toContain('attachment-thread-0')
    expect(compacted).toContain('attachment-thread-1')
    expect(compacted).toContain('stale-extra')

    // Run the second generation so prune exercises the recovered safe set.
    complete = false
    while (!complete) complete = await maintenance.runAttachmentSlice()
    expect(pruneExpiredLeases).toHaveBeenCalledOnce()
    const safe = pruneExpiredLeases.mock.calls[0]![0] as Set<string>
    expect(safe.has('attachment-thread-0')).toBe(true)
    expect(safe.has('attachment-thread-1')).toBe(true)
    expect(safe.has('stale-extra')).toBe(true)
    expect(safe.size).toBe(11)
  })

  it('keeps total write volume linear for a large profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-maintenance-amplify-'))
    roots.push(root)
    const threads = threadHarness(200)
    const pruneExpiredLeases = vi.fn(async () => undefined)
    const maintenance = createRuntimeMaintenanceSlices({
      dataDir: root,
      threads: threads.service,
      attachments: () => ({ pruneExpiredLeases }) as unknown as AttachmentStore,
      guardian: { scanThread: vi.fn(async () => ({ warnings: [] })) } as unknown as SessionGuardian,
      nowIso: () => '2026-09-03T00:00:00.000Z'
    })

    for (let generation = 0; generation < 2; generation += 1) {
      let complete = false
      while (!complete) complete = await maintenance.runAttachmentSlice()
    }
    const compactText = await readFile(join(root, 'maintenance-attachments', 'gen-1.json'), 'utf8')
    const compactBytes = Buffer.byteLength(compactText, 'utf8')
    // Chunked appends + compacted files + bounded cursor writes stay O(N); the
    // old cumulative whole-file rewrite grew quadratically with the profile.
    expect(maintenance.stats().bytesWritten).toBeLessThanOrEqual(12 * compactBytes)
    expect(pruneExpiredLeases).toHaveBeenCalledOnce()
  })

  it('bounds a slice even when every read is measurably slow', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'kun-maintenance-duration-'))
      roots.push(root)
      const ids = Array.from({ length: 200 }, (_, index) => `thread-${index}`)
      const listPage = vi.fn(async (options?: { cursor?: string; limit?: number }) => {
        const start = Number(options?.cursor ?? 0)
        const page = ids.slice(start, start + (options?.limit ?? 8))
        const next = start + page.length
        return {
          threads: page.map((id) => ({ id, status: 'idle', updatedAt: id })),
          hasMore: next < ids.length,
          ...(next < ids.length ? { nextCursor: String(next) } : {})
        }
      })
      const get = vi.fn(async (id: string) => {
        vi.setSystemTime(Date.now() + 30)
        return { id, turns: [{ attachmentIds: [`a-${id}`] }] }
      })
      const maintenance = createRuntimeMaintenanceSlices({
        dataDir: root,
        threads: { listPage, get } as unknown as ThreadService,
        attachments: () => ({ pruneExpiredLeases: vi.fn() }) as unknown as AttachmentStore,
        guardian: { scanThread: vi.fn() } as unknown as SessionGuardian,
        nowIso: () => '2026-09-03T00:00:00.000Z'
      })

      await maintenance.runAttachmentSlice()
      expect(maintenance.stats().maxDurationMs).toBeLessThanOrEqual(MAINTENANCE_SLICE_MAX_MS + 40)
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons a single hung read and retries it on the next slice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-maintenance-overshoot-'))
    roots.push(root)
    const ids = ['thread-0', 'thread-1']
    const listPage = vi.fn(async () => ({
      threads: ids.map((id) => ({ id, status: 'idle', updatedAt: id })),
      hasMore: false
    }))
    let getCalls = 0
    const get = vi.fn((id: string) => {
      getCalls += 1
      if (getCalls === 1) return new Promise(() => undefined)
      return Promise.resolve({ id, turns: [{ attachmentIds: [`a-${id}`] }] })
    })
    const maintenance = createRuntimeMaintenanceSlices({
      dataDir: root,
      threads: { listPage, get } as unknown as ThreadService,
      attachments: () => ({ pruneExpiredLeases: vi.fn() }) as unknown as AttachmentStore,
      guardian: { scanThread: vi.fn() } as unknown as SessionGuardian,
      nowIso: () => '2026-09-03T00:00:00.000Z'
    })

    await expect(maintenance.runAttachmentSlice()).resolves.toBe(false)
    expect(maintenance.stats().overshoots).toBe(1)
    expect(maintenance.stats().processedThreads).toBe(0)

    await expect(maintenance.runAttachmentSlice()).resolves.toBe(true)
    expect(maintenance.stats().processedThreads).toBe(2)
    expect(get).toHaveBeenCalledTimes(3)
  })
})
