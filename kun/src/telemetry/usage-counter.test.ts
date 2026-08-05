import { describe, expect, it } from 'vitest'
import { emptyUsageSnapshot } from '../contracts/usage.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import { UsageCounter } from './usage-counter.js'

function snapshot(overrides: Partial<UsageSnapshot>): UsageSnapshot {
  return { ...emptyUsageSnapshot(), ...overrides }
}

describe('UsageCounter.total cross-thread aggregate', () => {
  it('unions cache miss reasons across threads instead of dropping them', () => {
    const counter = new UsageCounter()
    counter.record(
      'thread-a',
      snapshot({
        promptTokens: 100,
        cacheHitTokens: 60,
        cacheMissTokens: 40,
        cacheMissReasons: ['cold_request'],
        cacheSuggestions: ['warm the cache']
      })
    )
    counter.record(
      'thread-b',
      snapshot({
        promptTokens: 100,
        cacheHitTokens: 40,
        cacheMissTokens: 60,
        cacheMissReasons: ['cold_request', 'tool_catalog_changed'],
        cacheSuggestions: ['keep MCP tools stable']
      })
    )

    const total = counter.total()
    expect(total.cacheMissReasons).toEqual(['cold_request', 'tool_catalog_changed'])
    expect(total.cacheSuggestions).toEqual(['warm the cache', 'keep MCP tools stable'])
  })

  it('recomputes the aggregate hit rate from summed token counts', () => {
    const counter = new UsageCounter()
    counter.record(
      'thread-a',
      snapshot({ promptTokens: 100, cacheHitTokens: 60, cacheMissTokens: 40 })
    )
    counter.record(
      'thread-b',
      snapshot({ promptTokens: 100, cacheHitTokens: 40, cacheMissTokens: 60 })
    )

    const total = counter.total()
    // 100 hits / 200 cacheable = 0.5.
    expect(total.cacheableTokenHitRate).toBe(0.5)
    expect(total.totalInputTokenHitRate).toBe(0.5)
  })

  it('keeps consecutive Responses cache deltas cumulative and isolated by thread', () => {
    const counter = new UsageCounter()
    counter.record('thread-a', snapshot({
      promptTokens: 1_000,
      completionTokens: 10,
      cachedTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 1_000,
      turns: 1
    }))
    counter.record('thread-a', snapshot({
      promptTokens: 1_000,
      completionTokens: 10,
      cachedTokens: 900,
      cacheHitTokens: 900,
      cacheMissTokens: 100,
      turns: 1
    }))
    counter.record('thread-b', snapshot({
      promptTokens: 1_000,
      completionTokens: 10,
      cachedTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 1_000,
      turns: 1
    }))

    expect(counter.forThread('thread-a')).toMatchObject({
      promptTokens: 2_000,
      completionTokens: 20,
      cachedTokens: 900,
      cacheHitTokens: 900,
      cacheMissTokens: 1_100,
      cacheHitRate: 0.45,
      turns: 2
    })
    expect(counter.forThread('thread-b')).toMatchObject({
      promptTokens: 1_000,
      completionTokens: 10,
      cachedTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 1_000,
      cacheHitRate: 0,
      turns: 1
    })
  })

  it('leaves aggregate rates and reasons unset without telemetry', () => {
    const counter = new UsageCounter()
    counter.record('thread-a', snapshot({ promptTokens: 100 }))

    const total = counter.total()
    expect(total.cacheableTokenHitRate).toBeUndefined()
    expect(total.totalInputTokenHitRate).toBeUndefined()
    expect(total.cacheMissReasons).toBeUndefined()
    expect(total.cacheSuggestions).toBeUndefined()
  })

  it('preserves reasoning, cache-write, and arbitrary currency usage', () => {
    const counter = new UsageCounter()
    counter.record('thread-a', snapshot({
      reasoningTokens: 7,
      cacheWriteTokens: 11,
      costByCurrency: { EUR: 0.25 }
    }))
    counter.record('thread-a', snapshot({
      reasoningTokens: 3,
      cacheWriteTokens: 5,
      costByCurrency: { EUR: 0.15 }
    }))

    expect(counter.forThread('thread-a')).toMatchObject({
      reasoningTokens: 10,
      cacheWriteTokens: 16,
      costByCurrency: { EUR: 0.4 }
    })
  })
})
