import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchModelRequestTracePage,
  type ModelRequestTracePage,
  type ModelRequestTraceRecord
} from '../../agent/model-request-traces'

const FIRST_PAGE_SIZE = 30
const POLL_INTERVAL_MS = 1_000
const POST_RUN_SETTLE_DELAY_MS = 1_000

export type ModelRequestTraceViewState = {
  records: ModelRequestTraceRecord[]
  selectedId: string | null
  selected: ModelRequestTraceRecord | null
  nextCursor?: string
  activeCount: number
  warnings: string[]
  loading: boolean
  loadingOlder: boolean
  error: string | null
  select: (id: string) => void
  refresh: () => void
  loadOlder: () => void
}

export function mergeModelRequestTraceRecords(
  current: readonly ModelRequestTraceRecord[],
  incoming: readonly ModelRequestTraceRecord[]
): ModelRequestTraceRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]))
  for (const record of incoming) byId.set(record.id, record)
  return [...byId.values()].sort((left, right) => {
    const byTime = Date.parse(right.startedAt) - Date.parse(left.startedAt)
    return Number.isNaN(byTime) || byTime === 0
      ? right.sequence - left.sequence || right.id.localeCompare(left.id)
      : byTime
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useModelRequestTraces({
  threadId,
  visible,
  threadRunning
}: {
  threadId: string | null
  visible: boolean
  threadRunning: boolean
}): ModelRequestTraceViewState {
  const [records, setRecords] = useState<ModelRequestTraceRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string>()
  const [activeCount, setActiveCount] = useState(0)
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scopeGeneration = useRef(0)
  const previousRunning = useRef(threadRunning)

  const applyLatestPage = useCallback((page: ModelRequestTracePage): void => {
    setRecords((current) => mergeModelRequestTraceRecords(current, page.records))
    setSelectedId((current) => current ?? page.records[0]?.id ?? null)
    setNextCursor(page.nextCursor)
    setActiveCount(page.activeCount)
    setWarnings(page.warnings)
  }, [])

  const fetchLatest = useCallback(async (showLoading: boolean): Promise<void> => {
    if (!threadId || !visible) return
    const generation = scopeGeneration.current
    if (showLoading) setLoading(true)
    setError(null)
    try {
      const page = await fetchModelRequestTracePage(threadId, { limit: FIRST_PAGE_SIZE })
      if (generation !== scopeGeneration.current) return
      applyLatestPage(page)
    } catch (fetchError) {
      if (generation === scopeGeneration.current) setError(errorMessage(fetchError))
    } finally {
      if (showLoading && generation === scopeGeneration.current) setLoading(false)
    }
  }, [applyLatestPage, threadId, visible])

  useEffect(() => {
    scopeGeneration.current += 1
    setRecords([])
    setSelectedId(null)
    setNextCursor(undefined)
    setActiveCount(0)
    setWarnings([])
    setError(null)
    setLoading(false)
    setLoadingOlder(false)
    previousRunning.current = false
    if (threadId && visible) void fetchLatest(true)
  }, [fetchLatest, threadId, visible])

  useEffect(() => {
    if (!threadId || !visible || (!threadRunning && activeCount === 0)) return
    const timer = globalThis.setInterval(() => void fetchLatest(false), POLL_INTERVAL_MS)
    return () => globalThis.clearInterval(timer)
  }, [activeCount, fetchLatest, threadId, threadRunning, visible])

  useEffect(() => {
    let settleTimer: ReturnType<typeof globalThis.setTimeout> | undefined
    if (threadId && visible && previousRunning.current && !threadRunning) {
      void fetchLatest(false)
      settleTimer = globalThis.setTimeout(
        () => void fetchLatest(false),
        POST_RUN_SETTLE_DELAY_MS
      )
    }
    previousRunning.current = threadRunning
    return () => {
      if (settleTimer !== undefined) globalThis.clearTimeout(settleTimer)
    }
  }, [fetchLatest, threadId, threadRunning, visible])

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!threadId || !visible || !nextCursor || loadingOlder) return
    const generation = scopeGeneration.current
    const cursor = nextCursor
    setLoadingOlder(true)
    setError(null)
    try {
      const page = await fetchModelRequestTracePage(threadId, {
        limit: FIRST_PAGE_SIZE,
        cursor
      })
      if (generation !== scopeGeneration.current) return
      setRecords((current) => mergeModelRequestTraceRecords(current, page.records))
      setNextCursor(page.nextCursor)
      setActiveCount(page.activeCount)
      setWarnings(page.warnings)
    } catch (fetchError) {
      if (generation === scopeGeneration.current) setError(errorMessage(fetchError))
    } finally {
      if (generation === scopeGeneration.current) setLoadingOlder(false)
    }
  }, [loadingOlder, nextCursor, threadId, visible])

  const selected = selectedId
    ? records.find((record) => record.id === selectedId) ?? null
    : null
  const refresh = useCallback((): void => {
    void fetchLatest(true)
  }, [fetchLatest])
  const requestOlder = useCallback((): void => {
    void loadOlder()
  }, [loadOlder])

  return {
    records,
    selectedId,
    selected,
    ...(nextCursor ? { nextCursor } : {}),
    activeCount,
    warnings,
    loading,
    loadingOlder,
    error,
    select: setSelectedId,
    refresh,
    loadOlder: requestOlder
  }
}
