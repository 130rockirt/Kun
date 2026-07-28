import { describe, expect, it, vi } from 'vitest'
import type {
  GraphNodeAttemptV1,
  GraphRunV1,
  TurnItem
} from '../../contracts/index.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { applyGraphEvent } from '../../graph/graph-reducer.js'
import {
  testAssignmentSnapshot,
  testGraphEnvelope,
  testGraphPlan
} from '../../graph/graph-test-fixtures.test-support.js'
import { buildGraphLeadSupervisionTool } from './graph-lead-supervision-tool.js'

const attempt: GraphNodeAttemptV1 = {
  version: 1,
  id: 'attempt_research_1',
  runId: 'run_1',
  nodeId: 'research',
  revision: 1,
  attemptNumber: 1,
  iteration: 0,
  commandId: 'command_attempt_1',
  idempotencyKey: 'attempt:research:1',
  status: 'running',
  assignment: testAssignmentSnapshot(),
  childThreadId: 'child_thread_1',
  queuedAt: '2026-07-28T00:00:00.000Z',
  startedAt: '2026-07-28T00:00:01.000Z',
  tokenUsage: 0,
  elapsedMs: 1_000
}

function graphRun(): GraphRunV1 {
  const base = applyGraphEvent(undefined, testGraphEnvelope(1, {
    type: 'run_created',
    payload: {
      plan: testGraphPlan({ workspaceRoot: '/workspace' }),
      projectId: 'project_1',
      sourceTurnId: 'turn_1'
    }
  }))
  return {
    ...base,
    status: 'running',
    nodes: {
      ...base.nodes,
      research: {
        ...base.nodes.research,
        status: 'running',
        attempts: [attempt]
      }
    }
  }
}

function item(value: Record<string, unknown>): TurnItem {
  return {
    turnId: 'child_turn_1',
    threadId: 'child_thread_1',
    role: 'assistant',
    status: 'completed',
    createdAt: '2026-07-28T00:00:02.000Z',
    ...value
  } as TurnItem
}

function context(abortSignal = new AbortController().signal): ToolHostContext {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    workspace: '/workspace',
    orchestration: 'graph',
    approvalPolicy: 'never',
    abortSignal,
    awaitApproval: async () => 'deny'
  }
}

function harness(items: TurnItem[]) {
  const run = graphRun()
  const steer = vi.fn(async () => run)
  const steerChildTurn = vi.fn(async () => undefined)
  const loadItems = vi.fn(async () => items)
  const tool = buildGraphLeadSupervisionTool({
    control: { steer } as never,
    store: { get: async () => run } as never,
    registry: {
      identify: async () => ({
        projectId: 'project_1',
        canonicalWorkspaceRoot: '/workspace'
      })
    } as never,
    threads: {
      get: async () => ({
        id: 'child_thread_1',
        status: 'running',
        turns: [{ id: 'child_turn_1', status: 'running' }]
      } as never)
    },
    sessions: { loadItems },
    steerChildTurn: () => steerChildTurn,
    childActivity: async () => ({
      status: 'running',
      activity: {
        phase: 'tool',
        label: 'Reading src/docs.css',
        toolName: 'read',
        startedAt: '2026-07-28T00:00:01.000Z',
        updatedAt: '2026-07-28T00:00:02.000Z'
      },
      updatedAt: '2026-07-28T00:00:02.000Z'
    }),
    shouldAdvertise: () => true,
    nowIso: () => '2026-07-28T00:00:03.000Z',
    nextId: (prefix) => `${prefix}_1`
  })
  return { tool, steer, steerChildTurn, loadItems }
}

