import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../src/contracts/events.js'
import type {
  ApprovalPolicy,
  ApprovalReviewer,
  SandboxMode
} from '../src/contracts/policy.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import type { ApprovalReviewPort } from '../src/ports/approval-review.js'
import type { ModelStreamChunk } from '../src/ports/model-client.js'
import { decideApproval } from '../src/server/routes/approvals.js'
import { ApprovalReviewService } from '../src/services/approval-review-service.js'
import { bootstrapThread, makeHarness, type Harness } from './loop-test-harness.js'
import {
  CapturingToolHost,
  ScriptedCapturingModel
} from './loop-transcript-harness.js'

const TOOL_NAME = 'permission_side_effect'
const ACTING_MODEL_ROUTE = {
  model: 'selected-model',
  providerId: 'selected-provider',
  accountId: 'selected-account'
} as const

type PermissionScenario = {
  harness: Harness
  model: ScriptedCapturingModel
  reviewModel?: ScriptedCapturingModel
  executed: () => number
}

describe('headless permission mode integration', () => {
  it.each([
    ['allow', 1],
    ['deny', 0]
  ] as const)('routes a manual user %s through the approval endpoint', async (decision, expectedExecutions) => {
    const scenario = await createPermissionScenario({
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalReviewer: 'user'
    })
    const approvalResponses: Array<ReturnType<typeof decideApproval>> = []
    const unsubscribe = scenario.harness.bus.subscribe(scenario.harness.threadId, (event) => {
      if (event.kind !== 'approval_requested') return
      approvalResponses.push(decideApproval({
        approvalId: event.approvalId,
        request: new Request(`http://127.0.0.1/v1/approvals/${event.approvalId}`, {
          method: 'POST',
          body: JSON.stringify({
            decision,
            reason: `integration user chose ${decision}`
          })
        }),
        gate: scenario.harness.approvalGate,
        events: scenario.harness.events
      }))
    })

    const status = await scenario.harness.loop.runTurn(
      scenario.harness.threadId,
      scenario.harness.turnId
    )
    unsubscribe()
    const responses = await Promise.all(approvalResponses)
    const events = await scenario.harness.sessionStore.loadEventsSince(
      scenario.harness.threadId,
      0
    )
    const result = await toolResult(scenario.harness)

    expect(status).toBe('completed')
    expect(responses).toHaveLength(1)
    expect(responses[0]?.status).toBe(200)
    expect(scenario.executed()).toBe(expectedExecutions)
    expect(events.filter((event) => event.kind === 'approval_requested')).toEqual([
      expect.objectContaining({
        approvalReviewer: 'user',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write'
      })
    ])
    expect(events.filter((event) => event.kind === 'approval_resolved')).toEqual([
      expect.objectContaining({
        approvalReviewer: 'user',
        status: decision === 'allow' ? 'allowed' : 'denied',
        reason: `integration user chose ${decision}`
      })
    ])
    expect(events.some(isApprovalReviewEvent)).toBe(false)
    if (decision === 'deny') {
      expect(result).toMatchObject({
        isError: true,
        output: {
          code: 'approval_denied',
          reviewer: 'user',
          reason: 'integration user chose deny'
        }
      })
    } else {
      expect(result).toMatchObject({
        isError: false,
        output: { executed: true }
      })
    }
  })

  it.each([
    {
      name: 'allow',
      chunks: reviewDecision('allow', 'low', 'The requested action is scoped to the task.'),
      expectedExecutions: 1,
      expectedStatus: 'approved'
    },
    {
      name: 'deny',
      chunks: reviewDecision('deny', 'high', 'The requested action has unrelated side effects.'),
      expectedExecutions: 0,
      expectedStatus: 'denied'
    },
    {
      name: 'fail closed when the review model fails',
      chunks: [
        { kind: 'error', message: 'review provider unavailable' },
        { kind: 'completed', stopReason: 'error' }
      ] satisfies ModelStreamChunk[],
      expectedExecutions: 0,
      expectedStatus: 'failed-closed'
    }
  ])(
    'uses the acting model route to $name',
    async ({ chunks, expectedExecutions, expectedStatus }) => {
      const scenario = await createPermissionScenario({
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalReviewer: 'agent',
        reviewChunks: chunks
      })

      const status = await scenario.harness.loop.runTurn(
        scenario.harness.threadId,
        scenario.harness.turnId
      )
      const events = await scenario.harness.sessionStore.loadEventsSince(
        scenario.harness.threadId,
        0
      )
      const reviewStarted = events.filter((event) => event.kind === 'approval_review_started')
      const reviewCompleted = events.filter((event) => event.kind === 'approval_review_completed')
      const approvalResolved = events.filter((event) => event.kind === 'approval_resolved')
      const result = await toolResult(scenario.harness)

      expect(status).toBe('completed')
      expect(scenario.executed()).toBe(expectedExecutions)
      expect(events.some((event) => event.kind === 'approval_requested')).toBe(false)
      expect(reviewStarted).toEqual([
        expect.objectContaining({
          reviewer: 'agent',
          status: 'in-progress',
          toolName: TOOL_NAME
        })
      ])
      expect(reviewCompleted).toEqual([
        expect.objectContaining({
          reviewer: 'agent',
          status: expectedStatus,
          decision: expectedExecutions === 1 ? 'allow' : 'deny',
          toolName: TOOL_NAME
        })
      ])
      expect(approvalResolved).toEqual([
        expect.objectContaining({
          approvalReviewer: 'agent',
          decisionSource: 'agent',
          status: expectedExecutions === 1 ? 'allowed' : 'denied',
          toolName: TOOL_NAME
        })
      ])
      expect(reviewCompleted[0]!.seq).toBeGreaterThan(reviewStarted[0]!.seq)
      expect(approvalResolved[0]!.seq).toBeGreaterThan(reviewCompleted[0]!.seq)
      expect(scenario.reviewModel?.requests).toHaveLength(1)
      expect(scenario.reviewModel?.requests[0]).toMatchObject({
        ...ACTING_MODEL_ROUTE,
        tools: [],
        stream: false,
        responseFormat: 'json_object'
      })
      if (expectedExecutions === 0) {
        expect(result).toMatchObject({
          isError: true,
          output: {
            code: 'approval_denied',
            reviewer: 'agent',
            reviewStatus: expectedStatus
          }
        })
      } else {
        expect(result).toMatchObject({
          isError: false,
          output: { executed: true }
        })
      }
    }
  )

  it('executes Full access without entering either approval path', async () => {
    const review = vi.fn<ApprovalReviewPort['review']>(async () => {
      throw new Error('Full access must not call the automatic reviewer')
    })
    const scenario = await createPermissionScenario({
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      approvalReviewer: 'user',
      approvalReview: { review }
    })

    const status = await scenario.harness.loop.runTurn(
      scenario.harness.threadId,
      scenario.harness.turnId
    )
    const events = await scenario.harness.sessionStore.loadEventsSince(
      scenario.harness.threadId,
      0
    )

    expect(status).toBe('completed')
    expect(scenario.executed()).toBe(1)
    expect(review).not.toHaveBeenCalled()
    expect(events.some((event) =>
      event.kind === 'approval_requested' ||
      event.kind === 'approval_resolved' ||
      isApprovalReviewEvent(event)
    )).toBe(false)
    expect(await toolResult(scenario.harness)).toMatchObject({
      isError: false,
      output: { executed: true }
    })
  })

  it('persists the review audit and fans out an identical ordered stream to concurrent subscribers', async () => {
    const scenario = await createPermissionScenario({
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalReviewer: 'agent',
      reviewChunks: reviewDecision(
        'allow',
        'low',
        'The action is necessary and bounded to the active task.'
      )
    })
    const firstSubscriber: RuntimeEvent[] = []
    const secondSubscriber: RuntimeEvent[] = []
    const unsubscribeFirst = scenario.harness.bus.subscribe(
      scenario.harness.threadId,
      (event) => firstSubscriber.push(event)
    )
    const unsubscribeSecond = scenario.harness.bus.subscribe(
      scenario.harness.threadId,
      (event) => secondSubscriber.push(event)
    )

    const status = await scenario.harness.loop.runTurn(
      scenario.harness.threadId,
      scenario.harness.turnId
    )
    unsubscribeFirst()
    unsubscribeSecond()

    expect(status).toBe('completed')
    expect(firstSubscriber).not.toHaveLength(0)
    expect(eventSequence(secondSubscriber)).toEqual(eventSequence(firstSubscriber))
    expect(firstSubscriber.some((event) => event.kind === 'approval_review_started')).toBe(true)
    expect(firstSubscriber.some((event) => event.kind === 'approval_review_completed')).toBe(true)

    const firstSeq = firstSubscriber[0]!.seq
    const durableReplay = await scenario.harness.sessionStore.loadEventsSince(
      scenario.harness.threadId,
      firstSeq - 1
    )
    expect(eventSequence(durableReplay)).toEqual(eventSequence(firstSubscriber))

    scenario.harness.bus.reset()
    expect(scenario.harness.bus.snapshotSince(scenario.harness.threadId, 0)).toEqual([])
    expect(eventSequence(await scenario.harness.sessionStore.loadEventsSince(
      scenario.harness.threadId,
      firstSeq - 1
    ))).toEqual(eventSequence(firstSubscriber))
  })
})

