export type BackfillScan<TUsage> = { highWater: number; usage: TUsage[] }

export type HybridThreadBackfillDeps<TUsage> = {
  indexedRows: () => Array<{ id: string; usage_backfilled?: number }>
  filesystemThreadIds: () => Promise<string[]>
  readMissingThread: (threadId: string) => Promise<boolean>
  scanEvents: (threadId: string) => Promise<BackfillScan<TUsage>>
  upsertMissing: (threadId: string, highWater: number) => Promise<void>
  noteExistingHighWater: (threadId: string, highWater: number) => void
  insertUsage: (threadId: string, usage: TUsage[]) => Promise<void>
  markUsageBackfilled: (threadId: string) => void
  threadDirectoryExists: (threadId: string) => Promise<boolean>
  deleteIndexRow: (threadId: string) => void
  yieldToEventLoop: () => Promise<void>
  warn: (action: string, error: unknown) => void
}

/** Single-flight owner for startup index/usage recovery and stale-row cleanup. */
export class HybridThreadBackfillCoordinator<TUsage> {
  private indexPromise: Promise<void> | null = null
  private promise: Promise<void> | null = null
  private stopped = false
  private rows: Array<{ id: string; usage_backfilled?: number }> = []
  private filesystemThreadIds: string[] = []
  private indexed = new Map<string, boolean>()
  private readonly readableMissingThreadIds = new Set<string>()

  constructor(private readonly deps: HybridThreadBackfillDeps<TUsage>) {}

  start(): void {
    if (this.promise || this.stopped) return
    this.indexPromise = this.indexMissingThreads()
      .catch((error) => this.deps.warn('background index backfill', error))
    this.promise = this.indexPromise
      .then(() => this.backfillUsageAndCleanStaleRows())
      .catch((error) => this.deps.warn('background backfill', error))
  }

  stop(): void { this.stopped = true }

  async waitForIndex(): Promise<void> { await this.indexPromise }

  async wait(): Promise<void> { await this.promise }

  private async indexMissingThreads(): Promise<void> {
    if (this.stopped) return
    this.rows = this.deps.indexedRows()
    this.indexed = new Map(
      this.rows.map((row) => [row.id, row.usage_backfilled === 1])
    )
    this.filesystemThreadIds = await this.deps.filesystemThreadIds()
    if (this.stopped) return
    for (const threadId of this.filesystemThreadIds) {
      if (this.stopped) return
      if (this.indexed.has(threadId)) continue
      const readable = await this.deps.readMissingThread(threadId)
      if (this.stopped) return
      if (!readable) continue
      await this.deps.upsertMissing(threadId, 0)
      if (this.stopped) return
      this.readableMissingThreadIds.add(threadId)
      await this.deps.yieldToEventLoop()
    }
  }

  private async backfillUsageAndCleanStaleRows(): Promise<void> {
    if (this.stopped) return
    for (const threadId of this.filesystemThreadIds) {
      if (this.stopped) return
      const usageBackfilled = this.indexed.get(threadId)
      if (usageBackfilled === true) continue
      if (usageBackfilled === undefined && !this.readableMissingThreadIds.has(threadId)) {
        continue
      }
      let scan: BackfillScan<TUsage>
      try {
        scan = await this.deps.scanEvents(threadId)
      } catch (error) {
        // Keep the thread eligible for the next startup instead of recording
        // a failed scan as a completed backfill.
        this.deps.warn(`usage backfill scan for ${threadId}`, error)
        await this.deps.yieldToEventLoop()
        continue
      }
      if (this.stopped) return
      this.deps.noteExistingHighWater(threadId, scan.highWater)
      await this.deps.insertUsage(threadId, scan.usage)
      if (this.stopped) return
      this.deps.markUsageBackfilled(threadId)
      await this.deps.yieldToEventLoop()
      if (this.stopped) return
    }
    try {
      for (const row of this.rows) {
        if (this.stopped) return
        const exists = await this.deps.threadDirectoryExists(row.id)
        if (this.stopped) return
        if (!exists) this.deps.deleteIndexRow(row.id)
      }
    } catch (error) { this.deps.warn('backfill cleanup', error) }
  }
}
