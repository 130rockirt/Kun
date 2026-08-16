import { z } from 'zod'
import type { SessionStore } from '../../ports/session-store.js'
import type { ThreadService } from '../../services/thread-service.js'
import { jsonResponse, type JsonResponse } from '../response.js'

const THREAD_CONTENT_SEARCH_MAX_THREADS = 40
const THREAD_CONTENT_SEARCH_DEFAULT_MATCHES = 12
const THREAD_CONTENT_SEARCH_MAX_QUERY_CHARS = 256
const THREAD_CONTENT_SEARCH_CANDIDATE_POOL = 500
/** Wall-clock ceiling for one scan; partial results beat a stalled palette. */
export const THREAD_CONTENT_SEARCH_BUDGET_MS = 400

const ContentSearchQuery = z.object({
  q: z.string().min(1).max(THREAD_CONTENT_SEARCH_MAX_QUERY_CHARS),
  limit: z.preprocess((value) => {
    if (typeof value !== 'string' || value.trim() === '') return undefined
    return Number(value)
  }, z.number().int().positive().max(20).optional())
})

export type ThreadContentMatch = {
  threadId: string
  title: string
  workspace: string
  snippet: string
  updatedAt: string
}

export type ThreadContentSearchResponse = { matches: ThreadContentMatch[] }
export type ThreadContentSearchStore = Pick<SessionStore, 'searchItemText'>

const CONTENT_SEARCH_DEADLINE = Symbol('content-search-deadline')

async function settleBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  now: () => number
): Promise<T | typeof CONTENT_SEARCH_DEADLINE> {
  const remainingMs = deadline - now()
  if (remainingMs <= 0) return CONTENT_SEARCH_DEADLINE
  return new Promise<T | typeof CONTENT_SEARCH_DEADLINE>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => resolvePromise(CONTENT_SEARCH_DEADLINE), remainingMs)
    let running: Promise<T>
    try {
      running = operation()
    } catch (error) {
      clearTimeout(timer)
      rejectPromise(error)
      return
    }
    void running.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        rejectPromise(error)
      }
    )
  })
}

export function snippetAroundMatch(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return text.slice(0, 160)
  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + query.length + 100)
  return ((start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''))
    .replace(/\s+/g, ' ')
    .trim()
}

export async function contentSearchThreads(
  service: ThreadService,
  sessionStore: ThreadContentSearchStore,
  request: Request,
  now: () => number = () => Date.now()
): Promise<JsonResponse> {
  const url = new URL(request.url)
  const parsed = ContentSearchQuery.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return jsonResponse({
      code: 'validation_error',
      message: 'invalid content search query',
      details: parsed.error.issues
    }, 400)
  }
  const search = sessionStore.searchItemText
  if (!search) return jsonResponse({ matches: [] } satisfies ThreadContentSearchResponse)

  const query = parsed.data.q
  const matchLimit = parsed.data.limit ?? THREAD_CONTENT_SEARCH_DEFAULT_MATCHES
  const deadline = now() + THREAD_CONTENT_SEARCH_BUDGET_MS
  const listed = await settleBeforeDeadline(
    () => service.list({ limit: THREAD_CONTENT_SEARCH_CANDIDATE_POOL }),
    deadline,
    now
  )
  if (listed === CONTENT_SEARCH_DEADLINE) {
    return jsonResponse({ matches: [] } satisfies ThreadContentSearchResponse)
  }
  const candidates = listed
    .filter((thread) => thread.status !== 'archived' && thread.status !== 'deleted')
    .sort((left, right) => sortableTime(right.updatedAt) - sortableTime(left.updatedAt))
    .slice(0, THREAD_CONTENT_SEARCH_MAX_THREADS)

  const matches: ThreadContentMatch[] = []
  for (const thread of candidates) {
    if (matches.length >= matchLimit || now() >= deadline) break
    let text: string | null
    try {
      const result = await settleBeforeDeadline(
        () => search.call(sessionStore, thread.id, query, { deadlineAtMs: deadline }),
        deadline,
        now
      )
      if (result === CONTENT_SEARCH_DEADLINE) break
      text = result
    } catch {
      continue
    }
    if (!text) continue
    matches.push({
      threadId: thread.id,
      title: thread.title.trim() || thread.id,
      workspace: thread.workspace,
      snippet: snippetAroundMatch(text, query),
      updatedAt: thread.updatedAt
    })
  }
  return jsonResponse({ matches } satisfies ThreadContentSearchResponse)
}

function sortableTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}
