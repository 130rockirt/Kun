import { describe, expect, it, vi } from 'vitest'
import { getThreadTimeline } from './threads.js'
import { createThreadRecord } from '../../domain/thread.js'
import { createTurnRecord } from '../../domain/turn.js'
import type { TurnItem } from '../../contracts/items.js'
import type { ThreadService } from '../../services/thread-service.js'
import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import { InMemorySessionStore } from '../../adapters/in-memory-session-store.js'

describe('getThreadTimeline detached delegate_task overlay', () => {
  async function timelineSetup(
    threadId: string,
    items: readonly TurnItem[],
    childRuns?: readonly unknown[]
  ) {
    const record = createThreadRecord({
      id: threadId, title: 'Detached', workspace: '/tmp', model: 'deepseek-chat',
      status: 'running'
    })
    const turn = createTurnRecord({
      id: `${threadId}_turn`, threadId: record.id, prompt: 'delegate', status: 'completed'
    })
    record.turns = [turn]
    const store = new InMemorySessionStore()
    for (const item of items) {
      await store.appendItem(record.id, item)
    }
    const diagnostics = vi.fn(async () => ({
      enabled: true,
      active: 0,
      childRuns: childRuns ?? [],
      aggregates: []
    }))
    const delegationRuntime = { diagnostics } as unknown as DelegationRuntime
    return { record, store, delegationRuntime, diagnostics }
  }

  function detachedDelegateResult(threadId: string, turnId: string): TurnItem {
    return {
      id: 'item_delegate_result',
      turnId,
      threadId,
      role: 'tool' as const,
      status: 'completed' as const,
      createdAt: '2026-08-27T03:26:43.157Z',
      kind: 'tool_result' as const,
      toolName: 'delegate_task',
      callId: 'call_delegate',
      toolKind: 'tool_call' as const,
      output: {
        childId: 'child_detached',
        status: 'running',
        detached: true,
        profile: 'ci-cd-and-automation'
      },
      isError: false
    }
  }

  function childRun(status: string, overrides: Record<string, unknown> = {}) {
    return {
      id: 'child_detached',
      parentThreadId: 'thr_detached',
      parentTurnId: 'thr_detached_turn',
      status,
      ...overrides
    }
  }

  it('overlays a completed child run onto the frozen running output', async () => {
    const setup = await timelineSetup('thr_detached', [
      detachedDelegateResult('thr_detached', 'thr_detached_turn')
    ], [
      childRun('completed', { summary: 'background child completed', durationMs: 781259 })
    ])

    const response = await getThreadTimeline(
      { get: async () => setup.record } as unknown as ThreadService,
      setup.record.id,
      new Request(`http://kun.local/v1/threads/${setup.record.id}/timeline`),
      setup.store,
      undefined,
      undefined,
      setup.delegationRuntime
    )

    const item = JSON.parse(response.body).turns[0].items.find(
      (entry: { id: string }) => entry.id === 'item_delegate_result'
    )
    expect(item.output).toMatchObject({
      status: 'completed',
      detached: true,
      summary: 'background child completed',
      durationMs: 781259
    })
    expect(item.isError).toBe(false)
  })

  it('marks a failed child run as an error result', async () => {
    const setup = await timelineSetup('thr_detached', [
      detachedDelegateResult('thr_detached', 'thr_detached_turn')
    ], [
      childRun('failed', { error: 'child crashed' })
    ])

    const response = await getThreadTimeline(
      { get: async () => setup.record } as unknown as ThreadService,
      setup.record.id,
      new Request(`http://kun.local/v1/threads/${setup.record.id}/timeline`),
      setup.store,
      undefined,
      undefined,
      setup.delegationRuntime
    )

    const item = JSON.parse(response.body).turns[0].items.find(
      (entry: { id: string }) => entry.id === 'item_delegate_result'
    )
    expect(item.output).toMatchObject({ status: 'failed', error: 'child crashed' })
    expect(item.isError).toBe(true)
  })

  it('keeps the persisted view when the child run is still running', async () => {
    const setup = await timelineSetup('thr_detached', [
      detachedDelegateResult('thr_detached', 'thr_detached_turn')
    ], [childRun('running')])

    const response = await getThreadTimeline(
      { get: async () => setup.record } as unknown as ThreadService,
      setup.record.id,
      new Request(`http://kun.local/v1/threads/${setup.record.id}/timeline`),
      setup.store,
      undefined,
      undefined,
      setup.delegationRuntime
    )

    const item = JSON.parse(response.body).turns[0].items.find(
      (entry: { id: string }) => entry.id === 'item_delegate_result'
    )
    expect(item.output).toMatchObject({ status: 'running', detached: true })
    expect(item.output).not.toHaveProperty('summary')
    expect(item.isError).toBe(false)
  })

  it('loads child runs only when a detached delegate result is on the page', async () => {
    const setup = await timelineSetup(
      'thr_detached',
      [{
        id: 'item_plain_result',
        turnId: 'thr_detached_turn',
        threadId: 'thr_detached',
        role: 'tool' as const,
        status: 'completed' as const,
        createdAt: '2026-08-27T03:26:43.157Z',
        kind: 'tool_result' as const,
        toolName: 'bash',
        callId: 'call_bash',
        toolKind: 'command_execution' as const,
        output: 'ok',
        isError: false
      }],
      []
    )

    const response = await getThreadTimeline(
      { get: async () => setup.record } as unknown as ThreadService,
      setup.record.id,
      new Request(`http://kun.local/v1/threads/${setup.record.id}/timeline`),
      setup.store,
      undefined,
      undefined,
      setup.delegationRuntime
    )

    expect(response.status).toBe(200)
    expect(setup.diagnostics).not.toHaveBeenCalled()
  })
})
