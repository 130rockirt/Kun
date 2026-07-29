import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '../../contracts/capabilities.js'
import { createTransport, resolveMcpHeaders } from './mcp-transport.js'

type RemoteTransportInternals = {
  _requestInit?: RequestInit
  _eventSourceInit?: {
    fetch?: typeof fetch
  }
}

function remoteServer(
  transport: 'streamable-http' | 'sse',
  headers: Record<string, string>
): McpServerConfig {
  return {
    enabled: true,
    transport,
    url: 'https://mcp.example.test',
    headers,
    args: [],
    env: {},
    workspaceRoots: [],
    trustScope: 'user',
    trustedWorkspaceRoots: [],
    timeoutMs: 1_000
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('remote MCP header environment expansion', () => {
  it('expands embedded and repeated references without mutating the configuration', () => {
    const configuredHeaders = {
      Authorization: 'Bearer ${TOKEN}',
      'X-Scope': '${ACCOUNT}:${ACCOUNT}',
      Accept: 'application/json, text/event-stream'
    }

    expect(resolveMcpHeaders(configuredHeaders, {
      TOKEN: 'secret-token',
      ACCOUNT: 'team-a'
    })).toEqual({
      Authorization: 'Bearer secret-token',
      'X-Scope': 'team-a:team-a',
      Accept: 'application/json, text/event-stream'
    })
    expect(configuredHeaders).toEqual({
      Authorization: 'Bearer ${TOKEN}',
      'X-Scope': '${ACCOUNT}:${ACCOUNT}',
      Accept: 'application/json, text/event-stream'
    })
  })

  it('reports a missing variable without including any resolved secret value', () => {
    expect.assertions(4)
    try {
      resolveMcpHeaders(
        { Authorization: 'Bearer ${TOKEN}/${MISSING_TOKEN}' },
        { TOKEN: 'resolved-secret' }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('Authorization')
      expect(message).toContain('MISSING_TOKEN')
      expect(message).not.toContain('resolved-secret')
      expect(message).not.toContain('Bearer')
    }
  })

  it('uses resolved headers for Streamable HTTP requests', () => {
    vi.stubEnv('KUN_MCP_HTTP_TOKEN', 'http-secret')
    const server = remoteServer('streamable-http', {
      Authorization: 'Bearer ${KUN_MCP_HTTP_TOKEN}'
    })

    const transport = createTransport(server) as unknown as RemoteTransportInternals

    expect(new Headers(transport._requestInit?.headers).get('Authorization'))
      .toBe('Bearer http-secret')
    expect(server.headers.Authorization).toBe('Bearer ${KUN_MCP_HTTP_TOKEN}')
  })

  it('uses resolved headers for SSE requests and event stream fetches', async () => {
    vi.stubEnv('KUN_MCP_SSE_TOKEN', 'sse-secret')
    let capturedInit: RequestInit | undefined
    const fetchStub: typeof fetch = async (_input, init) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    }
    vi.stubGlobal('fetch', vi.fn(fetchStub))
    const server = remoteServer('sse', {
      Authorization: 'Bearer ${KUN_MCP_SSE_TOKEN}',
      Accept: 'application/json, text/event-stream'
    })

    const transport = createTransport(server) as unknown as RemoteTransportInternals
    const requestHeaders = new Headers(transport._requestInit?.headers)
    expect(requestHeaders.get('Authorization')).toBe('Bearer sse-secret')

    const eventFetch = transport._eventSourceInit?.fetch
    expect(eventFetch).toBeTypeOf('function')
    await eventFetch?.('https://mcp.example.test/events', {
      headers: { 'Last-Event-ID': '42' }
    })

    const eventHeaders = new Headers(capturedInit?.headers)
    expect(eventHeaders.get('Authorization')).toBe('Bearer sse-secret')
    expect(eventHeaders.get('Accept')).toBe('application/json, text/event-stream')
    expect(eventHeaders.get('Last-Event-ID')).toBe('42')
    expect(server.headers.Authorization).toBe('Bearer ${KUN_MCP_SSE_TOKEN}')
  })

  it.each(['streamable-http', 'sse'] as const)(
    'fails before creating a %s transport when a referenced variable is absent',
    (transport) => {
      vi.stubEnv('KUN_MCP_MISSING_TOKEN', undefined)
      const server = remoteServer(transport, {
        Authorization: 'Bearer ${KUN_MCP_MISSING_TOKEN}'
      })

      expect(() => createTransport(server)).toThrow(
        'MCP header "Authorization" references missing environment variable "KUN_MCP_MISSING_TOKEN"'
      )
    }
  )
})
