import { describe, expect, it, vi } from 'vitest'
import type { RuntimeHandoffDiscoveryRecord } from '../../../kun/src/server/runtime-discovery.js'
import type { ManagerHandoffDiscoveryRecord } from '../../../kun/src/manager/manager-discovery.js'
import {
  drainKunOwnersForHandoff,
  KunHandoffError,
  withDrainedKunOwners
} from './kun-installed-build-handoff'

const controlDir = '/tmp/kun-control'
const dataDir = '/tmp/kun-data'
const settingsPath = '/tmp/Kun/kun-settings.json'

function manager(
  overrides: Partial<ManagerHandoffDiscoveryRecord> = {}
): ManagerHandoffDiscoveryRecord {
  return {
    version: 7,
    protocolVersion: 3,
    instanceId: 'manager-old',
    pid: 900,
    startedAt: '2026-08-21T00:00:00.000Z',
    host: '127.0.0.1',
    port: 43000,
    baseUrl: 'http://127.0.0.1:43000',
    managerToken: 'manager-secret',
    dataDir,
    settingsPath,
    ...overrides
  }
}

function runtime(
  flavor: 'production' | 'development',
  overrides: Partial<RuntimeHandoffDiscoveryRecord> = {}
): RuntimeHandoffDiscoveryRecord {
  const development = flavor === 'development'
  return {
    version: 1,
    instanceId: `${flavor}-old`,
    pid: development ? 902 : 901,
    startedAt: '2026-08-21T00:00:00.000Z',
    host: '127.0.0.1',
    port: development ? 43002 : 43001,
    baseUrl: `http://127.0.0.1:${development ? 43002 : 43001}`,
    runtimeToken: `${flavor}-secret`,
    ...(development ? { flavor } : {}),
    ...overrides
  }
}

function input() {
  return {
    reason: 'installed-build-change' as const,
    dataDirs: [dataDir],
    settingsPath,
    controlDir,
    targetBuildId: 'b'.repeat(64)
  }
}

