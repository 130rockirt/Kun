import { describe, expect, it, vi } from 'vitest'
import type { McpClientLike } from './mcp-types.js'
import { listAllMcpTools } from './mcp-tool-runtime.js'

describe('listAllMcpTools', () => {
  it('forwards an opaque empty cursor and refresh cache mode', async () => {
    const listTools = vi.fn<McpClientLike['listTools']>()
      .mockResolvedValueOnce({ tools: [{ name: 'first' }], nextCursor: '' })
      .mockResolvedValueOnce({ tools: [{ name: 'second' }] })
    const client = {
      listTools,
      callTool: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as McpClientLike

    await expect(listAllMcpTools(client, 1_000, 'refresh')).resolves.toEqual([
      { name: 'first' },
      { name: 'second' }
    ])
    expect(listTools).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      timeout: 1_000,
      cacheMode: 'refresh'
    })
    expect(listTools).toHaveBeenNthCalledWith(2, {
      cursor: '',
      timeout: 1_000,
      cacheMode: 'refresh'
    })
  })

  it('rejects a repeated opaque cursor instead of looping forever', async () => {
    const client = {
      listTools: vi.fn(async () => ({ tools: [], nextCursor: 'same' })),
      callTool: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as McpClientLike

    await expect(listAllMcpTools(client, 1_000)).rejects.toThrow(/repeated pagination cursor/)
  })
})
