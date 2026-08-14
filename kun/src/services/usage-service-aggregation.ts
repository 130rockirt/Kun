import { UsageCounter } from '../telemetry/usage-counter.js'
import { CacheTelemetry } from '../telemetry/cache-telemetry.js'
import {
  diagnoseCacheUsage,
  type CacheRequestSignature
} from '../cache/cache-diagnostics.js'
import { analyzeCacheRegression, cacheRegressionSeverityRank } from '../cache/cache-regression.js'
import type {
  DailyUsageBucket,
  DailyUsageCounters,
  DailyUsageResponse,
  ModelUsageBucket,
  ModelUsageResponse,
  ThreadUsageBucket,
  ThreadUsageResponse,
  UsageSnapshot
} from '../contracts/usage.js'
import { type DailyUsageAccumulator, type ModelUsageAccumulator, type ThreadUsageAccumulator, type UsageCountersTarget } from './usage-service-query.js'

export function emptyCounters(): DailyUsageCounters {
  return {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_miss_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    cost_cny: 0,
    cache_savings_usd: 0,
    cache_savings_cny: 0,
    token_economy_savings_tokens: 0,
    token_economy_savings_usd: 0,
    token_economy_savings_cny: 0,
    turns: 0,
    thread_count: 0,
    cache_hit_rate: null
  }
}

export function hasCacheTelemetry(usage: UsageSnapshot): boolean {
  return typeof usage.cacheHitTokens === 'number' || typeof usage.cacheMissTokens === 'number'
}

export function addUsageCounters(
  target: UsageCountersTarget,
  usage: UsageSnapshot
): { hasCacheTelemetry: boolean } {
  const cached = typeof usage.cacheHitTokens === 'number' ? usage.cacheHitTokens : 0
  const miss = typeof usage.cacheMissTokens === 'number' ? usage.cacheMissTokens : 0
  target.input_tokens += usage.promptTokens
  target.output_tokens += usage.completionTokens
  target.reasoning_tokens += usage.reasoningTokens ?? 0
  target.cached_tokens += cached
  target.cache_miss_tokens += miss
  target.total_tokens += usage.totalTokens
  target.cost_usd += usage.costUsd ?? 0
  target.cost_cny += usage.costCny ?? 0
  target.cache_savings_usd += usage.cacheSavingsUsd ?? 0
  target.cache_savings_cny += usage.cacheSavingsCny ?? 0
  target.token_economy_savings_tokens += usage.tokenEconomySavingsTokens ?? 0
  target.token_economy_savings_usd += usage.tokenEconomySavingsUsd ?? 0
  target.token_economy_savings_cny += usage.tokenEconomySavingsCny ?? 0
  target.turns += usage.turns
  return { hasCacheTelemetry: hasCacheTelemetry(usage) }
}

export function finalizeCacheRate<T extends DailyUsageCounters>(
  counters: T,
  hasTelemetry: boolean
): T {
  const cacheTotal = counters.cached_tokens + counters.cache_miss_tokens
  return {
    ...counters,
    cache_hit_rate: hasTelemetry && cacheTotal > 0 ? counters.cached_tokens / cacheTotal : null
  }
}

export function emptyDailyBucket(date: string): DailyUsageAccumulator {
  return {
    date,
    ...emptyCounters(),
    threadIds: new Set<string>(),
    hasCacheTelemetry: false
  }
}

export function emptyThreadBucket(threadId: string): ThreadUsageAccumulator {
  return {
    thread_id: threadId,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_miss_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    cost_cny: 0,
    cache_savings_usd: 0,
    cache_savings_cny: 0,
    token_economy_savings_tokens: 0,
    token_economy_savings_usd: 0,
    token_economy_savings_cny: 0,
    turns: 0,
    cache_hit_rate: null,
    last_turn_cache_hit_rate: null,
    last_turn_cacheable_hit_rate: null,
    last_turn_total_input_hit_rate: null,
    last_cache_miss_reasons: [],
    last_cache_suggestions: [],
    avg_ttft_ms: null,
    avg_tokens_per_second: null,
    hasCacheTelemetry: false,
    lastCompletedAt: ''
  }
}

