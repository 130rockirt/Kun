import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import {
  canvasDurableTurnOutcome,
  canvasLiveTurnOutcome,
  canvasTurnAllowsContinuation,
  normalizeCanvasTurnOutcome
} from './canvas-turn-outcome'

function thread(overrides: Partial<NormalizedThread> = {}): NormalizedThread {
  return {
    id: 'thread-design',
    title: 'Design',
    updatedAt: '2026-08-26T00:00:00.000Z',
    model: 'test-model',
    mode: 'agent',
    latestTurnId: 'turn-design',
    ...overrides
  }
}

describe('Canvas turn continuation outcome', () => {
  it.each([
    ['completed', 'completed'],
    ['success', 'completed'],
    ['aborted', 'aborted'],
    ['cancelled', 'aborted'],
    ['failed', 'failed'],
    ['error', 'failed'],
    ['running', 'unknown']
  ] as const)('normalizes %s as %s', (status, expected) => {
    expect(normalizeCanvasTurnOutcome(status)).toBe(expected)
  })

  it('uses an exact latest-turn match for durable replay', () => {
    expect(canvasDurableTurnOutcome({
      threads: [thread({ latestTurnStatus: 'aborted' })],
      threadId: 'thread-design',
      turnId: 'turn-design'
    })).toBe('aborted')
    expect(canvasDurableTurnOutcome({
      threads: [thread({ latestTurnStatus: 'aborted' })],
      threadId: 'thread-design',
      turnId: 'turn-older'
    })).toBe('unknown')
  })

  it('associates a live terminal status when the runtime omitted latestTurnId', () => {
    expect(canvasLiveTurnOutcome({
      threads: [thread({ latestTurnId: undefined, latestTurnStatus: 'failed' })],
      threadId: 'thread-design',
      turnId: 'turn-design'
    })).toBe('failed')
  })

  it('suppresses only known unsuccessful outcomes', () => {
    expect(canvasTurnAllowsContinuation('completed')).toBe(true)
    expect(canvasTurnAllowsContinuation('unknown')).toBe(true)
    expect(canvasTurnAllowsContinuation('aborted')).toBe(false)
    expect(canvasTurnAllowsContinuation('failed')).toBe(false)
  })
})
