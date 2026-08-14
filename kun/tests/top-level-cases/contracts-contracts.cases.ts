import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApprovalPolicySchema,
  DEFAULT_APPROVAL_POLICY,
  CreateThreadRequest,
  ThreadGoalSchema,
  ThreadTodoListSchema,
  SetThreadGoalRequest,
  SetThreadTodosRequest,
  RuntimeEvent,
  StartTurnRequest,
  UsageSnapshotSchema,
  AttachmentUploadRequest,
  MemoryRecord,
  KunErrorBody,
  KunCapabilitiesConfig,
  RuntimeCapabilityManifest,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  buildRuntimeCapabilityManifest,
  emptyUsageSnapshot,
  type RuntimeEvent as RuntimeEventType
} from '../../src/contracts/index.js'
import {
  modelCapabilitiesForModel,
  modelContextProfilesFromConfig
} from '../../src/loop/model-context-profile.js'
import {
  parseServeOptionsSafe,
  parseServeOptions,
  validateServeOptions,
  SERVE_USAGE,
  ServeExitCode
} from '../../src/cli/serve.js'

describe('contracts', () => {
  it('round-trips a thread creation payload through zod', () => {
    const parsed = CreateThreadRequest.parse({
      title: 'demo',
      workspace: '/tmp/ws',
      model: 'deepseek-chat'
    })
    expect(parsed.title).toBe('demo')
    expect(parsed.mode).toBe('agent')
  })

  it('accepts thread goal contracts and events', () => {
    const goal = ThreadGoalSchema.parse({
      threadId: 'thr_1',
      objective: 'ship goal mode',
      status: 'active',
      tokenBudget: 1000,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z'
    })
    expect(goal.objective).toBe('ship goal mode')
    expect(SetThreadGoalRequest.parse({ status: 'paused' }).status).toBe('paused')
    const event = RuntimeEvent.parse({
      kind: 'goal_updated',
      seq: 1,
      timestamp: '2026-06-03T00:00:01.000Z',
      threadId: 'thr_1',
      goal
    })
    expect(event.kind).toBe('goal_updated')
  })

  it('accepts thread todo contracts and events', () => {
    const todos = ThreadTodoListSchema.parse({
      threadId: 'thr_1',
      updatedAt: '2026-06-03T00:00:00.000Z',
      items: [{
        id: 'todo_1',
        content: 'Implement todo panel',
        status: 'in_progress',
        source: {
          kind: 'plan',
          planId: 'plan_1',
          relativePath: '.kunsdd/plan/plan.md',
          ordinal: 0,
          contentHash: 'abc'
        },
        createdAt: '2026-06-03T00:00:00.000Z',
        updatedAt: '2026-06-03T00:00:00.000Z'
      }]
    })
    expect(todos.items[0]?.source?.kind).toBe('plan')
    expect(SetThreadTodosRequest.parse({
      todos: [{ content: 'Done', status: 'completed' }]
    }).todos[0]?.status).toBe('completed')
    expect(SetThreadTodosRequest.safeParse({
      todos: [
        { content: 'one', status: 'in_progress' },
        { content: 'two', status: 'in_progress' }
      ]
    }).success).toBe(false)
    const event = RuntimeEvent.parse({
      kind: 'todos_updated',
      seq: 2,
      timestamp: '2026-06-03T00:00:01.000Z',
      threadId: 'thr_1',
      todos
    })
    expect(event.kind).toBe('todos_updated')
  })

  it('rejects invalid start turn payloads', () => {
    const result = StartTurnRequest.safeParse({ prompt: '' })
    expect(result.success).toBe(false)
  })

  it('accepts a bounded retry-stable client request id', () => {
    expect(StartTurnRequest.parse({
      prompt: 'retry safely',
      clientRequestId: '  request_123  '
    }).clientRequestId).toBe('request_123')
    expect(StartTurnRequest.safeParse({
      prompt: 'invalid empty key',
      clientRequestId: '   '
    }).success).toBe(false)
    expect(StartTurnRequest.safeParse({
      prompt: 'invalid oversized key',
      clientRequestId: 'x'.repeat(257)
    }).success).toBe(false)
  })

  it('bounds and deduplicates start-turn attachment ids', () => {
    expect(StartTurnRequest.safeParse({
      prompt: 'too many attachments',
      attachmentIds: Array.from({ length: 9 }, (_value, index) => `att_${index}`)
    }).success).toBe(false)
    expect(StartTurnRequest.safeParse({
      prompt: 'duplicate attachment',
      attachmentIds: ['att_same', 'att_same']
    }).success).toBe(false)
  })

  it('accepts per-turn reasoning effort on start turn payloads', () => {
    const parsed = StartTurnRequest.parse({
      prompt: 'Compare the approaches',
      model: 'auto',
      reasoningEffort: 'max'
    })
    expect(parsed.reasoningEffort).toBe('max')
  })

  it('accepts only the canonical priority service tier on start turns', () => {
    expect(StartTurnRequest.parse({
      prompt: 'Move faster',
      serviceTier: 'priority'
    }).serviceTier).toBe('priority')
    expect(StartTurnRequest.safeParse({
      prompt: 'Do not use the legacy label on the wire',
      serviceTier: 'fast'
    }).success).toBe(false)
  })

  it('accepts per-turn execution policy on start turn payloads', () => {
    const parsed = StartTurnRequest.parse({
      prompt: 'Inspect without changing files',
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only'
    })
    expect(parsed.approvalPolicy).toBe('on-request')
    expect(parsed.sandboxMode).toBe('read-only')
  })

  it('accepts the IM/headless disableUserInput flag on start turn payloads', () => {
    const parsed = StartTurnRequest.parse({
      prompt: 'Reply to the WeChat user',
      disableUserInput: true
    })
    expect(parsed.disableUserInput).toBe(true)
    expect(StartTurnRequest.parse({ prompt: 'GUI turn' }).disableUserInput).toBeUndefined()
  })

  it('accepts turn failure lifecycle messages', () => {
    const event = RuntimeEvent.parse({
      kind: 'turn_failed',
      seq: 1,
      timestamp: '2026-06-03T00:00:01.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      message: 'model stream exploded'
    })
    expect(event).toMatchObject({
      kind: 'turn_failed',
      message: 'model stream exploded'
    })
  })

  it('preserves the immutable authority snapshot on turn lifecycle events', () => {
    const event = RuntimeEvent.parse({
      kind: 'turn_started',
      seq: 1,
      timestamp: '2026-07-30T00:00:01.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalReviewer: 'agent'
    })

    expect(event).toMatchObject({
      kind: 'turn_started',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalReviewer: 'agent'
    })
  })

  it('accepts replayable automatic approval lifecycle and agent decision source', () => {
    const started = RuntimeEvent.parse({
      kind: 'approval_review_started',
      seq: 1,
      timestamp: '2026-07-30T00:00:00.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      reviewId: 'review_1',
      approvalId: 'approval_1',
      toolName: 'bash',
      reviewer: 'agent',
      status: 'in-progress',
      summary: 'Canonical action data unavailable'
    })
    const resolved = RuntimeEvent.parse({
      kind: 'approval_resolved',
      seq: 3,
      timestamp: '2026-07-30T00:00:00.002Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      approvalId: 'approval_1',
      toolName: 'bash',
      status: 'denied',
      approvalReviewer: 'agent',
      decisionSource: 'agent',
      summary: 'Canonical action data unavailable',
      reason: 'Automatic review failed closed.'
    })

    expect(started).toMatchObject({
      kind: 'approval_review_started',
      reviewer: 'agent',
      status: 'in-progress'
    })
    expect(started).not.toHaveProperty('action')
    expect(resolved).toMatchObject({
      kind: 'approval_resolved',
      status: 'denied',
      decisionSource: 'agent'
    })
  })

  it('accepts request-local context snapshot events', () => {
    const event = RuntimeEvent.parse({
      kind: 'context_snapshot',
      seq: 2,
      timestamp: '2026-07-24T00:00:01.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
      stepIndex: 1,
      contextWindowTokens: 256_000,
      softThresholdTokens: 192_000,
      hardThresholdTokens: 217_600,
      estimatedInputTokens: 12_000,
      breakdown: {
        tools: 3_000,
        system: 2_000,
        skills: 1_000,
        messages: 5_000,
        other: 1_000
      },
      toolCount: 21,
      activeSkillIds: ['openspec-apply-change']
    })

    expect(event).toMatchObject({
      kind: 'context_snapshot',
      model: 'deepseek-v4-pro',
      stepIndex: 1,
      softThresholdTokens: 192_000,
      breakdown: { tools: 3_000, messages: 5_000 }
    })
  })

  it('accepts GUI plan context on start turn payloads', () => {
    const parsed = StartTurnRequest.parse({
      prompt: 'Plan auth',
      displayText: 'Generate implementation plan',
      guiPlan: {
        operation: 'draft',
        workspaceRoot: '/tmp/ws',
        relativePath: '.deepseekgui/plan/auth.md',
        planId: '/tmp/ws:.deepseekgui/plan/auth.md',
        sourceRequest: 'Add auth',
        title: 'Auth'
      }
    })
    expect(parsed.guiPlan?.relativePath).toBe('.deepseekgui/plan/auth.md')
    expect(parsed.displayText).toBe('Generate implementation plan')
  })

  it('rejects unsafe GUI plan context paths on start turn payloads', () => {
    const result = StartTurnRequest.safeParse({
      prompt: 'Plan auth',
      guiPlan: {
        operation: 'draft',
        workspaceRoot: '/tmp/ws',
        relativePath: '.deepseekgui/plan/nested/auth.md',
        planId: 'plan_bad'
      }
    })
    expect(result.success).toBe(false)
  })

  it('accepts only reserved versioned SVG artifact paths on Design turns', () => {
    const parsed = StartTurnRequest.parse({
      prompt: 'Animate the logo',
      guiDesignMode: true,
      guiDesignArtifact: {
        kind: 'svg',
        artifactId: 'motion',
        relativePath: '.kun-design/doc/motion/v2.svg'
      }
    })
    expect(parsed.guiDesignArtifact).toEqual({
      kind: 'svg',
      artifactId: 'motion',
      relativePath: '.kun-design/doc/motion/v2.svg'
    })
    expect(StartTurnRequest.safeParse({
      prompt: 'Unsafe SVG',
      guiDesignArtifact: {
        kind: 'svg',
        artifactId: 'motion',
        relativePath: '../motion.svg'
      }
    }).success).toBe(false)
  })

  it('produces a deterministic empty usage snapshot', () => {
    const usage = emptyUsageSnapshot()
    expect(usage.cacheHitRate).toBeNull()
    expect(usage.totalTokens).toBe(0)
  })

  it('parses usage with cache metrics', () => {
    const usage = UsageSnapshotSchema.parse({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedTokens: 60,
      cacheHitTokens: 40,
      cacheMissTokens: 60,
      cacheHitRate: 0.4,
      turns: 1
    })
    expect(usage.cacheHitRate).toBeCloseTo(0.4)
  })

  it('accepts the canonical lifecycle runtime events', () => {
    const samples: RuntimeEventType[] = [
      {
        kind: 'thread_created',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.000Z',
        threadId: 'thr_1',
        title: 'demo'
      },
      {
        kind: 'turn_started',
        seq: 2,
        timestamp: '2025-01-01T00:00:01.000Z',
        threadId: 'thr_1',
        turnId: 'turn_1'
      },
      {
        kind: 'usage',
        seq: 3,
        timestamp: '2025-01-01T00:00:02.000Z',
        threadId: 'thr_1',
        usage: emptyUsageSnapshot()
      },
      {
        kind: 'heartbeat',
        seq: 4,
        timestamp: '2025-01-01T00:00:03.000Z',
        threadId: 'thr_1'
      }
    ]
    for (const sample of samples) {
      const parsed = RuntimeEvent.parse(sample)
      expect(parsed.kind).toBe(sample.kind)
    }
  })

  it('accepts extension contracts for attachments, memory, child events, and structured errors', () => {
    expect(AttachmentUploadRequest.parse({
      name: 'shot.png',
      mimeType: 'image/png',
      dataBase64: 'abcd',
      textFallback: {
        dataBase64: 'abcd',
        mimeType: 'image/webp',
        byteSize: 3,
        width: 1,
        height: 1,
        wasCompressed: true
      },
      threadId: 'thr_1'
    }).textFallback?.mimeType).toBe('image/webp')

    expect(MemoryRecord.parse({
      id: 'mem_1',
      content: 'Use pnpm',
      scope: 'workspace',
      workspace: '/tmp/ws',
      tags: ['frontend'],
      confidence: 0.9,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z'
    }).tags).toEqual(['frontend'])

    const child = RuntimeEvent.parse({
      kind: 'turn_completed',
      seq: 10,
      timestamp: '2026-06-03T00:00:00.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      child: {
        parentThreadId: 'thr_1',
        parentTurnId: 'turn_1',
        childId: 'child_1',
        childLabel: 'research',
        childStatus: 'completed',
        childSeq: 1
      }
    })
    expect(child.child?.childId).toBe('child_1')

    expect(KunErrorBody.parse({
      code: 'model_modality_unsupported',
      message: 'model does not support image input'
    }).code).toBe('model_modality_unsupported')
  })
})
