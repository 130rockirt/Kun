import type { DailyUsageResponse, ModelUsageResponse, ThreadUsageResponse } from '../contracts/usage.js'
import { addUtcDays, assertValidTimezone, type DailyUsageAccumulator, type DailyUsageQuery, dateString, formatDateInTimezone, inclusiveDayCount, type ModelUsageAccumulator, type ModelUsageQuery, parseDateString, type ThreadUsageAccumulator, type ThreadUsageRecord } from './usage-service-query.js'
import { addUsageCounters, emptyCounters, emptyDailyBucket, emptyModelBucket, emptyThreadBucket, finalizeCacheRate, finalizeDailyBucket, finalizeModelBucket, finalizeThreadBucket } from './usage-service-aggregation.js'

type SummedCounters = Pick<DailyUsageResponse['totals'],
  | 'input_tokens' | 'output_tokens' | 'reasoning_tokens' | 'cached_tokens' | 'cache_miss_tokens'
  | 'total_tokens' | 'cost_usd' | 'cost_cny' | 'value_estimate_usd' | 'value_estimate_cny'
  | 'cache_savings_usd' | 'cache_savings_cny' | 'token_economy_savings_tokens'
  | 'token_economy_savings_usd' | 'token_economy_savings_cny' | 'turns'
>

function addFinalCounters(target: ReturnType<typeof emptyCounters>, bucket: SummedCounters): void {
  target.input_tokens += bucket.input_tokens
  target.output_tokens += bucket.output_tokens
  target.reasoning_tokens += bucket.reasoning_tokens
  target.cached_tokens += bucket.cached_tokens
  target.cache_miss_tokens += bucket.cache_miss_tokens
  target.total_tokens += bucket.total_tokens
  target.cost_usd += bucket.cost_usd
  target.cost_cny += bucket.cost_cny
  target.value_estimate_usd += bucket.value_estimate_usd
  target.value_estimate_cny += bucket.value_estimate_cny
  target.cache_savings_usd += bucket.cache_savings_usd
  target.cache_savings_cny += bucket.cache_savings_cny
  target.token_economy_savings_tokens += bucket.token_economy_savings_tokens
  target.token_economy_savings_usd += bucket.token_economy_savings_usd
  target.token_economy_savings_cny += bucket.token_economy_savings_cny
  target.turns += bucket.turns
}

export function buildThreadUsageResponse(records: readonly ThreadUsageRecord[]): ThreadUsageResponse {
  const buckets = new Map<string, ThreadUsageAccumulator>()
  for (const record of records) {
    const bucket = buckets.get(record.threadId) ?? emptyThreadBucket(record.threadId)
    const added = addUsageCounters(bucket, record.usage, record.model)
    bucket.hasCacheTelemetry ||= added.hasCacheTelemetry
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
  const finalized = [...buckets.values()].map(finalizeThreadBucket)
    .sort((a, b) => b.total_tokens - a.total_tokens || a.thread_id.localeCompare(b.thread_id))
  const totalsBase = { ...emptyCounters(), thread_count: finalized.length }
  for (const bucket of finalized) addFinalCounters(totalsBase, bucket)
  return {
    group_by: 'thread',
    buckets: finalized,
    totals: finalizeCacheRate(totalsBase, [...buckets.values()].some((bucket) => bucket.hasCacheTelemetry))
  }
}

export function buildDailyUsageResponse(records: readonly ThreadUsageRecord[], query: DailyUsageQuery): DailyUsageResponse {
  const days = inclusiveDayCount(query.from, query.to)
  assertValidTimezone(query.timezone)
  const buckets = new Map<string, DailyUsageAccumulator>()
  const start = parseDateString(query.from, 'from')
  for (let offset = 0; offset < days; offset += 1) {
    const day = dateString(addUtcDays(start, offset))
    buckets.set(day, emptyDailyBucket(day))
  }
  for (const record of records) {
    const day = formatDateInTimezone(record.completedAt, query.timezone)
    const bucket = day ? buckets.get(day) : undefined
    if (!bucket) continue
    const added = addUsageCounters(bucket, record.usage, record.model)
    bucket.threadIds.add(record.threadId)
    bucket.thread_count = bucket.threadIds.size
    bucket.hasCacheTelemetry ||= added.hasCacheTelemetry
  }
  const finalized = [...buckets.values()].map(finalizeDailyBucket)
  const totalsBase = { ...emptyCounters(), days, active_days: 0 }
  const threadIds = new Set<string>()
  for (const bucket of finalized) {
    addFinalCounters(totalsBase, bucket)
    const accumulator = buckets.get(bucket.date)
    for (const id of accumulator?.threadIds ?? []) threadIds.add(id)
    if (bucket.turns || bucket.total_tokens || bucket.cost_usd || bucket.cost_cny || bucket.value_estimate_usd) totalsBase.active_days += 1
  }
  totalsBase.thread_count = threadIds.size
  return { group_by: 'day', from: query.from, to: query.to, timezone: query.timezone, buckets: finalized, totals: finalizeCacheRate(totalsBase, [...buckets.values()].some((bucket) => bucket.hasCacheTelemetry)) }
}

export function buildModelUsageResponse(records: readonly ThreadUsageRecord[], query: ModelUsageQuery): ModelUsageResponse {
  const days = inclusiveDayCount(query.from, query.to)
  assertValidTimezone(query.timezone)
  const start = parseDateString(query.from, 'from')
  const dayBuckets = new Map<string, DailyUsageAccumulator>()
  const modelBuckets = new Map<string, ModelUsageAccumulator>()
  for (let offset = 0; offset < days; offset += 1) dayBuckets.set(dateString(addUtcDays(start, offset)), emptyDailyBucket(dateString(addUtcDays(start, offset))))
  for (const record of records) {
    const day = formatDateInTimezone(record.completedAt, query.timezone)
    const dayBucket = day ? dayBuckets.get(day) : undefined
    if (!dayBucket) continue
    const model = record.model?.trim() || 'unknown'
    const modelBucket = modelBuckets.get(model) ?? emptyModelBucket(model)
    for (const bucket of [dayBucket, modelBucket]) {
      const added = addUsageCounters(bucket, record.usage, record.model)
      bucket.threadIds.add(record.threadId)
      bucket.thread_count = bucket.threadIds.size
      bucket.hasCacheTelemetry ||= added.hasCacheTelemetry
    }
    modelBuckets.set(model, modelBucket)
  }
  const finalizedDays = [...dayBuckets.values()].map(finalizeDailyBucket)
  const finalizedModels = [...modelBuckets.values()].map(finalizeModelBucket)
    .sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model))
  const totalsBase = { ...emptyCounters(), days, active_days: 0 }
  for (const bucket of finalizedDays) {
    addFinalCounters(totalsBase, bucket)
    if (bucket.turns || bucket.total_tokens || bucket.cost_usd || bucket.cost_cny || bucket.value_estimate_usd) totalsBase.active_days += 1
  }
  const ids = new Set<string>()
  for (const bucket of modelBuckets.values()) for (const id of bucket.threadIds) ids.add(id)
  totalsBase.thread_count = ids.size
  return { group_by: 'model', from: query.from, to: query.to, timezone: query.timezone, buckets: finalizedModels, days: finalizedDays, totals: finalizeCacheRate(totalsBase, [...modelBuckets.values()].some((bucket) => bucket.hasCacheTelemetry)) }
}
