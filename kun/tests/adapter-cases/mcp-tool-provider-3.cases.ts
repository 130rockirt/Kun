import { describe, expect, it } from 'vitest'

import { mkdir, mkdtemp } from 'node:fs/promises'

import { createServer, get as httpGet } from 'node:http'

import type { AddressInfo } from 'node:net'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { CapabilityRegistry } from '../../src/adapters/tool/capability-registry.js'

import { LocalToolHost } from '../../src/adapters/tool/local-tool-host.js'

import {
  FileMcpOAuthProvider,
  buildMcpStdioEnvironment,
  buildMcpToolProviders,
  clearMcpOAuthCredentials,
  createMcpOAuthProvider,
  formatMcpConnectionError,
  isMcpServerTrusted,
  isMcpServerVisible,
  listMcpOAuthDiagnostics,
  McpAuthorizationRequiredError,
  resolveMcpServerCwd,
  type McpClientLike
} from '../../src/adapters/tool/mcp-tool-provider.js'

import { REDACTED_SECRET } from '../../src/config/secret-redaction.js'

import { KunCapabilitiesConfig, type McpServerConfig } from '../../src/contracts/capabilities.js'

import type { ToolHostContext } from '../../src/ports/tool-host.js'

function buildContext(workspace: string): ToolHostContext {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    workspace,
    threadMode: 'agent',
    approvalPolicy: 'auto',
    sandboxMode: 'danger-full-access',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

function fakeClient(): McpClientLike {
  return {
    async listTools() {
      return {
        tools: [
          {
            name: 'Search Issues',
            description: 'Search issue tracker',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query']
            },
            annotations: { readOnlyHint: true }
          }
        ]
      }
    },
    async callTool(input) {
      return {
        content: [{ type: 'text', text: `called ${input.name}` }],
        structuredContent: input.arguments
      }
    },
    async close() {
      // no-op
    }
  }
}

async function getFreePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return address.port
}

async function httpStatus(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.setTimeout(3_000, () => request.destroy(new Error('HTTP request timed out')))
  })
}

describe('MCP tool provider', () => {

it('receives remote MCP OAuth authorization codes on a loopback callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-mcp-oauth-'))
    const redirectPort = await getFreePort()
    const opened: string[] = []
    const server = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          vercel: {
            transport: 'streamable-http',
            url: 'https://mcp.vercel.com',
            trustScope: 'user',
            oauth: {
              redirectPort,
              callbackTimeoutMs: 5_000
            }
          }
        }
      }
    }).mcp.servers.vercel as McpServerConfig
    const provider = new FileMcpOAuthProvider(
      'vercel',
      server,
      join(root, 'vercel.json'),
      async (url) => {
        opened.push(url.toString())
      },
      undefined,
      true
    )

    const oauthState = provider.state()
    await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'))
    expect(provider.redirectUrl.port).toBe(String(redirectPort))
    const code = provider.waitForAuthorizationCode()
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }))
    const callbackUrl = new URL(provider.redirectUrl)
    callbackUrl.searchParams.set('code', 'abc123')
    callbackUrl.searchParams.set('state', oauthState)
    const status = await httpStatus(callbackUrl)

    expect(status).toBe(200)
    await expect(code).resolves.toEqual({ ok: true, value: 'abc123' })
    expect(opened).toEqual(['https://auth.example.test/authorize'])
  }, 10_000)

it('rejects non-http MCP OAuth authorization urls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-mcp-oauth-'))
    const opened: string[] = []
    const server = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          vercel: {
            transport: 'streamable-http',
            url: 'https://mcp.vercel.com',
            trustScope: 'user',
            oauth: {}
          }
        }
      }
    }).mcp.servers.vercel as McpServerConfig
    const provider = new FileMcpOAuthProvider(
      'vercel',
      server,
      join(root, 'vercel.json'),
      async (url) => {
        opened.push(url.toString())
      },
      undefined,
      true
    )

    await expect(provider.redirectToAuthorization(new URL('file:///tmp/token'))).rejects.toThrow(/http or https/)
    expect(opened).toEqual([])
  })

it('keeps remote MCP OAuth callbacks bound to the generated state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-mcp-oauth-'))
    const redirectPort = await getFreePort()
    const server = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          vercel: {
            transport: 'streamable-http',
            url: 'https://mcp.vercel.com',
            trustScope: 'user',
            oauth: {
              redirectPort,
              callbackTimeoutMs: 5_000
            }
          }
        }
      }
    }).mcp.servers.vercel as McpServerConfig
    const provider = new FileMcpOAuthProvider(
      'vercel',
      server,
      join(root, 'vercel.json'),
      async () => undefined,
      undefined,
      true
    )

    const state = provider.state()
    await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'))
    const code = provider.waitForAuthorizationCode()
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }))

    const wrongStateUrl = new URL(provider.redirectUrl)
    wrongStateUrl.searchParams.set('code', 'wrong-code')
    wrongStateUrl.searchParams.set('state', 'wrong-state')
    await expect(httpStatus(wrongStateUrl)).resolves.toBe(400)

    const callbackUrl = new URL(provider.redirectUrl)
    callbackUrl.searchParams.set('code', 'right-code')
    callbackUrl.searchParams.set('state', state)
    await expect(httpStatus(callbackUrl)).resolves.toBe(200)
    await expect(code).resolves.toEqual({ ok: true, value: 'right-code' })
  }, 10_000)

it('closes connected MCP clients during shutdown', async () => {
    let closed = 0
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return { tools: [] }
        },
        async callTool() {
          return { ok: true }
        },
        async close() {
          closed += 1
        }
      })
    })

    await built.close()

    expect(closed).toBe(1)
  })

})
