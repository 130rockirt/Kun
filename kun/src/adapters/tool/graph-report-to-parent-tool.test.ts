import { describe, expect, it, vi } from 'vitest'
import {
  GraphMessageV1Schema,
  type GraphNodeAttemptV1,
  type GraphRunV1
} from '../../contracts/index.js'
import { applyGraphEvent } from '../../graph/graph-reducer.js'
import {
  testAssignmentSnapshot,
  testGraphEnvelope,
  testGraphPlan
} from '../../graph/graph-test-fixtures.test-support.js'
import { GraphWorkerSessionRegistry } from '../../graph/graph-worker-sessions.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { buildGraphReportToParentTool } from './graph-report-to-parent-tool.js'

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
  childThreadId: 'worker_thread',
  queuedAt: '2026-07-29T00:00:00.000Z',
  startedAt: '2026-07-29T00:00:01.000Z',
  tokenUsage: 0,
  elapsedMs: 1_000
}

function runWithAttempts(attempts: GraphNodeAttemptV1[] = [attempt]): GraphRunV1 {
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
        attempts
      }
    }
  }
}

function context(threadId = 'worker_thread'): ToolHostContext {
  return {
    threadId,
    turnId: 'worker_turn',
    workspace: '/workspace',
    orchestration: 'graph',
    approvalPolicy: 'never',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'deny'
  }
}

function harness(run = runWithAttempts()) {
  const sessions = new GraphWorkerSessionRegistry()
  sessions.bind('worker_thread', {
    runId: run.id,
    nodeId: 'research',
    attemptId: attempt.id
  })
  const send = vi.fn(async (input: Record<string, unknown>) => ({
    run: { ...run, lastEventSeq: run.lastEventSeq + 1 },
    message: GraphMessageV1Schema.parse({
      version: 1,
      ...input,
      status: 'queued',
      createdAt: '2026-07-29T00:00:02.000Z'
    }),
    duplicate: false
  }))
  const signal = vi.fn(async () => undefined)
  let sequence = 0
  const tool = buildGraphReportToParentTool({
    store: { get: async () => run } as never,
    mailbox: { send } as never,
    workerSessions: sessions,
    shouldAdvertise: (ctx) => sessions.has(ctx.threadId),
    signalSupervision: signal,
    nextId: (prefix) => `${prefix}_${++sequence}`
  })
  return { tool, sessions, send, signal }
}

describe('report_to_parent', () => {
  it('infers worker identity and wakes the Lead for a material finding', async () => {
    const { tool, send, signal } = harness()
    const result = await tool.execute({
      type: 'finding',
      summary: 'The API and UI use different field names.',
      details: 'Runtime emits workerId while the renderer reads nodeId.',
      evidence: ['src/runtime.ts:42', 'src/view.tsx:18']
    }, context())

    expect(result.output).toMatchObject({
      accepted: true,
      type: 'finding',
      leadNotified: true,
      workflowStateChanged: false
    })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run_1',
      sender: {
        kind: 'worker',
        nodeId: 'research',
        attemptId: 'attempt_research_1'
      },
      recipients: [{ kind: 'lead' }],
      type: 'finding',
      priority: 'normal',
      summary: 'The API and UI use different field names.',
      details: expect.stringContaining('src/runtime.ts:42'),
      replyRequired: false
    }), expect.any(Object))
    expect(signal).toHaveBeenCalledWith({
      runId: 'run_1',
      reason: 'worker_report',
      nodeIds: ['research'],
      digest: 'finding: The API and UI use different field names.'
    })
  })

  it('persists progress without waking and makes questions blocking', async () => {
    const { tool, send, signal } = harness()
    const progress = await tool.execute({
      type: 'progress',
      summary: 'Inspected both runtime entry points.'
    }, context())
    expect(progress.output).toMatchObject({ leadNotified: false })
    expect(signal).not.toHaveBeenCalled()

    const question = await tool.execute({
      type: 'question',
      summary: 'Should the compatibility route remain public?'
    }, context())
    expect(question.output).toMatchObject({ leadNotified: true })
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'question',
      priority: 'blocking',
      replyRequired: true
    })
  })

  it('rejects unbound and stale child attempts', async () => {
    const { tool, sessions, send } = harness()
    sessions.release('worker_thread')
    const unbound = await tool.execute({
      type: 'risk',
      summary: 'Unbound report.'
    }, context())
    expect(unbound).toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('not bound') }
    })
    expect(send).not.toHaveBeenCalled()

    const newer = {
      ...attempt,
      id: 'attempt_research_2',
      attemptNumber: 2,
      childThreadId: 'new_worker_thread'
    }
    const staleHarness = harness(runWithAttempts([attempt, newer]))
    const stale = await staleHarness.tool.execute({
      type: 'result',
      summary: 'Stale result.'
    }, context())
    expect(stale).toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('stale') }
    })
    expect(staleHarness.send).not.toHaveBeenCalled()
  })
})
