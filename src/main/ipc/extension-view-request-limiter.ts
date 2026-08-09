import type { WebContents } from 'electron'
import { MAX_EXTENSION_IPC_BODY_BYTES } from './app-ipc-schemas/extensions'

export class ExtensionViewRequestLimiter {
  private readonly states = new Map<number, { startedAt: number; calls: number; outstanding: number }>()
  private readonly trackedSenders = new Set<number>()

  begin(sender: WebContents, payload: unknown): () => void {
    const size = Buffer.byteLength(JSON.stringify(payload))
    if (size > MAX_EXTENSION_IPC_BODY_BYTES) throw new Error('Extension View message is too large.')
    const now = Date.now()
    const state = this.states.get(sender.id) ?? { startedAt: now, calls: 0, outstanding: 0 }
    if (now - state.startedAt >= 60_000) {
      state.startedAt = now
      state.calls = 0
    }
    if (state.calls >= 120) throw new Error('Extension View request rate limit exceeded.')
    if (state.outstanding >= 16) throw new Error('Extension View outstanding request limit exceeded.')
    state.calls += 1
    state.outstanding += 1
    this.states.set(sender.id, state)
    const release = (): void => {
      const current = this.states.get(sender.id)
      if (!current) return
      current.outstanding = Math.max(0, current.outstanding - 1)
    }
    if (!this.trackedSenders.has(sender.id)) {
      this.trackedSenders.add(sender.id)
      sender.once('destroyed', () => {
        this.states.delete(sender.id)
        this.trackedSenders.delete(sender.id)
      })
    }
    return release
  }
}