export function emptyModelBucket(model: string): ModelUsageAccumulator {
  return {
    model,
    ...emptyCounters(),
    threadIds: new Set<string>(),
    hasCacheTelemetry: false
  }
}

export function finalizeDailyBucket(bucket: DailyUsageAccumulator): DailyUsageBucket {
  const finalized = finalizeCacheRate(bucket, bucket.hasCacheTelemetry)
  return {
    date: finalized.date,
    input_tokens: finalized.input_tokens,
    output_tokens: finalized.output_tokens,
    reasoning_tokens: finalized.reasoning_tokens,
    cached_tokens: finalized.cached_tokens,
    cache_miss_tokens: finalized.cache_miss_tokens,
    total_tokens: finalized.total_tokens,
    cost_usd: finalized.cost_usd,
    cost_cny: finalized.cost_cny,
    cache_savings_usd: finalized.cache_savings_usd,
    cache_savings_cny: finalized.cache_savings_cny,
    token_economy_savings_tokens: finalized.token_economy_savings_tokens,
    token_economy_savings_usd: finalized.token_economy_savings_usd,
    token_economy_savings_cny: finalized.token_economy_savings_cny,
    turns: finalized.turns,
    thread_count: finalized.thread_count,
    cache_hit_rate: finalized.cache_hit_rate
  }
}

export function finalizeThreadBucket(bucket: ThreadUsageAccumulator): ThreadUsageBucket {
  const finalized = finalizeCacheRate({ ...bucket, thread_count: 0 }, bucket.hasCacheTelemetry)
  return {
    thread_id: bucket.thread_id,
    input_tokens: finalized.input_tokens,
    output_tokens: finalized.output_tokens,
    reasoning_tokens: finalized.reasoning_tokens,
    cached_tokens: finalized.cached_tokens,
    cache_miss_tokens: finalized.cache_miss_tokens,
    total_tokens: finalized.total_tokens,
    cost_usd: finalized.cost_usd,
    cost_cny: finalized.cost_cny,
    cache_savings_usd: finalized.cache_savings_usd,
    cache_savings_cny: finalized.cache_savings_cny,
    token_economy_savings_tokens: finalized.token_economy_savings_tokens,
    token_economy_savings_usd: finalized.token_economy_savings_usd,
    token_economy_savings_cny: finalized.token_economy_savings_cny,
    turns: finalized.turns,
    cache_hit_rate: finalized.cache_hit_rate,
    last_turn_cache_hit_rate: bucket.last_turn_cache_hit_rate,
    last_turn_cacheable_hit_rate: bucket.last_turn_cacheable_hit_rate,
    last_turn_total_input_hit_rate: bucket.last_turn_total_input_hit_rate,
    last_cache_miss_reasons: bucket.last_cache_miss_reasons,
    last_cache_suggestions: bucket.last_cache_suggestions,
    avg_ttft_ms: bucket.avg_ttft_ms,
    avg_tokens_per_second: bucket.avg_tokens_per_second
  }
}

export function finalizeModelBucket(bucket: ModelUsageAccumulator): ModelUsageBucket {
  const finalized = finalizeCacheRate(bucket, bucket.hasCacheTelemetry)
  return {
    model: bucket.model,
    input_tokens: finalized.input_tokens,
    output_tokens: finalized.output_tokens,
    reasoning_tokens: finalized.reasoning_tokens,
    cached_tokens: finalized.cached_tokens,
    cache_miss_tokens: finalized.cache_miss_tokens,
    total_tokens: finalized.total_tokens,
    cost_usd: finalized.cost_usd,
    cost_cny: finalized.cost_cny,
    cache_savings_usd: finalized.cache_savings_usd,
    cache_savings_cny: finalized.cache_savings_cny,
    token_economy_savings_tokens: finalized.token_economy_savings_tokens,
    token_economy_savings_usd: finalized.token_economy_savings_usd,
    token_economy_savings_cny: finalized.token_economy_savings_cny,
    turns: finalized.turns,
    thread_count: bucket.threadIds.size,
    cache_hit_rate: finalized.cache_hit_rate
  }
}
