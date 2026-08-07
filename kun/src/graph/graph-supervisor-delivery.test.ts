import { describe, expect, it, vi } from 'vitest'
import type { GraphDomainEventV1, GraphRunV1 } from '../contracts/graph.js'
import { applyGraphEvent } from './graph-reducer.js'
import type { AppendGraphEventInput } from './graph-run-store.js'
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

function applyTestAppend(
  current: GraphRunV1,
  input: AppendGraphEventInput
) {
  const graphSeq = current.lastEventSeq + 1
  const envelope = testGraphEnvelope(graphSeq, input.event as GraphDomainEventV1, {
    eventId: `graph_event_${current.id}_${graphSeq}`,
    runId: current.id,
    threadId: current.threadId,
    graphRevision: input.graphRevision,
    ...(input.commandId ? { commandId: input.commandId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.timestamp ? { timestamp: input.timestamp } : {})
  })
  return {
    state: applyGraphEvent(current, envelope),
    envelope,
    duplicate: false as const
  }
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
      events: vi.fn(async () => []),
      append: vi.fn(async (_runId: string, input: AppendGraphEventInput) => {
        const result = applyTestAppend(current, input)
        current = result.state
        return result
      })
    }
    let leadAStarted!: () => void
    const startedA = new Promise<void>((resolve) => {
      leadAStarted = resolve
    })
    let leadBStarted!: () => void
    const startedB = new Promise<void>((resolve) => {
      leadBStarted = resolve
    })
    let releaseLeadA!: () => void
    const releasedA = new Promise<void>((resolve) => {
      releaseLeadA = resolve
    })
    let releaseLeadB!: () => void
    const releasedB = new Promise<void>((resolve) => {
      releaseLeadB = resolve
    })
    let episode = 0
    const supervisor = new GraphSupervisor({
      store: store as never,
      config: () => testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } }),
      delegation: () => undefined,
      leadTurn: async () => {
        episode += 1
        if (episode === 1) {
          leadAStarted()
          await releasedA
          return
        }
        leadBStarted()
        await releasedB
      }
    })
    await supervisor.signal({
      runId: current.id,
      reason: 'help',
      nodeIds: [],
      digest: 'Deliver episode A.'
    })
    const flushingA = supervisor.flush(current.id)
    await startedA

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
    releaseLeadA()
    await startedB

    expect(current.steering).toEqual([
      expect.objectContaining({ steeringId: 'steering_a', status: 'handled' }),
      expect.objectContaining({ steeringId: 'steering_b', status: 'persisted' })
    ])
    releaseLeadB()
    await flushingA

    expect(current.steering).toEqual([
      expect.objectContaining({ steeringId: 'steering_a', status: 'handled' }),
      expect.objectContaining({ steeringId: 'steering_b', status: 'handled' })
    ])
    await supervisor.stop()
  })
})
