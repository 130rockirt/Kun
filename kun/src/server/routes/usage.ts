import { TurnUsageResponseSchema } from '../../contracts/usage.js'
import {
  ServiceManagerHttpError,
  ServiceManagerTransportError,
  UsageIndexUnavailableError
} from '../../manager/usage-errors.js'
import type { UsageService } from '../../services/usage-service.js'
import {
  UsageFallbackLimitError,
  buildDailyUsageResponse,
  buildModelUsageResponse,
  buildThreadUsageResponse,
  buildTurnUsageResponse,
  loadLiveUsageRemainders,
  loadUsageHistory,
  parseDailyUsageQuery,
  parseModelUsageQuery,
  parseTurnUsageQuery,
  usageQueryUtcRange,
  UsageValidationError
} from '../../services/usage-service.js'
import type { ServerRuntime } from './server-runtime.js'
import { jsonResponse, type JsonResponse } from '../response.js'

const FALLBACK_PROVENANCE = { source: 'jsonl-fallback' as const, degraded: true as const }

type FallbackUsageResponse = typeof FALLBACK_PROVENANCE

function isUsageIndexDegraded(error: unknown): boolean {
  return error instanceof UsageIndexUnavailableError ||
    error instanceof ServiceManagerTransportError ||
    error instanceof ServiceManagerHttpError && (error.status === 502 || error.status === 503)
}

function markFallback<T extends object>(response: T): T & FallbackUsageResponse {
  return { ...response, ...FALLBACK_PROVENANCE }
}

async function indexOrFallback<T extends object>(
  indexed: () => Promise<T>,
  fallback: () => Promise<T>
): Promise<T> {
  try {
    return await indexed()
  } catch (error) {
    if (!isUsageIndexDegraded(error)) throw error
    return markFallback(await fallback())
  }
}

/** Runtime-cumulative response retained for backward compatibility. */
export type UsageEndpointResponse = {
  total: ReturnType<UsageService['total']>
  perThread: Array<{ threadId: string; usage: ReturnType<UsageService['forThread']> }>
}

export async function buildUsageResponse(runtime: ServerRuntime): Promise<UsageEndpointResponse> {
  const threads = await runtime.threadService.list()
  return {
    total: runtime.usageService.total(),
    perThread: threads.map((thread) => ({
      threadId: thread.id,
      usage: runtime.usageService.forThread(thread.id)
    }))
  }
}

export async function usageJsonResponse(
  request: Request,
  runtime: ServerRuntime
): Promise<JsonResponse> {
  const query = queryRecord(request)
  const groupBy = stringParam(query, 'group_by') ?? 'runtime'
  try {
    if (groupBy === 'thread') {
      const threadId = stringParam(query, 'thread_id')
      const fallback = async () => buildThreadUsageResponse(await loadUsageHistory(runtime, { threadId }))
      if (!runtime.sessionStore.aggregateUsage) return jsonResponse(markFallback(await fallback()))
      return jsonResponse(await indexOrFallback(
        async () => runtime.sessionStore.aggregateUsage!(
          { groupBy: 'thread', ...(threadId ? { threadId } : {}) },
          await loadLiveUsageRemainders(runtime, { ...(threadId ? { threadId } : {}) }, true)
        ),
        fallback
      ))
    }
    if (groupBy === 'day') {
      const dayQuery = parseDailyUsageQuery(query)
      const range = usageQueryUtcRange(dayQuery)
      const fallback = async () => buildDailyUsageResponse(await loadUsageHistory(runtime, range), dayQuery)
      if (!runtime.sessionStore.aggregateUsage) return jsonResponse(markFallback(await fallback()))
      return jsonResponse(await indexOrFallback(
        async () => runtime.sessionStore.aggregateUsage!(
          { ...dayQuery, ...range }, await loadLiveUsageRemainders(runtime, range, true)
        ),
        fallback
      ))
    }
    if (groupBy === 'model') {
      const modelQuery = parseModelUsageQuery(query)
      const range = usageQueryUtcRange(modelQuery)
      const fallback = async () => buildModelUsageResponse(await loadUsageHistory(runtime, range), modelQuery)
      if (!runtime.sessionStore.aggregateUsage) return jsonResponse(markFallback(await fallback()))
      return jsonResponse(await indexOrFallback(
        async () => runtime.sessionStore.aggregateUsage!(
          { ...modelQuery, ...range }, await loadLiveUsageRemainders(runtime, range, true)
        ),
        fallback
      ))
    }
    if (groupBy === 'turn') {
      const turnQuery = parseTurnUsageQuery(query)
      const fallback = async () => buildTurnUsageResponse(
        await loadUsageHistory(runtime, { threadId: turnQuery.threadId }), turnQuery
      )
      if (!runtime.sessionStore.aggregateUsage) {
        return jsonResponse(TurnUsageResponseSchema.parse(markFallback(await fallback())))
      }
      return jsonResponse(TurnUsageResponseSchema.parse(await indexOrFallback(
        async () => runtime.sessionStore.aggregateUsage!(
          turnQuery,
          await loadLiveUsageRemainders(runtime, { threadId: turnQuery.threadId }, true)
        ),
        fallback
      )))
    }
  } catch (error) {
    if (error instanceof UsageValidationError) {
      return jsonResponse({ code: error.code, message: error.message }, 400)
    }
    if (error instanceof UsageIndexUnavailableError || error instanceof UsageFallbackLimitError) {
      return jsonResponse({ code: error.code, message: error.message }, 503)
    }
    if (error instanceof ServiceManagerHttpError) {
      return jsonResponse({
        code: error.code ?? 'service_manager_error',
        message: error.message
      }, error.status)
    }
    throw error
  }
  if (groupBy !== 'runtime') {
    return jsonResponse({
      code: 'validation_error',
      message: `unsupported usage grouping: ${groupBy}`
    }, 400)
  }
  return jsonResponse(await buildUsageResponse(runtime))
}

function queryRecord(request: Request): Record<string, string> {
  const url = new URL(request.url)
  return Object.fromEntries(url.searchParams.entries())
}

function stringParam(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
