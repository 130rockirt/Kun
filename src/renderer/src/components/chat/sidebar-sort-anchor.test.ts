import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import { sortSidebarThreads, type SidebarThreadActivityContext } from './sidebar-project-selectors'

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

describe('sidebar sort anchors', () => {
  it('freezes a running thread position while its turn refreshes updatedAt', () => {
    const settled = thread('settled', { updatedAt: '2026-08-20T00:00:05.000Z' })
    const running = thread('running-anchor', { updatedAt: '2026-08-20T00:00:01.000Z' })
    const runningContext: SidebarThreadActivityContext = {
      ...settledContext,
      watchTurnCompletion: { 'running-anchor': true }
    }

    expect(sortSidebarThreads([running, settled], runningContext).map((item) => item.id)).toEqual([
      'settled',
      'running-anchor'
    ])

    const refreshed = thread('running-anchor', { updatedAt: '2026-08-20T00:00:09.000Z' })
    expect(sortSidebarThreads([refreshed, settled], runningContext).map((item) => item.id)).toEqual([
      'settled',
      'running-anchor'
    ])
  })

  it('freezes an awaiting-input thread position as well', () => {
    const settled = thread('settled-await', { updatedAt: '2026-08-20T00:00:05.000Z' })
    const waiting = thread('waiting-anchor', { updatedAt: '2026-08-20T00:00:01.000Z' })
    const waitingContext: SidebarThreadActivityContext = {
      ...settledContext,
      awaitingUserInputThreadIds: { 'waiting-anchor': true }
    }

    expect(sortSidebarThreads([waiting, settled], waitingContext).map((item) => item.id)).toEqual([
      'settled-await',
      'waiting-anchor'
    ])

    const refreshed = thread('waiting-anchor', { updatedAt: '2026-08-20T00:00:09.000Z' })
    expect(sortSidebarThreads([refreshed, settled], waitingContext).map((item) => item.id)).toEqual([
      'settled-await',
      'waiting-anchor'
    ])
  })

  it('releases the sort anchor once the turn settles and lands on the final updatedAt', () => {
    const settled = thread('settled-late', { updatedAt: '2026-08-20T00:00:05.000Z' })
    const running = thread('settling-anchor', { updatedAt: '2026-08-20T00:00:01.000Z' })
    const runningContext: SidebarThreadActivityContext = {
      ...settledContext,
      watchTurnCompletion: { 'settling-anchor': true }
    }
    sortSidebarThreads([running, settled], runningContext)

    const finished = thread('settling-anchor', { updatedAt: '2026-08-20T00:00:09.000Z' })
    expect(sortSidebarThreads([finished, settled], settledContext).map((item) => item.id)).toEqual([
      'settling-anchor',
      'settled-late'
    ])
  })

  it('keeps pinned threads first even while a sort anchor is frozen', () => {
    const pinned = thread('pinned-frozen', {
      updatedAt: '2026-06-01T00:00:00.000Z',
      pinned: true
    })
    const running = thread('frozen-under-pin', { updatedAt: '2026-08-20T00:00:00.000Z' })
    const context: SidebarThreadActivityContext = {
      ...settledContext,
      watchTurnCompletion: { 'frozen-under-pin': true }
    }

    expect(sortSidebarThreads([running, pinned], context).map((item) => item.id)).toEqual([
      'pinned-frozen',
      'frozen-under-pin'
    ])
  })
})
