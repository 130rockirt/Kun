import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { LocalToolHost, buildDefaultLocalTools } from '../../src/adapters/tool/local-tool-host.js'
import { CapabilityRegistry } from '../../src/adapters/tool/capability-registry.js'
import { buildBrowserUseToolProviders } from '../../src/adapters/tool/browser-use-tool-provider.js'
import { CREATE_PLAN_TOOL_NAME } from '../../src/adapters/tool/create-plan-tool.js'
import { GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME } from '../../src/adapters/tool/goal-tools.js'
import { FileThreadStore, FileSessionStore } from '../../src/adapters/file/index.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'
import { ContextCompactor } from '../../src/loop/context-compactor.js'
import { COMPACTION_SYSTEM_PROMPT } from '../../src/loop/compaction-summary.js'
import { effectiveHistoryAfterLatestCompaction } from '../../src/loop/compaction-history.js'
import { resolveModelContextProfile } from '../../src/loop/model-context-profile.js'
import { isPlanClarifyingQuestion } from '../../src/loop/agent-loop.js'
import { LoopTelemetry } from '../../src/loop/loop-telemetry.js'
import {
  makeApprovalItem,
  makeAssistantReasoningItem,
  makeAssistantTextItem,
  makeGoalContextItem,
  makeToolCallItem,
  makeToolResultItem,
  makeUserInputItem,
  makeUserItem
} from '../../src/domain/item.js'
import { createThreadRecord } from '../../src/domain/thread.js'
import { createImmutablePrefix, setSystemPrompt } from '../../src/cache/immutable-prefix.js'
import { InflightTracker } from '../../src/loop/inflight-tracker.js'
import { SteeringQueue } from '../../src/loop/steering-queue.js'
import { SequentialIdGenerator } from '../../src/ports/id-generator.js'
import type { SessionStore } from '../../src/ports/session-store.js'
import { TurnService } from '../../src/services/turn-service.js'
import type { TurnItem } from '../../src/contracts/items.js'
import type { ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'
import type { BrowserController } from '../../src/ports/browser-controller.js'
import {
  bootstrapThread,
  makeFakeModel,
  makeHarness,
  makeSilentModel,
  resolveNextUserInput
} from '../loop-test-harness.js'

describe('FileSessionStore', () => {
  let dataDir = ''
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kun-test-'))
    await mkdir(dataDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('persists events and items as JSONL with atomic index writes', async () => {
    const threadStore = new FileThreadStore({ dataDir })
    const sessionStore = new FileSessionStore({ dataDir })
    await threadStore.upsert(
      createThreadRecord({ id: 'thr_x', title: 'demo', workspace: '/tmp', model: 'm' })
    )
    await sessionStore.appendEvent('thr_x', {
      kind: 'heartbeat',
      seq: 1,
      timestamp: new Date().toISOString(),
      threadId: 'thr_x'
    })
    const events = await sessionStore.loadEventsSince('thr_x', 0)
    expect(events).toHaveLength(1)
    const content = await readFile(join(dataDir, 'threads', 'thr_x', 'events.jsonl'), 'utf-8')
    expect(content.endsWith('\n')).toBe(true)
    const index = JSON.parse(
      await readFile(join(dataDir, 'threads', 'index.json'), 'utf-8')
    ) as { order: string[] }
    expect(index.order).toContain('thr_x')
  })

  it('handles concurrent file thread index writes in the same millisecond', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const threadStore = new FileThreadStore({
        dataDir,
        now: () => new Date('2026-06-03T00:00:00.000Z')
      })
      const threads = Array.from({ length: 20 }, (_, index) =>
        createThreadRecord({
          id: `thr_concurrent_${index}`,
          title: `demo ${index}`,
          workspace: '/tmp',
          model: 'm'
        })
      )

      await expect(Promise.all(threads.map((thread) => threadStore.upsert(thread))))
        .resolves.toHaveLength(20)
      const index = JSON.parse(
        await readFile(join(dataDir, 'threads', 'index.json'), 'utf-8')
      ) as { order: string[] }

      expect(index.order).toEqual(expect.arrayContaining(threads.map((thread) => thread.id)))
    } finally {
      spy.mockRestore()
    }
  })

  it('continues event sequence numbers after a file-backed restart', async () => {
    const sessionStore = new FileSessionStore({ dataDir })
    await sessionStore.appendEvent('thr_seq', {
      kind: 'heartbeat',
      seq: 7,
      timestamp: new Date().toISOString(),
      threadId: 'thr_seq'
    })
    const bus = new InMemoryEventBus()
    const recorder = new RuntimeEventRecorder({
      eventBus: bus,
      sessionStore,
      allocateSeq: (threadId) => bus.allocateSeq(threadId),
      nowIso: () => new Date().toISOString()
    })
    const event = await recorder.record({ kind: 'heartbeat', threadId: 'thr_seq' })
    expect(event.seq).toBe(8)
  })

  it.each([
    ['aborted', 'aborted'],
    ['failed', 'failed']
  ] as const)('finalizes open turn items in messages.jsonl when a turn is %s', async (finalStatus, expectedToolStatus) => {
    const nowIso = () => '2026-06-05T00:00:00.000Z'
    const threadId = `thr_finalize_${finalStatus}`
    const threadStore = new FileThreadStore({ dataDir, now: () => new Date(nowIso()) })
    const sessionStore = new FileSessionStore({ dataDir })
    const bus = new InMemoryEventBus()
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus: bus,
        sessionStore,
        allocateSeq: (id) => bus.allocateSeq(id),
        nowIso
      }),
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor({ softThreshold: 64, hardThreshold: 128 }),
      ids: new SequentialIdGenerator(),
      nowIso
    })

    await threadStore.upsert(
      createThreadRecord({ id: threadId, title: 'demo', workspace: '/tmp', model: 'm' })
    )
    const { turnId } = await turns.startTurn({
      threadId,
      request: { prompt: 'run a tool' }
    })
    await turns.applyItem(
      threadId,
      makeToolCallItem({
        id: 'item_tool_open',
        turnId,
        threadId,
        callId: 'call_open',
        toolName: 'echo',
        arguments: { text: 'hi' }
      })
    )
    await turns.applyItem(
      threadId,
      makeToolResultItem({
        id: 'item_result_open',
        turnId,
        threadId,
        callId: 'call_open',
        toolName: 'echo',
        output: { partial: true },
        status: 'running'
      })
    )
    await turns.applyItem(
      threadId,
      makeApprovalItem({
        id: 'item_approval_open',
        turnId,
        threadId,
        approvalId: 'approval_open',
        toolName: 'echo',
        summary: 'Approve echo'
      })
    )
    await turns.applyItem(
      threadId,
      makeUserInputItem({
        id: 'item_input_open',
        turnId,
        threadId,
        inputId: 'input_open',
        prompt: 'Need input'
      })
    )

    if (finalStatus === 'aborted') {
      await turns.interruptTurn({ threadId, turnId })
    } else {
      await turns.finishTurn({ threadId, turnId, status: 'failed', error: 'boom' })
    }

    const latestById = new Map((await sessionStore.loadItems(threadId)).map((item) => [item.id, item]))
    expect(latestById.get('item_tool_open')?.status).toBe(expectedToolStatus)
    expect(latestById.get('item_result_open')?.status).toBe(expectedToolStatus)
    expect(latestById.get('item_approval_open')?.status).toBe('expired')
    expect(latestById.get('item_input_open')?.status).toBe('cancelled')
    expect(
      [...latestById.values()].some((item) =>
        item.turnId === turnId && (item.status === 'pending' || item.status === 'running')
      )
    ).toBe(false)

    const rawMessages = await readFile(join(dataDir, 'threads', threadId, 'messages.jsonl'), 'utf-8')
    const messageLines = rawMessages
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TurnItem)
    expect(messageLines.filter((item) => item.id === 'item_tool_open').map((item) => item.status))
      .toEqual(['pending', expectedToolStatus])
    expect(messageLines.filter((item) => item.id === 'item_result_open').map((item) => item.status))
      .toEqual(['running', expectedToolStatus])
  })

  it('survives a malformed JSONL line', async () => {
    const sessionStore = new FileSessionStore({ dataDir })
    await mkdir(join(dataDir, 'threads', 'thr_y'), { recursive: true })
    await appendFile(
      join(dataDir, 'threads', 'thr_y', 'events.jsonl'),
      '{"kind":"heartbeat","seq":1,"timestamp":"t","threadId":"thr_y"}\n',
      'utf-8'
    )
    const events = await sessionStore.loadEventsSince('thr_y', 0)
    expect(events).toHaveLength(1)
  })

  it('compacts usage events by retention window while preserving a carryover baseline', async () => {
    const sessionStore = new FileSessionStore({
      dataDir,
      usageEventCompaction: {
        maxBytes: 1,
        retentionDays: 365,
        nowIso: () => '2026-06-03T00:00:00.000Z'
      }
    })
    const usage = (tokens: number) => ({
      promptTokens: tokens,
      completionTokens: 0,
      totalTokens: tokens,
      cacheHitRate: null,
      turns: tokens
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'heartbeat',
      seq: 1,
      timestamp: '2024-01-01T00:00:00.000Z',
      threadId: 'thr_usage_compact'
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 2,
      timestamp: '2024-01-01T00:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-chat',
      usage: usage(2)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 3,
      timestamp: '2025-06-02T23:59:59.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-chat',
      usage: usage(3)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 4,
      timestamp: '2025-06-04T00:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-chat',
      usage: usage(4)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 5,
      timestamp: '2025-06-04T01:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-chat',
      usage: usage(5)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 6,
      timestamp: '2025-06-04T02:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-reasoner',
      usage: usage(6)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 7,
      timestamp: '2026-06-02T00:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-reasoner',
      usage: usage(7)
    })

    const events = await sessionStore.loadEventsSince('thr_usage_compact', 0)
    expect(events.map((event) => event.seq)).toEqual([1, 3, 5, 6, 7])
    expect(await sessionStore.highestSeq('thr_usage_compact')).toBe(7)
  })
})
