import { beforeEach, describe, expect, it } from 'vitest'
import type { QueuedUserMessage } from './chat-store-types'
import {
  failQueuedSubmission,
  resetUnknownOutcomeAttempts,
  scheduleUnknownOutcomeRetry,
  turnAdmissionOutcomeMayBeUnknown
} from './chat-store-thread-actions-support'

function message(id: string): QueuedUserMessage {
  return { id, text: `message ${id}` }
}

beforeEach(() => {
  resetUnknownOutcomeAttempts('key-1')
})

describe('queue failure governance', () => {
  it('classifies deterministic 4xx rejections as known outcomes', () => {
    expect(turnAdmissionOutcomeMayBeUnknown(
      new Error('{"code":"task_surface_locked","message":"task surface is locked"}')
    )).toBe(false)
    expect(turnAdmissionOutcomeMayBeUnknown(
      new Error('{"code":"design_profile_locked","message":"profile locked"}')
    )).toBe(false)
    expect(turnAdmissionOutcomeMayBeUnknown(
      new Error('{"code":"validation_error","message":"bad request"}')
    )).toBe(false)
    // Network-like outcomes remain unknown so they can recover/back off.
    expect(turnAdmissionOutcomeMayBeUnknown(
      new Error('{"code":"unknown","message":"socket closed"}')
    )).toBe(true)
    expect(turnAdmissionOutcomeMayBeUnknown(
      new Error('{"code":"runtime_offline","message":"offline"}')
    )).toBe(true)
  })

  it('marks one queued submission terminal with the structured rejection view', () => {
    const result = failQueuedSubmission(
      [message('q-1'), message('q-2')],
      'q-1',
      { code: 'task_surface_locked', message: 'locked' }
    )

    expect(result[0]).toMatchObject({
      id: 'q-1',
      deliveryState: 'failed',
      errorCode: 'task_surface_locked',
      errorMessage: 'locked'
    })
    expect(result[1]).toMatchObject({ id: 'q-2' })
    expect(result[1]!.deliveryState).toBeUndefined()
  })

  it('backs off unknown outcomes with a bounded attempt cap', () => {
    const delays: number[] = []
    let retryable = true
    for (let attempt = 0; attempt < 6 && retryable; attempt += 1) {
      const scheduled = scheduleUnknownOutcomeRetry('key-1')
      retryable = scheduled.retryable
      if (scheduled.retryable) delays.push(scheduled.delayMs)
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(retryable).toBe(false)
    // A fresh key starts the backoff ladder over.
    expect(scheduleUnknownOutcomeRetry('key-2')).toMatchObject({ retryable: true, delayMs: 1_000 })
  })

  it('resets the backoff ladder on recovery', () => {
    scheduleUnknownOutcomeRetry('key-1')
    resetUnknownOutcomeAttempts('key-1')
    expect(scheduleUnknownOutcomeRetry('key-1')).toMatchObject({ retryable: true, delayMs: 1_000 })
  })
})
