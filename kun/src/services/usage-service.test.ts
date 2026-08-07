import { describe, expect, it } from 'vitest'
import { buildThreadUsageResponse, type ThreadUsageRecord, UsageService } from './usage-service.js'

const signature = {
  model: 'model-a',
  providerId: 'provider-a',
  endpointFormat: 'chat_completions',
  prefixFingerprint: 'prefix-a',
  toolCatalogFingerprint: 'tools-a',
  activeSkillIds: ['skill-a']
}

describe('usage cache diagnostics', () => {
  it('attaches cache diagnostics to recorded usage snapshots', () => {
    const usage = new UsageService()

    usage.record('thread-a', {
      promptTokens: 1_000,
      completionTokens: 20,
      totalTokens: 1_020,
      cacheHitTokens: 600,
      cacheMissTokens: 200,
      cacheHitRate: 0.75,
      turns: 1
    }, signature)

    const current = usage.forThread('thread-a')
    expect(current.cacheableTokenHitRate).toBe(0.75)
    expect(current.totalInputTokenHitRate).toBe(0.6)
    expect(current.cacheMissReasons).toContain('cold_request')
  })

  it('explains a hit-rate regression once a thread has a warm baseline', () => {
    const usage = new UsageService()
    const warm = (hit: number, miss: number) => ({
      promptTokens: hit + miss,
      completionTokens: 10,
      totalTokens: hit + miss + 10,
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      cacheHitRate: hit / (hit + miss),
      turns: 1
    })

    // Two warm turns at ~90% establish the baseline (no regression yet).
    usage.record('thread-r', warm(900, 100), signature)
    usage.record('thread-r', warm(900, 100), signature)
    // A prefix change collapses the hit rate — should be explained.
    const dropped = usage.record('thread-r', warm(50, 950), {
      ...signature,
      prefixFingerprint: 'prefix-b'
    })

    expect(dropped.cacheMissReasons).toContain('stable_prefix_changed')
    expect(dropped.cacheSuggestions?.some((s) => /Cache hit rate dropped/.test(s))).toBe(true)
    expect(dropped.cacheSuggestions?.some((s) => /stable system prefix changed/.test(s))).toBe(true)
  })

  it('does not re-announce the same regression every turn (cooldown)', () => {
    const usage = new UsageService()
    const warm = (hit: number, miss: number) => ({
      promptTokens: hit + miss,
      completionTokens: 10,
      totalTokens: hit + miss + 10,
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      cacheHitRate: hit / (hit + miss),
      turns: 1
    })
    usage.record('thread-c', warm(900, 100), signature)
    usage.record('thread-c', warm(900, 100), signature)
    const first = usage.record('thread-c', warm(50, 950), { ...signature, prefixFingerprint: 'prefix-b' })
    const second = usage.record('thread-c', warm(50, 950), { ...signature, prefixFingerprint: 'prefix-b' })

    expect(first.cacheSuggestions?.some((s) => /Cache hit rate dropped/.test(s))).toBe(true)
    // The very next turn at the same low rate must NOT repeat the announcement.
    expect(second.cacheSuggestions?.some((s) => /Cache hit rate dropped/.test(s))).toBe(false)
  })

  it('starts a fresh baseline when the model changes (no cross-model false regression)', () => {
    const usage = new UsageService()
    const warm = (hit: number, miss: number) => ({
      promptTokens: hit + miss,
      completionTokens: 10,
      totalTokens: hit + miss + 10,
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      cacheHitRate: hit / (hit + miss),
      turns: 1
    })
    usage.record('thread-m', warm(900, 100), signature)
    usage.record('thread-m', warm(900, 100), signature)
    // Switch model: the first turn on model-b is cold and has a low hit rate,
    // but must not be reported as a regression against model-a's baseline.
    const switched = usage.record('thread-m', warm(50, 950), { ...signature, model: 'model-b' })
    expect(switched.cacheSuggestions?.some((s) => /Cache hit rate dropped/.test(s))).toBe(false)
  })

  it('surfaces the latest-turn cache diagnostic fields in thread usage', () => {
    const records: ThreadUsageRecord[] = [
      {
        threadId: 'thread-a',
        completedAt: '2026-06-21T00:00:00.000Z',
        usage: {
          promptTokens: 1_000,
          completionTokens: 20,
          totalTokens: 1_020,
          cacheHitTokens: 600,
          cacheMissTokens: 200,
          cacheHitRate: 0.75,
          cacheableTokenHitRate: 0.75,
          totalInputTokenHitRate: 0.6,
          cacheMissReasons: ['tool_catalog_changed'],
          cacheSuggestions: ['Keep MCP and Skill tools stable within a thread.'],
          turns: 1
        }
      }
    ]

    const response = buildThreadUsageResponse(records)
    expect(response.buckets[0]).toMatchObject({
      thread_id: 'thread-a',
      last_turn_cacheable_hit_rate: 0.75,
      last_turn_total_input_hit_rate: 0.6,
      last_cache_miss_reasons: ['tool_catalog_changed'],
      last_cache_suggestions: ['Keep MCP and Skill tools stable within a thread.']
    })
  })
})

