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
import { addUtcDays, assertValidTimezone, type DailyUsageAccumulator, type DailyUsageQuery, dateString, formatDateInTimezone, inclusiveDayCount, type ModelUsageAccumulator, type ModelUsageQuery, parseDateString, type ThreadUsageAccumulator, type ThreadUsageRecord } from './usage-service-query.js'
import { addUsageCounters, emptyCounters, emptyDailyBucket, emptyModelBucket, emptyThreadBucket, finalizeCacheRate, finalizeDailyBucket, finalizeModelBucket, finalizeThreadBucket, hasCacheTelemetry } from './usage-service-aggregation.js'

export function buildThreadUsageResponse(records: readonly ThreadUsageRecord[]): ThreadUsageResponse {
  const buckets = new Map<string, ThreadUsageAccumulator>()
  for (const record of records) {
    const bucket = buckets.get(record.threadId) ?? emptyThreadBucket(record.threadId)
    const added = addUsageCounters(bucket, record.usage)
    bucket.hasCacheTelemetry = bucket.hasCacheTelemetry || added.hasCacheTelemetry
    // ISO timestamps compare lexicographically; `>=` keeps the latest turn (and
    // the later array position on ties) as the source of last_turn_cache_hit_rate.
    if (record.completedAt >= bucket.lastCompletedAt) {
      bucket.lastCompletedAt = record.completedAt
      bucket.last_turn_cache_hit_rate = record.usage.cacheHitRate ?? null
      bucket.last_turn_cacheable_hit_rate = record.usage.cacheableTokenHitRate ?? null
      bucket.last_turn_total_input_hit_rate = record.usage.totalInputTokenHitRate ?? null
      bucket.last_cache_miss_reasons = record.usage.cacheMissReasons ?? []
      bucket.last_cache_suggestions = record.usage.cacheSuggestions ?? []
      bucket.avg_ttft_ms = record.usage.avgTtftMs ?? null
      bucket.avg_tokens_per_second = record.usage.avgTokensPerSecond ?? null
    }
    buckets.set(record.threadId, bucket)
  }
  const finalized = [...buckets.values()]
    .map(finalizeThreadBucket)
    .sort((a, b) => b.total_tokens - a.total_tokens || a.thread_id.localeCompare(b.thread_id))
  const totalsBase = finalized.reduce(
    (acc, bucket) => {
      acc.input_tokens += bucket.input_tokens
      acc.output_tokens += bucket.output_tokens
      acc.reasoning_tokens += bucket.reasoning_tokens
      acc.cached_tokens += bucket.cached_tokens
      acc.cache_miss_tokens += bucket.cache_miss_tokens
      acc.total_tokens += bucket.total_tokens
      acc.cost_usd += bucket.cost_usd
      acc.cost_cny += bucket.cost_cny
      acc.cache_savings_usd += bucket.cache_savings_usd
      acc.cache_savings_cny += bucket.cache_savings_cny
      acc.token_economy_savings_tokens += bucket.token_economy_savings_tokens
      acc.token_economy_savings_usd += bucket.token_economy_savings_usd
      acc.token_economy_savings_cny += bucket.token_economy_savings_cny
      acc.turns += bucket.turns
      return acc
    },
    { ...emptyCounters(), thread_count: finalized.length }
  )
  const totals = finalizeCacheRate(
    totalsBase,
    [...buckets.values()].some((bucket) => bucket.hasCacheTelemetry)
  )
  return { group_by: 'thread', buckets: finalized, totals }
}

export function buildDailyUsageResponse(
  records: readonly ThreadUsageRecord[],
  query: DailyUsageQuery
): DailyUsageResponse {
  const days = inclusiveDayCount(query.from, query.to)
  assertValidTimezone(query.timezone)
  const start = parseDateString(query.from, 'from')
  const buckets = new Map<string, DailyUsageAccumulator>()
  for (let offset = 0; offset < days; offset += 1) {
    const day = dateString(addUtcDays(start, offset))
    buckets.set(day, emptyDailyBucket(day))
  }

  for (const record of records) {
    const day = formatDateInTimezone(record.completedAt, query.timezone)
    if (!day) continue
    const bucket = buckets.get(day)
    if (!bucket) continue
    const added = addUsageCounters(bucket, record.usage)
    bucket.threadIds.add(record.threadId)
    bucket.thread_count = bucket.threadIds.size
    bucket.hasCacheTelemetry = bucket.hasCacheTelemetry || added.hasCacheTelemetry
  }

  const finalized = [...buckets.values()].map(finalizeDailyBucket)
  const threadIds = new Set<string>()
  const totalsBase = finalized.reduce(
    (acc, bucket) => {
      acc.input_tokens += bucket.input_tokens
      acc.output_tokens += bucket.output_tokens
      acc.reasoning_tokens += bucket.reasoning_tokens
      acc.cached_tokens += bucket.cached_tokens
      acc.cache_miss_tokens += bucket.cache_miss_tokens
      acc.total_tokens += bucket.total_tokens
      acc.cost_usd += bucket.cost_usd
      acc.cost_cny += bucket.cost_cny
      acc.cache_savings_usd += bucket.cache_savings_usd
      acc.cache_savings_cny += bucket.cache_savings_cny
      acc.token_economy_savings_tokens += bucket.token_economy_savings_tokens
      acc.token_economy_savings_usd += bucket.token_economy_savings_usd
      acc.token_economy_savings_cny += bucket.token_economy_savings_cny
      acc.turns += bucket.turns
      if (
        bucket.turns > 0 ||
        bucket.total_tokens > 0 ||
        bucket.cost_usd > 0 ||
        bucket.cost_cny > 0 ||
        bucket.token_economy_savings_tokens > 0
      ) {
        acc.active_days += 1
      }
      const accumulator = buckets.get(bucket.date)
      if (accumulator) {
        for (const threadId of accumulator.threadIds) threadIds.add(threadId)
      }
      return acc
    },
    { ...emptyCounters(), days, active_days: 0 }
  )
  totalsBase.thread_count = threadIds.size
  const totals = finalizeCacheRate(
    totalsBase,
    [...buckets.values()].some((bucket) => bucket.hasCacheTelemetry)
  )

  return {
    group_by: 'day',
    from: query.from,
    to: query.to,
    timezone: query.timezone,
    buckets: finalized,
    totals
  }
}

