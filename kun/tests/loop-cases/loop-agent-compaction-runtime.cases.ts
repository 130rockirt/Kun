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
  it('compacts the history when the soft threshold is reached', async () => {
    const h = makeHarness(makeSilentModel(), {
      compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 })
    })
    await bootstrapThread(h)
    for (let i = 0; i < 10; i += 1) {
      await h.sessionStore.appendItem(
        h.threadId,
        makeUserItem({ id: `hist_${i}`, turnId: h.turnId, threadId: h.threadId, text: 'x'.repeat(20) })
      )
    }
    await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)
    const effectiveItems = effectiveHistoryAfterLatestCompaction(items)
    expect(items.some((item) => item.kind === 'compaction')).toBe(true)
    // The visible transcript remains complete, while the model-visible
    // projection starts at the latest compaction marker followed by the recent
    // tail kept verbatim.
    expect(items.some((item) => item.id === 'hist_0')).toBe(true)
    expect(effectiveItems[0]?.kind).toBe('compaction')
    expect(effectiveItems.some((item) => item.id === 'hist_0')).toBe(false)
    expect(effectiveItems.length).toBeLessThan(items.length)
  })

  it('does not reintroduce an ended goal context after compaction reloads canonical history', async () => {
    const requests: ModelRequest[] = []
    const h = makeHarness({
      provider: 'goal-context-compaction',
      model: 'goal-context-compaction',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        requests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, {
      compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 })
    })
    await bootstrapThread(h)
    await h.threads.setGoal(h.threadId, {
      objective: 'Old goal that has already ended.',
      status: 'active'
    })
    await h.sessionStore.appendItem(h.threadId, makeGoalContextItem({
      id: 'old_goal_context',
      threadId: h.threadId,
      turnId: h.turnId,
      goalKey: 'old_goal_key',
      text: 'STALE GOAL CONTEXT MUST NOT REACH THE MODEL.',
      createdAt: '2026-08-06T00:00:00.000Z'
    }))
    await h.threads.setGoal(h.threadId, { status: 'complete' })
    for (let index = 0; index < 10; index += 1) {
      await h.sessionStore.appendItem(h.threadId, makeUserItem({
        id: `goal_compaction_history_${index}`,
        threadId: h.threadId,
        turnId: h.turnId,
        text: 'x'.repeat(20)
      }))
    }

    await expect(h.loop.runTurn(h.threadId, h.turnId)).resolves.toBe('completed')

    const request = requests[0]
    expect(request).toBeDefined()
    expect(request?.history.some((item) => item.kind === 'goal_context')).toBe(false)
    expect(JSON.stringify(request?.history)).not.toContain('STALE GOAL CONTEXT MUST NOT REACH THE MODEL.')
    expect((await h.sessionStore.loadItems(h.threadId)).some((item) => item.id === 'old_goal_context')).toBe(true)
  })

  it('can use a model summary for history compaction while reusing the main prefix', async () => {
    const requests: ModelRequest[] = []
    const h = makeHarness(
      {
        provider: 'fold-summary',
        model: 'fold-summary',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          const isSummaryRequest = request.tools.length === 0 &&
            request.systemPrompt === COMPACTION_SYSTEM_PROMPT
          if (isSummaryRequest) {
            yield {
              kind: 'usage',
              usage: {
                promptTokens: 22,
                completionTokens: 7,
                totalTokens: 29,
                cachedTokens: 0,
                cacheHitTokens: 0,
                cacheMissTokens: 22,
                cacheHitRate: 0,
                turns: 1
              }
            }
            yield {
              kind: 'assistant_text_delta',
              text: 'Model summary: preserve alpha.txt and continue with beta.'
            }
            yield { kind: 'completed', stopReason: 'stop' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 }),
        contextCompaction: {
          summaryMode: 'model',
          summaryTimeoutMs: 5_000,
          summaryMaxTokens: 333,
          summaryInputMaxBytes: 4_096
        }
      }
    )
    await bootstrapThread(h)
    for (let i = 0; i < 10; i += 1) {
      await h.sessionStore.appendItem(
        h.threadId,
        makeUserItem({
          id: `model_summary_hist_${i}`,
          turnId: h.turnId,
          threadId: h.threadId,
          text: `alpha.txt observation ${i}; next step beta ${'x'.repeat(24)}`
        })
      )
    }

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const [summaryRequest, mainRequest] = requests
    if (!summaryRequest || !mainRequest) throw new Error('expected summary and main model requests')
    const summaryContinuation = summaryRequest.history[summaryRequest.history.length - 1]
    const persisted = await h.sessionStore.loadItems(h.threadId)
    const persistedSummary = persisted.find((item) => item.kind === 'compaction')
    const mainSummary = mainRequest.history.find((item) => item.kind === 'compaction')

    expect(status).toBe('completed')
    expect(requests).toHaveLength(2)
    // Compaction-mode turn: dedicated summarizer system prompt, no main prefix,
    // and the real conversation fed as messages with a free-form continuation.
    expect(summaryRequest.systemPrompt).toBe(COMPACTION_SYSTEM_PROMPT)
    expect(summaryRequest.prefix).toEqual([])
    expect(summaryRequest.tools).toEqual([])
    expect(summaryRequest.maxTokens).toBe(333)
    expect(summaryRequest.temperature).toBe(0)
    expect(summaryRequest.reasoningEffort).toBe('off')
    expect(summaryRequest.history.some((item) => item.id === 'model_summary_hist_0')).toBe(true)
    expect(summaryContinuation?.kind).toBe('user_message')
    expect(summaryContinuation?.kind === 'user_message' ? summaryContinuation.text : '')
      .toContain('Provide a detailed summary of our conversation above')
    expect(mainSummary?.kind === 'compaction' ? mainSummary.summary : '')
      .toContain('Model summary: preserve alpha.txt')
    expect(persistedSummary?.kind === 'compaction' ? persistedSummary.summary : '')
      .toContain('Model summary: preserve alpha.txt')
  })

  it('uses heuristic compaction when an extension run with budget 1 has reserved its main request', async () => {
    const requests: ModelRequest[] = []
    const h = makeHarness(
      {
        provider: 'budget-one',
        model: 'budget-one',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 }),
        contextCompaction: { summaryMode: 'model', summaryTimeoutMs: 5_000 }
      }
    )
    await bootstrapThread(h)
    const thread = await h.threadStore.get(h.threadId)
    if (!thread) throw new Error('expected extension budget thread')
    await h.threadStore.upsert({
      ...thread,
      ownerExtensionId: 'acme.budget-one',
      extensionBudget: {
        maxTokens: 1_000_000,
        maxElapsedMs: 60_000,
        maxConcurrentRuns: 1,
        maxModelRequests: 1,
        maxToolInvocations: 10,
        maxRetainedEvents: 1_000
      },
      turns: thread.turns.map((turn) =>
        turn.id === h.turnId
          ? { ...turn, extensionBudgetTokenBaseline: 0, extensionModelRequests: 0 }
          : turn
      )
    })
    for (let index = 0; index < 10; index += 1) {
      await h.sessionStore.appendItem(h.threadId, makeUserItem({
        id: `budget_one_history_${index}`,
        turnId: h.turnId,
        threadId: h.threadId,
        text: `private budget one history ${index} ${'x'.repeat(24)}`
      }))
    }

    await expect(h.loop.runTurn(h.threadId, h.turnId)).resolves.toBe('completed')

    expect(requests).toHaveLength(1)
    expect(requests[0]?.systemPrompt).not.toBe(COMPACTION_SYSTEM_PROMPT)
    expect((await h.threadStore.get(h.threadId))?.turns[0]?.extensionModelRequests).toBe(1)
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'compaction',
      summary: expect.stringContaining('Conversation and work summary:')
    }))
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error',
      code: 'compaction_summary_fallback',
      message: expect.stringContaining('model-request budget exhausted')
    }))
  })

  it('atomically charges summary and main requests to an extension run with budget 2', async () => {
    const requests: ModelRequest[] = []
    const h = makeHarness(
      {
        provider: 'budget-two',
        model: 'budget-two',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          if (request.systemPrompt === COMPACTION_SYSTEM_PROMPT) {
            yield { kind: 'assistant_text_delta', text: 'budget two model summary' }
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 }),
        contextCompaction: { summaryMode: 'model', summaryTimeoutMs: 5_000 }
      }
    )
    await bootstrapThread(h)
    const thread = await h.threadStore.get(h.threadId)
    if (!thread) throw new Error('expected extension budget thread')
    await h.threadStore.upsert({
      ...thread,
      ownerExtensionId: 'acme.budget-two',
      extensionBudget: {
        maxTokens: 1_000_000,
        maxElapsedMs: 60_000,
        maxConcurrentRuns: 1,
        maxModelRequests: 2,
        maxToolInvocations: 10,
        maxRetainedEvents: 1_000
      },
      turns: thread.turns.map((turn) =>
        turn.id === h.turnId
          ? { ...turn, extensionBudgetTokenBaseline: 0, extensionModelRequests: 0 }
          : turn
      )
    })
    for (let index = 0; index < 10; index += 1) {
      await h.sessionStore.appendItem(h.threadId, makeUserItem({
        id: `budget_two_history_${index}`,
        turnId: h.turnId,
        threadId: h.threadId,
        text: `private budget two history ${index} ${'x'.repeat(24)}`
      }))
    }

    await expect(h.loop.runTurn(h.threadId, h.turnId)).resolves.toBe('completed')

    expect(requests).toHaveLength(2)
    expect(requests[0]?.systemPrompt).toBe(COMPACTION_SYSTEM_PROMPT)
    expect(requests[1]?.systemPrompt).not.toBe(COMPACTION_SYSTEM_PROMPT)
    expect((await h.threadStore.get(h.threadId))?.turns[0]?.extensionModelRequests).toBe(2)
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'compaction',
      summary: expect.stringContaining('budget two model summary')
    }))
  })

  it('does not send a reserved main request after compaction exhausts the extension token budget', async () => {
    const requests: ModelRequest[] = []
    const h = makeHarness(
      {
        provider: 'budget-summary-tokens',
        model: 'budget-summary-tokens',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          if (request.systemPrompt === COMPACTION_SYSTEM_PROMPT) {
            yield { kind: 'assistant_text_delta', text: 'summary consumed the remaining token budget' }
            yield {
              kind: 'usage',
              usage: {
                promptTokens: 8,
                completionTokens: 4,
                totalTokens: 12,
                cacheHitRate: null,
                turns: 1
              }
            }
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 }),
        contextCompaction: { summaryMode: 'model', summaryTimeoutMs: 5_000 }
      }
    )
    await bootstrapThread(h)
    const thread = await h.threadStore.get(h.threadId)
    if (!thread) throw new Error('expected extension budget thread')
    await h.threadStore.upsert({
      ...thread,
      ownerExtensionId: 'acme.budget-summary-tokens',
      extensionBudget: {
        maxTokens: 10,
        maxElapsedMs: 60_000,
        maxConcurrentRuns: 1,
        maxModelRequests: 2,
        maxToolInvocations: 10,
        maxRetainedEvents: 1_000
      },
      turns: thread.turns.map((turn) =>
        turn.id === h.turnId
          ? { ...turn, extensionBudgetTokenBaseline: 0, extensionModelRequests: 0 }
          : turn
      )
    })
    for (let index = 0; index < 10; index += 1) {
      await h.sessionStore.appendItem(h.threadId, makeUserItem({
        id: `budget_summary_tokens_history_${index}`,
        turnId: h.turnId,
        threadId: h.threadId,
        text: `token budget history ${index} ${'x'.repeat(24)}`
      }))
    }

    await expect(h.loop.runTurn(h.threadId, h.turnId)).resolves.toBe('completed')

    expect(requests).toHaveLength(1)
    expect(requests[0]?.systemPrompt).toBe(COMPACTION_SYSTEM_PROMPT)
    expect((await h.threadStore.get(h.threadId))?.turns[0]?.extensionModelRequests).toBe(2)
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'error',
      code: 'extension_budget_exhausted',
      message: expect.stringContaining('token budget exhausted')
    }))
  })

  it('records a visible fallback event when configured model compaction summaries fail', async () => {
    const requests: ModelRequest[] = []
    const h = makeHarness(
      {
        provider: 'fold-summary-fails',
        model: 'fold-summary-fails',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          const isSummaryRequest = request.tools.length === 0 &&
            request.systemPrompt === COMPACTION_SYSTEM_PROMPT
          if (isSummaryRequest) {
            yield { kind: 'error', message: 'summary model unavailable', code: 'summary_down' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 }),
        contextCompaction: {
          summaryMode: 'model',
          summaryTimeoutMs: 5_000
        }
      }
    )
    await bootstrapThread(h)
    for (let i = 0; i < 10; i += 1) {
      await h.sessionStore.appendItem(
        h.threadId,
        makeUserItem({
          id: `fallback_hist_${i}`,
          turnId: h.turnId,
          threadId: h.threadId,
          text: `fallback observation ${i} ${'x'.repeat(24)}`
        })
      )
    }

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const fallback = events.find(
      (event) => event.kind === 'error' && event.code === 'compaction_summary_fallback'
    )
    const persisted = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(fallback?.kind === 'error' ? fallback.message : '').toContain('summary model unavailable')
    expect(persisted.some((item) =>
      item.kind === 'compaction' &&
      item.summary.includes('Conversation and work summary:') &&
      item.summary.includes('<kun:tool_digest sha256=')
    )).toBe(true)
  })

  it('compacts on the next step when provider usage reports high prompt tokens', async () => {
    const seenHistory: TurnItem[][] = []
    const echoTool = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async () => ({ output: 'tool result from high usage turn' })
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'usage-pressure',
        model: 'usage-pressure',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          seenHistory.push(request.history)
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'usage',
              usage: {
                promptTokens: 1_200,
                completionTokens: 1,
                totalTokens: 1_201,
                cachedTokens: 0,
                cacheHitTokens: 0,
                cacheMissTokens: 1_200,
                cacheHitRate: 0,
                turns: 1
              }
            }
            yield {
              kind: 'tool_call_complete',
              callId: 'call_echo',
              toolName: 'echo',
              arguments: { text: 'hi' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        tools: [echoTool],
        compactor: new ContextCompactor({ softThreshold: 1_000, hardThreshold: 2_000 })
      }
    )
    await bootstrapThread(h)
    const activeTurnItems = await h.sessionStore.loadItems(h.threadId)
    await h.sessionStore.rewriteItems(h.threadId, [
      makeUserItem({
        id: 'historic_user',
        turnId: 'turn_historic',
        threadId: h.threadId,
        text: `historic request eligible for compaction ${'x'.repeat(800)}`
      }),
      makeAssistantTextItem({
        id: 'historic_assistant',
        turnId: 'turn_historic',
        threadId: h.threadId,
        text: `historic response eligible for compaction ${'y'.repeat(800)}`
      }),
      ...activeTurnItems
    ])

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const secondHistory = seenHistory[1] ?? []
    const persisted = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(seenHistory[0]?.some((item) => item.kind === 'compaction')).toBe(false)
    expect(secondHistory.some((item) => item.kind === 'compaction')).toBe(true)
    expect(secondHistory.some((item) => item.kind === 'tool_result')).toBe(true)
    expect(
      secondHistory.some((item) =>
        item.kind === 'compaction' && item.summary.includes('compaction threshold')
      )
    ).toBe(true)
    expect(persisted.some((item) => item.kind === 'compaction')).toBe(true)
  })

  it('warns once near the thread cost budget and blocks when exhausted', async () => {
    let modelCalls = 0
    const h = makeHarness({
      provider: 'budget',
      model: 'budget',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        modelCalls += 1
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await bootstrapThread(h)
    const thread = await h.threadStore.get(h.threadId)
    await h.threadStore.upsert({ ...thread!, costBudgetUsd: 10 })
    h.usage.record(h.threadId, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitRate: null,
      turns: 0,
      costUsd: 8
    })

    await h.loop.runTurn(h.threadId, h.turnId)
    const warnedThread = await h.threadStore.get(h.threadId)
    expect(modelCalls).toBe(1)
    expect(warnedThread?.costBudgetWarningSent).toBe(true)
    expect((await h.sessionStore.loadItems(h.threadId)).some((item) =>
      item.kind === 'error' && item.code === 'budget_warning'
    )).toBe(true)

    const second = await h.turns.startTurn({ threadId: h.threadId, request: { prompt: 'again' } })
    h.turnId = second.turnId
    h.usage.record(h.threadId, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitRate: null,
      turns: 0,
      costUsd: 2
    })
    await h.loop.runTurn(h.threadId, h.turnId)
    expect(modelCalls).toBe(1)
    expect((await h.sessionStore.loadItems(h.threadId)).some((item) =>
      item.kind === 'error' && item.code === 'budget_limited'
    )).toBe(true)
  })
})
