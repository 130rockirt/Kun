import type { MemoryRecord } from '../../contracts/memory.js'
import type { CanonicalMemoryReadResult } from '../../memory/memory-canonical-files.js'
import { canonicalMemoryHash } from '../../memory/memory-record-normalizer.js'

type IndexedMemoryRow = { id: string; canonicalHash: string; updatedAt: string }

export type HybridMemoryBackfillState = {
  running: boolean
  scanned: number
  remaining: number
}

export class HybridMemoryBackfillCoordinator {
  private stopped = false
  private promise: Promise<void> | null = null
  private stateValue: HybridMemoryBackfillState = { running: false, scanned: 0, remaining: 0 }

  constructor(private readonly deps: {
    readCanonical: () => Promise<CanonicalMemoryReadResult>
    indexedRows: () => IndexedMemoryRow[]
    upsert: (record: MemoryRecord, hash: string) => void
    remove: (id: string) => void
    noteState: (state: HybridMemoryBackfillState) => void
    yieldToEventLoop: () => Promise<void>
    warn: (action: string, error: unknown) => void
    batchSize?: number
  }) {}

  start(): void {
    if (this.promise || this.stopped) return
    this.promise = this.run().catch((error) => this.deps.warn('backfill', error))
  }

  stop(): void { this.stopped = true }
  async wait(): Promise<void> { await this.promise }
  state(): HybridMemoryBackfillState { return { ...this.stateValue } }

  private async run(): Promise<void> {
    const canonical = await this.deps.readCanonical()
    if (this.stopped) return
    const indexed = new Map(this.deps.indexedRows().map((row) => [row.id, row]))
    const canonicalIds = new Set(canonical.records.map((record) => record.id))
    const malformedIds = new Set(canonical.malformedIds)
    const total = canonical.records.length + indexed.size
    this.update({ running: true, scanned: 0, remaining: total })
    const batchSize = Math.max(1, Math.floor(this.deps.batchSize ?? 32))

    for (let offset = 0; offset < canonical.records.length; offset += batchSize) {
      if (this.stopped) return
      for (const record of canonical.records.slice(offset, offset + batchSize)) {
        const hash = canonicalMemoryHash(record)
        const row = indexed.get(record.id)
        if (!row || row.canonicalHash !== hash || row.updatedAt !== record.updatedAt) {
          this.deps.upsert(record, hash)
        }
        this.update({
          running: true,
          scanned: Math.min(total, this.stateValue.scanned + 1),
          remaining: Math.max(0, total - this.stateValue.scanned - 1)
        })
      }
      await this.deps.yieldToEventLoop()
    }

    for (const row of indexed.values()) {
      if (this.stopped) return
      if (!canonicalIds.has(row.id) || malformedIds.has(row.id)) this.deps.remove(row.id)
      this.update({
        running: true,
        scanned: Math.min(total, this.stateValue.scanned + 1),
        remaining: Math.max(0, total - this.stateValue.scanned - 1)
      })
      if (this.stateValue.scanned % batchSize === 0) await this.deps.yieldToEventLoop()
    }
    this.update({ running: false, scanned: total, remaining: 0 })
  }

  private update(state: HybridMemoryBackfillState): void {
    this.stateValue = state
    this.deps.noteState(state)
  }
}
