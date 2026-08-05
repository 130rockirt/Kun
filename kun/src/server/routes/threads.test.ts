import { describe, expect, it, vi } from 'vitest'
import { getThread } from './threads.js'
import { buildRouter } from './index.js'
import type { ServerRuntime } from './server-runtime.js'
import { createThreadRecord } from '../../domain/thread.js'
import { createTurnRecord } from '../../domain/turn.js'
import { createApprovalRequest } from '../../domain/approval.js'
import { InMemoryApprovalGate } from '../../adapters/in-memory-approval-gate.js'
import { InMemoryUserInputGate } from '../../adapters/in-memory-user-input-gate.js'
import type { ThreadService } from '../../services/thread-service.js'

function serviceWith(threadId: string): ThreadService {
  const record = createThreadRecord({
    id: threadId,
    title: 'Demo',
    workspace: '/tmp',
    model: 'deepseek-chat',
    status: 'running'
  })
  return {
    get: async (id: string) => (id === threadId ? record : null)
  } as unknown as ThreadService
}

describe('getThread pendingUserInputIds (#606)', () => {
  it('reports request ids the user-input gate is still awaiting for the thread', async () => {
    const gate = new InMemoryUserInputGate()
    // request() returns a promise that stays pending until resolved; we only
    // care that the request is now addressable in the gate.
    void gate
      .request({
        id: 'in_live',
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_input',
        prompt: 'north or south?',
        questions: []
      })
      .catch(() => undefined)
    // A request for a different thread must not leak into this thread's list.
    void gate
      .request({
        id: 'in_other',
        threadId: 'thr_2',
        turnId: 'turn_x',
        itemId: 'item_x',
        prompt: 'unrelated',
        questions: []
      })
      .catch(() => undefined)

    const response = await getThread(serviceWith('thr_1'), 'thr_1', undefined, gate)
    const body = JSON.parse(response.body)
    expect(body.pendingUserInputIds).toEqual(['in_live'])
  })

  it('reports an empty list when nothing is awaiting (finished thread)', async () => {
    const response = await getThread(serviceWith('thr_1'), 'thr_1', undefined, new InMemoryUserInputGate())
    const body = JSON.parse(response.body)
    expect(body.pendingUserInputIds).toEqual([])
  })

  it('omits no field when no gate is provided', async () => {
    const response = await getThread(serviceWith('thr_1'), 'thr_1')
    const body = JSON.parse(response.body)
    expect(body.pendingUserInputIds).toEqual([])
    expect(body).not.toHaveProperty('pendingApprovalIds')
  })
})

describe('getThread replay snapshot boundary (#1087)', () => {
  it('freezes latestSeq before projection reads so a hydration-window event remains replayable', async () => {
    const initial = createThreadRecord({
      id: 'thr_boundary', title: 'Boundary', workspace: '/tmp',
      model: 'deepseek-chat', status: 'running'
    })
    initial.turns = [createTurnRecord({
      id: 'turn_boundary', threadId: initial.id, prompt: 'wait', status: 'running',
      createdAt: '2026-08-05T00:00:00.000Z'
    })]
    const settled = {
      ...initial,
      status: 'idle' as const,
      turns: initial.turns.map((turn) => ({ ...turn, status: 'completed' as const }))
    }
    const order: string[] = []
    let durableHighWater = 200
    const service = {
      get: vi.fn(async () => {
        order.push('thread')
        // A terminal event becomes durable after the response's replay floor
        // was captured but before its state projection is read.
        return settled
      })
    } as unknown as ThreadService
    const sessionStore = {
      highestSeq: vi.fn(async () => {
        order.push('event-boundary')
        const boundary = durableHighWater
        durableHighWater = 201
        return boundary
      }),
      loadItems: vi.fn(async () => {
        order.push('items')
        return []
      })
    }

    const response = await getThread(service, initial.id, sessionStore as never)
    const body = JSON.parse(response.body)

    expect(order).toEqual(['event-boundary', 'thread', 'items'])
    expect(durableHighWater).toBe(201)
    expect(body.latestSeq).toBe(200)
    expect(body.status).toBe('idle')
  })
})