describe('usage per-turn timing aggregation', () => {
  const timed = (overrides: Record<string, unknown>) => ({
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    cacheHitRate: null,
    turns: 1,
    ...overrides
  })

  it('attaches turn averages to the cumulative snapshot per turnId', () => {
    const usage = new UsageService()
    // Turn A: two model calls within one user turn.
    usage.record('thread-a', timed({ completionTokens: 40, requestTtftMs: 800, requestGenerationMs: 2_000 }), undefined, 'turn-a')
    const turnASnapshot = usage.record('thread-a', timed({ completionTokens: 120, requestTtftMs: 1_200, requestGenerationMs: 2_000 }), undefined, 'turn-a')
    // Turn B: separate averages, must not bleed into turn A.
    const afterTurnB = usage.record('thread-a', timed({ completionTokens: 50, requestTtftMs: 500, requestGenerationMs: 1_000 }), undefined, 'turn-b')

    expect(turnASnapshot.turnAvgTtftMs).toBe(1_000)
    expect(turnASnapshot.turnAvgTokensPerSecond).toBe(40)
    // Session averages aggregate across all calls in the thread.
    expect(afterTurnB.avgTtftMs).toBe((800 + 1_200 + 500) / 3)
    expect(afterTurnB.avgTokensPerSecond).toBe(210 / 5_000 * 1_000)
    // Turn B has its own fresh averages.
    expect(afterTurnB.turnAvgTtftMs).toBe(500)
  })

  it('reports null turn averages without timing data', () => {
    const usage = new UsageService()
    const snapshot = usage.record('thread-a', timed({}), undefined, 'turn-a')

    expect(snapshot.turnAvgTtftMs).toBeNull()
    expect(snapshot.turnAvgTokensPerSecond).toBeNull()
  })

  it('does not fold timing into a turn when turnId is omitted', () => {
    const usage = new UsageService()
    const snapshot = usage.record('thread-a', timed({ requestTtftMs: 900, requestGenerationMs: 1_000 }))

    expect(snapshot.turnAvgTtftMs).toBeUndefined()
    // Session aggregation still applies.
    expect(snapshot.avgTtftMs).toBe(900)
  })

  it('endTurn releases per-turn aggregation for finished turns', () => {
    const usage = new UsageService()
    usage.record('thread-a', timed({ requestTtftMs: 800, requestGenerationMs: 1_000 }), undefined, 'turn-a')
    usage.endTurn('thread-a', 'turn-a')

    // A new call in the same turnId starts a fresh aggregation window.
    const next = usage.record('thread-a', timed({ requestTtftMs: 200, requestGenerationMs: 1_000 }), undefined, 'turn-a')
    expect(next.turnAvgTtftMs).toBe(200)
  })
})
