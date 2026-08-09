import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEventDraft } from './runtime-event-recorder.js'
import type {
  ModelRequest,
  ModelStreamChunk
} from '../ports/model-client.js'
import {
  createApprovalActionEnvelope,
  createApprovalRequest
} from '../domain/approval.js'
import { emptyUsageSnapshot } from '../contracts/usage.js'
import { UsageService } from './usage-service.js'
import {
  APPROVAL_REVIEW_SYSTEM_PROMPT,
  ApprovalReviewService,
  parseApprovalReviewDecision
} from './approval-review-service.js'

function stream(chunks: readonly ModelStreamChunk[]): AsyncIterable<ModelStreamChunk> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

function hangingStream(): AsyncIterable<ModelStreamChunk> {
  return (async function* () {
    yield* [] as ModelStreamChunk[]
    await new Promise<void>(() => undefined)
  })()
}

function approval() {
  const action = createApprovalActionEnvelope({
    toolName: 'bash',
    providerId: 'provider-selected',
    providerKind: 'built-in',
    toolKind: 'command_execution',
    effects: {
      network: false,
      externalWrite: false,
      processExecution: true,
      guiAutomation: false
    },
    arguments: {
      command: 'npm test',
      apiKey: 'sk-action-secret-abcdefghijklmnop'
    },
    workspace: '/workspace',
    cwd: '/workspace',
    reason: 'workspace command requires approval'
  })
  return createApprovalRequest({
    id: 'approval_1',
    threadId: 'thread_1',
    turnId: 'turn_1',
    toolName: 'bash',
    summary: 'caller-controlled summary sk-summary-secret-abcdefghijklmnop',
    action,
    createdAt: '2026-07-29T00:00:00.000Z'
  })
}

function reviewDataPayload(request: ModelRequest): {
  text: string
  payload: Record<string, unknown>
} {
  const item = request.history[0]
  if (!item || item.kind !== 'user_message') {
    throw new Error('expected reviewer user message')
  }
  const match = item.text.match(
    /^<REVIEW_DATA untrusted="true">\n([\s\S]+)\n<\/REVIEW_DATA>$/
  )
  if (!match?.[1]) throw new Error('expected delimited review data')
  return {
    text: match[1],
    payload: JSON.parse(match[1]) as Record<string, unknown>
  }
}

function service(input: {
  stream: (request: ModelRequest) => AsyncIterable<ModelStreamChunk>
  events: RuntimeEventDraft[]
  record?: (event: RuntimeEventDraft) => Promise<unknown>
  timeoutMs?: number
}): ApprovalReviewService {
  return new ApprovalReviewService({
    model: { stream: input.stream },
    events: {
      record: async (event: RuntimeEventDraft) => {
        input.events.push(event)
        return input.record?.(event)
      }
    } as never,
    usage: new UsageService(),
    timeoutMs: input.timeoutMs,
    nowIso: () => '2026-07-29T00:00:00.000Z',
    nextReviewId: () => 'review_1'
  })
}

