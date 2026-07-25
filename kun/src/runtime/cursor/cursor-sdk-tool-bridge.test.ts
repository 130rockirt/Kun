import { describe, expect, test, vi } from 'vitest'
import {
  buildCursorCustomTools,
  selectCursorBridgeTools,
  type CursorBridgeTool
} from './cursor-sdk-tool-bridge.js'

const tools: CursorBridgeTool[] = [{
  name: 'mcp_call_tool',
  description: 'Call an MCP tool',
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
  inputSchema: { type: 'object' },
  providerId: 'extension:render',
  providerKind: 'extension'
}, {
  name: 'echo',
  description: 'Internal echo',
  inputSchema: { type: 'object' },
  providerId: 'builtin',
  providerKind: 'built-in'
}]

describe('Cursor SDK Kun custom-tool bridge', () => {
  test('keeps Kun and provider provenance while excluding internal-only tools', () => {
    expect(selectCursorBridgeTools(tools).map((tool) => [
      tool.name,
      tool.providerId,
      tool.providerKind
    ])).toEqual([
      ['mcp_call_tool', 'mcp:facade', 'mcp'],
      ['extension_render', 'extension:render', 'extension']
    ])
  })

  test('maps Cursor callbacks to Kun execution and preserves call identity', async () => {
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
    expect(execute).toHaveBeenCalledWith(
      'mcp_call_tool',
      { serverId: 'docs' },
      'cursor-call-1'
    )
    expect(customTools.mcp_call_tool?.inputSchema).toMatchObject({
      required: ['serverId']
    })
    expect(customTools.echo).toBeUndefined()
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
