import { describe, expect, it, vi } from 'vitest'
import { emptyUsageSnapshot } from '../../contracts/usage.js'
import type { ServerRuntime } from './server-runtime.js'
import { usageJsonResponse } from './usage.js'

describe('usageJsonResponse', () => {
  it('coalesces concurrent all-thread usage record loads', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const loadUsageRecords = vi.fn(async () => {
      await gate
      return []
    })
    const runtime = runtimeFixture({
      loadUsageRecords,
      list: vi.fn(async () => [])
    })

    const daily = usageJsonResponse(request('day', '2026-08-01', '2026-08-09'), runtime)
    const model = usageJsonResponse(request('model', '2026-08-01', '2026-08-09'), runtime)

    await vi.waitFor(() => expect(loadUsageRecords).toHaveBeenCalledTimes(1))
    release()
    const responses = await Promise.all([daily, model])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
  })

  it('reuses thread summaries when the optional usage index is unavailable', async () => {
    const get = vi.fn(async () => null)
    const list = vi.fn(async () => [{
      id: 'thread-1',
      model: 'fixture-model',
      updatedAt: '2026-08-09T00:00:00.000Z'
    }])
    const runtime = runtimeFixture({
      loadUsageRecords: vi.fn(async () => { throw new Error('index unavailable') }),
      loadEventsSince: vi.fn(async () => []),
      get,
      list
    })

    const response = await usageJsonResponse(
      request('day', '2026-08-01', '2026-08-09'),
      runtime
    )

    expect(response.status).toBe(200)
    expect(list).toHaveBeenCalledTimes(1)
    expect(get).not.toHaveBeenCalled()
  })
})

function request(groupBy: 'day' | 'model', from: string, to: string): Request {
  const params = new URLSearchParams({
    group_by: groupBy,
    from,
    to,
    timezone: 'UTC'
  })
  return new Request(`http://kun.local/v1/usage?${params.toString()}`)
}

function runtimeFixture(overrides: {
  get?: (threadId: string) => Promise<unknown>
  list: () => Promise<unknown[]>
  loadEventsSince?: (threadId: string, sinceSeq: number) => Promise<unknown[]>
  loadUsageRecords: () => Promise<unknown[]>
}): ServerRuntime {
  return {
    threadService: {
      get: overrides.get ?? vi.fn(async () => null),
      list: overrides.list
    },
    sessionStore: {
      loadEventsSince: overrides.loadEventsSince ?? vi.fn(async () => []),
      loadUsageRecords: overrides.loadUsageRecords
    },
    usageService: {
      forThread: () => emptyUsageSnapshot()
    },
    nowIso: () => '2026-08-09T00:00:00.000Z'
  } as unknown as ServerRuntime
}
