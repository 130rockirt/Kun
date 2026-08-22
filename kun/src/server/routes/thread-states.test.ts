import { describe, expect, it, vi } from 'vitest'
import { getThreadStates } from './threads.js'
import { buildRouter } from './index.js'
import type { ServerRuntime } from './server-runtime.js'
import type { JsonResponse } from '../response.js'

function runtimeState(id: string) {
  return {
    id,
    status: 'running' as const,
    updatedAt: '2026-08-22T00:00:00.000Z',
    latestSeq: 1,
    pendingUserInputIds: id === 'thr_7' ? ['in_7'] : [],
    latestTurn: null
  }
}

describe('getThreadStates', () => {
  it('deduplicates ids, bounds concurrency at four, and preserves request order', async () => {
    let active = 0
    let maxActive = 0
    const loadState = vi.fn(async (id: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 0))
      active -= 1
      return runtimeState(id)
    })
    const threadIds = Array.from({ length: 20 }, (_, index) => `thr_${index}`)
    const response = await getThreadStates(new Request('http://kun.local/v1/threads/states', {
      method: 'POST',
      body: JSON.stringify({ threadIds: [...threadIds, 'thr_7'] })
    }), loadState)
    const body = JSON.parse(response.body)

    expect(maxActive).toBe(4)
    expect(loadState).toHaveBeenCalledTimes(20)
    expect(body.results.map((result: { id: string }) => result.id)).toEqual(threadIds)
    expect(body.results[7].state.pendingUserInputIds).toEqual(['in_7'])
  })

  it('keeps missing and unavailable failures scoped to their thread', async () => {
    const response = await getThreadStates(new Request('http://kun.local/v1/threads/states', {
      method: 'POST',
      body: JSON.stringify({ threadIds: ['thr_ok', 'thr_missing', 'thr_error'] })
    }), async (id) => {
      if (id === 'thr_missing') return null
      if (id === 'thr_error') throw new Error('owner offline')
      return runtimeState(id)
    })

    expect(JSON.parse(response.body).results).toEqual([
      { id: 'thr_ok', ok: true, state: runtimeState('thr_ok') },
      {
        id: 'thr_missing', ok: false,
        error: { code: 'not_found', message: 'thread not found: thr_missing' }
      },
      {
        id: 'thr_error', ok: false,
        error: { code: 'unavailable', message: 'thread state unavailable: thr_error' }
      }
    ])
  })

  it('rejects more than 200 requested ids before loading any state', async () => {
    const loadState = vi.fn(async (id: string) => runtimeState(id))
    const response = await getThreadStates(new Request('http://kun.local/v1/threads/states', {
      method: 'POST',
      body: JSON.stringify({
        threadIds: Array.from({ length: 201 }, (_, index) => `thr_${index}`)
      })
    }), loadState)

    expect(response.status).toBe(400)
    expect(loadState).not.toHaveBeenCalled()
  })

  it('forwards each batch state read to its execution owner', async () => {
    const forwardThreadControl = vi.fn(async (_request: Request, threadId: string) =>
      new Response(JSON.stringify({
        ...runtimeState(threadId),
        latestSeq: 3,
        pendingUserInputIds: threadId === 'thr_waiting' ? ['in_waiting'] : []
      }), { status: 200 }))
    const router = buildRouter({
      runtimeToken: 'thread-route-token', insecure: false, forwardThreadControl
    } as unknown as ServerRuntime)
    const request = new Request('http://127.0.0.1/v1/threads/states', {
      method: 'POST',
      headers: {
        authorization: 'Bearer thread-route-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ threadIds: ['thr_running', 'thr_waiting'] })
    })
    const match = router.match('POST', new URL(request.url).pathname)
    if (!match) throw new Error('thread states route not found')

    const result = await match.handler(request, { params: match.params }) as JsonResponse
    expect(JSON.parse(result.body).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'thr_running', ok: true }),
      expect.objectContaining({
        id: 'thr_waiting',
        state: expect.objectContaining({ pendingUserInputIds: ['in_waiting'] })
      })
    ]))
    expect(forwardThreadControl).toHaveBeenCalledTimes(2)
    expect(forwardThreadControl.mock.calls.map((call) => call[1])).toEqual([
      'thr_running', 'thr_waiting'
    ])
    expect(forwardThreadControl.mock.calls[0][0]).toMatchObject({ method: 'GET' })
    expect(forwardThreadControl.mock.calls[0][0].headers.get('content-type')).toBeNull()
  })
})
