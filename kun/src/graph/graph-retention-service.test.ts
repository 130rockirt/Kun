import { describe, expect, it, vi } from 'vitest'
import type { GraphRunV1 } from '../contracts/graph.js'
import { GraphRetentionService } from './graph-retention-service.js'
import { testGraphConfig } from './graph-test-fixtures.test-support.js'

describe('GraphRetentionService', () => {
  it('removes only expired terminal runs without live thread references', async () => {
    const remove = vi.fn(async () => undefined)
    const old = '2026-07-20T00:00:00.000Z'
    const recent = '2026-07-26T00:00:00.000Z'
    const service = new GraphRetentionService({
      runs: {
        list: vi.fn(async () => [
          { id: 'run_expired', updatedAt: old, status: 'completed', artifacts: [], nodes: {} },
          { id: 'run_referenced', updatedAt: old, status: 'completed', artifacts: [], nodes: {} },
          { id: 'run_recent', updatedAt: recent, status: 'completed', artifacts: [], nodes: {} }
        ] as unknown as GraphRunV1[]),
        remove
      } as never,
      references: {
        compact: vi.fn(async () => 2),
        referencedRunIds: vi.fn(async () => new Set(['run_referenced']))
      },
      registry: {
        listProjectIdentities: vi.fn(async () => [
          { projectId: 'project_a' },
          { projectId: 'project_b' }
        ] as never),
        compactRetention: vi.fn(async (projectId: string) => ({
          auditRemoved: projectId === 'project_a' ? 4 : 1
        }))
      },
      learning: {
        compactRetention: vi.fn(async (projectId: string) => projectId === 'project_a'
          ? { episodesRemoved: 3, jobsRemoved: 1 }
          : { episodesRemoved: 2, jobsRemoved: 4 })
      },
      config: () => testGraphConfig({ retention: { graphDays: 2 } }),
      nowIso: () => '2026-07-26T12:00:00.000Z'
    })

    await expect(service.run()).resolves.toEqual({
      referencesRemoved: 2,
      runsRemoved: 1,
      episodesRemoved: 5,
      jobsRemoved: 5,
      auditRemoved: 5,
      artifactsRemoved: 0,
      retainedReferencedRuns: 1
    })
    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('run_expired')
  })

  it('coalesces concurrent maintenance requests', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const list = vi.fn(async () => {
      await wait
      return []
    })
    const service = new GraphRetentionService({
      runs: { list, remove: vi.fn() } as never,
      references: {
        compact: vi.fn(async () => 0),
        referencedRunIds: vi.fn(async () => new Set<string>())
      },
      registry: {
        listProjectIdentities: vi.fn(async () => []),
        compactRetention: vi.fn()
      },
      learning: { compactRetention: vi.fn() },
      config: () => testGraphConfig(),
      nowIso: () => '2026-07-26T12:00:00.000Z'
    })
    const first = service.run()
    const second = service.run()
    expect(second).toBe(first)
    release()
    await first
    expect(list).toHaveBeenCalledOnce()
  })

  it('deletes only expired unreferenced artifacts owned exclusively by Graph', async () => {
    const removeArtifact = vi.fn(async () => undefined)
    const old = '2026-07-20T00:00:00.000Z'
    const retainedRun = {
      id: 'run_live',
      status: 'running',
      updatedAt: old,
      artifacts: [{ artifactId: 'art_protected', retention: 'run' }],
      nodes: {
        work: { attempts: [{ id: 'attempt_live' }] }
      }
    } as unknown as GraphRunV1
    const service = new GraphRetentionService({
      runs: {
        list: vi.fn(async () => [retainedRun]),
        remove: vi.fn()
      } as never,
      references: {
        compact: vi.fn(async () => 0),
        referencedRunIds: vi.fn(async () => new Set<string>())
      },
      registry: {
        listProjectIdentities: vi.fn(async () => []),
        compactRetention: vi.fn()
      },
      learning: { compactRetention: vi.fn() },
      artifacts: {
        list: vi.fn(async () => [
          {
            id: 'art_expired',
            byteSize: 10,
            lineCount: 1,
            createdAt: old,
            origins: ['graph:run_removed'],
            originHistoryComplete: true as const
          },
          {
            id: 'art_protected',
            byteSize: 10,
            lineCount: 1,
            createdAt: old,
            origins: ['graph:run_live'],
            originHistoryComplete: true as const
          },
          {
            id: 'art_shared',
            byteSize: 10,
            lineCount: 1,
            createdAt: old,
            origins: ['graph:run_removed', 'web_fetch'],
            originHistoryComplete: true as const
          },
          {
            id: 'art_legacy',
            byteSize: 10,
            lineCount: 1,
            createdAt: old,
            origin: 'graph:run_removed'
          }
        ]),
        delete: removeArtifact
      },
      config: () => testGraphConfig({ retention: { artifactDays: 2 } }),
      nowIso: () => '2026-07-26T12:00:00.000Z'
    })

    await expect(service.run()).resolves.toMatchObject({ artifactsRemoved: 1 })
    expect(removeArtifact).toHaveBeenCalledOnce()
    expect(removeArtifact).toHaveBeenCalledWith('art_expired')
  })
})
