import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import {
  sortSidebarThreads,
  type SidebarThreadActivityContext
} from './sidebar-project-selectors'
import {
  createSidebarThreadOrderTracker,
  type SidebarThreadOrderTracker
} from './sidebar-thread-order-tracker'

function thread(id: string, overrides: Partial<NormalizedThread> = {}): NormalizedThread {
  return {
    id,
    title: id,
    workspace: '/tmp/app',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides
  } as NormalizedThread
}

const settledContext: SidebarThreadActivityContext = {
  activeThreadId: null,
  busy: false,
  watchTurnCompletion: {},
  unreadThreadIds: {}
}

function reconcile(
  tracker: SidebarThreadOrderTracker,
  threads: NormalizedThread[],
  context: SidebarThreadActivityContext,
  baselineKey = ''
): string[] {
  return tracker.reconcile({
    baselineKey,
    containerKey: 'project:root',
    context,
    threads: sortSidebarThreads(threads)
  }).map((item) => item.id)
}

describe('sidebar stable thread ordering', () => {
  it('keeps the prior position when running and updatedAt arrive together', () => {
    const tracker = createSidebarThreadOrderTracker()
    const settled = thread('settled', { updatedAt: '2026-08-20T00:00:05.000Z' })
    const background = thread('background', { updatedAt: '2026-08-20T00:00:01.000Z' })
    expect(reconcile(tracker, [background, settled], settledContext)).toEqual([
      'settled',
      'background'
    ])

    const refreshed = thread('background', { updatedAt: '2026-08-20T00:00:09.000Z' })
    const runningContext = {
      ...settledContext,
      watchTurnCompletion: { background: true }
    }
    expect(reconcile(tracker, [refreshed, settled], runningContext)).toEqual([
      'settled',
      'background'
    ])
    expect(reconcile(tracker, [
      thread('background', { updatedAt: '2026-08-20T00:00:12.000Z' }),
      settled
    ], runningContext)).toEqual(['settled', 'background'])
  })

  it('uses the normal base order for a running row first discovered at startup', () => {
    const tracker = createSidebarThreadOrderTracker()
    const context = { ...settledContext, watchTurnCompletion: { running: true } }
    expect(reconcile(tracker, [
      thread('running', { updatedAt: '2026-08-20T00:00:09.000Z' }),
      thread('settled', { updatedAt: '2026-08-20T00:00:05.000Z' })
    ], context)).toEqual(['running', 'settled'])
  })

  it('promotes awaiting input once and freezes the promoted position after answering', () => {
    const tracker = createSidebarThreadOrderTracker()
    const newer = thread('newer', { updatedAt: '2026-08-20T00:00:05.000Z' })
    const waiting = thread('waiting', { updatedAt: '2026-08-20T00:00:01.000Z' })
    const running = { ...settledContext, watchTurnCompletion: { waiting: true } }
    expect(reconcile(tracker, [waiting, newer], running)).toEqual(['newer', 'waiting'])

    const awaiting = {
      ...running,
      awaitingUserInputThreadIds: { waiting: true as const }
    }
    expect(reconcile(tracker, [waiting, newer], awaiting)).toEqual(['waiting', 'newer'])
    expect(reconcile(tracker, [waiting, newer], awaiting)).toEqual(['waiting', 'newer'])
    expect(reconcile(tracker, [waiting, newer], running)).toEqual(['waiting', 'newer'])
  })

  it.each([
    ['completed', { unreadThreadIds: { result: 'completed' as const } }],
    ['failed', { unreadThreadIds: { result: 'failed' as const } }],
    ['visible completion', {}]
  ])('promotes a %s result after running', (_label, resultPatch) => {
    const tracker = createSidebarThreadOrderTracker()
    const result = thread('result', { updatedAt: '2026-08-20T00:00:01.000Z' })
    const newer = thread('newer-result', { updatedAt: '2026-08-20T00:00:05.000Z' })
    const running = { ...settledContext, watchTurnCompletion: { result: true } }
    reconcile(tracker, [result, newer], running)
    expect(reconcile(tracker, [result, newer], {
      ...settledContext,
      ...resultPatch
    })).toEqual(['result', 'newer-result'])
  })

  it('orders simultaneous attention transitions by final updatedAt', () => {
    const tracker = createSidebarThreadOrderTracker()
    const first = thread('first-result', { updatedAt: '2026-08-20T00:00:02.000Z' })
    const second = thread('second-result', { updatedAt: '2026-08-20T00:00:01.000Z' })
    reconcile(tracker, [first, second], {
      ...settledContext,
      watchTurnCompletion: { 'first-result': true, 'second-result': true }
    })

    expect(reconcile(tracker, [
      { ...first, updatedAt: '2026-08-20T00:00:08.000Z' },
      { ...second, updatedAt: '2026-08-20T00:00:09.000Z' }
    ], {
      ...settledContext,
      unreadThreadIds: {
        'first-result': 'completed',
        'second-result': 'completed'
      }
    })).toEqual(['second-result', 'first-result'])
  })

  it('keeps pinned rows above attention promotions', () => {
    const tracker = createSidebarThreadOrderTracker()
    const pinned = thread('pinned', { pinned: true })
    const waiting = thread('waiting-under-pin')
    reconcile(tracker, [waiting, pinned], {
      ...settledContext,
      watchTurnCompletion: { 'waiting-under-pin': true }
    })
    expect(reconcile(tracker, [waiting, pinned], {
      ...settledContext,
      awaitingUserInputThreadIds: { 'waiting-under-pin': true }
    })).toEqual(['pinned', 'waiting-under-pin'])
  })

  it('treats a changed manual-order key as a new explicit baseline', () => {
    const tracker = createSidebarThreadOrderTracker()
    const waiting = thread('manual-waiting')
    const other = thread('manual-other')
    reconcile(tracker, [other, waiting], {
      ...settledContext,
      awaitingUserInputThreadIds: { 'manual-waiting': true }
    })
    expect(reconcile(tracker, [other, waiting], {
      ...settledContext,
      awaitingUserInputThreadIds: { 'manual-waiting': true }
    }, 'manual-v2')).toEqual(['manual-other', 'manual-waiting'])
  })
})
