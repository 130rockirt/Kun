import { describe, expect, it } from 'vitest'
import { LoopTelemetry } from './loop-telemetry.js'

describe('LoopTelemetry', () => {
  it('starts without pressure instead of restoring cumulative usage', () => {
    const telemetry = new LoopTelemetry()

    expect(telemetry.consumePromptPressure('thread_1', 'fallback')).toBeUndefined()
  })

  it('keeps the highest prompt pressure seen before compaction consumes it', () => {
    const telemetry = new LoopTelemetry()

    telemetry.recordPromptPressure('thread_1', 'first', 20)
    telemetry.recordPromptPressure('thread_1', 'smaller', 10)
    telemetry.recordPromptPressure('thread_1', 'largest', 30)

    expect(telemetry.consumePromptPressure('thread_1', 'fallback')).toEqual({
      model: 'largest',
      promptTokens: 30
    })
    expect(telemetry.consumePromptPressure('thread_1', 'fallback')).toBeUndefined()
  })

  it('classifies additive and breaking tool catalog changes without persistence side effects', () => {
    const telemetry = new LoopTelemetry()
    const base = {
      threadId: 'thread_1',
      workspace: '/workspace',
      mode: 'agent',
      model: 'model',
      activeSkillIds: [],
      fingerprint: 'first',
      toolNames: ['read'],
      toolHashes: { read: 'hash_read' }
    }

    expect(telemetry.recordToolCatalogFingerprint(base)).toEqual({ kind: 'none' })
    expect(telemetry.recordToolCatalogFingerprint({
      ...base,
      fingerprint: 'additive',
      toolNames: ['read', 'grep'],
      toolHashes: { read: 'hash_read', grep: 'hash_grep' }
    })).toMatchObject({ kind: 'additive' })
    expect(telemetry.recordToolCatalogFingerprint({
      ...base,
      fingerprint: 'breaking',
      toolHashes: { read: 'mutated' }
    })).toMatchObject({ kind: 'breaking' })
  })
})
