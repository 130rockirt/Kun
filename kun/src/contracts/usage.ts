import { z } from 'zod'

/**
 * Token, cache, and cost counters emitted with every model response.
 *
 * `cacheHitTokens`/`cacheMissTokens` are optional because some providers
 * (or older model revisions) do not surface prompt-cache hit counts. When
 * the values are absent, `cacheHitRate` is reported as `null` rather than
 * guessing at zero.
 */
export const UsageSnapshotSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  /** Provider-reported reasoning tokens when separately available. */
  reasoningTokens: z.number().int().nonnegative().optional(),
  /** Virtual/public alias requested before route-pool target resolution. */
  requestedModelId: z.string().min(1).optional(),
  /** Concrete upstream attribution for routed requests. */
  actualProviderId: z.string().min(1).optional(),
  actualModelId: z.string().min(1).optional(),
  routePoolId: z.string().min(1).optional(),
  routeTargetId: z.string().min(1).optional(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative().optional(),
  cacheHitTokens: z.number().int().nonnegative().optional(),
  cacheMissTokens: z.number().int().nonnegative().optional(),
  /** Tokens written into a provider-managed prompt cache. */
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  cacheHitRate: z.number().min(0).max(1).nullable(),
  cacheableTokenHitRate: z.number().min(0).max(1).nullable().optional(),
  totalInputTokenHitRate: z.number().min(0).max(1).nullable().optional(),
  cacheMissReasons: z.array(z.string()).optional(),
  cacheSuggestions: z.array(z.string()).optional(),
  turns: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  costCny: z.number().nonnegative().optional(),
  /** Provider-reported costs retained without assuming a two-currency world. */
  costByCurrency: z.record(
    z.string().regex(/^[A-Z]{3}$/),
    z.number().nonnegative()
  ).optional(),
  /**
   * @deprecated Savings are reported in tokens only (cache hits via
   * `cacheHitTokens`, compression via `tokenEconomySavingsTokens`).
   * The money fields remain parseable for persisted threads recorded
   * by older runtimes but are no longer populated.
   */
  cacheSavingsUsd: z.number().nonnegative().optional(),
  cacheSavingsCny: z.number().nonnegative().optional(),
  tokenEconomySavingsTokens: z.number().int().nonnegative().optional(),
  tokenEconomySavingsUsd: z.number().nonnegative().optional(),
  tokenEconomySavingsCny: z.number().nonnegative().optional(),
  /** Provider reported an unrecoverable error mid-stream. */
  hasError: z.boolean().optional(),
  /**
   * Time-to-first-token of this single model request (ms), measured from
   * request start until the first text/reasoning chunk arrives. Missing for
   * non-streaming or legacy providers.
   */
  requestTtftMs: z.number().nonnegative().optional(),
  /** Time spent generating this single model response (ms), from first chunk
   * until the final usage/completed chunk. Used with `completionTokens` to
   * derive per-request tokens-per-second. */
  requestGenerationMs: z.number().nonnegative().optional(),
  /** Average TTFT across model calls of the current turn (null = no data). */
  turnAvgTtftMs: z.number().nonnegative().nullable().optional(),
  /** Average tokens-per-second across model calls of the current turn. */
  turnAvgTokensPerSecond: z.number().nonnegative().nullable().optional(),
  /** Thread-cumulative average TTFT across all model calls (null = no data). */
  avgTtftMs: z.number().nonnegative().nullable().optional(),
  /** Thread-cumulative average tokens-per-second across all model calls. */
  avgTokensPerSecond: z.number().nonnegative().nullable().optional()
})
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const DailyUsageCountersSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  cache_miss_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  cost_cny: z.number().nonnegative(),
  cache_savings_usd: z.number().nonnegative(),
  cache_savings_cny: z.number().nonnegative(),
  token_economy_savings_tokens: z.number().int().nonnegative(),
  token_economy_savings_usd: z.number().nonnegative(),
  token_economy_savings_cny: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  thread_count: z.number().int().nonnegative(),
  cache_hit_rate: z.number().min(0).max(1).nullable()
})
export type DailyUsageCounters = z.infer<typeof DailyUsageCountersSchema>