describe('ApprovalReviewService', () => {
  it('records a complete failed-closed lifecycle when canonical action data is missing', async () => {
      const events: RuntimeEventDraft[] = []
      const streamModel = vi.fn((_request: ModelRequest) => stream([]))
      const request = approval()
      delete request.action
      const reviewer = service({ events, stream: streamModel })

      await expect(reviewer.review({
        approval: request,
        route: { model: 'selected-model' },
        signal: new AbortController().signal
      })).resolves.toMatchObject({
        decision: 'deny',
        reviewStatus: 'failed-closed',
        reason: expect.stringContaining('canonical action data is unavailable')
      })

      expect(streamModel).not.toHaveBeenCalled()
      expect(events.map((event) => event.kind)).toEqual([
        'approval_review_started',
        'approval_review_completed',
        'approval_resolved'
      ])
      expect(events[0]).toMatchObject({
        kind: 'approval_review_started',
        status: 'in-progress'
      })
      expect(events[0]).not.toHaveProperty('action')
      expect(events[1]).toMatchObject({
        kind: 'approval_review_completed',
        status: 'failed-closed',
        decision: 'deny'
      })
      expect(events[2]).toMatchObject({
        kind: 'approval_resolved',
        status: 'denied',
        decisionSource: 'agent'
      })
    })

  it('performs at most one strict repair on the same route', async () => {
      const requests: ModelRequest[] = []
      const events: RuntimeEventDraft[] = []
      const outputs = [
        'Sure, this looks fine.',
        '{"decision":"deny","riskLevel":"high","rationale":"The command is broader than the intent."}'
      ]
      const reviewer = service({
        events,
        stream: (request) => {
          requests.push(request)
          return stream([
            { kind: 'assistant_text_delta', text: outputs.shift() ?? '' },
            { kind: 'completed', stopReason: 'stop' }
          ])
        }
      })

      await expect(reviewer.review({
        approval: approval(),
        route: {
          model: 'same-model',
          providerId: 'same-provider',
          accountId: 'same-account'
        },
        intent: 'Run tests',
        signal: new AbortController().signal
      })).resolves.toMatchObject({
        decision: 'deny',
        reviewStatus: 'denied',
        riskLevel: 'high'
      })

      expect(requests).toHaveLength(2)
      expect(requests.map(({ model, providerId, accountId, tools }) => ({
        model,
        providerId,
        accountId,
        tools
      }))).toEqual([
        {
          model: 'same-model',
          providerId: 'same-provider',
          accountId: 'same-account',
          tools: []
        },
        {
          model: 'same-model',
          providerId: 'same-provider',
          accountId: 'same-account',
          tools: []
        }
      ])
      expect(requests.map((request) => request.turnId)).toEqual([
        'turn_1__review_1',
        'turn_1__review_1'
      ])
      expect(JSON.stringify(requests[1]?.history)).toContain('PREVIOUS_INVALID_OUTPUT')
    })

  it('fails closed after exhausted repair and never substitutes a route', async () => {
      const requests: ModelRequest[] = []
      const events: RuntimeEventDraft[] = []
      const reviewer = service({
        events,
        stream: (request) => {
          requests.push(request)
          return stream([
            { kind: 'assistant_text_delta', text: 'allow' },
            { kind: 'completed', stopReason: 'stop' }
          ])
        }
      })

      await expect(reviewer.review({
        approval: approval(),
        route: { model: 'only-model', providerId: 'only-provider', accountId: 'only-account' },
        signal: new AbortController().signal
      })).resolves.toMatchObject({
        decision: 'deny',
        reviewStatus: 'failed-closed'
      })
      expect(requests).toHaveLength(2)
      expect(new Set(requests.map((request) =>
        `${request.model}/${request.providerId}/${request.accountId}`
      ))).toEqual(new Set(['only-model/only-provider/only-account']))
      expect(events.at(-2)).toMatchObject({
        kind: 'approval_review_completed',
        status: 'failed-closed',
        decision: 'deny'
      })
      expect(events.at(-1)).toMatchObject({
        kind: 'approval_resolved',
        status: 'denied',
        decisionSource: 'agent'
      })
    })

  it('fails closed on provider errors and redacts the terminal rationale', async () => {
      const events: RuntimeEventDraft[] = []
      const streamModel = vi.fn((_request: ModelRequest) => (async function* () {
        yield* [] as ModelStreamChunk[]
        throw new Error('provider rejected apiKey=provider-secret-value')
      })())
      const reviewer = service({ events, stream: streamModel })

      await expect(reviewer.review({
        approval: approval(),
        route: { model: 'selected-model', providerId: 'selected-provider' },
        signal: new AbortController().signal
      })).resolves.toMatchObject({
        decision: 'deny',
        reviewStatus: 'failed-closed'
      })
      expect(streamModel).toHaveBeenCalledOnce()
      expect(JSON.stringify(events)).not.toContain('provider-secret-value')
    })

  it('times out a stuck provider and returns a terminal denial', async () => {
      vi.useFakeTimers()
      try {
        const events: RuntimeEventDraft[] = []
        const reviewer = service({
          events,
          stream: () => hangingStream(),
          timeoutMs: 100
        })
        const pending = reviewer.review({
          approval: approval(),
          route: { model: 'selected-model' },
          signal: new AbortController().signal
        })

        await vi.advanceTimersByTimeAsync(101)
        await expect(pending).resolves.toMatchObject({
          decision: 'deny',
          reviewStatus: 'timed-out'
        })
        expect(events.at(-2)).toMatchObject({
          kind: 'approval_review_completed',
          status: 'timed-out'
        })
        expect(events.at(-1)).toMatchObject({
          kind: 'approval_resolved',
          status: 'denied',
          decisionSource: 'agent'
        })
      } finally {
        vi.useRealTimers()
      }
    })

  it('links parent-turn abort and records an aborted denial', async () => {
      const events: RuntimeEventDraft[] = []
      const controller = new AbortController()
      const reviewer = service({
        events,
        stream: () => hangingStream()
      })
      const pending = reviewer.review({
        approval: approval(),
        route: { model: 'selected-model' },
        signal: controller.signal
      })

      await vi.waitFor(() => {
        expect(events[0]).toMatchObject({ kind: 'approval_review_started' })
      })
      controller.abort(new Error('parent turn aborted'))
      await expect(pending).resolves.toMatchObject({
        decision: 'deny',
        reviewStatus: 'aborted'
      })
      expect(events.at(-2)).toMatchObject({
        kind: 'approval_review_completed',
        status: 'aborted'
      })
      expect(events.at(-1)).toMatchObject({
        kind: 'approval_resolved',
        status: 'denied',
        decisionSource: 'agent'
      })
    })
})
