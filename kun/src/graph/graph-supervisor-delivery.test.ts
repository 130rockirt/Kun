import { describe, expect, it, vi } from 'vitest'
import type { GraphRunV1 } from '../contracts/graph.js'
import { applyGraphEvent } from './graph-reducer.js'
import { GraphSupervisor } from './graph-supervisor.js'
import {
  testGraphConfig,
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

function baseRun(): GraphRunV1 {
  return applyGraphEvent(undefined, testGraphEnvelope(1, {
    type: 'run_created',
    payload: {
      plan: testGraphPlan(),
      projectId: 'project_1',
      sourceTurnId: 'turn_1'
    }
  }))
}

describe('GraphSupervisor delivery', () => {
  it('acknowledges only steering present in the delivered Lead episode', async () => {
    const steeringA = {
      version: 1 as const,
      steeringId: 'steering_a',
      runId: 'run_1',
      target: { kind: 'lead' as const },
      text: 'Episode A guidance.',
      status: 'persisted' as const,
      createdAt: '2026-07-26T00:00:00.000Z'
    }
    const steeringB = {
      ...steeringA,
      steeringId: 'steering_b',
      text: 'Episode B guidance.'
    }
    let current: GraphRunV1 = {
      ...baseRun(),
      status: 'running',
      steering: [steeringA]
    }
    const store = {
      get: vi.fn(async () => current),
      list: vi.fn(async () => [current]),
      append: vi.fn(async (_runId: string, input: {
        event: {
          type: string
          payload?: {
            steeringId?: string
            to?: 'handled'
          }
        }
      }) => {
        if (
          input.event.type === 'steering_status_changed' &&
          input.event.payload?.steeringId &&
          input.event.payload.to === 'handled'
        ) {
          current = {
            ...current,
            steering: current.steering.map((entry) =>
              entry.steeringId === input.event.payload!.steeringId
                ? { ...entry, status: 'handled' as const }
                : entry)
          }
        }
        current = { ...current, lastEventSeq: current.lastEventSeq + 1 }
        return { state: current, envelope: {}, duplicate: false }
      })
    }
    let leadStarted!: () => void
    const started = new Promise<void>((resolve) => {
      leadStarted = resolve
    })
    let releaseLead!: () => void
    const released = new Promise<void>((resolve) => {
      releaseLead = resolve
    })
    const supervisor = new GraphSupervisor({
      store: store as never,
      config: () => testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } }),
      delegation: () => undefined,
      leadTurn: async () => {
        leadStarted()
        await released
      }
    })
    await supervisor.signal({
      runId: current.id,
      reason: 'help',
      nodeIds: [],
      digest: 'Deliver episode A.'
    })
    const flushingA = supervisor.flush(current.id)
    await started

    // Steering B and its supervision request become durable while A is still
    // running. A must not acknowledge either on B's behalf.
    current = {
      ...current,
      steering: [...current.steering, steeringB],
      lastEventSeq: current.lastEventSeq + 1
    }
    await supervisor.signal({
      runId: current.id,
      reason: 'user_steering',
      nodeIds: [],
      digest: 'Deliver episode B.'
    })
    releaseLead()
    await flushingA

    expect(current.steering).toEqual([
      expect.objectContaining({ steeringId: 'steering_a', status: 'handled' }),
      expect.objectContaining({ steeringId: 'steering_b', status: 'persisted' })
    ])
    await supervisor.stop()
  })
})
