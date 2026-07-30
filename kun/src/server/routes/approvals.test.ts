import { describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalGate } from '../../adapters/in-memory-approval-gate.js'
import { createApprovalRequest } from '../../domain/approval.js'
import { decideApproval } from './approvals.js'

function decisionRequest(approvalId: string, decision: 'allow' | 'deny'): Request {
  return new Request(`http://127.0.0.1/v1/approvals/${approvalId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision })
  })
}

describe('approval decision route', () => {
  it.each([
    'review_automatic_1',
    'approval_automatic_1'
  ])('cannot resolve unregistered automatic identifier %s', async (identifier) => {
    const gate = new InMemoryApprovalGate()
    const events = { record: vi.fn(async () => undefined) }

    const response = await decideApproval({
      approvalId: identifier,
      request: decisionRequest(identifier, 'allow'),
      gate,
      events: events as never
    })
    if (response instanceof Response) throw new Error('expected JSON response')

    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'not_found',
      message: expect.stringContaining(identifier)
    })
    expect(gate.get(identifier)).toBeUndefined()
    expect(gate.pending()).toEqual([])
    expect(events.record).not.toHaveBeenCalled()
  })

  it('serializes concurrent manual clients and persists one resolution before release', async () => {
    const gate = new InMemoryApprovalGate()
    const pending = gate.request(createApprovalRequest({
      id: 'approval_manual_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      toolName: 'write',
      summary: 'Write the requested file'
    }))
    const events = {
      record: vi.fn(async () => undefined)
    }

    const [first, second] = await Promise.all([
      decideApproval({
        approvalId: 'approval_manual_1',
        request: decisionRequest('approval_manual_1', 'allow'),
        gate,
        events: events as never
      }),
      decideApproval({
        approvalId: 'approval_manual_1',
        request: decisionRequest('approval_manual_1', 'allow'),
        gate,
        events: events as never
      })
    ])
    if (first instanceof Response || second instanceof Response) {
      throw new Error('expected JSON responses')
    }

    await expect(pending).resolves.toBe('allow')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect([
      JSON.parse(first.body).alreadyResolved,
      JSON.parse(second.body).alreadyResolved
    ].filter(Boolean)).toHaveLength(1)
    expect(events.record).toHaveBeenCalledOnce()
    expect(events.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'approval_resolved',
      approvalId: 'approval_manual_1',
      approvalReviewer: 'user',
      status: 'allowed'
    }))
  })

  it('allows only one winner when concurrent manual clients submit opposite decisions', async () => {
    const gate = new InMemoryApprovalGate()
    const pending = gate.request(createApprovalRequest({
      id: 'approval_manual_race',
      threadId: 'thread_1',
      turnId: 'turn_1',
      toolName: 'bash',
      summary: 'Run a command'
    }))
    const events = {
      record: vi.fn(async () => undefined)
    }

    const responses = await Promise.all([
      decideApproval({
        approvalId: 'approval_manual_race',
        request: decisionRequest('approval_manual_race', 'allow'),
        gate,
        events: events as never
      }),
      decideApproval({
        approvalId: 'approval_manual_race',
        request: decisionRequest('approval_manual_race', 'deny'),
        gate,
        events: events as never
      })
    ])
    if (responses.some((response) => response instanceof Response)) {
      throw new Error('expected JSON responses')
    }
    const jsonResponses = responses as Array<{
      status: number
      body: string
    }>
    const winner = await pending

    expect(jsonResponses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(events.record).toHaveBeenCalledOnce()
    expect(events.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'approval_resolved',
      approvalId: 'approval_manual_race',
      approvalReviewer: 'user',
      status: winner === 'allow' ? 'allowed' : 'denied'
    }))
    expect(gate.get('approval_manual_race')).toMatchObject({
      status: winner === 'allow' ? 'allowed' : 'denied'
    })
  })
})
