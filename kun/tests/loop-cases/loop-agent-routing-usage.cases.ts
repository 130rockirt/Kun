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

describe('AgentLoop', () => {
  it('does not auto-compact DeepSeek v4 turns at the legacy threshold', async () => {
    const h = makeHarness(makeSilentModel(), {
      compactor: new ContextCompactor()
    })
    await bootstrapThread(h, { request: { prompt: 'hello', model: 'deepseek-v4-flash' } })
    await h.sessionStore.appendItem(
      h.threadId,
      makeUserItem({
        id: 'legacy_threshold_sized_history',
        turnId: h.turnId,
        threadId: h.threadId,
        text: 'x'.repeat(80_000)
      })
    )

    await h.loop.runTurn(h.threadId, h.turnId)

    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items.some((item) => item.kind === 'compaction')).toBe(false)
  })

  it('routes turn model auto before sending the real model request', async () => {
    const seenModels: string[] = []
    const h = makeHarness({
      provider: 'router-recorder',
      model: 'fallback',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        seenModels.push(request.model)
        if (request.turnId.endsWith('_auto_router')) {
          expect(request.stream).toBe(false)
          expect(request.maxTokens).toBe(96)
          yield { kind: 'assistant_text_delta', text: '{"model":"deepseek-v4-pro","thinking":"max"}' }
          yield { kind: 'completed', stopReason: 'stop' }
          return
        }
        expect(request.reasoningEffort).toBe('max')
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await h.threadStore.upsert(
      createThreadRecord({
        id: h.threadId,
        title: 'demo',
        workspace: '/tmp',
        model: 'deepseek-v4-flash'
      })
    )
    const { turnId } = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'Help me choose the appropriate approach', model: 'auto' }
    })

    await h.loop.runTurn(h.threadId, turnId)

    expect(seenModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })

  it('keeps explicit turn reasoning effort when auto routing chooses the model', async () => {
    const seenModels: string[] = []
    const h = makeHarness({
      provider: 'router-reasoning-override',
      model: 'fallback',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        seenModels.push(request.model)
        if (request.turnId.endsWith('_auto_router')) {
          yield { kind: 'assistant_text_delta', text: '{"model":"deepseek-v4-pro","thinking":"max"}' }
          yield { kind: 'completed', stopReason: 'stop' }
          return
        }
        expect(request.reasoningEffort).toBe('low')
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await h.threadStore.upsert(
      createThreadRecord({
        id: h.threadId,
        title: 'demo',
        workspace: '/tmp',
        model: 'auto'
      })
    )
    const { turnId } = await h.turns.startTurn({
      threadId: h.threadId,
      request: {
        prompt: 'Help me choose the appropriate approach',
        model: 'auto',
        reasoningEffort: 'low'
      }
    })

    await h.loop.runTurn(h.threadId, turnId)

    expect(seenModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })

  it('falls back to a concrete heuristic model when auto router fails', async () => {
    let realRequestModel = ''
    const h = makeHarness({
      provider: 'router-failure',
      model: 'auto',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        if (request.turnId.endsWith('_auto_router')) {
          yield { kind: 'error', message: 'router unavailable' }
          return
        }
        realRequestModel = request.model
        expect(request.reasoningEffort).toBe('high')
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await h.threadStore.upsert(
      createThreadRecord({
        id: h.threadId,
        title: 'demo',
        workspace: '/tmp',
        model: 'auto'
      })
    )
    const { turnId } = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'Help me choose the appropriate approach' }
    })

    await h.loop.runTurn(h.threadId, turnId)

    expect(realRequestModel).toBe('deepseek-v4-flash')
  })

  it('uses the latest compaction item as the effective history boundary', async () => {
    const seenHistory: ModelRequest['history'][] = []
    const h = makeHarness({
      provider: 'recorder',
      model: 'recorder',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        seenHistory.push(request.history)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, {
      compactor: new ContextCompactor({ softThreshold: 100_000, hardThreshold: 120_000 })
    })
    await bootstrapThread(h)
    await h.turns.finishTurn({ threadId: h.threadId, turnId: h.turnId, status: 'completed' })
    for (let i = 0; i < 8; i += 1) {
      await h.sessionStore.appendItem(
        h.threadId,
        makeUserItem({
          id: `manual_hist_${i}`,
          turnId: h.turnId,
          threadId: h.threadId,
          text: i === 0 ? 'original requirement alpha' : `old detail ${i}`
        })
      )
    }

    const compacted = await h.turns.compact({
      threadId: h.threadId,
      request: { reason: 'manual test' }
    })
    expect(compacted.summary).toContain('original requirement alpha')

    const next = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'continue after compact' }
    })
    h.turnId = next.turnId
    await h.loop.runTurn(h.threadId, h.turnId)

    const history = seenHistory[0] ?? []
    expect(history[0]?.kind).toBe('compaction')
    expect(
      history.some((item) => item.kind === 'user_message' && item.text === 'original requirement alpha')
    ).toBe(false)
    expect(
      history.some((item) => item.kind === 'user_message' && item.text === 'continue after compact')
    ).toBe(true)
    expect(
      history.some((item) => item.kind === 'compaction' && item.summary.includes('original requirement alpha'))
    ).toBe(true)
  })

  it('records usage and emits a usage event', async () => {
    const h = makeHarness(
      makeFakeModel([
        {
          kind: 'usage',
          usage: {
            promptTokens: 12,
            completionTokens: 4,
            totalTokens: 16,
            cachedTokens: 6,
            cacheHitTokens: 6,
            cacheMissTokens: 6,
            cacheHitRate: 0.5,
            turns: 1
          }
        },
        { kind: 'completed', stopReason: 'stop' }
      ])
    )
    await bootstrapThread(h)
    const seen: number[] = []
    h.bus.subscribe(h.threadId, (event) => {
      if (event.kind === 'usage') seen.push(event.seq)
    })
    await h.loop.runTurn(h.threadId, h.turnId)
    expect(seen.length).toBeGreaterThan(0)
    const replay = await h.sessionStore.loadEventsSince(h.threadId, 0)
    expect(replay.some((event) => event.kind === 'usage')).toBe(true)
  })

  it('persists coalesced assistant text deltas for SSE replay before the final item', async () => {
    const h = makeHarness(
      makeFakeModel([
        { kind: 'assistant_text_delta', text: 'he' },
        { kind: 'assistant_text_delta', text: 'llo' },
        { kind: 'completed', stopReason: 'stop' }
      ])
    )
    await bootstrapThread(h)
    await h.loop.runTurn(h.threadId, h.turnId)
    const replay = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const deltas = replay.filter((event) => event.kind === 'assistant_text_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ item: { text: 'hello', status: 'running' } })
    const finalItemEvent = replay.find((event) =>
      event.kind === 'item_created' && event.item.kind === 'assistant_text'
    )
    expect(finalItemEvent?.seq).toBeGreaterThan(deltas[0]!.seq)
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items.some((item) => item.kind === 'assistant_text' && item.text === 'hello')).toBe(true)
  })

  it('persists completed reasoning before completed assistant text', async () => {
    const h = makeHarness(
      makeFakeModel([
        { kind: 'assistant_reasoning_delta', text: 'thinking' },
        { kind: 'assistant_text_delta', text: 'answer' },
        { kind: 'completed', stopReason: 'stop' }
      ])
    )
    await bootstrapThread(h)
    await h.loop.runTurn(h.threadId, h.turnId)

    const itemKinds = (await h.sessionStore.loadItems(h.threadId))
      .filter((item) => item.kind === 'assistant_reasoning' || item.kind === 'assistant_text')
      .map((item) => item.kind)

    expect(itemKinds).toEqual(['assistant_reasoning', 'assistant_text'])
  })
})
