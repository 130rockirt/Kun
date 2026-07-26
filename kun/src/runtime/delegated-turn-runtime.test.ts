import { describe, expect, it } from 'vitest'
import {
  ReplaceableDelegatedTurnRuntime,
  type DelegatedTurnRuntime
} from './delegated-turn-runtime.js'

function runtime(label: string): DelegatedTurnRuntime {
  return {
    handlesProvider: (providerId) => providerId === 'subscription',
    async runTurn(_threadId, turnId) {
      expect(turnId).toBe('turn-1')
      return label === 'old' ? 'completed' : 'failed'
    }
  }
}

describe('ReplaceableDelegatedTurnRuntime', () => {
  it('keeps a resolved in-flight generation while later turns use the replacement', async () => {
    const oldRuntime = runtime('old')
    const router = new ReplaceableDelegatedTurnRuntime(oldRuntime)
    const pinned = router.resolveProvider('subscription')

    router.replace(runtime('new'))

    await expect(
      pinned?.runTurn('thread-1', 'turn-1', new AbortController().signal, 'subscription')
    ).resolves.toBe('completed')
    await expect(
      router.runTurn('thread-1', 'turn-1', new AbortController().signal, 'subscription')
    ).resolves.toBe('failed')
  })
})
