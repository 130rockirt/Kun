import { describe, expect, it, vi } from 'vitest'
import { GRAPH_CONTRACT_VERSION } from '../../contracts/index.js'
import {
  testAssignmentSnapshot,
  testGraphEnvelope,
  testGraphPlan
} from '../../graph/graph-test-fixtures.test-support.js'
import { graphReviewSemanticKey } from '../../graph/graph-control-service.js'
import { replayGraphEvents } from '../../graph/graph-reducer.js'
import { GraphWorkerSessionRegistry } from '../../graph/graph-worker-sessions.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
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

function reviewableRun(valid = true) {
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
  const node = run.nodes.research!
  node.status = 'reviewing'
  node.attempts = [{
    version: GRAPH_CONTRACT_VERSION,
    id: 'attempt_latest',
    runId: run.id,
    nodeId: node.node.id,
    revision: run.currentRevision,
    attemptNumber: 1,
    iteration: 0,
    commandId: 'command_attempt',
    idempotencyKey: 'attempt:latest',
    status: 'reviewing',
    assignment: testAssignmentSnapshot(),
    result: {
      version: GRAPH_CONTRACT_VERSION,
      summary: 'Inspected the target and returned bounded evidence.',
      artifactRefs: [],
      changedFiles: [],
      evidence: ['Relevant source was inspected.'],
      risks: [],
      suggestedMessages: []
    },
    validation: {
      version: GRAPH_CONTRACT_VERSION,
      valid,
      issues: valid
        ? []
        : [{
            code: 'required_field_missing',
            path: ['checks'],
            message: 'Required checks are missing.',
            severity: 'error'
          }],
      normalizedNodeCount: 1,
      normalizedEdgeCount: 0
    },
    queuedAt: '2026-07-29T00:00:00.000Z',
    startedAt: '2026-07-29T00:00:01.000Z',
    finishedAt: '2026-07-29T00:00:02.000Z',
    tokenUsage: 100,
    elapsedMs: 2_000
  }]
  run.status = 'awaiting_supervision'
  run.lastEventSeq = 17
  return run
}

function reviewTools(
  run: ReturnType<typeof reviewableRun>,
  recordReview: ReturnType<typeof vi.fn>,
  nextId: (prefix: string) => string = (prefix) => `${prefix}_1`
) {
  return buildGraphModeLocalTools({
    drafts: {} as never,
    events: { record: vi.fn() } as never,
    control: { recordReview } as never,
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
    enabled: () => true,
    nowIso: () => '2026-07-29T01:00:00.000Z',
    nextId
  })
}

