import { describe, expect, it, vi } from 'vitest'
import {
  GRAPH_CONTRACT_VERSION,
  GraphNodeAttemptV1Schema,
  type GraphRunV1
} from '../contracts/graph.js'
import { GraphControlService } from './graph-control-service.js'
import { replayGraphEvents } from './graph-reducer.js'
import {
  TEST_GRAPH_NOW,
  testAssignmentSnapshot,
  testGraphConfig,
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

function testRun(): GraphRunV1 {
  return replayGraphEvents([
    testGraphEnvelope(1, {
      type: 'run_created',
      payload: {
        plan: testGraphPlan(),
        projectId: 'project_1',
        sourceTurnId: 'turn_1'
      }
    })
  ])
}

function attempt(run: GraphRunV1, attemptNumber: number, iteration: number) {
  return GraphNodeAttemptV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    id: `attempt_${iteration}_${attemptNumber}`,
    runId: run.id,
    nodeId: 'research',
    revision: run.currentRevision,
    attemptNumber,
    iteration,
    commandId: `command_${iteration}_${attemptNumber}`,
    idempotencyKey: `attempt:${iteration}:${attemptNumber}`,
    status: 'failed',
    assignment: testAssignmentSnapshot(),
    failureClass: 'retryable',
    normalizedFailure: 'test failure',
    queuedAt: TEST_GRAPH_NOW,
    finishedAt: TEST_GRAPH_NOW,
    tokenUsage: 0,
    elapsedMs: 1
  })
}

describe('GraphControlService retry admission', () => {
  it('rejects retry after the node consumes its effective attempt limit', async () => {
    const run = testRun()
    run.status = 'awaiting_supervision'
    run.nodes.research.status = 'failed'
    run.nodes.research.attempts = [
      attempt(run, 1, 0),
      attempt(run, 2, 0)
    ]
    const append = vi.fn()
    const control = new GraphControlService({
      store: { get: async () => run, append } as never,
      config: () => testGraphConfig()
    })

    await expect(control.retryNode(run.id, 'research', {
      commandId: 'retry_exhausted',
      idempotencyKey: 'retry_exhausted'
    })).rejects.toThrow(/used 2 of 2 attempts/)
    expect(append).not.toHaveBeenCalled()
  })

  it('counts only attempts from the current loop iteration', async () => {
    const run = testRun()
    run.status = 'awaiting_supervision'
    run.nodes.research.status = 'failed'
    run.nodes.research.loopIteration = 1
    run.nodes.research.attempts = [
      attempt(run, 1, 0),
      attempt(run, 2, 0),
      attempt(run, 3, 1)
    ]
    const append = vi.fn(async () => ({ state: run }))
    const control = new GraphControlService({
      store: { get: async () => run, append } as never,
      config: () => testGraphConfig()
    })

    await control.retryNode(run.id, 'research', {
      commandId: 'retry_loop_iteration',
      idempotencyKey: 'retry_loop_iteration'
    })
    expect(append).toHaveBeenCalledOnce()
  })

  it('does not bypass blocked or dependency-unsatisfied work', async () => {
    const run = testRun()
    run.status = 'running'
    run.nodes.finish.status = 'blocked'
    const append = vi.fn()
    const control = new GraphControlService({
      store: { get: async () => run, append } as never,
      config: () => testGraphConfig()
    })

    await expect(control.retryNode(run.id, 'finish', {
      commandId: 'retry_blocked',
      idempotencyKey: 'retry_blocked'
    })).rejects.toThrow(/cannot retry node finish from blocked/)

    run.nodes.finish.status = 'skipped'
    await expect(control.retryNode(run.id, 'finish', {
      commandId: 'retry_skipped',
      idempotencyKey: 'retry_skipped'
    })).rejects.toThrow(/dependencies are blocked/)
    expect(append).not.toHaveBeenCalled()
  })
})
