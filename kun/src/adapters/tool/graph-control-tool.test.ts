import { describe, expect, it, vi } from 'vitest'
import {
  GRAPH_CONTRACT_VERSION,
  GraphNodeAttemptV1Schema
} from '../../contracts/index.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { replayGraphEvents } from '../../graph/graph-reducer.js'
import {
  TEST_GRAPH_NOW,
  testAssignmentSnapshot,
  testGraphConfig,
  testGraphEnvelope,
  testGraphPlan
} from '../../graph/graph-test-fixtures.test-support.js'
import { GraphWorkerSessionRegistry } from '../../graph/graph-worker-sessions.js'
import { buildGraphModeLocalTools } from './graph-mode-tool-provider.js'

function context(): ToolHostContext {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    workspace: '/workspace',
    orchestration: 'graph',
    approvalPolicy: 'never',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'deny'
  }
}

describe('graph_control_run model surface', () => {
  it('keeps host fields and non-delivering steer off the bounded control tool', async () => {
    const run = replayGraphEvents([
      testGraphEnvelope(1, {
        type: 'run_created',
        payload: {
          plan: testGraphPlan(),
          projectId: 'project_1',
          sourceTurnId: 'turn_1'
        }
      })
    ])
    run.status = 'awaiting_supervision'
    run.nodes.research.status = 'failed'
    run.nodes.research.attempts = [1, 2].map((attemptNumber) =>
      GraphNodeAttemptV1Schema.parse({
        version: GRAPH_CONTRACT_VERSION,
        id: `attempt_research_${attemptNumber}`,
        runId: run.id,
        nodeId: 'research',
        revision: run.currentRevision,
        attemptNumber,
        iteration: 0,
        commandId: `command_research_${attemptNumber}`,
        idempotencyKey: `attempt:research:${attemptNumber}`,
        status: 'failed',
        assignment: testAssignmentSnapshot(),
        failureClass: 'retryable',
        normalizedFailure: 'Host rejected the result.',
        queuedAt: TEST_GRAPH_NOW,
        finishedAt: TEST_GRAPH_NOW,
        tokenUsage: 0,
        elapsedMs: 1
      }))
    run.nodes.finish.status = 'blocked'
    const tools = buildGraphModeLocalTools({
      drafts: {} as never,
      events: { record: vi.fn() } as never,
      control: {} as never,
      store: { get: async () => run } as never,
      mailbox: {} as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      config: () => testGraphConfig(),
      enabled: () => true
    })
    const control = tools.find((tool) => tool.name === 'graph_control_run')!
    const schema = JSON.stringify(control.inputSchema)
    expect(schema).not.toContain('expectedSeq')
    expect(schema).not.toContain('expectedRevision')
    expect(schema).not.toContain('"steer"')
    expect(control.description).toContain('graph_supervise_node guide')

    const result = await control.execute(
      { action: 'inspect', runId: run.id },
      context()
    )
    expect(result.isError).not.toBe(true)
    expect(result.output).toMatchObject({
      runId: run.id,
      status: run.status,
      currentRevision: 1,
      plan: {
        nodeCount: 2,
        edgeCount: 1,
        completionNodeIds: ['finish']
      },
      nodes: expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'research',
          attemptCount: 2,
          effectiveMaxAttempts: 2,
          attemptsRemaining: 0,
          canRetry: false,
          canSupersede: true
        }),
        expect.objectContaining({
          nodeId: 'finish',
          canRetry: false,
          canSupersede: false
        })
      ])
    })
    expect(result.output).not.toHaveProperty('plans')
    expect(result.output).not.toHaveProperty('messages')
    expect(result.output).not.toHaveProperty('steering')

    run.nodes.research.loopIteration = 1
    run.nodes.research.attempts.push(GraphNodeAttemptV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      id: 'attempt_research_3',
      runId: run.id,
      nodeId: 'research',
      revision: run.currentRevision,
      attemptNumber: 3,
      iteration: 1,
      commandId: 'command_research_3',
      idempotencyKey: 'attempt:research:3',
      status: 'failed',
      assignment: testAssignmentSnapshot(),
      failureClass: 'retryable',
      normalizedFailure: 'Current loop iteration failure.',
      queuedAt: TEST_GRAPH_NOW,
      finishedAt: TEST_GRAPH_NOW,
      tokenUsage: 0,
      elapsedMs: 1
    }))
    const nextIteration = await control.execute(
      { action: 'inspect', runId: run.id },
      context()
    )
    expect(nextIteration.output).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'research',
          attemptCount: 3,
          currentIterationAttemptCount: 1,
          effectiveMaxAttempts: 2,
          attemptsRemaining: 1,
          canRetry: true,
          canSupersede: false
        })
      ])
    })
  })
})