describe('getThread approval recovery snapshots (#1053)', () => {
  it('materializes live approvals without replaying event history', async () => {
    const record = createThreadRecord({
      id: 'thr_approval', title: 'Approval recovery', workspace: '/tmp',
      model: 'deepseek-chat', status: 'running'
    })
    record.turns = [createTurnRecord({
      id: 'turn_approval', threadId: record.id, prompt: 'Run tests', status: 'running',
      createdAt: '2026-08-01T00:00:00.000Z'
    })]
    const service = { get: async (id: string) => id === record.id ? record : null } as ThreadService
    const approvalGate = new InMemoryApprovalGate()
    const approval = createApprovalRequest({
      id: 'approval_live', threadId: record.id, turnId: 'turn_approval', toolName: 'bash',
      summary: 'Run focused tests', createdAt: '2026-08-01T00:00:01.000Z'
    })
    void approvalGate.request(approval).catch(() => undefined)
    const loadEventsSince = vi.fn(async () => [])
    const sessionStore = { highestSeq: async () => 7, loadItems: async () => [], loadEventsSince }

    const response = await getThread(service, record.id, sessionStore as never, undefined, approvalGate)
    const body = JSON.parse(response.body)

    expect(body.pendingApprovalIds).toEqual([approval.id])
    expect(body.turns[0].items).toContainEqual(expect.objectContaining({
      kind: 'approval', approvalId: approval.id, status: 'pending'
    }))
    expect(loadEventsSince).not.toHaveBeenCalled()
  })

  it('preserves in-memory turn items when no session store is available', async () => {
    const record = createThreadRecord({
      id: 'thr_no_session_store', title: 'No session store', workspace: '/tmp',
      model: 'deepseek-chat', status: 'running'
    })
    const turn = createTurnRecord({
      id: 'turn_no_session_store', threadId: record.id, prompt: 'Run tests', status: 'running',
      createdAt: '2026-08-01T00:00:00.000Z'
    })
    turn.items = [{
      id: 'item_user', turnId: turn.id, threadId: record.id, role: 'user',
      status: 'completed', createdAt: '2026-08-01T00:00:00.000Z',
      kind: 'user_message', text: 'Run tests'
    }]
    record.turns = [turn]
    const service = { get: async (id: string) => id === record.id ? record : null } as ThreadService
    const approvalGate = new InMemoryApprovalGate()
    const approval = createApprovalRequest({
      id: 'approval_no_session_store', threadId: record.id, turnId: turn.id, toolName: 'bash',
      summary: 'Run focused tests', createdAt: '2026-08-01T00:00:01.000Z'
    })
    void approvalGate.request(approval).catch(() => undefined)

    const response = await getThread(service, record.id, undefined, undefined, approvalGate)
    const body = JSON.parse(response.body)

    expect(body.turns[0].items.map((item: { id: string }) => item.id)).toEqual([
      'item_user', 'item_approval_no_session_store'
    ])
  })

  it('inserts a recovered approval at its chronological point in the turn', async () => {
    const record = createThreadRecord({
      id: 'thr_chronological', title: 'Chronological approval', workspace: '/tmp',
      model: 'deepseek-chat', status: 'running'
    })
    record.turns = [createTurnRecord({
      id: 'turn_chronological', threadId: record.id, prompt: 'Run tests', status: 'running',
      createdAt: '2026-08-01T00:00:00.000Z'
    })]
    const approvalGate = new InMemoryApprovalGate()
    const approval = createApprovalRequest({
      id: 'approval_live', threadId: record.id, turnId: 'turn_chronological', toolName: 'bash',
      summary: 'Run focused tests', createdAt: '2026-08-01T00:00:01.000Z'
    })
    void approvalGate.request(approval).catch(() => undefined)
    const sessionStore = {
      highestSeq: async () => 8,
      loadItems: async () => [
        {
          id: 'item_user', turnId: 'turn_chronological', threadId: record.id, role: 'user' as const,
          status: 'completed' as const, createdAt: '2026-08-01T00:00:00.000Z',
          kind: 'user_message' as const, text: 'Run tests'
        },
        {
          id: 'item_result', turnId: 'turn_chronological', threadId: record.id, role: 'tool' as const,
          status: 'completed' as const, createdAt: '2026-08-01T00:00:02.000Z',
          finishedAt: '2026-08-01T00:00:02.000Z', kind: 'tool_result' as const,
          toolName: 'bash', callId: 'call_1', toolKind: 'tool_call' as const, output: 'done', isError: false
        }
      ]
    }
    const service = { get: async (id: string) => id === record.id ? record : null } as ThreadService

    const response = await getThread(service, record.id, sessionStore as never, undefined, approvalGate)
    const body = JSON.parse(response.body)

    expect(body.turns[0].items.map((item: { id: string }) => item.id)).toEqual([
      'item_user', 'item_approval_live', 'item_result'
    ])
  })

  it('keeps an older persisted pending record non-actionable when the live gate is empty', async () => {
    const record = createThreadRecord({
      id: 'thr_stale', title: 'Stale approval', workspace: '/tmp',
      model: 'deepseek-chat', status: 'running'
    })
    record.turns = [createTurnRecord({
      id: 'turn_stale', threadId: record.id, prompt: 'Run tests', status: 'running',
      createdAt: '2026-08-01T00:00:00.000Z'
    })]
    const sessionStore = {
      highestSeq: async () => 1,
      loadItems: async () => [{
        id: 'item_approval_stale', turnId: 'turn_stale', threadId: record.id, role: 'tool' as const,
        status: 'pending' as const, createdAt: '2026-08-01T00:00:01.000Z',
        kind: 'approval' as const, approvalId: 'approval_stale', toolName: 'bash', summary: 'Run focused tests'
      }]
    }
    const service = { get: async (id: string) => id === record.id ? record : null } as ThreadService

    const response = await getThread(
      service, record.id, sessionStore as never, undefined, new InMemoryApprovalGate()
    )
    const body = JSON.parse(response.body)

    expect(body.pendingApprovalIds).toEqual([])
    expect(body.turns[0].items).toContainEqual(expect.objectContaining({
      approvalId: 'approval_stale', status: 'pending'
    }))
  })
})

describe('GET /v1/threads/:id active-owner forwarding (#1053)', () => {
  it('uses the execution owner so approval liveness comes from the owning gate', async () => {
    const forwarded = new Response(JSON.stringify({ owner: true }), { status: 200 })
    const forwardThreadControl = vi.fn(async () => forwarded)
    const router = buildRouter({
      runtimeToken: 'thread-route-token', insecure: false, forwardThreadControl
    } as unknown as ServerRuntime)
    const request = new Request('http://127.0.0.1/v1/threads/thr_owner', {
      headers: { authorization: 'Bearer thread-route-token' }
    })
    const match = router.match('GET', new URL(request.url).pathname)
    if (!match) throw new Error('thread route not found')

    const result = await match.handler(request, { params: match.params })

    expect(forwardThreadControl).toHaveBeenCalledWith(request, 'thr_owner')
    expect(result).toBe(forwarded)
  })
})
