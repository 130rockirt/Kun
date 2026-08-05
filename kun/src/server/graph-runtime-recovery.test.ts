import { describe, expect, it, vi } from 'vitest'
import type { GraphRunV1 } from '../contracts/graph.js'
import { applyGraphEvent } from '../graph/graph-reducer.js'
import { graphSupervisionObligationForSignal } from '../graph/graph-supervision-obligation.js'
import {
  testGraphConfig,
  testGraphEnvelope,
  testGraphPlan
} from '../graph/graph-test-fixtures.test-support.js'
import { recoverGraphLeadOwnership } from './graph-runtime-recovery.js'

function graphRun(status: GraphRunV1['status']): GraphRunV1 {
  const created = applyGraphEvent(undefined, testGraphEnvelope(1, {
    type: 'run_created',
    payload: {
      plan: testGraphPlan(),
      projectId: 'project_1',
      sourceTurnId: 'turn_1'
    }
  }))
  return { ...created, status }
}

describe('Graph runtime Lead ownership recovery', () => {
  it.each([
    ['completed', 'completion'],
    ['failed', 'failure'],
    ['cancelled', 'completion']
  ] as const)('recovers %s with the matching empty-subject lifecycle signal', async (
    status,
    reason
  ) => {
    const run = graphRun(status)
    const redeliverNow = vi.fn(async () => undefined)

    await recoverGraphLeadOwnership({
      store: {
        list: async () => [run],
        events: async () => []
      } as never,
      drafts: {
        findBySourceTurn: async () => null
      } as never,
      supervisor: { redeliverNow } as never,
      config: () => testGraphConfig(),
      threadStore: {
        get: async () => ({
          id: run.threadId,
          turns: [{ id: run.sourceTurnId, status: 'running' }]
        })
      } as never,
      handleSourceTurnTerminal: async () => undefined
    })

    expect(redeliverNow).toHaveBeenCalledOnce()
    expect(redeliverNow).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      reason,
      nodeIds: [],
      recoveryKey: `terminal:${status}:${run.sourceTurnId}:0`
    }))
  })

  it.each(['pending', 'delivering'] as const)(
    'reconciles a %s terminal obligation without restarting an already-terminal source turn',
    async (state) => {
      const base = graphRun('completed')
      const candidate = graphSupervisionObligationForSignal(base, {
        runId: base.id,
        reason: 'completion',
        nodeIds: [],
        digest: 'Persisted terminal outcome.'
      }, '2026-07-26T00:00:00.000Z')
      const run: GraphRunV1 = {
        ...base,
        supervisionObligations: [{
          ...candidate,
          state,
          ...(state === 'delivering'
            ? {
                deliveryAttempts: 1,
                leaseUntil: '2026-07-26T00:00:30.000Z'
              }
            : {})
        }]
      }
      const reconcileTerminal = vi.fn(async () => undefined)
      const redeliverNow = vi.fn(async () => undefined)

      await recoverGraphLeadOwnership({
        store: { list: async () => [run] } as never,
        drafts: {} as never,
        supervisor: { reconcileTerminal, redeliverNow } as never,
        config: () => testGraphConfig(),
        threadStore: {
          get: async () => ({
            id: run.threadId,
            turns: [{ id: run.sourceTurnId, status: 'completed' }]
          })
        } as never,
        handleSourceTurnTerminal: async () => undefined
      })

      expect(reconcileTerminal).toHaveBeenCalledWith(run.id, {
        resolveLifecycle: true
      })
      expect(redeliverNow).not.toHaveBeenCalled()
    }
  )

  it('reconciles terminal obligations when the durable source turn is missing', async () => {
    const run = graphRun('cancelled')
    const reconcileTerminal = vi.fn(async () => undefined)
    const redeliverNow = vi.fn(async () => undefined)

    await recoverGraphLeadOwnership({
      store: { list: async () => [run] } as never,
      drafts: {} as never,
      supervisor: { reconcileTerminal, redeliverNow } as never,
      config: () => testGraphConfig(),
      threadStore: { get: async () => null } as never,
      handleSourceTurnTerminal: async () => undefined
    })

    expect(reconcileTerminal).toHaveBeenCalledWith(run.id, {
      resolveLifecycle: true
    })
    expect(redeliverNow).not.toHaveBeenCalled()
  })
})
