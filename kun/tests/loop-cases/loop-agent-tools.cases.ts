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
  it('keeps running past the legacy eight-step ceiling until the model stops', async () => {
    let calls = 0
    const noop = LocalToolHost.defineTool({
      name: 'noop',
      description: 'Complete without side effects.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const h = makeHarness(
      {
        provider: 'long-runner',
        model: 'long-runner',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls <= 9) {
            yield {
              kind: 'tool_call_complete',
              callId: `call_noop_${calls}`,
              toolName: 'noop',
              arguments: {}
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'assistant_text_delta', text: 'done' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [noop], toolStorm: { enabled: false } }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(calls).toBe(10)
    expect(items.some((item) => item.kind === 'assistant_text' && item.text === 'done')).toBe(true)
  })

  it('replaces live partial tool results with final tool results in the thread snapshot', async () => {
    const partialTool = LocalToolHost.defineTool({
      name: 'partial_bash',
      description: 'Emit a partial update then a final result',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      policy: 'auto',
      execute: async (_args, _context, onUpdate) => {
        await onUpdate?.({ output: { partial: true }, isError: false })
        return { output: { exit_code: 127 }, isError: true }
      }
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'fake',
        model: 'fake',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_partial',
              toolName: 'partial_bash',
              arguments: {}
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [partialTool] }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const thread = await h.threadStore.get(h.threadId)
    const result = thread?.turns
      .flatMap((turn) => turn.items)
      .find((item) => item.kind === 'tool_result' && item.callId === 'call_partial')

    expect(status).toBe('completed')
    expect(result).toMatchObject({
      kind: 'tool_result',
      status: 'completed',
      isError: true,
      output: { exit_code: 127 }
    })
  })

  it('defers additive tool catalog changes until the next turn', async () => {
    const seenInstructions: string[][] = []
    const seenToolNames: string[][] = []
    let modelCalls = 0
    let advertiseExtra = false
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
        advertiseExtra = true
        return { output: { ok: true } }
      }
    })
    const extraTool = LocalToolHost.defineTool({
      name: 'extra_tool',
      description: 'Appears after the first tool call',
      inputSchema: { type: 'object', properties: {}, required: [] },
      policy: 'auto',
      shouldAdvertise: () => advertiseExtra,
      execute: async () => ({ output: { ok: true } })
    })
    const h = makeHarness(
      {
        provider: 'catalog-drift',
        model: 'catalog-drift',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          seenInstructions.push([modelRequestContextText(request)])
          seenToolNames.push((request.tools ?? []).map((tool) => tool.name))
          modelCalls += 1
          if (modelCalls === 1) {
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
      { tools: [echoTool, extraTool] }
    )
    await bootstrapThread(h)

    await h.loop.runTurn(h.threadId, h.turnId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const items = await h.sessionStore.loadItems(h.threadId)

    expect(events.some((event) => event.kind === 'tool_catalog_changed')).toBe(true)
    expect(events.find((event) => event.kind === 'tool_catalog_changed')).toMatchObject({
      kind: 'tool_catalog_changed',
      changeKind: 'additive'
    })
    expect(items.some((item) => item.kind === 'error' && item.code === 'tool_catalog_changed')).toBe(false)
    expect(seenInstructions[1]?.some((text) => text.includes('Tool catalog changed'))).toBe(true)
    expect(seenInstructions[1]?.some((text) => text.includes('next turn'))).toBe(true)
    expect(seenToolNames[0]).toEqual(['echo'])
    expect(seenToolNames[1]).toEqual(['echo'])
  })

  it('deep-freezes an existing tool schema for every model step in a turn', async () => {
    let modelCalls = 0
    const seenSchemas: Record<string, unknown>[] = []
    const inputSchema: Record<string, unknown> = {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
    const echoTool = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo text.',
      inputSchema,
      policy: 'auto',
      execute: async () => {
        inputSchema.properties = {
          text: { type: 'string' },
          unexpected: { type: 'boolean' }
        }
        return { output: { ok: true } }
      }
    })
    const h = makeHarness(
      {
        provider: 'catalog-breaking-drift',
        model: 'catalog-breaking-drift',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          modelCalls += 1
          seenSchemas.push(structuredClone(request.tools?.[0]?.inputSchema ?? {}))
          if (modelCalls > 1) {
            yield { kind: 'completed', stopReason: 'stop' }
            return
          }
          yield {
            kind: 'tool_call_complete',
            callId: 'call_echo',
            toolName: 'echo',
            arguments: { text: 'hi' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
        }
      },
      { tools: [echoTool] }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const items = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(modelCalls).toBe(2)
    expect(seenSchemas[1]).toEqual(seenSchemas[0])
    expect(JSON.stringify(seenSchemas[1])).not.toContain('unexpected')
    expect(events.find((event) => event.kind === 'tool_catalog_changed')).toMatchObject({
      kind: 'tool_catalog_changed',
      changeKind: 'breaking'
    })
    expect(items.some((item) => item.kind === 'error' && item.code === 'tool_catalog_changed')).toBe(false)
  })

	  it('runs consecutive built-in read-only tool calls in a deterministic parallel batch', async () => {
    const started: string[] = []
    let resolveBothStarted!: () => void
    let releaseTools!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseTools = resolve
    })
    const makeReadOnlyTool = (name: 'read' | 'grep') =>
      LocalToolHost.defineTool({
        name,
        description: `${name} test tool`,
        inputSchema: {
          type: 'object',
          properties: {}
        },
        policy: 'auto',
        execute: async () => {
          started.push(name)
          if (started.length === 2) resolveBothStarted()
          await release
          return { output: { name } }
        }
      })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'parallel-model',
        model: 'parallel-model',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_read',
              toolName: 'read',
              arguments: {}
            }
            yield {
              kind: 'tool_call_complete',
              callId: 'call_grep',
              toolName: 'grep',
              arguments: {}
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [makeReadOnlyTool('read'), makeReadOnlyTool('grep')] }
    )
    await bootstrapThread(h)

    const run = h.loop.runTurn(h.threadId, h.turnId)
    let startupError: Error | undefined
    try {
      await Promise.race([
        bothStarted,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`only started ${started.join(',') || 'none'}`)), 100)
        })
      ])
    } catch (error) {
      startupError = error instanceof Error ? error : new Error(String(error))
    } finally {
      releaseTools()
    }
    const status = await run
    if (startupError) throw startupError

    const resultCallIds = (await h.sessionStore.loadItems(h.threadId))
      .filter((item) => item.kind === 'tool_result')
      .map((item) => item.kind === 'tool_result' ? item.callId : '')

    expect(status).toBe('completed')
    expect(started).toEqual(['read', 'grep'])
    expect(resultCallIds).toEqual(['call_read', 'call_grep'])
  })

  it('fans out multiple delegate_task calls from one message in a single parallel batch', async () => {
    const started: string[] = []
    let resolveBothStarted!: () => void
    let releaseChildren!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseChildren = resolve
    })
    // A single delegation-kind tool invoked twice in one assistant message.
    // If the loop ran these sequentially, only the first would start and the
    // second would never reach `bothStarted` before the release.
    const delegateTool = LocalToolHost.defineTool({
      name: 'delegate_task',
      description: 'fake delegation tool',
      inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
      policy: 'auto',
      execute: async (args) => {
        started.push(String(args.prompt))
        if (started.length === 2) resolveBothStarted()
        await release
        return { output: { summary: `done ${String(args.prompt)}` } }
      }
    })
    const toolHost = new LocalToolHost({
      registry: new CapabilityRegistry([
        { id: 'delegation', kind: 'delegation', enabled: true, available: true, tools: [delegateTool] }
      ])
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'delegation-model',
        model: 'delegation-model',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls === 1) {
            yield { kind: 'tool_call_complete', callId: 'call_a', toolName: 'delegate_task', arguments: { prompt: 'a' } }
            yield { kind: 'tool_call_complete', callId: 'call_b', toolName: 'delegate_task', arguments: { prompt: 'b' } }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { toolHost }
    )
    await bootstrapThread(h)

    const run = h.loop.runTurn(h.threadId, h.turnId)
    let startupError: Error | undefined
    try {
      await Promise.race([
        bothStarted,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`only started ${started.join(',') || 'none'}`)), 200)
        })
      ])
    } catch (error) {
      startupError = error instanceof Error ? error : new Error(String(error))
    } finally {
      releaseChildren()
    }
    const status = await run
    if (startupError) throw startupError

    const resultCallIds = (await h.sessionStore.loadItems(h.threadId))
      .filter((item) => item.kind === 'tool_result')
      .map((item) => item.kind === 'tool_result' ? item.callId : '')

    expect(status).toBe('completed')
    expect(started.sort()).toEqual(['a', 'b'])
    expect(resultCallIds).toEqual(['call_a', 'call_b'])
  })

	  it('repairs wrapped tool arguments before persisting and dispatching calls', async () => {
	    let observedArguments: Record<string, unknown> | null = null
	    let calls = 0
	    const h = makeHarness(
	      {
	        provider: 'wrapped-tool-args',
	        model: 'wrapped-tool-args',
	        async *stream(): AsyncIterable<ModelStreamChunk> {
	          calls += 1
	          if (calls > 1) {
	            yield { kind: 'completed', stopReason: 'stop' }
	            return
	          }
	          yield {
	            kind: 'tool_call_complete',
            callId: 'call_wrapped',
            toolName: 'capture_args',
            arguments: {
              tool_name: 'capture_args',
              arguments: '{"path":"src/main.ts"}'
            }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
        }
      },
      {
        tools: [
          LocalToolHost.defineTool({
            name: 'capture_args',
            description: 'Capture repaired args.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: true },
            policy: 'auto',
            execute: async (args) => {
              observedArguments = { ...args }
              return { output: { ok: true } }
            }
          })
        ]
      }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(observedArguments).toEqual({ path: 'src/main.ts' })
    const items = await h.sessionStore.loadItems(h.threadId)
    const toolCall = items.find((item) => item.kind === 'tool_call' && item.callId === 'call_wrapped')
    expect(toolCall).toMatchObject({
      arguments: { path: 'src/main.ts' },
      summary: expect.stringContaining('flattened arguments wrapper')
    })
  })

	  it('allows repeated identical ordinary tool calls within a turn', async () => {
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
        provider: 'storm-model',
        model: 'storm-model',
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
          yield { kind: 'assistant_text_delta', text: 'The repeated call was unnecessary; the earlier result is sufficient.' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [echoTool] }
    )
    await bootstrapThread(h)

	    const status = await h.loop.runTurn(h.threadId, h.turnId)
	    const items = await h.sessionStore.loadItems(h.threadId)
	    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
	    const stormResult = items.find(
	      (item) => item.kind === 'tool_result' && item.callId === 'call_echo_3'
	    )
    const thirdCall = items.find(
      (item) => item.kind === 'tool_call' && item.callId === 'call_echo_3'
    )

    expect(status).toBe('completed')
	    expect(executions).toBe(3)
	    expect(thirdCall).toMatchObject({ kind: 'tool_call', status: 'completed' })
	    expect(stormResult?.kind === 'tool_result' ? stormResult.isError : true).toBe(false)
	    expect(events.some((event) => event.kind === 'tool_storm_suppressed')).toBe(false)
	  })
})
