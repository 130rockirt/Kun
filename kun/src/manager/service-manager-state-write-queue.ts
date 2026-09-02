import { writePersistedManagerState } from './service-manager-state-persistence.js'
import type { ServiceManagerStateSnapshot } from './service-manager-state-snapshot.js'

/**
 * Serialized durable-write queue for the Manager state file. While one atomic
 * write is in flight, later mutations only replace `pendingSnapshot`; the
 * trailing write persists just the latest snapshot instead of one full write
 * per mutation. `flush()` settles once every queued mutation is durable.
 */
export class ManagerStateWriteQueue {
  private chain = Promise.resolve()
  private pendingSnapshot: ServiceManagerStateSnapshot | undefined
  private inFlight = false
  private failure: unknown

  constructor(private readonly path: string) {}

  enqueue(snapshot: ServiceManagerStateSnapshot): void {
    if (this.failure !== undefined) return
    this.chain = this.chain.then(async () => {
      if (this.failure !== undefined) return
      if (!this.inFlight && snapshot !== this.pendingSnapshot) {
        await this.write(snapshot)
      } else if (snapshot !== this.pendingSnapshot) {
        this.pendingSnapshot = snapshot
      }
      while (this.pendingSnapshot !== undefined && this.failure === undefined) {
        const coalesced = this.pendingSnapshot
        this.pendingSnapshot = undefined
        await this.write(coalesced)
      }
    }).catch((error: unknown) => {
      this.failure = error
      console.error('[kun-manager] failed to persist manager lease state:', error)
      throw error
    })
    void this.chain.catch(() => undefined)
  }

  async flush(): Promise<void> {
    await this.chain
    if (this.failure !== undefined) throw this.failure
  }

  get failed(): unknown {
    return this.failure
  }

  private async write(snapshot: ServiceManagerStateSnapshot): Promise<void> {
    this.inFlight = true
    try {
      await writePersistedManagerState(this.path, snapshot)
    } finally {
      this.inFlight = false
    }
  }
}
