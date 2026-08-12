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
import { modelRequestContextText } from '../../src/loop/model-request-context.js'
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
  it('recovers from malformed Browser Use arguments without poisoning model history', async () => {
    const requests: ModelRequest[] = []
    let calls = 0
    const browserController: BrowserController = {
      readiness: () => ({ available: true }),
      execute: vi.fn(async ({ action }) => ({
        ok: true,
        code: action.action === 'snapshot' ? 'snapshot' : 'opened',
        message: 'ok'
      }))
    }
    const browserProviders = buildBrowserUseToolProviders({
      enabled: true,
      mode: 'public',
      approvalMode: 'auto-safe',
      maxTabs: 2,
      maxObservationActionsPerTurn: 3,
      maxInteractionActionsPerTurn: 1,
      maxSnapshotNodes: 250,
      maxSnapshotTextChars: 20_000,
      maxImageDimension: 1280,
      idleTimeoutMs: 300_000
    }, { controller: browserController }).providers
    const toolHost = new LocalToolHost({
      registry: new CapabilityRegistry([
        {
          id: 'builtin',
          kind: 'built-in',
          enabled: true,
          available: true,
          tools: buildDefaultLocalTools()
        },
        ...browserProviders
      ])
    })
    const h = makeHarness({
      provider: 'browser-recovery-model',
      model: 'browser-recovery-model',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        requests.push(request)
        calls += 1
        if (calls === 1) {
          yield {
            kind: 'tool_call_complete',
            callId: 'call-invalid-browser',
            toolName: 'browser_use',
            arguments: {
              action: 'navigate',
              url: 'https://example.com/path?secret=should-not-persist'
            }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        if (calls === 2) {
          const previousCall = request.history.find(
            (item) => item.kind === 'tool_call' && item.callId === 'call-invalid-browser'
          )
          expect(previousCall?.kind === 'tool_call' ? previousCall.arguments : undefined).toEqual({})
          expect(JSON.stringify(request.history)).not.toContain('action":"invalid')
          expect(JSON.stringify(request.history)).not.toContain('should-not-persist')
          yield {
            kind: 'tool_call_complete',
            callId: 'call-open-browser',
            toolName: 'browser_use',
            arguments: { action: 'open', url: 'https://example.com/path' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        if (calls === 3) {
          yield {
            kind: 'tool_call_complete',
            callId: 'call-snapshot-browser',
            toolName: 'browser_use',
            arguments: { action: 'snapshot' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: 'Browser recovery completed.' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, { toolHost })
    await bootstrapThread(h, {
      request: {
        prompt: 'Recover Browser Use',
        clientSurface: 'gui',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access'
      }
    })

    await expect(h.loop.runTurn(h.threadId, h.turnId)).resolves.toBe('completed')

    expect(browserController.execute).toHaveBeenCalledTimes(2)
    expect(browserController.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: { action: 'open', url: 'https://example.com/path' } })
    )
    expect(browserController.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: { action: 'snapshot' } })
    )
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    expect(events.some((event) => event.kind === 'tool_storm_suppressed')).toBe(false)
    const items = await h.sessionStore.loadItems(h.threadId)
    const invalidCall = items.find(
      (item) => item.kind === 'tool_call' && item.callId === 'call-invalid-browser'
    )
    expect(invalidCall?.kind === 'tool_call' ? invalidCall.arguments : undefined).toEqual({})
    expect(JSON.stringify(items)).not.toContain('should-not-persist')
    expect(JSON.stringify(items)).not.toContain('action":"invalid')
  })

  it('lets a suppressed tool loop recover by using a different tool', async () => {
    const requests: ModelRequest[] = []
    let echoExecutions = 0
    let alternateExecutions = 0
    const echoTool = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async () => {
        echoExecutions += 1
        return { output: { ok: echoExecutions } }
      }
    })
    const alternateTool = LocalToolHost.defineTool({
      name: 'alternate_lookup',
      description: 'Use a different lookup strategy.',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async () => {
        alternateExecutions += 1
        return { output: { found: true } }
      }
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'storm-alternate-model',
        model: 'storm-alternate-model',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          calls += 1
          if (calls <= 3) {
            yield {
              kind: 'tool_call_complete',
              callId: `call_echo_${calls}`,
              toolName: 'echo',
              arguments: { text: 'repeat me' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          if (calls === 4) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_alternate',
              toolName: 'alternate_lookup',
              arguments: {}
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'assistant_text_delta', text: 'The alternate lookup completed successfully.' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [echoTool, alternateTool] }
    )
    await bootstrapThread(h)

    await expect(h.loop.runTurn(h.threadId, h.turnId)).resolves.toBe('completed')

    expect(echoExecutions).toBe(2)
    expect(alternateExecutions).toBe(1)
    expect(requests[3]?.tools.map((tool) => tool.name)).toContain('alternate_lookup')
    expect(modelRequestContextText(requests[3]!)).toContain('Tool-loop recovery:')
    expect(modelRequestContextText(requests[4]!)).not.toContain('Tool-loop recovery:')
    expect((await h.turns.getTurn(h.threadId, h.turnId))?.status).toBe('completed')
    expect(h.inflight.size()).toBe(0)
  })

  it('does not reopen tools after an active-goal suppression final answer', async () => {
    const requests: ModelRequest[] = []
    let executions = 0
    const scheduleGoalResume = vi.fn(() => ({ cancel: vi.fn() }))
    const echoTool = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async () => {
        executions += 1
        return { output: { ok: executions } }
      }
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'storm-final-answer-model',
        model: 'storm-final-answer-model',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          calls += 1
          if (calls <= 4) {
            yield {
              kind: 'tool_call_complete',
              callId: `call_echo_${calls}`,
              toolName: 'echo',
              arguments: { text: 'repeat me' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield {
            kind: 'assistant_text_delta',
            text: 'The first two calls completed; the repeated calls were not executed.'
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        tools: [echoTool],
        goalResume: { setTimer: scheduleGoalResume }
      }
    )
    await bootstrapThread(h)
    await h.threads.setGoal(h.threadId, {
      objective: 'Finish using the completed echo result.',
      status: 'active'
    })

    await expect(h.loop.runTurn(h.threadId, h.turnId)).resolves.toBe('completed')

    expect(executions).toBe(2)
    expect(calls).toBe(5)
    expect(requests[3]?.tools).toHaveLength(1)
    expect(requests[4]?.tools).toHaveLength(0)
    expect(modelRequestContextText(requests[4]!))
      .toContain('Tool-loop final-answer recovery:')
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'assistant_text',
      text: 'The first two calls completed; the repeated calls were not executed.'
    }))
    expect((await h.turns.getTurn(h.threadId, h.turnId))?.status).toBe('completed')
    expect((await h.threads.getGoal(h.threadId))?.status).toBe('active')
    expect(scheduleGoalResume).not.toHaveBeenCalled()
    expect(h.inflight.size()).toBe(0)
  })

  it('fails and releases the turn when suppression recovery still has no answer', async () => {
    const requests: ModelRequest[] = []
    let executions = 0
    const echoTool = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async () => {
        executions += 1
        return { output: { ok: executions } }
      }
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'storm-empty-recovery-model',
        model: 'storm-empty-recovery-model',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          calls += 1
          if (calls <= 4) {
            yield {
              kind: 'tool_call_complete',
              callId: `call_echo_${calls}`,
              toolName: 'echo',
              arguments: { text: 'repeat me' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [echoTool] }
    )
    await bootstrapThread(h)

    await expect(h.loop.runTurn(h.threadId, h.turnId)).resolves.toBe('failed')

    expect(executions).toBe(2)
    expect(requests[4]?.tools).toHaveLength(0)
    const turn = await h.turns.getTurn(h.threadId, h.turnId)
    const thread = await h.threadStore.get(h.threadId)
    const items = await h.sessionStore.loadItems(h.threadId)
    const terminalEvents = (await h.sessionStore.loadEventsSince(h.threadId, 0)).filter(
      (event) =>
        event.kind === 'turn_completed' ||
        event.kind === 'turn_failed' ||
        event.kind === 'turn_aborted'
    )
    expect(turn).toMatchObject({ status: 'failed', error: expect.stringContaining('final answer') })
    expect(thread?.status).toBe('idle')
    expect(h.inflight.size()).toBe(0)
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'error',
      code: 'tool_loop_suppressed'
    }))
    expect(items.some((item) => item.kind === 'assistant_text' && item.text.trim())).toBe(false)
    expect(terminalEvents).toEqual([
      expect.objectContaining({ kind: 'turn_failed', code: 'tool_loop_suppressed' })
    ])
  })

  it('does not complete silently when the budget blocks suppression recovery', async () => {
    let executions = 0
    let modelCalls = 0
    const echoTool = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async () => {
        executions += 1
        return { output: { ok: executions } }
      }
    })
    const h = makeHarness(
      {
        provider: 'storm-budget-model',
        model: 'storm-budget-model',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          modelCalls += 1
          yield {
            kind: 'tool_call_complete',
            callId: `call_echo_${modelCalls}`,
            toolName: 'echo',
            arguments: { text: 'repeat me' }
          }
          if (modelCalls === 3) {
            yield {
              kind: 'usage',
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
                cacheHitRate: null,
                turns: 1,
                costUsd: 1
              }
            }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
        }
      },
      { tools: [echoTool] }
    )
    await bootstrapThread(h)
    const thread = await h.threadStore.get(h.threadId)
    await h.threadStore.upsert({ ...thread!, costBudgetUsd: 1 })

    await expect(h.loop.runTurn(h.threadId, h.turnId)).resolves.toBe('failed')

    expect(modelCalls).toBe(3)
    expect(executions).toBe(2)
    expect((await h.turns.getTurn(h.threadId, h.turnId))).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('final answer')
    })
    expect((await h.sessionStore.loadEventsSince(h.threadId, 0))).toContainEqual(
      expect.objectContaining({ kind: 'turn_failed', code: 'tool_loop_suppressed' })
    )
    expect(h.inflight.size()).toBe(0)
  })

  it('suppresses the third identical Graph run inspection within a turn', async () => {
    let executions = 0
    const inspectTool = LocalToolHost.defineTool({
      name: 'graph_control_run',
      description: 'Inspect a durable Graph run.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          runId: { type: 'string' }
        },
        required: ['action', 'runId']
      },
      policy: 'auto',
      execute: async () => {
        executions += 1
        return { output: { seq: executions } }
      }
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'graph-inspect-model',
        model: 'graph-inspect-model',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls <= 3) {
            yield {
              kind: 'tool_call_complete',
              callId: `call_graph_inspect_${calls}`,
              toolName: 'graph_control_run',
              arguments: { action: 'inspect', runId: 'run_1' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'assistant_text_delta', text: 'The existing Graph inspection result is sufficient.' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [inspectTool] }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const stormResult = items.find(
      (item) => item.kind === 'tool_result' && item.callId === 'call_graph_inspect_3'
    )
    const thirdCall = items.find(
      (item) => item.kind === 'tool_call' && item.callId === 'call_graph_inspect_3'
    )

    expect(status).toBe('completed')
    expect(executions).toBe(2)
    expect(thirdCall).toMatchObject({ kind: 'tool_call', status: 'failed' })
    expect(stormResult?.kind === 'tool_result' ? stormResult.isError : false).toBe(true)
    expect(stormResult?.kind === 'tool_result' ? JSON.stringify(stormResult.output) : '')
      .toContain('repeat-loop guard suppressed')
    expect(events.find((event) => event.kind === 'tool_storm_suppressed')).toMatchObject({
      kind: 'tool_storm_suppressed',
      callId: 'call_graph_inspect_3',
      toolName: 'graph_control_run'
    })
  })

	  it('can disable the storm breaker through loop config', async () => {
	    let executions = 0
	    const echoTool = LocalToolHost.defineTool({
	      name: 'echo',
	      description: 'Echo text',
	      inputSchema: {
	        type: 'object',
	        properties: { text: { type: 'string' } },
	        required: ['text']
	      },
	      policy: 'auto',
	      execute: async () => {
	        executions += 1
	        return { output: { ok: executions } }
	      }
	    })
	    let calls = 0
	    const h = makeHarness(
	      {
	        provider: 'storm-disabled-model',
	        model: 'storm-disabled-model',
	        async *stream(): AsyncIterable<ModelStreamChunk> {
	          calls += 1
	          if (calls <= 3) {
	            yield {
	              kind: 'tool_call_complete',
	              callId: `call_echo_${calls}`,
	              toolName: 'echo',
	              arguments: { text: 'repeat me' }
	            }
	            yield { kind: 'completed', stopReason: 'tool_calls' }
	            return
	          }
	          yield { kind: 'completed', stopReason: 'stop' }
	        }
	      },
	      { tools: [echoTool], toolStorm: { enabled: false } }
	    )
	    await bootstrapThread(h)

	    const status = await h.loop.runTurn(h.threadId, h.turnId)
	    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)

	    expect(status).toBe('completed')
	    expect(executions).toBe(3)
	    expect(events.some((event) => event.kind === 'tool_storm_suppressed')).toBe(false)
	  })

	  it('uses compact tool history for model requests without mutating persisted results', async () => {
    const longOutput = Array.from({ length: 600 }, (_, index) =>
      index === 320 ? 'ERROR auth middleware failed hard' : `plain output line ${index}`
    ).join('\n')
    const observedRequests: ModelRequest[] = []
    const bashTool = LocalToolHost.defineTool({
      name: 'bash',
      description: 'Execute command',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      },
      policy: 'auto',
      execute: async () => ({
        output: {
          command: 'npm test',
          cwd: '/tmp',
          exit_code: 1,
          output: longOutput,
          full_output_path: '/tmp/full-output.log'
        },
        isError: true
      })
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'capture',
        model: 'capture',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          observedRequests.push(request)
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_bash',
              toolName: 'bash',
              arguments: { command: 'npm test' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        tools: [bashTool],
        compactor: new ContextCompactor({ softThreshold: 1_000_000, hardThreshold: 1_100_000 }),
        tokenEconomy: { enabled: true }
      }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const persisted = (await h.sessionStore.loadItems(h.threadId)).find((item) => item.kind === 'tool_result')
    const secondRequestResult = observedRequests[1]?.history.find((item) => item.kind === 'tool_result')
    const usageEvents = (await h.sessionStore.loadEventsSince(h.threadId, 0))
      .filter((event) => event.kind === 'usage')

    expect(status).toBe('completed')
    expect(persisted?.kind === 'tool_result' ? JSON.stringify(persisted.output) : '').toContain('plain output line 599')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '').not.toContain('plain output line 300')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output).length : 0)
      .toBeLessThan(JSON.stringify(persisted?.kind === 'tool_result' ? persisted.output : '').length)
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '').toContain('token economy')
    expect(usageEvents.some((event) =>
      event.kind === 'usage' && (event.usage.tokenEconomySavingsTokens ?? 0) > 0
    )).toBe(true)
  })

  it('bounds tool history for model requests even when token economy is disabled', async () => {
    const longOutput = Array.from({ length: 700 }, (_, index) =>
      index === 350 ? 'ERROR default history hygiene caught this line' : `verbose output line ${index}`
    ).join('\n')
    const observedRequests: ModelRequest[] = []
    const bashTool = LocalToolHost.defineTool({
      name: 'bash',
      description: 'Execute command',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      },
      policy: 'auto',
      execute: async () => ({
        output: {
          command: 'npm test',
          output: longOutput
        },
        isError: true
      })
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'capture',
        model: 'capture',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          observedRequests.push(request)
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_bash',
              toolName: 'bash',
              arguments: { command: 'npm test', transcript: 'x'.repeat(12_000) }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        tools: [bashTool],
        compactor: new ContextCompactor({ softThreshold: 1_000_000, hardThreshold: 1_100_000 })
      }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const persisted = (await h.sessionStore.loadItems(h.threadId)).find((item) => item.kind === 'tool_result')
    const secondRequestCall = observedRequests[1]?.history.find((item) => item.kind === 'tool_call')
    const secondRequestResult = observedRequests[1]?.history.find((item) => item.kind === 'tool_result')

    expect(status).toBe('completed')
    expect(persisted?.kind === 'tool_result' ? JSON.stringify(persisted.output) : '').toContain('verbose output line 699')
    expect(secondRequestCall?.kind === 'tool_call' ? String(secondRequestCall.arguments.transcript) : '')
      .toContain('cache hygiene')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '')
      .toContain('ERROR default history hygiene caught this line')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '')
      .toContain('verbose output line 699')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '')
      .toContain('cache hygiene')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output).length : 0)
      .toBeLessThan(JSON.stringify(persisted?.kind === 'tool_result' ? persisted.output : '').length)
  })
})
