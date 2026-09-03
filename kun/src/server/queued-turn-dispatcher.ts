import type { TurnService } from '../services/turn-service.js'
import type { ThreadStore } from '../ports/thread-store.js'

/**
 * Serial per-thread queue drain. Queued turns never run concurrently on one
 * thread; a drain already in flight for the thread absorbs follow-up triggers
 * (turn settlement, cancel, manual resume) because each loop iteration
 * re-reads the durable queue under the thread mutation lock.
 */
export class QueuedTurnDispatcher {
  private readonly draining = new Set<string>()

  constructor(
    private readonly input: {
      turns: Pick<TurnService, 'startNextQueuedTurn'>
      runTurn: (threadId: string, turnId: string) => Promise<unknown> | void
    }
  ) {}

  drain(threadId: string): void {
    if (this.draining.has(threadId)) return
    this.draining.add(threadId)
    void this.drainLoop(threadId)
      .catch((error) => {
        console.warn(
          `[kun] queued-turn dispatcher failed for ${threadId}: ` +
          `${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        this.draining.delete(threadId)
      })
  }

  private async drainLoop(threadId: string): Promise<void> {
    for (;;) {
      const started = await this.input.turns.startNextQueuedTurn(threadId)
      if (!started) return
      // startNextQueuedTurn already admitted the turn; runTurn is fire-and-
      // forget here because its settlement re-triggers drain via onTurnSettled.
      await this.input.runTurn(threadId, started.turnId)
    }
  }

  /** Restart sweep: drain every thread with durable queued turns. */
  async drainAllQueued(threadStore: ThreadStore): Promise<number> {
    const summaries = await threadStore.list({ includeSide: true })
    let queuedThreads = 0
    for (const summary of summaries) {
      const metadata = await (
        threadStore.getMetadata?.(summary.id) ?? threadStore.get(summary.id)
      ).catch(() => null)
      if (!metadata?.turns.some((turn) => turn.status === 'queued')) continue
      queuedThreads += 1
      this.drain(summary.id)
    }
    return queuedThreads
  }
}
