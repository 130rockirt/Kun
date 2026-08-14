import { describe, expect, it, vi } from 'vitest'
import { makeToolResultItem } from '../domain/item.js'
import type { ToolCallLike, ToolHost, ToolHostContext } from '../ports/tool-host.js'
import { createFastContextToolHost } from './fast-context-tool-host.js'

const context = {
  threadId: 'child', turnId: 'turn', workspace: '/workspace', fastContext: true,
  fastContextTaskCount: 2, approvalPolicy: 'auto', abortSignal: new AbortController().signal,
  awaitApproval: async () => 'allow' as const
} as ToolHostContext

const readCall = (arguments_: Record<string, unknown>): ToolCallLike => ({
  callId: 'read_call', toolName: 'read', arguments: arguments_
})

function sourceHost(execute = vi.fn()): ToolHost {
  return {
    id: 'source-host',
    listTools: async () => [
      { name: 'glob', description: 'glob', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      { name: 'grep', description: 'grep', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      { name: 'read', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'bash', description: 'bash', inputSchema: { type: 'object', properties: {} } }
    ],
    execute: async (call) => {
      execute(call)
      return {
        item: makeToolResultItem({
          id: `item_${call.callId}`, threadId: 'child', turnId: 'turn', callId: call.callId,
          toolName: call.toolName, output: { ok: true }
        }),
        approved: true
      }
    }
  }
}

describe('createFastContextToolHost', () => {
  it('requires task_indexes provenance for every Fast Context source schema', async () => {
    const host = createFastContextToolHost(sourceHost(), 2)
    const tools = await host.listTools(context)
    const read = tools.find((tool) => tool.name === 'read')!
    expect(read.inputSchema).toMatchObject({
      properties: { task_indexes: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer', minimum: 1, maximum: 2 } } },
      required: ['path', 'task_indexes']
    })
    expect(tools.map((tool) => tool.name)).toEqual(['glob', 'grep', 'read'])
    expect(tools.find((tool) => tool.name === 'glob')?.description).toContain('candidate-file discovery')
    expect(tools.find((tool) => tool.name === 'grep')?.description).toContain('at most 30 matches')
    expect(read.description).toContain('capped at 200 lines')
    expect(tools.map((tool) => tool.description).join('\n')).toContain('task_indexes')
  })

  it('rejects missing/invalid attribution and strips valid task_indexes before source execution', async () => {
    const executed = vi.fn()
    const host = createFastContextToolHost(sourceHost(executed), 2)
    const missing = await host.execute(readCall({ path: 'src/a.ts' }), context)
    expect(missing.item).toMatchObject({
      kind: 'tool_result', isError: true,
      output: { code: 'fast_context_task_indexes_required' }
    })
    const invalid = await host.execute(readCall({
      path: 'src/a.ts',
      task_indexes: Array.from({ length: 1_000 }, () => ({ nested: ['untrusted'] }))
    }), context)
    expect(invalid.item).toMatchObject({
      output: { code: 'fast_context_task_indexes_required', task_indexes_provided: true }
    })
    const invalidOutput = invalid.item.kind === 'tool_result' ? invalid.item.output : undefined
    expect(invalidOutput).not.toHaveProperty('task_indexes')
    expect(JSON.stringify(invalidOutput)).not.toContain('untrusted')
    await host.execute(readCall({ path: 'src/a.ts', task_indexes: [2] }), context)
    expect(executed).toHaveBeenCalledWith(expect.objectContaining({
      arguments: { path: 'src/a.ts' }
    }))
    expect(executed.mock.calls[0]?.[0].arguments).not.toHaveProperty('task_indexes')
  })

  it('rejects a non-source call without delegating it to the underlying host', async () => {
    const executed = vi.fn()
    const host = createFastContextToolHost(sourceHost(executed), 2)

    const result = await host.execute({ callId: 'bash_call', toolName: 'bash', arguments: {} }, context)

    expect(result.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: { code: 'fast_context_tool_not_allowed' }
    })
    expect(executed).not.toHaveBeenCalled()
  })

  it('keeps source provenance uniform for a single-task child', async () => {
    const executed = vi.fn()
    const host = createFastContextToolHost(sourceHost(executed), 1)
    const singleContext = { ...context, fastContextTaskCount: 1 }
    const missing = await host.execute(readCall({ path: 'src/a.ts' }), singleContext)
    expect(missing.item).toMatchObject({ output: { code: 'fast_context_task_indexes_required' } })
    await host.execute(readCall({ path: 'src/a.ts', task_indexes: [1] }), singleContext)
    expect(executed).toHaveBeenCalledWith(expect.objectContaining({ arguments: { path: 'src/a.ts' } }))
  })
})
