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
  it('does not release an allow when the parent aborts during terminal audit persistence', async () => {
      const events: RuntimeEventDraft[] = []
      const controller = new AbortController()
      let releaseAudit!: () => void
      let auditObserved!: () => void
      const auditBarrier = new Promise<void>((resolve) => {
        releaseAudit = resolve
      })
      const observed = new Promise<void>((resolve) => {
        auditObserved = resolve
      })
      const reviewer = service({
        events,
        stream: () => stream([{
          kind: 'assistant_text_delta',
          text: '{"decision":"allow","riskLevel":"low","rationale":"Action matches intent."}'
        }]),
        record: async (event) => {
          if (
            event.kind === 'approval_review_completed' &&
            event.status === 'approved'
          ) {
            auditObserved()
            await auditBarrier
          }
        }
      })
      const pending = reviewer.review({
        approval: approval(),
        route: { model: 'selected-model' },
        signal: controller.signal
      })

      await observed
      controller.abort(new Error('parent turn stopped'))
      releaseAudit()
      await expect(pending).resolves.toMatchObject({
        decision: 'deny',
        reviewStatus: 'aborted'
      })
      expect(events.filter((event) =>
        event.kind === 'approval_review_completed'
      )).toEqual([
        expect.objectContaining({ status: 'approved', decision: 'allow' }),
        expect.objectContaining({ status: 'aborted', decision: 'deny' })
      ])
    })

  it('converts an approved decision to deny when its terminal audit cannot persist', async () => {
      const events: RuntimeEventDraft[] = []
      const reviewer = service({
        events,
        stream: () => stream([{
          kind: 'assistant_text_delta',
          text: '{"decision":"allow","riskLevel":"low","rationale":"Action matches intent."}'
        }]),
        record: async (event) => {
          if (
            event.kind === 'approval_review_completed' &&
            event.status === 'approved'
          ) {
            throw new Error('disk unavailable')
          }
        }
      })

      await expect(reviewer.review({
        approval: approval(),
        route: { model: 'selected-model' },
        signal: new AbortController().signal
      })).resolves.toMatchObject({
        decision: 'deny',
        reviewStatus: 'failed-closed',
        reason: expect.stringContaining('terminal audit lifecycle')
      })
      expect(events.filter((event) => event.kind === 'approval_review_completed')).toEqual([
        expect.objectContaining({ status: 'approved', decision: 'allow' }),
        expect.objectContaining({ status: 'failed-closed', decision: 'deny' })
      ])
    })

  it('does not release an allow when the agent approval resolution cannot persist', async () => {
      const events: RuntimeEventDraft[] = []
      const reviewer = service({
        events,
        stream: () => stream([{
          kind: 'assistant_text_delta',
          text: '{"decision":"allow","riskLevel":"low","rationale":"Action matches intent."}'
        }]),
        record: async (event) => {
          if (
            event.kind === 'approval_resolved' &&
            event.status === 'allowed'
          ) {
            throw new Error('resolution append failed')
          }
        }
      })

      await expect(reviewer.review({
        approval: approval(),
        route: { model: 'selected-model' },
        signal: new AbortController().signal
      })).resolves.toMatchObject({
        decision: 'deny',
        reviewStatus: 'failed-closed',
        reason: expect.stringContaining('terminal audit lifecycle')
      })
      expect(events.map((event) => event.kind)).toEqual([
        'approval_review_started',
        'approval_review_completed',
        'approval_resolved',
        'approval_review_completed',
        'approval_resolved'
      ])
      expect(events.slice(-2)).toEqual([
        expect.objectContaining({
          kind: 'approval_review_completed',
          status: 'failed-closed',
          decision: 'deny'
        }),
        expect.objectContaining({
          kind: 'approval_resolved',
          status: 'denied',
          decisionSource: 'agent'
        })
      ])
    })

  it('fails closed without invoking a model when the exact route is unavailable', async () => {
      const events: RuntimeEventDraft[] = []
      const streamModel = vi.fn((_request: ModelRequest) => stream([]))
      const reviewer = service({ events, stream: streamModel })

      await expect(reviewer.review({
        approval: approval(),
        signal: new AbortController().signal
      })).resolves.toMatchObject({
        decision: 'deny',
        reviewStatus: 'failed-closed'
      })
      expect(streamModel).not.toHaveBeenCalled()
      expect(events.map((event) => event.kind)).toEqual([
        'approval_review_started',
        'approval_review_completed',
        'approval_resolved'
      ])
    })
})
