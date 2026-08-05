import { describe, expect, test, vi } from 'vitest'
import {
  buildCursorCustomTools,
  selectCursorBridgeTools,
  type CursorBridgeTool
} from './cursor-sdk-tool-bridge.js'

const tools: CursorBridgeTool[] = [{
  name: 'mcp_call_tool',
  description: 'Call an MCP tool',
  toolKind: 'tool_call',
  inputSchema: {
    type: 'object',
    properties: { serverId: { type: 'string' } },
    required: ['serverId']
  },
  providerId: 'mcp:facade',
  providerKind: 'mcp'
}, {
  name: 'extension_render',
  description: 'Render through an extension',
  toolKind: 'tool_call',
  inputSchema: { type: 'object' },
  providerId: 'extension:render',
  providerKind: 'extension'
}, {
  name: '  padded_tool  ',
  description: 'Padded name',
  toolKind: 'command_execution',
  inputSchema: { type: 'object' },
  providerId: 'builtin',
  providerKind: 'built-in'
}, {
  name: 'echo',
  description: 'Internal echo',
  inputSchema: { type: 'object' },
  providerId: 'builtin',
  providerKind: 'built-in'
}]

describe('Cursor SDK Kun custom-tool bridge', () => {
  test('keeps Kun and provider provenance (including toolKind) while excluding internal-only tools', () => {
    expect(selectCursorBridgeTools(tools).map((tool) => [
      tool.name,
      tool.toolKind,
      tool.providerId,
      tool.providerKind
    ])).toEqual([
      ['mcp_call_tool', 'tool_call', 'mcp:facade', 'mcp'],
      ['extension_render', 'tool_call', 'extension:render', 'extension'],
      ['  padded_tool  ', 'command_execution', 'builtin', 'built-in']
    ])
  })

  test('maps Cursor callbacks to Kun execution and preserves call identity and provenance', async () => {
    const execute = vi.fn(async () => ({
      output: { ok: true, value: 42 }
    }))
    const customTools = buildCursorCustomTools(tools, execute)

    await expect(customTools.mcp_call_tool?.execute(
      { serverId: 'docs' },
      { toolCallId: 'cursor-call-1' }
    )).resolves.toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, value: 42 }, null, 2)
      }]
    })
    expect(execute).toHaveBeenCalledWith({
      toolName: 'mcp_call_tool',
      args: { serverId: 'docs' },
      toolCallId: 'cursor-call-1',
      providerId: 'mcp:facade',
      toolKind: 'tool_call'
    })
    expect(customTools.mcp_call_tool?.inputSchema).toMatchObject({
      required: ['serverId']
    })
    expect(customTools.echo).toBeUndefined()
  })

  test('normalizes padded tool names so the SDK key and Kun lookup agree', async () => {
    const execute = vi.fn(async () => ({ output: 'ok' }))
    const customTools = buildCursorCustomTools(tools, execute)

    expect(customTools.padded_tool).toBeDefined()
    expect(customTools['  padded_tool  ']).toBeUndefined()
    await customTools.padded_tool?.execute({}, {})
    expect(execute).toHaveBeenCalledWith({
      toolName: 'padded_tool',
      args: {},
      providerId: 'builtin',
      toolKind: 'command_execution'
    })
  })

  test('returns callback failures to Cursor as tool errors', async () => {
    const customTools = buildCursorCustomTools(tools, async () => {
      throw new Error('MCP disconnected')
    })
    await expect(customTools.mcp_call_tool?.execute({}, {})).resolves.toEqual({
      content: [{
        type: 'text',
        text: 'Kun tool "mcp_call_tool" failed: MCP disconnected'
      }],
      isError: true
    })
  })
})