describe('graph_supervise_node', () => {
  it('returns a bounded cursor page without provider continuation metadata', async () => {
    const items = [
      item({ id: 'item_1', kind: 'assistant_reasoning', text: 'Inspecting the footer.' }),
      item({
        id: 'item_2',
        kind: 'tool_call',
        toolName: 'read',
        callId: 'call_1',
        toolKind: 'tool_call',
        arguments: { path: 'src/docs.css' },
        providerMetadata: { gemini: { thoughtSignature: 'secret-continuation' } }
      }),
      item({
        id: 'item_3',
        kind: 'tool_result',
        toolName: 'read',
        callId: 'call_1',
        toolKind: 'tool_call',
        output: 'x'.repeat(10_000),
        isError: false
      })
    ]
    const { tool } = harness(items)
    const result = await tool.execute({
      action: 'inspect',
      runId: 'run_1',
      nodeId: 'research',
      afterItemId: 'item_1',
      limit: 2
    }, context())
    const output = result.output as {
      child: { runtimeActivity: { activity: { label: string } } }
      transcript: { items: Array<Record<string, unknown>>; nextCursor: string }
    }

    expect(result.isError).not.toBe(true)
    expect(output.transcript.items.map((entry) => entry.id)).toEqual(['item_2', 'item_3'])
    expect(output.transcript.nextCursor).toBe('item_3')
    expect(output.child.runtimeActivity.activity.label).toBe('Reading src/docs.css')
    expect(JSON.stringify(output)).not.toContain('providerMetadata')
    expect(JSON.stringify(output)).not.toContain('secret-continuation')
    expect(JSON.stringify(output)).toContain('[truncated]')
  })

  it('persists attempt guidance before steering the active child turn', async () => {
    const { tool, steer, steerChildTurn } = harness([])
    const result = await tool.execute({
      action: 'guide',
      runId: 'run_1',
      nodeId: 'research',
      text: 'Publish footer-analysis with graph_worker_publish_artifact.'
    }, context())

    expect(result.output).toMatchObject({
      persisted: true,
      immediateDelivery: { status: 'delivered' }
    })
    expect(steer).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({
        target: {
          kind: 'attempt',
          nodeId: 'research',
          attemptId: 'attempt_research_1'
        }
      }),
      expect.any(Object),
      false
    )
    expect(steerChildTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'child_thread_1',
      turnId: 'child_turn_1',
      text: expect.stringContaining('Publish footer-analysis')
    }))

    steerChildTurn.mockRejectedValueOnce(new Error('turn is no longer active'))
    const raced = await tool.execute({
      action: 'guide',
      runId: 'run_1',
      nodeId: 'research',
      text: 'Keep this instruction for the repair attempt.'
    }, context())
    expect(raced.output).toMatchObject({
      persisted: true,
      immediateDelivery: {
        status: 'queued',
        detail: expect.stringContaining('turn is no longer active')
      }
    })
  })

  it('waits for the Lead-selected interval and then performs a fresh inspection', async () => {
    vi.useFakeTimers()
    try {
      const progress = item({
        id: 'item_after_wait',
        kind: 'assistant_text',
        text: 'The footer artifact is now being published.'
      })
      const { tool, loadItems } = harness([progress])
      const waiting = tool.execute({
        action: 'wait',
        runId: 'run_1',
        nodeId: 'research',
        waitMs: 30_000
      }, context())
      await Promise.resolve()
      await Promise.resolve()
      expect(loadItems).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(30_000)
      const result = await waiting
      expect(loadItems).toHaveBeenCalledOnce()
      expect(result.output).toMatchObject({
        transcript: {
          items: [expect.objectContaining({
            id: 'item_after_wait',
            text: 'The footer artifact is now being published.'
          })]
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits abortably and does not expose another Lead turn child session', async () => {
    const controller = new AbortController()
    const { tool, loadItems } = harness([])
    const waiting = tool.execute({
      action: 'wait',
      runId: 'run_1',
      nodeId: 'research',
      waitMs: 30_000
    }, context(controller.signal))
    controller.abort()
    const aborted = await waiting

    expect(aborted).toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('aborted') }
    })
    expect(loadItems).not.toHaveBeenCalled()

    const unauthorized = await tool.execute({
      action: 'inspect',
      runId: 'run_1',
      nodeId: 'research'
    }, { ...context(), turnId: 'turn_other' })
    expect(unauthorized).toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('does not own') }
    })
    expect(loadItems).not.toHaveBeenCalled()
  })
})
