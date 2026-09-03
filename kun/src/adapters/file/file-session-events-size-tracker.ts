import { stat } from 'node:fs/promises'

export type EventsFileSizeInfo = {
  size: number
  dev: number
  ino: number
  mtimeMs: number
}

/**
 * Tracks the canonical events.jsonl size across appends so the hot per-event
 * write path does not pay a `stat()` after every `appendFile`. The first
 * observation for a thread stats the file; later appends add their record
 * bytes. Mutation points that replace or trim the file (event retention trim,
 * usage compaction, thread deletion, memory reset) clear the tracked entry so
 * the next append re-stats authoritative bytes.
 *
 * Size accounting is for threshold decisions (retention scheduling, usage
 * compaction debt, highest-seq cache invalidation), not for byte-exact
 * layouts; consumers already tolerate size drift because a cache mismatch
 * only forces a re-scan.
 */
export class FileSessionEventsSizeTracker {
  private readonly tracked = new Map<string, EventsFileSizeInfo>()

  constructor(
    private readonly pathFor: (threadId: string) => string,
    private readonly maxThreads = 512
  ) {}

  async observeAfterAppend(
    threadId: string,
    recordBytes: number
  ): Promise<EventsFileSizeInfo> {
    const current = this.tracked.get(threadId)
    if (current) {
      const next = { ...current, size: current.size + recordBytes }
      this.remember(threadId, next)
      return next
    }
    // No tracked entry: a stat issued after the append already includes
    // its bytes, so do not add recordBytes again.
    return await this.refresh(threadId)
  }

  async refresh(threadId: string): Promise<EventsFileSizeInfo> {
    const info = await stat(this.pathFor(threadId))
    const next: EventsFileSizeInfo = {
      size: info.size,
      dev: info.dev,
      ino: info.ino,
      mtimeMs: info.mtimeMs
    }
    this.remember(threadId, next)
    return next
  }

  invalidate(threadId: string): void {
    this.tracked.delete(threadId)
  }

  clear(): void {
    this.tracked.clear()
  }

  private remember(threadId: string, info: EventsFileSizeInfo): void {
    this.tracked.delete(threadId)
    this.tracked.set(threadId, info)
    while (this.tracked.size > this.maxThreads) {
      const oldest = this.tracked.keys().next().value
      if (oldest === undefined) return
      this.tracked.delete(oldest)
    }
  }
}
