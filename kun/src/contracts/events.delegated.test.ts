import { describe, expect, test } from 'vitest'
import { RuntimeEvent } from './events.js'

const capabilities = {
  nativeResume: true,
  structuredStreaming: true,
  kunTools: false,
  externalApproval: false,
  liveSteering: false,
  nativeContextTelemetry: false,
  fork: false
}

describe('delegated runtime event contract', () => {
  test('keeps bounded capability metadata and strips native session identifiers', () => {
    const parsed = RuntimeEvent.parse({
      kind: 'delegated_runtime',
      seq: 1,
      timestamp: '2026-07-25T00:00:00.000Z',
      threadId: 'thread_1',
      turnId: 'turn_1',
      providerKind: 'cursor-sdk',
      providerId: 'cursor-subscription',
      phase: 'rebased',
      reason: 'history_changed',
      capabilities,
      nativeSessionId: 'must-not-be-projected'
    })
    expect(parsed).toMatchObject({
      kind: 'delegated_runtime',
      phase: 'rebased',
      capabilities
    })
    expect(parsed).not.toHaveProperty('nativeSessionId')
  })

  test('rejects incomplete capability snapshots', () => {
    expect(() => RuntimeEvent.parse({
      kind: 'delegated_runtime',
      seq: 1,
      timestamp: '2026-07-25T00:00:00.000Z',
      threadId: 'thread_1',
      providerKind: 'agent-sdk',
      providerId: 'claude-subscription',
      phase: 'resumed',
      capabilities: { nativeResume: true }
    })).toThrow()
  })
})