export const DailyUsageBucketSchema = DailyUsageCountersSchema.extend({
  date: DateStringSchema
})
export type DailyUsageBucket = z.infer<typeof DailyUsageBucketSchema>

export const DailyUsageTotalsSchema = DailyUsageCountersSchema.extend({
  days: z.number().int().nonnegative(),
  active_days: z.number().int().nonnegative()
})
export type DailyUsageTotals = z.infer<typeof DailyUsageTotalsSchema>

export const DailyUsageResponseSchema = z.object({
  group_by: z.literal('day'),
  from: DateStringSchema,
  to: DateStringSchema,
  timezone: z.string().min(1),
  buckets: z.array(DailyUsageBucketSchema),
  totals: DailyUsageTotalsSchema
})
export type DailyUsageResponse = z.infer<typeof DailyUsageResponseSchema>

export const ThreadUsageBucketSchema = DailyUsageCountersSchema.omit({
  thread_count: true
}).extend({
  thread_id: z.string().min(1),
  /**
   * Cache hit rate of the most recent turn (by completedAt), distinct from the
   * thread-cumulative `cache_hit_rate`. The cumulative rate is dragged down by
   * the unavoidable cold first turn; this reflects steady-state caching for the
   * usage chip. Null when the latest turn had no cache telemetry.
   */
  last_turn_cache_hit_rate: z.number().min(0).max(1).nullable().default(null),
  last_turn_cacheable_hit_rate: z.number().min(0).max(1).nullable().default(null),
  last_turn_total_input_hit_rate: z.number().min(0).max(1).nullable().default(null),
  last_cache_miss_reasons: z.array(z.string()).default([]),
  last_cache_suggestions: z.array(z.string()).default([]),
  /** Thread-cumulative model timing from the latest persisted usage snapshot. */
  avg_ttft_ms: z.number().nonnegative().nullable().optional(),
  avg_tokens_per_second: z.number().nonnegative().nullable().optional()
})
export type ThreadUsageBucket = z.infer<typeof ThreadUsageBucketSchema>

export const ThreadUsageTotalsSchema = DailyUsageCountersSchema.omit({
  thread_count: true
}).extend({
  thread_count: z.number().int().nonnegative()
})
export type ThreadUsageTotals = z.infer<typeof ThreadUsageTotalsSchema>

export const ThreadUsageResponseSchema = z.object({
  group_by: z.literal('thread'),
  buckets: z.array(ThreadUsageBucketSchema),
  totals: ThreadUsageTotalsSchema
})
export type ThreadUsageResponse = z.infer<typeof ThreadUsageResponseSchema>

export const ModelUsageBucketSchema = DailyUsageCountersSchema.extend({
  model: z.string().min(1)
})
export type ModelUsageBucket = z.infer<typeof ModelUsageBucketSchema>

export const ModelUsageDayBucketSchema = DailyUsageBucketSchema
export type ModelUsageDayBucket = z.infer<typeof ModelUsageDayBucketSchema>

export const ModelUsageResponseSchema = z.object({
  group_by: z.literal('model'),
  from: DateStringSchema,
  to: DateStringSchema,
  timezone: z.string().min(1),
  buckets: z.array(ModelUsageBucketSchema),
  days: z.array(ModelUsageDayBucketSchema),
  totals: DailyUsageTotalsSchema
})
export type ModelUsageResponse = z.infer<typeof ModelUsageResponseSchema>

export const emptyUsageSnapshot = (): UsageSnapshot => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  cacheHitRate: null,
  turns: 0,
  tokenEconomySavingsTokens: 0,
  turnAvgTtftMs: null,
  turnAvgTokensPerSecond: null,
  avgTtftMs: null,
  avgTokensPerSecond: null
})
