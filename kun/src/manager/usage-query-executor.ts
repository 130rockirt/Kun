import { Worker } from 'node:worker_threads'
import type {
  SessionUsageAggregateQuery,
  SessionUsageAggregateResponse
} from '../contracts/usage-query.js'
import type { SessionUsageRecord } from '../ports/session-store.js'

const USAGE_QUERY_TIMEOUT_MS = 8_000
const USAGE_QUERY_RESULT_TTL_MS = 1_000
const USAGE_QUERY_RECENT_MAX = 32

type WorkerOutput =
  | { ok: true; result: SessionUsageAggregateResponse }
  | { ok: false; error: string }

type RecentResult = { value: SessionUsageAggregateResponse; settledAt: number }

export class UsageQueryExecutor {
  private readonly inflight = new Map<string, Promise<SessionUsageAggregateResponse>>()
  private readonly recent = new Map<string, RecentResult>()
  private epoch = 0

  constructor(
    private readonly sqlitePath: string,
    private readonly workerRunner?: (
      query: SessionUsageAggregateQuery,
      liveRecords: SessionUsageRecord[]
    ) => Promise<SessionUsageAggregateResponse>
  ) {}

  invalidate(): void {
    this.epoch += 1
    this.recent.clear()
  }

  execute(
    query: SessionUsageAggregateQuery,
    liveRecords: SessionUsageRecord[] = []
  ): Promise<SessionUsageAggregateResponse> {
    const epoch = this.epoch
    this.pruneRecent()
    const queryKey = JSON.stringify({ query, liveRecords })
    const key = `${epoch}:${queryKey}`
    const cached = this.recent.get(key)
    if (cached && Date.now() - cached.settledAt <= USAGE_QUERY_RESULT_TTL_MS) {
      return Promise.resolve(cached.value)
    }
    const active = this.inflight.get(key)
    if (active) return active
    const request = (this.workerRunner?.(query, liveRecords) ?? this.runWorker(query, liveRecords)).then((value) => {
      if (this.epoch === epoch) {
        this.recent.set(key, { value, settledAt: Date.now() })
        this.pruneRecent()
      }
      return value
    }).finally(() => {
      if (this.inflight.get(key) === request) this.inflight.delete(key)
    })
    this.inflight.set(key, request)
    return request
  }

  private pruneRecent(): void {
    const now = Date.now()
    for (const [key, value] of this.recent) {
      if (now - value.settledAt > USAGE_QUERY_RESULT_TTL_MS) this.recent.delete(key)
    }
    while (this.recent.size > USAGE_QUERY_RECENT_MAX) {
      const oldest = this.recent.keys().next().value
      if (oldest === undefined) break
      this.recent.delete(oldest)
    }
  }

  private runWorker(
    query: SessionUsageAggregateQuery,
    liveRecords: SessionUsageRecord[]
  ): Promise<SessionUsageAggregateResponse> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./usage-query-worker.js', import.meta.url), {
        workerData: { sqlitePath: this.sqlitePath, query, liveRecords }
      })
      const timer = setTimeout(() => {
        void worker.terminate()
        reject(new Error('usage_query_timeout'))
      }, USAGE_QUERY_TIMEOUT_MS)
      worker.once('message', (message: WorkerOutput) => {
        clearTimeout(timer)
        void worker.terminate()
        if (message.ok) resolve(message.result)
        else reject(new Error(`usage_index_unavailable: ${message.error}`))
      })
      worker.once('error', (error) => {
        clearTimeout(timer)
        const message = error instanceof Error ? error.message : String(error)
        reject(new Error(`usage_index_unavailable: ${message}`, { cause: error }))
      })
      worker.once('exit', (code) => {
        if (code === 0) return
        clearTimeout(timer)
        reject(new Error(`usage_index_unavailable: worker exited with code ${code}`))
      })
    })
  }
}
