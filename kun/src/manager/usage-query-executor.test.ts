import { describe, expect, it, vi } from 'vitest'
import type { SessionUsageAggregateResponse } from '../contracts/usage-query.js'
import { UsageQueryExecutor } from './usage-query-executor.js'

describe('UsageQueryExecutor invalidation', () => {
  it('does not reuse or cache an in-flight result from an invalidated epoch', async () => {
    const deferred: Array<{
      resolve: (value: SessionUsageAggregateResponse) => void
      promise: Promise<SessionUsageAggregateResponse>
    }> = []
    const runner = vi.fn(() => {
      let resolve!: (value: SessionUsageAggregateResponse) => void
      const promise = new Promise<SessionUsageAggregateResponse>((done) => { resolve = done })
      deferred.push({ resolve, promise })
      return promise
    })
    const executor = new UsageQueryExecutor('/tmp/not-opened.sqlite3', runner)
    const query = { groupBy: 'thread' as const, threadId: 'thread-1' }
    const stale = executor.execute(query)
    executor.invalidate()
    const fresh = executor.execute(query)

    expect(runner).toHaveBeenCalledTimes(2)
    deferred[0]!.resolve(threadResponse(1))
    deferred[1]!.resolve(threadResponse(2))
    await expect(stale).resolves.toMatchObject({ totals: { turns: 1 } })
    await expect(fresh).resolves.toMatchObject({ totals: { turns: 2 } })
    await expect(executor.execute(query)).resolves.toMatchObject({ totals: { turns: 2 } })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('bounds the recent-result cache', async () => {
    const runner = vi.fn(async () => threadResponse(1))
    const executor = new UsageQueryExecutor('/tmp/not-opened.sqlite3', runner)
    for (let index = 0; index < 33; index += 1) {
      await executor.execute({ groupBy: 'thread', threadId: `thread-${index}` })
    }
    await executor.execute({ groupBy: 'thread', threadId: 'thread-0' })
    expect(runner).toHaveBeenCalledTimes(34)
  })
})

function threadResponse(turns: number): SessionUsageAggregateResponse {
  return {
    group_by: 'thread',
    buckets: [],
    totals: {
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cache_miss_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      cost_cny: 0,
      value_estimate_usd: 0,
      value_estimate_cny: 0,
      value_estimate_coverage: 'unavailable',
      value_estimate_priced_requests: 0,
      value_estimate_unpriced_requests: 0,
      cache_savings_usd: 0,
      cache_savings_cny: 0,
      token_economy_savings_tokens: 0,
      token_economy_savings_usd: 0,
      token_economy_savings_cny: 0,
      turns,
      thread_count: 0,
      cache_hit_rate: null
    }
  }
}