describe('installed build handoff coordinator', () => {
  it('drains both Runtime flavors and an older-schema Manager under one lock', async () => {
    const currentManager = manager()
    const currentRuntimes = new Map([
      ['production', runtime('production')],
      ['development', runtime('development')]
    ] as const)
    let managerAlive = true
    let lockHeld = false
    const order: string[] = []
    const stopRuntime = vi.fn(async (
      _dataDir: string,
      target: { discovery: RuntimeHandoffDiscoveryRecord }
    ) => {
      expect(lockHeld).toBe(true)
      const flavor = target.discovery.flavor ?? 'production'
      order.push(`runtime:${flavor}`)
      currentRuntimes.delete(flavor)
      return { stopped: true, forced: flavor === 'development' }
    })
    const stopManager = vi.fn(async () => {
      expect(lockHeld).toBe(true)
      order.push('manager')
      managerAlive = false
      return { stopped: true, forced: false }
    })
    const fetchMock = vi.fn(async () => Response.json({
      instanceId: currentManager.instanceId,
      pid: currentManager.pid,
      startedAt: currentManager.startedAt,
      slots: [...currentRuntimes.values()].map((registration) => ({ registration: {
        ...registration,
        flavor: registration.flavor ?? 'production'
      } }))
    }))

    const report = await drainKunOwnersForHandoff({ ...input(), fetch: fetchMock as unknown as typeof fetch }, {
      withManagerLock: async <T>(_dir: string, action: () => Promise<T>) => {
        lockHeld = true
        try { return await action() } finally { lockHeld = false }
      },
      readManager: async () => managerAlive ? currentManager : null,
      readRuntime: async (_dir, flavor) => currentRuntimes.get(flavor ?? 'production') ?? null,
      processAlive: (pid) => managerAlive && pid === currentManager.pid ||
        [...currentRuntimes.values()].some((record) => record.pid === pid),
      recordForcedOwner: vi.fn(async () => ({ markerId: 'marker' })) as never,
      stopRuntime: stopRuntime as never,
      stopManager: stopManager as never,
      now: (() => { let value = 100; return () => value += 5 })()
    })

    expect(order).toEqual(['runtime:production', 'runtime:development', 'manager'])
    expect(report.owners).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime', flavor: 'production', result: 'graceful' }),
      expect.objectContaining({ kind: 'runtime', flavor: 'development', result: 'forced' }),
      expect.objectContaining({ kind: 'manager', result: 'graceful' })
    ]))
  })

  it('uses minimally parsed Manager slots when filesystem discovery is absent', async () => {
    const currentManager = manager()
    const slot = runtime('production')
    let runtimeAlive = true
    let managerAlive = true
    const stopRuntime = vi.fn(async () => {
      runtimeAlive = false
      return { stopped: true, forced: false }
    })
    const fetchMock = vi.fn(async () => Response.json({
      instanceId: currentManager.instanceId,
      pid: currentManager.pid,
      startedAt: currentManager.startedAt,
      futureStatusField: true,
      slots: [{ registration: { ...slot, flavor: 'production', futureSlotField: true } }]
    }))

    await expect(drainKunOwnersForHandoff({
      ...input(),
      fetch: fetchMock as unknown as typeof fetch
    }, {
      withManagerLock: async <T>(_dir: string, action: () => Promise<T>) => action(),
      readManager: async () => managerAlive ? currentManager : null,
      readRuntime: async () => null,
      processAlive: (pid) => pid === slot.pid ? runtimeAlive : managerAlive,
      stopRuntime: stopRuntime as never,
      stopManager: (async () => {
        managerAlive = false
        return { stopped: true, forced: false }
      }) as never
    })).resolves.toMatchObject({ reason: 'installed-build-change' })

    expect(stopRuntime).toHaveBeenCalledOnce()
  })

  it('re-discovers and drains a replacement Runtime that races the first pass', async () => {
    const first = runtime('production')
    const second = runtime('production', {
      instanceId: 'production-raced',
      pid: 903,
      startedAt: '2026-08-21T00:01:00.000Z',
      port: 43003,
      baseUrl: 'http://127.0.0.1:43003'
    })
    let current: RuntimeHandoffDiscoveryRecord | null = first
    const stopped: string[] = []

    await drainKunOwnersForHandoff(input(), {
      withManagerLock: async <T>(_dir: string, action: () => Promise<T>) => action(),
      readManager: async () => null,
      readRuntime: async (_dir, flavor) => flavor === 'production' ? current : null,
      processAlive: (pid) => current?.pid === pid,
      stopRuntime: (async (_dir: string, target: { discovery: RuntimeHandoffDiscoveryRecord }) => {
        stopped.push(target.discovery.instanceId)
        current = target.discovery.instanceId === first.instanceId ? second : null
        return { stopped: true, forced: false }
      }) as never,
      stopManager: vi.fn() as never
    })

    expect(stopped).toEqual([first.instanceId, second.instanceId])
  })

  it('fails closed before stopping anything when Manager settings scope differs', async () => {
    const stopRuntime = vi.fn()
    const stopManager = vi.fn()
    const failure = await drainKunOwnersForHandoff(input(), {
      withManagerLock: async <T>(_dir: string, action: () => Promise<T>) => action(),
      readManager: async () => manager({ settingsPath: '/tmp/Other/settings.json' }),
      readRuntime: async () => null,
      processAlive: () => true,
      stopRuntime: stopRuntime as never,
      stopManager: stopManager as never
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(KunHandoffError)
    expect(failure).toMatchObject({ code: 'unsafe_scope', retryable: false })
    expect(stopRuntime).not.toHaveBeenCalled()
    expect(stopManager).not.toHaveBeenCalled()
  })

  it('wraps an ambiguous Runtime failure and preserves the Manager', async () => {
    const target = runtime('production')
    const stopManager = vi.fn()
    const failure = await drainKunOwnersForHandoff(input(), {
      withManagerLock: async <T>(_dir: string, action: () => Promise<T>) => action(),
      readManager: async () => manager(),
      readRuntime: async (_dir, flavor) => flavor === 'production' ? target : null,
      processAlive: () => true,
      stopRuntime: (async () => { throw new Error('identity proof failed') }) as never,
      stopManager: stopManager as never
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(KunHandoffError)
    expect(failure).toMatchObject({
      code: 'runtime_stop_failed',
      phase: 'stop-runtimes',
      owner: { kind: 'runtime', flavor: 'production', pid: target.pid }
    })
    expect(String((failure as Error).message)).not.toContain(target.runtimeToken)
    expect(stopManager).not.toHaveBeenCalled()
  })

  it('runs the post-drain action before releasing the Manager election lock', async () => {
    let lockHeld = false
    const result = await withDrainedKunOwners(input(), async () => {
      expect(lockHeld).toBe(true)
      return 'manager-started'
    }, {
      withManagerLock: async <T>(_dir: string, action: () => Promise<T>) => {
        lockHeld = true
        try { return await action() } finally { lockHeld = false }
      },
      readManager: async () => null,
      readRuntime: async () => null,
      processAlive: () => false,
      stopRuntime: vi.fn() as never,
      stopManager: vi.fn() as never
    })

    expect(lockHeld).toBe(false)
    expect(result.value).toBe('manager-started')
  })
})
