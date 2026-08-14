import { describe, expect, it } from 'vitest'
import {
  InterruptedTurnResumeCoordinator,
  type InterruptedTurnResumeTimer
} from './interrupted-turn-resume-coordinator.js'

type ScheduledTimer = {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

function fakeTimer(): { scheduled: ScheduledTimer[]; setTimer: (fn: () => void, delayMs: number) => InterruptedTurnResumeTimer } {
  const scheduled: ScheduledTimer[] = []
  return {
    scheduled,
    setTimer: (callback, delayMs): InterruptedTurnResumeTimer => {
      const timer = { callback, delayMs, cancelled: false }
      scheduled.push(timer)
      return { cancel: () => { timer.cancelled = true } }
    }
  }
}

describe('InterruptedTurnResumeCoordinator', () => {
  it('resumes an interrupted thread once, marking it resumed before launch', async () => {
    const resumed: string[] = []
    const coordinator = new InterruptedTurnResumeCoordinator({
      launch: async (threadId) => { resumed.push(threadId) },
      canResume: async () => true,
      isThreadBusy: async () => false,
      markResumed: async () => undefined,
      baseDelayMs: 10
    })

    expect(await coordinator.resumeInterrupted('thread-1')).toBe(true)
    expect(resumed).toEqual(['thread-1'])
  })

  it('skips threads that cannot resume or are busy', async () => {
    const resumed: string[] = []
    const coordinator = new InterruptedTurnResumeCoordinator({
      launch: async (threadId) => { resumed.push(threadId) },
      canResume: async () => false,
      isThreadBusy: async () => true,
      markResumed: async () => undefined
    })

    expect(await coordinator.resumeInterrupted('thread-1')).toBe(false)
    expect(resumed).toEqual([])
  })

  it('defers a capacity-blocked launch and retries later without re-marking', async () => {
    const { scheduled, setTimer } = fakeTimer()
    const launched: string[] = []
    const marked: string[] = []
    let failFirst = true
    const coordinator = new InterruptedTurnResumeCoordinator({
      launch: async (threadId) => {
        if (failFirst) {
          failFirst = false
          const error = new Error('capacity') as Error & { name: string }
          error.name = 'TurnCapacityError'
          throw error
        }
        launched.push(threadId)
      },
      canResume: async () => true,
      isThreadBusy: async () => false,
      markResumed: async (threadId) => { marked.push(threadId) },
      setTimer,
      baseDelayMs: 25,
      maxDelayMs: 100
    })

    expect(await coordinator.resumeInterrupted('thread-1')).toBe(false)
    expect(launched).toEqual([])
    // The failed launch did not burn the resume marker; the deferred timer
    // retries and finally succeeds.
    expect(scheduled).toHaveLength(1)
    scheduled[0]?.callback()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(marked).toEqual(['thread-1'])
    expect(launched).toEqual(['thread-1'])
  })

  it('stops scheduling after shutdown', async () => {
    const { scheduled, setTimer } = fakeTimer()
    let launches = 0
    const coordinator = new InterruptedTurnResumeCoordinator({
      launch: async () => { launches += 1 },
      canResume: async () => true,
      isThreadBusy: async () => false,
      markResumed: async () => undefined,
      setTimer,
      baseDelayMs: 10
    })

    coordinator.defer('thread-1')
    coordinator.shutdown()
    scheduled[0]?.callback()
    await Promise.resolve()

    expect(launches).toBe(0)
  })

  it('fires the deferred timer only once per thread', async () => {
    const { scheduled, setTimer } = fakeTimer()
    let launches = 0
    const coordinator = new InterruptedTurnResumeCoordinator({
      launch: async () => { launches += 1 },
      canResume: async () => true,
      isThreadBusy: async () => false,
      markResumed: async () => undefined,
      setTimer,
      baseDelayMs: 25
    })

    coordinator.defer('thread-1')
    coordinator.defer('thread-1')
    expect(scheduled).toHaveLength(1)
    scheduled[0]?.callback()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(launches).toBe(1)
  })
})
