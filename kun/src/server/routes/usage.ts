import { TurnUsageResponseSchema } from '../../contracts/usage.js'
import type { UsageService } from '../../services/usage-service.js'
import {
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

/**
 * The SQLite usage index is a rebuildable projection; JSONL events remain the
 * canonical history. When the index is unavailable (worker timeout, missing
 * database, or a manager-side failure), fall back to the JSONL history read
 * so the usage panels keep working instead of surfacing a 500.
 */
function isUsageIndexDegraded(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('usage_index_unavailable') ||
    message.includes('usage_query_timeout') ||
    message.includes('Kun Service Manager request failed')
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
      if (runtime.sessionStore.aggregateUsage) {
        const aggregateQuery = {
          groupBy: 'thread',
          ...(threadId ? { threadId } : {})
        } as const
        try {
          return jsonResponse(await runtime.sessionStore.aggregateUsage(
            aggregateQuery,
            await loadLiveUsageRemainders(
              runtime,
              { ...(threadId ? { threadId } : {}) },
              true
            )
          ))
        } catch (error) {
          if (!isUsageIndexDegraded(error)) throw error
        }
      }
      return jsonResponse(buildThreadUsageResponse(await loadUsageHistory(runtime, {
        threadId
      })))
    }
    if (groupBy === 'day') {
      const dayQuery = parseDailyUsageQuery(query)
      const range = usageQueryUtcRange(dayQuery)
      if (runtime.sessionStore.aggregateUsage) {
        try {
          return jsonResponse(await runtime.sessionStore.aggregateUsage(
            { ...dayQuery, ...range },
            await loadLiveUsageRemainders(runtime, range, true)
          ))
        } catch (error) {
          if (!isUsageIndexDegraded(error)) throw error
        }
      }
      return jsonResponse(
        buildDailyUsageResponse(
          await loadUsageHistory(runtime, range),
          dayQuery
        )
      )
    }
    if (groupBy === 'model') {
      const modelQuery = parseModelUsageQuery(query)
      const range = usageQueryUtcRange(modelQuery)
      if (runtime.sessionStore.aggregateUsage) {
        try {
          return jsonResponse(await runtime.sessionStore.aggregateUsage(
            { ...modelQuery, ...range },
            await loadLiveUsageRemainders(runtime, range, true)
          ))
        } catch (error) {
          if (!isUsageIndexDegraded(error)) throw error
        }
      }
      return jsonResponse(
        buildModelUsageResponse(
          await loadUsageHistory(runtime, range),
          modelQuery
        )
      )
    }
    if (groupBy === 'turn') {
      const turnQuery = parseTurnUsageQuery(query)
      if (runtime.sessionStore.aggregateUsage) {
        try {
          return jsonResponse(TurnUsageResponseSchema.parse(
            await runtime.sessionStore.aggregateUsage(
              turnQuery,
              await loadLiveUsageRemainders(runtime, { threadId: turnQuery.threadId }, true)
            )
          ))
        } catch (error) {
          if (!isUsageIndexDegraded(error)) throw error
        }
      }
      const response = buildTurnUsageResponse(
        await loadUsageHistory(runtime, { threadId: turnQuery.threadId }),
        turnQuery
      )
      return jsonResponse(TurnUsageResponseSchema.parse(response))
    }
  } catch (error) {
    if (error instanceof UsageValidationError) {
      return jsonResponse({ code: error.code, message: error.message }, 400)
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('usage_query_timeout') || message.includes('usage_index_unavailable')) {
      return jsonResponse({
        code: message.includes('usage_query_timeout')
          ? 'usage_query_timeout'
          : 'usage_index_unavailable',
        message: 'Usage history is temporarily unavailable. The previous totals were kept.'
      }, 503)
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