describe('Graph Lead review tool', () => {
  it('advertises concise Lead-owned fields and normalizes a pass', async () => {
    const run = reviewableRun()
    const recordReview = vi.fn(async () => run)
    let next = 0
    const reviewTool = reviewTools(
      run,
      recordReview,
      (prefix) => `${prefix}_${++next}`
    ).find((tool) => tool.name === 'graph_review_node')!
    const schema = reviewTool.inputSchema as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema.required).toEqual(['runId', 'nodeId', 'outcome', 'summary'])
    expect(schema.properties).not.toHaveProperty('review')
    expect(schema.properties).not.toHaveProperty('expectedSeq')
    expect(schema.properties).not.toHaveProperty('expectedRevision')

    const result = await reviewTool.execute({
      runId: run.id,
      nodeId: 'research',
      outcome: 'pass',
      summary: 'The inspected evidence satisfies the node contract.',
      evidence: ['Confirmed the relevant source path.']
    }, context())

    expect(result.isError).not.toBe(true)
    expect(recordReview).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({
        version: GRAPH_CONTRACT_VERSION,
        reviewId: 'graph_review_1',
        nodeId: 'research',
        attemptId: 'attempt_latest',
        reviewerKind: 'lead',
        outcome: 'pass',
        summary: 'The inspected evidence satisfies the node contract.',
        evidence: ['Confirmed the relevant source path.'],
        artifactRefs: [],
        createdAt: '2026-07-29T01:00:00.000Z'
      }),
      expect.objectContaining({
        commandId: 'graph_command_2',
        idempotencyKey: graphReviewSemanticKey(run.id, 'attempt_latest', 'lead'),
        expectedRevision: 1
      }),
      'lead'
    )
  })

  it('reuses one semantic command key when the same Lead decision is replayed', async () => {
    const run = reviewableRun()
    let next = 0
    const recordReview = vi.fn(async (
      _runId: string,
      review: ReturnType<typeof reviewableRun>['reviews'][number],
      _command: { commandId: string; idempotencyKey: string },
      _authority: 'lead'
    ) => {
      if (run.reviews.length === 0) {
        run.reviews.push(review)
        run.nodes.research!.status = 'accepted'
        run.nodes.research!.attempts[0]!.status = 'accepted'
        run.status = 'completed'
      }
      return run
    })
    const reviewTool = reviewTools(
      run,
      recordReview,
      (prefix) => `${prefix}_${++next}`
    ).find((tool) => tool.name === 'graph_review_node')!
    const input = {
      runId: run.id,
      nodeId: 'research',
      outcome: 'pass' as const,
      summary: 'The inspected evidence satisfies the node contract.',
      evidence: ['Confirmed the relevant source path.']
    }

    const first = await reviewTool.execute(input, context())
    const replay = await reviewTool.execute(input, context())

    expect(first.isError).not.toBe(true)
    expect(replay.isError).not.toBe(true)
    expect(recordReview).toHaveBeenCalledTimes(2)
    const firstReview = recordReview.mock.calls[0]![1]
    const replayReview = recordReview.mock.calls[1]![1]
    expect(firstReview.reviewId).not.toBe(replayReview.reviewId)
    expect(recordReview.mock.calls.map((call) => call[2].idempotencyKey)).toEqual([
      graphReviewSemanticKey(run.id, 'attempt_latest', 'lead'),
      graphReviewSemanticKey(run.id, 'attempt_latest', 'lead')
    ])
  })

  it('preserves revision instructions and rejects stale or invalid pass targets', async () => {
    const run = reviewableRun()
    const recordReview = vi.fn(async () => run)
    const reviewTool = reviewTools(run, recordReview)
      .find((tool) => tool.name === 'graph_review_node')!
    const revise = await reviewTool.execute({
      runId: run.id,
      nodeId: 'research',
      outcome: 'revise',
      summary: 'The result omitted a required check.',
      repairInstructions: 'Run the focused check and report its actual outcome.'
    }, context())
    expect(revise.isError).not.toBe(true)
    expect(recordReview).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({
        outcome: 'revise',
        repairInstructions: 'Run the focused check and report its actual outcome.'
      }),
      expect.any(Object),
      'lead'
    )

    run.nodes.research!.attempts.unshift({
      ...run.nodes.research!.attempts[0]!,
      id: 'attempt_stale',
      attemptNumber: 1
    })
    const stale = await reviewTool.execute({
      runId: run.id,
      nodeId: 'research',
      attemptId: 'attempt_stale',
      outcome: 'revise',
      summary: 'Try to revise an old attempt.'
    }, context())
    expect(stale).toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('not a submitted result awaiting review') }
    })

    const invalidRun = reviewableRun(false)
    const invalidPass = await reviewTools(invalidRun, recordReview)
      .find((tool) => tool.name === 'graph_review_node')!
      .execute({
        runId: invalidRun.id,
        nodeId: 'research',
        outcome: 'pass',
        summary: 'Attempt to pass invalid evidence.'
      }, context())
    expect(invalidPass).toMatchObject({
      isError: true,
      output: { error: 'cannot pass invalid attempt attempt_latest' }
    })
  })

  it('bounds oversized Lead prose instead of rejecting and retrying the review', async () => {
    const run = reviewableRun()
    const recordReview = vi.fn(async (..._args: unknown[]) => run)
    const reviewTool = reviewTools(run, recordReview)
      .find((tool) => tool.name === 'graph_review_node')!
    const result = await reviewTool.execute({
      runId: run.id,
      nodeId: 'research',
      outcome: 'revise',
      summary: '审'.repeat(4_311),
      evidence: [
        '证'.repeat(4_311),
        ...Array.from({ length: 140 }, (_, index) => `evidence-${index}`)
      ],
      artifactRefs: [{
        version: 1,
        artifactId: 'fabricated_review_artifact',
        contentHash: 'a'.repeat(64),
        mimeType: 'text/plain',
        byteLength: 1,
        summary: 'Not published by the reviewed attempt.',
        visibility: 'lead',
        retention: 'run',
        createdAt: '2026-07-29T01:00:00.000Z'
      }],
      repairInstructions: '修'.repeat(33_000)
    }, context())

    expect(result.isError).not.toBe(true)
    expect(recordReview).toHaveBeenCalledOnce()
    const review = recordReview.mock.calls[0]?.[1] as {
      summary: string
      evidence: string[]
      artifactRefs: unknown[]
      repairInstructions: string
    }
    expect(review.summary).toHaveLength(4_096)
    expect(review.evidence).toHaveLength(128)
    expect(review.evidence[0]).toHaveLength(4_096)
    expect(review.artifactRefs).toEqual([])
    expect(review.repairInstructions).toHaveLength(32_768)
  })

  it('rejects a later Graph turn in the same thread reviewing an older run', async () => {
    const run = reviewableRun()
    const recordReview = vi.fn(async () => run)
    const reviewTool = reviewTools(run, recordReview)
      .find((tool) => tool.name === 'graph_review_node')!

    const result = await reviewTool.execute({
      runId: run.id,
      nodeId: 'research',
      outcome: 'pass',
      summary: 'A later turn must not inherit Lead authority.'
    }, {
      ...context(),
      turnId: 'turn_2'
    })

    expect(result).toMatchObject({
      isError: true,
      output: { error: 'current Lead turn does not own this GraphRun' }
    })
    expect(recordReview).not.toHaveBeenCalled()
  })
})
