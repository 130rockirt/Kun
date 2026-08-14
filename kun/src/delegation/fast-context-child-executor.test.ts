import { describe, expect, it } from 'vitest'
import { LocalToolHost, type LocalTool } from '../adapters/tool/local-tool-host.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { createChildAgentExecutor } from './child-agent-executor.js'

const tasks = [{ title: 'Read implementation', query: 'Find the implementation and explain its behavior.' }]
const groupedTasks = [
  ...tasks,
  { title: 'Read callers', query: 'Find callers and explain their behavior.' }
]

function sourceTool(
  name: 'grep' | 'glob' | 'read',
  onExecute?: (context: ToolHostContext) => void
): LocalTool {
  return LocalToolHost.defineTool({
    name,
    description: name,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: true },
    policy: 'auto',
    sideEffect: 'read-only',
    execute: async (_args, context) => {
      onExecute?.(context)
      return {
        output: name === 'read'
          ? { relative_path: 'src/target.ts', start_line: 10, end_line: 12, content: 'export const target = true' }
          : { matches: [] }
      }
    }
  })
}

function fastContextInput(model: string, signal = new AbortController().signal) {
  return {
    childId: 'child_fast_context', parentThreadId: 'parent', parentTurnId: 'turn_parent',
    prompt: 'retrieve source evidence', workspace: '/workspace', model, toolPolicy: 'readOnly' as const,
    fastContext: true, fastContextTasks: tasks, signal
  }
}

class CatalogModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'catalog-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    yield { kind: 'assistant_text_delta', text: 'Task 1: source found.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class ReadForeverModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'read-forever-model'
  requests = 0

  async *stream(): AsyncIterable<ModelStreamChunk> {
    this.requests += 1
    yield { kind: 'tool_call_complete', callId: `read_${this.requests}`, toolName: 'read', arguments: { path: 'src/target.ts', task_indexes: [1] } }
    yield { kind: 'completed', stopReason: 'tool_calls' }
  }
}

class OverflowThenConcludeModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'too-many-tools-model'
  requests = 0

  async *stream(): AsyncIterable<ModelStreamChunk> {
    this.requests += 1
    if (this.requests === 1) {
      for (let index = 0; index < 9; index += 1) {
        yield { kind: 'tool_call_complete', callId: `read_${index}`, toolName: 'read', arguments: { path: 'src/target.ts', task_indexes: [1] } }
      }
      yield { kind: 'completed', stopReason: 'tool_calls' }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'Task 1: source found after bounded reads.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class ReadThenConcludeModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'read-then-conclude-model'
  requests = 0

  async *stream(): AsyncIterable<ModelStreamChunk> {
    this.requests += 1
    if (this.requests === 1) {
      yield { kind: 'tool_call_complete', callId: 'read_once', toolName: 'read', arguments: { path: 'src/target.ts', task_indexes: [1] } }
      yield { kind: 'completed', stopReason: 'tool_calls' }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'Task 1: source found.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

describe('Fast Context child executor', () => {
  it('bypasses provider-native SDK composition and exposes only grep, glob, and read', async () => {
    const model = new CatalogModel()
    let nativeFactoryCalls = 0
    const executor = createChildAgentExecutor({
      model,
      toolHost: new LocalToolHost({ tools: [sourceTool('grep'), sourceTool('glob'), sourceTool('read'), sourceTool('read')].slice(0, 3) }),
      prefix: createImmutablePrefix({ systemPrompt: 'test' }), defaultModel: model.model,
      createDelegatedRuntime: () => {
        nativeFactoryCalls += 1
        throw new Error('Fast Context must not construct a provider-native runtime')
      }
    })

    const result = await executor({ ...fastContextInput(model.model), fastContextTasks: groupedTasks })
    expect(result).toMatchObject({ summary: 'Task 1: source found.', evidencePack: { version: 1 } })
    expect(result.evidencePack?.tasks[0]).toMatchObject({ index: 0, evidence: [] })
    expect(nativeFactoryCalls).toBe(0)
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools.map((tool) => tool.name).sort()).toEqual(['glob', 'grep', 'read'])
    expect(model.requests[0]?.tools.find((tool) => tool.name === 'read')?.inputSchema).toMatchObject({
      properties: { task_indexes: { type: 'array', minItems: 1, maxItems: 2 } },
      required: expect.arrayContaining(['task_indexes'])
    })
  })

  it('caps a Fast Context child at four model steps, reserving the fourth for synthesis', async () => {
    const model = new ReadForeverModel()
    let reads = 0
    const executor = createChildAgentExecutor({
      model, toolHost: new LocalToolHost({ tools: [sourceTool('grep'), sourceTool('glob'), sourceTool('read', () => { reads += 1 })] }),
      prefix: createImmutablePrefix({ systemPrompt: 'test' }), defaultModel: model.model
    })

    await expect(executor(fastContextInput(model.model))).rejects.toMatchObject({
      name: 'ChildResultExecutionError',
      result: { evidencePack: { version: 1, tasks: [{ evidence: [{ path: 'src/target.ts', ranges: [[10, 12]] }] }] } }
    })
    expect(model.requests).toBe(4)
    expect(reads).toBe(3)
  })

  it('truncates tool-call overflow and continues with the accepted batch', async () => {
    const model = new OverflowThenConcludeModel()
    let reads = 0
    const executor = createChildAgentExecutor({
      model, toolHost: new LocalToolHost({ tools: [sourceTool('grep'), sourceTool('glob'), sourceTool('read', () => { reads += 1 })] }),
      prefix: createImmutablePrefix({ systemPrompt: 'test' }), defaultModel: model.model
    })

    await expect(executor(fastContextInput(model.model))).resolves.toMatchObject({
      summary: 'Task 1: source found after bounded reads.'
    })
    expect(model.requests).toBe(2)
    expect(reads).toBe(8)
  })

  it('confines full-access Fast Context source calls to the captured workspace', async () => {
    const model = new ReadThenConcludeModel()
    let sourceContext: ToolHostContext | undefined
    const executor = createChildAgentExecutor({
      model,
      toolHost: new LocalToolHost({ tools: [
        sourceTool('grep'), sourceTool('glob'), sourceTool('read', (context) => { sourceContext = context })
      ] }),
      prefix: createImmutablePrefix({ systemPrompt: 'test' }), defaultModel: model.model
    })

    await expect(executor({
      ...fastContextInput(model.model),
      sandboxMode: 'danger-full-access'
    })).resolves.toMatchObject({ evidencePack: { version: 1 } })
    expect(sourceContext).toMatchObject({
      fastContext: true,
      fastContextTaskCount: 1,
      sandboxMode: 'danger-full-access',
      allowedReadPaths: ['.']
    })
  })
})
