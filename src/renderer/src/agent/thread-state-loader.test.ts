import { describe, expect, it, vi } from 'vitest'
import type { AgentProvider } from './provider-types'
import {
  loadThreadStates,
  THREAD_STATE_FALLBACK_CONCURRENCY
} from './thread-state-loader'

describe('loadThreadStates', () => {
  it('falls back from an unavailable batch route with bounded single reads', async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `thr_${index}`)
    let active = 0
    let maxActive = 0
    const provider = {
      getThreadStates: vi.fn(async () => {
        throw new Error(JSON.stringify({ code: 'not_found', message: 'legacy route not found' }))
      }),
      getThreadState: vi.fn(async (id: string) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 0))
        active -= 1
        return {
          status: 'idle',
          updatedAt: '',
          latestSeq: Number(id.slice(4)),
          pendingUserInputIds: []
        }
      })
    } satisfies Pick<AgentProvider, 'getThreadState' | 'getThreadStates'>

    const results = await loadThreadStates(provider, ids)

    expect(provider.getThreadStates).toHaveBeenCalledWith(ids)
    expect(provider.getThreadState).toHaveBeenCalledTimes(20)
    expect(maxActive).toBe(THREAD_STATE_FALLBACK_CONCURRENCY)
    expect(results.every((result) => result.ok)).toBe(true)
  })

  it('does not fan out single reads after a transient batch failure', async () => {
    const provider = {
      getThreadStates: vi.fn(async () => {
        throw new Error(JSON.stringify({ code: 'runtime_offline', message: 'restarting' }))
      }),
      getThreadState: vi.fn()
    } satisfies Pick<AgentProvider, 'getThreadState' | 'getThreadStates'>

    const results = await loadThreadStates(provider, ['thr_1', 'thr_2'])

    expect(provider.getThreadState).not.toHaveBeenCalled()
    expect(results).toEqual([
      expect.objectContaining({ id: 'thr_1', ok: false }),
      expect.objectContaining({ id: 'thr_2', ok: false })
    ])
  })
})