async function createPermissionScenario(input: {
  approvalPolicy: ApprovalPolicy
  sandboxMode: SandboxMode
  approvalReviewer: ApprovalReviewer
  reviewChunks?: ModelStreamChunk[]
  approvalReview?: ApprovalReviewPort
}): Promise<PermissionScenario> {
  let executionCount = 0
  const tool = LocalToolHost.defineTool({
    name: TOOL_NAME,
    description: 'Perform a test-only side effect behind the permission boundary.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' }
      },
      required: ['target']
    },
    policy: 'on-request',
    effects: {
      network: false,
      externalWrite: false,
      processExecution: false,
      guiAutomation: false
    },
    execute: async () => {
      executionCount += 1
      return { output: { executed: true } }
    }
  })
  const toolHost = new CapturingToolHost({ tools: [tool] })
  const model = new ScriptedCapturingModel([
    [
      {
        kind: 'tool_call_complete',
        callId: 'call_permission',
        toolName: TOOL_NAME,
        arguments: { target: 'bounded-test-target' }
      },
      { kind: 'completed', stopReason: 'tool_calls' }
    ],
    [
      { kind: 'assistant_text_delta', text: 'Permission flow completed.' },
      { kind: 'completed', stopReason: 'stop' }
    ]
  ])

  let reviewDelegate: ApprovalReviewPort | undefined
  const approvalReview = input.approvalReview ?? (input.reviewChunks
    ? {
        review: (reviewInput) => {
          if (!reviewDelegate) throw new Error('approval review delegate was not initialized')
          return reviewDelegate.review(reviewInput)
        }
      } satisfies ApprovalReviewPort
    : undefined)
  const harness = makeHarness(model, {
    toolHost,
    ...(approvalReview ? { approvalReview } : {})
  })
  let reviewModel: ScriptedCapturingModel | undefined
  if (input.reviewChunks) {
    reviewModel = new ScriptedCapturingModel([input.reviewChunks], {
      provider: 'review-test-provider',
      model: 'review-test-model'
    })
    reviewDelegate = new ApprovalReviewService({
      model: reviewModel,
      events: harness.events,
      usage: harness.usage,
      timeoutMs: 1_000,
      nextReviewId: () => 'review_permission_integration'
    })
  }

  await bootstrapThread(harness, {
    request: {
      prompt: 'Perform the requested permission-gated action.',
      ...ACTING_MODEL_ROUTE,
      approvalPolicy: input.approvalPolicy,
      sandboxMode: input.sandboxMode,
      approvalReviewer: input.approvalReviewer
    }
  })
  return {
    harness,
    model,
    ...(reviewModel ? { reviewModel } : {}),
    executed: () => executionCount
  }
}

function reviewDecision(
  decision: 'allow' | 'deny',
  riskLevel: 'low' | 'medium' | 'high' | 'critical',
  rationale: string
): ModelStreamChunk[] {
  return [
    {
      kind: 'assistant_text_delta',
      text: JSON.stringify({ decision, riskLevel, rationale })
    },
    { kind: 'completed', stopReason: 'stop' }
  ]
}

async function toolResult(harness: Harness) {
  const items = await harness.sessionStore.loadItems(harness.threadId)
  return items.find((item) =>
    item.kind === 'tool_result' &&
    item.callId === 'call_permission'
  )
}

function isApprovalReviewEvent(event: RuntimeEvent): boolean {
  return event.kind === 'approval_review_started' || event.kind === 'approval_review_completed'
}

function eventSequence(events: readonly RuntimeEvent[]): Array<{
  seq: number
  kind: RuntimeEvent['kind']
}> {
  return events.map((event) => ({ seq: event.seq, kind: event.kind }))
}
