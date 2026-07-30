import { describe, expect, it, vi } from 'vitest'
import {
  LlmDebugRecorder,
  startLlmDebugRoundIfEnabled
} from './llm-debug-recorder.js'

const meta = {
  threadId: 'thread-policy',
  turnId: 'turn-policy',
  provider: 'compat',
  model: 'model-policy'
}

describe('Agent Perspective thread capture policy', () => {
  it('does not create a round when capture is disabled', async () => {
    const recorder = new LlmDebugRecorder({ shouldCapture: async () => false })

    await expect(startLlmDebugRoundIfEnabled(recorder, meta)).resolves.toBeUndefined()
    expect(recorder.snapshot()).toEqual([])
    expect(recorder.activeCaptureCount).toBe(0)
  })

  it('snapshots the policy at request start', async () => {
    let enabled = true
    const recorder = new LlmDebugRecorder({ shouldCapture: () => enabled })

    const started = await startLlmDebugRoundIfEnabled(recorder, meta)
    expect(started).toBeDefined()
    enabled = false
    if (!started) throw new Error('expected trace round')
    await recorder.finish(started)

    expect(recorder.snapshot()).toHaveLength(1)
    await expect(startLlmDebugRoundIfEnabled(recorder, {
      ...meta,
      turnId: 'turn-disabled'
    })).resolves.toBeUndefined()
    expect(recorder.snapshot()).toHaveLength(1)
  })

  it('fails closed without throwing when the policy lookup fails', async () => {
    const onError = vi.fn()
    const recorder = new LlmDebugRecorder({
      shouldCapture: async () => {
        throw new Error('thread store unavailable')
      }
    })

    await expect(startLlmDebugRoundIfEnabled(recorder, meta, onError))
      .resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
    expect(recorder.snapshot()).toEqual([])
  })
})
