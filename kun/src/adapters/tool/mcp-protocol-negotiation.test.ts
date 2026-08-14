import { Client, InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { McpElicitationRuntime } from './mcp-elicitation.js'
import { mcpClientOptions } from './mcp-transport.js'

const server = (transport: McpServerConfig['transport']): McpServerConfig => ({
  enabled: true,
  transport,
  ...(transport === 'stdio' ? { command: 'fixture' } : { url: 'https://mcp.example.test' }),
  headers: {},
  args: [],
  env: {},
  workspaceRoots: [],
  trustScope: 'user',
  trustedWorkspaceRoots: [],
  timeoutMs: 5_000
})

describe('MCP protocol era negotiation', () => {
  it.each(['stdio', 'streamable-http'] as const)('enables auto negotiation for %s', (transport) => {
    expect(mcpClientOptions(server(transport)).versionNegotiation).toMatchObject({
      mode: 'auto',
      probe: { timeoutMs: 5_000, maxRetries: 0 }
    })
  })

  it('keeps legacy SSE in legacy mode', () => {
    expect(mcpClientOptions(server('sse')).versionNegotiation).toEqual({ mode: 'legacy' })
  })

  it('negotiates the modern 2026-07-28 era', async () => {
    const { client, close } = await connectFixture('2026-07-28', true)
    try {
      expect(client.getProtocolEra()).toBe('modern')
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
    } finally {
      await close()
    }
  })

  it('keeps turn context through the SDK modern input-required retry', async () => {
    const fixture = await connectInputRequiredFixture()
    const runtime = new McpElicitationRuntime('modern-input')
    fixture.client.setRequestHandler('elicitation/create', (request) => runtime.handle(request.params))
    const context: ToolHostContext = {
      threadId: 'thread-modern-input',
      turnId: 'turn-modern-input',
      workspace: '/workspace',
      approvalPolicy: 'auto',
      awaitApproval: async () => 'allow',
      abortSignal: new AbortController().signal,
      awaitUserInput: async (input) => ({
        status: 'submitted' as const,
        answers: [{ id: input.questions[0]?.id ?? 'name', label: 'Kun', value: 'Kun' }]
      })
    }
    try {
      const result = await runtime.run(context, () => fixture.client.callTool({
        name: 'interactive',
        arguments: {}
      }))
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'done' }] })
      expect(fixture.retry).toMatchObject({
        requestState: 'opaque-state',
        inputResponses: { answer: { action: 'accept', content: { name: 'Kun' } } }
      })
    } finally {
      await fixture.close()
    }
  })

  it.each(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) (
    'falls back to historical revision %s',
    async (revision) => {
      const { client, methods, close } = await connectFixture(revision, false)
      try {
        expect(methods.slice(0, 2)).toEqual(['server/discover', 'initialize'])
        expect(client.getProtocolEra()).toBe('legacy')
        expect(client.getNegotiatedProtocolVersion()).toBe(revision)
      } finally {
        await close()
      }
    }
  )
})

async function connectFixture(
  revision: string,
  modern: boolean
): Promise<{ client: Client; methods: string[]; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const methods: string[] = []
  serverTransport.onmessage = (message) => {
    if (!('id' in message) || !('method' in message)) return
    methods.push(message.method)
    if (message.method === 'server/discover') {
      void serverTransport.send(modern
        ? response(message.id, {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {} },
            ttlMs: 0,
            cacheScope: 'private'
          })
        : errorResponse(message.id, -32601, 'Method not found'))
      return
    }
    if (message.method === 'initialize') {
      void serverTransport.send(response(message.id, {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' }
      }))
    }
  }
  await serverTransport.start()
  const client = new Client(
    { name: 'kun-test', version: '1.0.0' },
    mcpClientOptions(server('streamable-http'))
  )
  await client.connect(clientTransport)
  return {
    client,
    methods,
    close: async () => {
      await client.close()
      await serverTransport.close()
    }
  }
}

async function connectInputRequiredFixture(): Promise<{
  client: Client
  retry: Record<string, unknown>
  close: () => Promise<void>
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const retry: Record<string, unknown> = {}
  serverTransport.onmessage = (message) => {
    if (!('id' in message) || !('method' in message)) return
    if (message.method === 'server/discover') {
      void serverTransport.send(response(message.id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: 'private'
      }))
      return
    }
    if (message.method !== 'tools/call') return
    const params = message.params as Record<string, unknown>
    if (!params.inputResponses) {
      void serverTransport.send(response(message.id, {
        resultType: 'input_required',
        requestState: 'opaque-state',
        inputRequests: {
          answer: {
            method: 'elicitation/create',
            params: {
              mode: 'form',
              message: 'What should the server call you?',
              requestedSchema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name']
              }
            }
          }
        }
      }))
      return
    }
    Object.assign(retry, {
      inputResponses: params.inputResponses,
      requestState: params.requestState
    })
    void serverTransport.send(response(message.id, {
      resultType: 'complete',
      content: [{ type: 'text', text: 'done' }]
    }))
  }
  await serverTransport.start()
  const client = new Client(
    { name: 'kun-input-test', version: '1.0.0' },
    mcpClientOptions(server('streamable-http'))
  )
  await client.connect(clientTransport)
  return {
    client,
    retry,
    close: async () => {
      await client.close()
      await serverTransport.close()
    }
  }
}

function response(id: string | number, result: Record<string, unknown>): JSONRPCMessage {
  return { jsonrpc: '2.0', id, result } as JSONRPCMessage
}

function errorResponse(id: string | number, code: number, message: string): JSONRPCMessage {
  return { jsonrpc: '2.0', id, error: { code, message } } as JSONRPCMessage
}
