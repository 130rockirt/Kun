import { describe, expect, it, vi } from 'vitest'
import { McpCapabilityConfig, type McpServerConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  buildMcpToolProviders,
  type McpClientLifecycleHandlers,
  type McpClientLike,
  type McpToolDescriptor
} from './mcp-tool-provider.js'

class MockMcpClient implements McpClientLike {
  lifecycle: McpClientLifecycleHandlers = {}
  close = vi.fn(async () => undefined)
  listResources?: McpClientLike['listResources']
  readResource?: McpClientLike['readResource']
  listResourceTemplates?: McpClientLike['listResourceTemplates']
  listPrompts?: McpClientLike['listPrompts']
  getPrompt?: McpClientLike['getPrompt']
  listTools = vi.fn(async (): Promise<{ tools: McpToolDescriptor[] }> => ({ tools: this.tools }))

  constructor(
    private readonly tools: McpToolDescriptor[],
    readonly callTool: McpClientLike['callTool']
  ) {}

  setLifecycleHandlers(handlers: McpClientLifecycleHandlers): void {
    this.lifecycle = handlers
  }
}

const server: McpServerConfig = {
  enabled: true,
  transport: 'streamable-http',
  url: 'http://127.0.0.1:39999/mcp',
  headers: {},
  args: [],
  env: {},
  workspaceRoots: [],
  trustScope: 'user',
  trustedWorkspaceRoots: [],
  timeoutMs: 1_000
}

const context: ToolHostContext = {
  threadId: 'thread_test',
  turnId: 'turn_test',
  workspace: '/workspace',
  approvalPolicy: 'auto',
  abortSignal: new AbortController().signal,
  awaitApproval: vi.fn()
}

const descriptors = (count: number, prefix: string): McpToolDescriptor[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `${prefix}${index}`,
    description: `${prefix} tool ${index}`,
    inputSchema: { type: 'object', properties: {} }
  }))

const singleAutoSearchConfig = (autoThresholdToolCount: number) =>
  McpCapabilityConfig.parse({
    enabled: true,
    servers: { docs: server },
    search: {
      enabled: true,
      mode: 'auto',
      autoThresholdToolCount,
      topKDefault: 5,
      topKMax: 10,
      minScore: 0.15
    }
  })

describe('mcp tool provider manual refresh catalog sync', () => {
  it('removes direct providers when a manual refresh crosses the auto threshold', async () => {
    const client = new MockMcpClient([], vi.fn(async () => ({ ok: true })))
    client.listTools
      .mockResolvedValueOnce({ tools: descriptors(1, 'a') })
      .mockResolvedValueOnce({ tools: descriptors(5, 'a') })

    const built = await buildMcpToolProviders(singleAutoSearchConfig(3), {
      clientFactory: vi.fn(async () => client)
    })
    expect(built.providers.map((provider) => provider.id)).toContain('mcp:docs')

    const unregistered: string[] = []
    await built.startBackgroundReconnect({
      register: () => undefined,
      unregister: (providerId) => unregistered.push(providerId),
      replace: () => undefined
    })

    const refresh = built.providers
      .flatMap((provider) => provider.tools)
      .find((tool) => tool.name === 'mcp_refresh_catalog')!
    await refresh.execute({}, context)

    expect(unregistered).toContain('mcp:docs')
    expect(built.search.indexedToolCount).toBe(5)
    expect(built.search.active).toBe(true)
  })

  it('registers direct providers when a manual refresh falls below the auto threshold', async () => {
    const client = new MockMcpClient([], vi.fn(async () => ({ ok: true })))
    client.listTools
      .mockResolvedValueOnce({ tools: descriptors(5, 'a') })
      .mockResolvedValueOnce({ tools: descriptors(1, 'a') })

    const built = await buildMcpToolProviders(singleAutoSearchConfig(3), {
      clientFactory: vi.fn(async () => client)
    })
    expect(built.providers.map((provider) => provider.id)).toEqual(['mcp:search', 'mcp:facade'])

    const registered: string[] = []
    await built.startBackgroundReconnect({
      register: (provider) => registered.push(provider.id),
      unregister: () => undefined,
      replace: () => undefined
    })

    const refresh = built.providers
      .flatMap((provider) => provider.tools)
      .find((tool) => tool.name === 'mcp_refresh_catalog')!
    await refresh.execute({}, context)

    expect(registered).toContain('mcp:docs')
    expect(built.search.indexedToolCount).toBe(1)
    expect(built.search.active).toBe(false)
  })

  it('replaces an exposed direct provider when a refresh changes its schema', async () => {
    const oldDescriptor: McpToolDescriptor = {
      name: 'lookup',
      description: 'old schema',
      inputSchema: { type: 'object', properties: {} }
    }
    const newDescriptor: McpToolDescriptor = {
      name: 'lookup',
      description: 'new schema',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }
    const client = new MockMcpClient([], vi.fn(async () => ({ ok: true })))
    client.listTools
      .mockResolvedValueOnce({ tools: [oldDescriptor] })
      .mockResolvedValueOnce({ tools: [newDescriptor] })

    const built = await buildMcpToolProviders(singleAutoSearchConfig(3), {
      clientFactory: vi.fn(async () => client)
    })
    expect(built.providers.map((provider) => provider.id)).toContain('mcp:docs')

    const replaced: string[] = []
    await built.startBackgroundReconnect({
      register: () => undefined,
      unregister: () => undefined,
      replace: (provider) => replaced.push(provider.tools[0]?.description ?? '')
    })

    const refresh = built.providers
      .flatMap((provider) => provider.tools)
      .find((tool) => tool.name === 'mcp_refresh_catalog')!
    await refresh.execute({}, context)

    expect(replaced[replaced.length - 1]).toBe('new schema')
  })

  it('keeps the old catalog and fingerprint when a manual refresh fails', async () => {
    const client = new MockMcpClient([], vi.fn(async () => ({ ok: true })))
    client.listTools
      .mockResolvedValueOnce({ tools: descriptors(1, 'a') })
      .mockRejectedValueOnce(new Error('refresh boom'))

    const built = await buildMcpToolProviders(singleAutoSearchConfig(3), {
      clientFactory: vi.fn(async () => client)
    })
    const fingerprintBefore = built.search.catalogFingerprint

    await built.startBackgroundReconnect({
      register: () => undefined,
      unregister: () => undefined,
      replace: () => undefined
    })

    const refresh = built.providers
      .flatMap((provider) => provider.tools)
      .find((tool) => tool.name === 'mcp_refresh_catalog')!
    await expect(refresh.execute({}, context)).rejects.toThrow('refresh boom')

    expect(built.search.indexedToolCount).toBe(1)
    expect(built.search.catalogFingerprint).toBe(fingerprintBefore)
    expect(built.search.lastError).toBe('refresh boom')
  })
})