export function buildModelUsageResponse(
  records: readonly ThreadUsageRecord[],
  query: ModelUsageQuery
): ModelUsageResponse {
  const days = inclusiveDayCount(query.from, query.to)
  assertValidTimezone(query.timezone)
  const start = parseDateString(query.from, 'from')
  const dayBuckets = new Map<string, DailyUsageAccumulator>()
  const modelBuckets = new Map<string, ModelUsageAccumulator>()
  for (let offset = 0; offset < days; offset += 1) {
    const day = dateString(addUtcDays(start, offset))
    dayBuckets.set(day, emptyDailyBucket(day))
  }

  for (const record of records) {
    const day = formatDateInTimezone(record.completedAt, query.timezone)
    if (!day) continue
    const dayBucket = dayBuckets.get(day)
    if (!dayBucket) continue

    const model = record.model?.trim() || 'unknown'
    const modelBucket = modelBuckets.get(model) ?? emptyModelBucket(model)
    const dayAdded = addUsageCounters(dayBucket, record.usage)
    const modelAdded = addUsageCounters(modelBucket, record.usage)
    dayBucket.threadIds.add(record.threadId)
    dayBucket.thread_count = dayBucket.threadIds.size
    dayBucket.hasCacheTelemetry = dayBucket.hasCacheTelemetry || dayAdded.hasCacheTelemetry
    modelBucket.threadIds.add(record.threadId)
    modelBucket.thread_count = modelBucket.threadIds.size
    modelBucket.hasCacheTelemetry = modelBucket.hasCacheTelemetry || modelAdded.hasCacheTelemetry
    modelBuckets.set(model, modelBucket)
  }

  const finalizedDays = [...dayBuckets.values()].map(finalizeDailyBucket)
  const finalizedModels = [...modelBuckets.values()]
    .map(finalizeModelBucket)
    .sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model))
  const totalsBase = finalizedDays.reduce(
    (acc, bucket) => {
      acc.input_tokens += bucket.input_tokens
      acc.output_tokens += bucket.output_tokens
      acc.reasoning_tokens += bucket.reasoning_tokens
      acc.cached_tokens += bucket.cached_tokens
      acc.cache_miss_tokens += bucket.cache_miss_tokens
      acc.total_tokens += bucket.total_tokens
      acc.cost_usd += bucket.cost_usd
      acc.cost_cny += bucket.cost_cny
      acc.cache_savings_usd += bucket.cache_savings_usd
      acc.cache_savings_cny += bucket.cache_savings_cny
      acc.token_economy_savings_tokens += bucket.token_economy_savings_tokens
      acc.token_economy_savings_usd += bucket.token_economy_savings_usd
      acc.token_economy_savings_cny += bucket.token_economy_savings_cny
      acc.turns += bucket.turns
      if (
        bucket.turns > 0 ||
        bucket.total_tokens > 0 ||
        bucket.cost_usd > 0 ||
        bucket.cost_cny > 0 ||
        bucket.token_economy_savings_tokens > 0
      ) {
        acc.active_days += 1
      }
      return acc
    },
    { ...emptyCounters(), days, active_days: 0 }
  )
  const threadIds = new Set<string>()
  for (const bucket of modelBuckets.values()) {
    for (const threadId of bucket.threadIds) threadIds.add(threadId)
  }
  totalsBase.thread_count = threadIds.size
  const totals = finalizeCacheRate(
    totalsBase,
    [...modelBuckets.values()].some((bucket) => bucket.hasCacheTelemetry)
  )

  return {
    group_by: 'model',
    from: query.from,
    to: query.to,
    timezone: query.timezone,
    buckets: finalizedModels,
    days: finalizedDays,
    totals
  }
}
