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

it('adds common GUI app command paths to stdio MCP environments', () => {
    const env = buildMcpStdioEnvironment({ NODE_ENV: 'test' }, {
      platform: 'darwin',
      baseEnv: {
        PATH: '/usr/bin:/opt/homebrew/bin',
        HOME: '/Users/alice'
      }
    })

    expect(env.NODE_ENV).toBe('test')
    expect(env.PATH?.split(':')).toEqual([
      '/usr/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/local/bin',
      '/Users/alice/.volta/bin',
      '/Users/alice/.local/bin',
      '/Users/alice/.bun/bin'
    ])
  })

it('adds nvm node bin directories to stdio MCP environments on Linux', async () => {
    const home = (await mkdtemp(join(tmpdir(), 'kun-nvm-home-'))).replace(/\\/g, '/')
    const nvmBin = `${home}/.nvm/versions/node/v22.23.0/bin`
    await mkdir(nvmBin, { recursive: true })

    const env = buildMcpStdioEnvironment({}, {
      platform: 'linux',
      baseEnv: {
        PATH: '/usr/bin',
        HOME: home
      }
    })

    expect(env.PATH).toContain(nvmBin)
  })

it('keeps explicitly configured stdio MCP PATH values ahead of common paths', () => {
    const env = buildMcpStdioEnvironment({ Path: 'C:\\Tools' }, {
      platform: 'win32',
      baseEnv: {
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        ProgramFiles: 'C:\\Program Files',
        PATH: 'C:\\Windows\\System32'
      }
    })

    expect(env.Path?.split(';')).toEqual([
      'C:\\Tools',
      'C:\\Users\\alice\\AppData\\Roaming\\npm',
      'C:\\Program Files\\nodejs'
    ])
  })

it('formats missing stdio MCP commands with an actionable PATH hint', () => {
    const server = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          filesystem: {
            transport: 'stdio',
            command: 'npx',
            trustScope: 'user'
          }
        }
      }
    }).mcp.servers.filesystem
    const error = Object.assign(new Error('spawn npx ENOENT'), {
      code: 'ENOENT',
      path: 'npx'
    })

    expect(formatMcpConnectionError(error, server)).toContain('Could not find "npx" on PATH')
  })

it('evaluates workspace trust scopes', () => {
    const server = {
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: [],
      url: undefined,
      headers: {},
      env: {},
      workspaceRoots: [],
      trustScope: 'workspace',
      trustedWorkspaceRoots: ['/tmp/project'],
      timeoutMs: 30_000
    } satisfies McpServerConfig

    expect(isMcpServerTrusted(server, '/tmp/project')).toBe(true)
    expect(isMcpServerTrusted(server, '/tmp/project/sub')).toBe(true)
    expect(isMcpServerTrusted(server, '/tmp/other')).toBe(false)
  })

it('evaluates workspace visibility scopes independently from trust', () => {
    const server = {
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: [],
      url: undefined,
      headers: {},
      env: {},
      workspaceRoots: ['/tmp/project'],
      trustScope: 'user',
      trustedWorkspaceRoots: [],
      timeoutMs: 30_000
    } satisfies McpServerConfig

    expect(isMcpServerTrusted(server, '/tmp/other')).toBe(true)
    expect(isMcpServerVisible(server, '/tmp/project')).toBe(true)
    expect(isMcpServerVisible(server, '/tmp/project/sub')).toBe(true)
    expect(isMcpServerVisible(server, '/tmp/other')).toBe(false)
  })

it('resolves stdio MCP working directories from explicit config or trusted workspace fallback', () => {
    const base = {
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: [],
      url: undefined,
      headers: {},
      env: {},
      workspaceRoots: [],
      trustScope: 'workspace',
      trustedWorkspaceRoots: ['/tmp/project'],
      timeoutMs: 30_000
    } satisfies McpServerConfig

    expect(resolveMcpServerCwd({ ...base, cwd: '/tmp/explicit' })).toBe('/tmp/explicit')
    expect(resolveMcpServerCwd(base)).toBe('/tmp/project')
    expect(resolveMcpServerCwd({ ...base, trustScope: 'user', trustedWorkspaceRoots: [] })).toBeUndefined()
    expect(resolveMcpServerCwd({ ...base, transport: 'streamable-http', url: 'https://mcp.example.test' })).toBeUndefined()
  })

it('builds registry providers from connected MCP clients and executes tools', async () => {
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
      clientFactory: async () => fakeClient()
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    expect(built.connectedServers).toBe(1)
    expect(built.toolCount).toBe(1)
    expect(built.diagnostics[0]).toMatchObject({ id: 'github', status: 'connected', toolCount: 1 })

    const tools = await host.listTools(buildContext('/tmp/project'))
    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp_search',
      'mcp_describe',
      'mcp_read_only_call',
      'mcp_call',
      'mcp_refresh_catalog',
      'mcp_github_search_issues'
    ])
    expect(tools[0]?.providerId).toBe('mcp:search')

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'mcp_call',
      arguments: { toolId: 'mcp_github_search_issues', arguments: { query: 'bug' } }
    }, buildContext('/tmp/project'))
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        serverId: 'github',
        toolName: 'Search Issues'
      })
    }
  })

it('uses BM25 MCP search meta tools when search discovery is enabled', async () => {
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        search: {
          enabled: true,
          mode: 'search',
          topKDefault: 2,
          topKMax: 5
        },
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
          return {
            tools: [
              {
                name: 'search_issues',
                title: 'Search issues',
                description: 'Search GitHub issues and pull requests by query',
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string', description: 'Issue search query' } },
                  required: ['query']
                },
                annotations: { readOnlyHint: true }
              },
              {
                name: 'create_issue',
                description: 'Create a GitHub issue',
                inputSchema: {
                  type: 'object',
                  properties: { title: { type: 'string' }, body: { type: 'string' } },
                  required: ['title']
                }
              }
            ]
          }
        },
        async callTool(input) {
          return { called: input.name, arguments: input.arguments }
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const context = buildContext('/tmp/project')

    expect(built.toolCount).toBe(2)
    expect(built.search).toMatchObject({
      enabled: true,
      mode: 'search',
      active: true,
      indexedToolCount: 2,
      advertisedToolCount: 10
    })
    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual([
      'mcp_search',
      'mcp_describe',
      'mcp_read_only_call',
      'mcp_call',
      'mcp_refresh_catalog'
    ])

    const search = await host.execute({
      callId: 'call_search',
      toolName: 'mcp_search',
      arguments: { query: '查 github issue' }
    }, context)
    expect(search.item.kind).toBe('tool_result')
    if (search.item.kind === 'tool_result') {
      const output = search.item.output as { results: Array<{ toolId: string }> }
      expect(output.results[0]?.toolId).toBe('mcp_github_search_issues')
    }

    const describe = await host.execute({
      callId: 'call_describe',
      toolName: 'mcp_describe',
      arguments: { toolId: 'mcp_github_search_issues' }
    }, context)
    if (describe.item.kind === 'tool_result') {
      expect(describe.item.output).toMatchObject({
        toolId: 'mcp_github_search_issues',
        toolName: 'search_issues'
      })
    }

    const call = await host.execute({
      callId: 'call_tool',
      toolName: 'mcp_call',
      arguments: { toolId: 'mcp_github_search_issues', arguments: { query: 'bug' } }
    }, context)
    if (call.item.kind === 'tool_result') {
      expect(call.item.output).toMatchObject({
        serverId: 'github',
        toolName: 'search_issues',
        result: {
          called: 'search_issues',
          arguments: { query: 'bug' }
        }
      })
    }
  })

it('hides workspace-scoped tools outside trusted roots', async () => {
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
      clientFactory: async () => fakeClient()
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    expect((await host.listTools(buildContext('/tmp/other'))).map((tool) => tool.name)).toEqual([
      'mcp_search',
      'mcp_describe',
      'mcp_read_only_call',
      'mcp_call',
      'mcp_refresh_catalog'
    ])
    const result = await host.execute({
      callId: 'call_1',
      toolName: 'mcp_call',
      arguments: { toolId: 'mcp_github_search_issues', arguments: { query: 'bug' } }
    }, buildContext('/tmp/other'))
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind === 'tool_result') {
      expect(result.item.isError).toBe(true)
      expect(result.item.output).toMatchObject({ error: 'unknown MCP tool: mcp_github_search_issues' })
    }
  })

it('hides workspace-visible tools outside configured visibility roots', async () => {
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          codegraph: {
            transport: 'stdio',
            command: 'node',
            workspaceRoots: ['/tmp/project'],
            trustScope: 'user'
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => fakeClient()
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    expect((await host.listTools(buildContext('/tmp/project'))).map((tool) => tool.name)).toEqual([
      'mcp_search',
      'mcp_describe',
      'mcp_read_only_call',
      'mcp_call',
      'mcp_refresh_catalog',
      'mcp_codegraph_search_issues'
    ])
    const search = await host.execute({
      callId: 'call_search',
      toolName: 'mcp_search',
      arguments: { query: 'issues' }
    }, buildContext('/tmp/project'))
    if (search.item.kind === 'tool_result') {
      expect((search.item.output as { results: Array<{ toolId: string }> }).results[0]?.toolId)
        .toBe('mcp_codegraph_search_issues')
    }
    const other = await host.execute({
      callId: 'call_search_other',
      toolName: 'mcp_search',
      arguments: { query: 'issues' }
    }, buildContext('/tmp/other'))
    if (other.item.kind === 'tool_result') {
      expect((other.item.output as { results: unknown[] }).results).toEqual([])
    }
  })

it('records diagnostics for failed MCP server connections', async () => {
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          broken: {
            transport: 'streamable-http',
            url: 'https://example.invalid/mcp',
            trustScope: 'user'
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => {
        throw new Error('connect failed')
      }
    })

    expect(built.providers.map((provider) => provider.id)).toEqual(['mcp:search', 'mcp:facade'])
    expect(built.connectedServers).toBe(0)
    expect(built.diagnostics[0]).toMatchObject({
      id: 'broken',
      status: 'error',
      lastError: 'connect failed'
    })
  })

it('records actionable diagnostics when stdio MCP commands are missing', async () => {
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          filesystem: {
            transport: 'stdio',
            command: 'npx',
            trustScope: 'user'
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => {
        throw Object.assign(new Error('spawn npx ENOENT'), {
          code: 'ENOENT',
          path: 'npx'
        })
      }
    })

    expect(built.providers.map((provider) => provider.id)).toEqual(['mcp:search', 'mcp:facade'])
    expect(built.diagnostics[0]).toMatchObject({
      id: 'filesystem',
      status: 'error'
    })
    expect(built.diagnostics[0]?.lastError).toContain('Could not find "npx" on PATH')
  })

it('passes MCP timeouts and abort signals to discovery and execution', async () => {
    const listOptions: Array<{ signal?: AbortSignal; timeout?: number } | undefined> = []
    const callOptions: Array<{ signal?: AbortSignal; timeout?: number } | undefined> = []
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project'],
            timeoutMs: 1234
          }
        }
      }
    })
    const client: McpClientLike = {
      async listTools(options) {
        listOptions.push(options)
        return {
          tools: [
            {
              name: 'read',
              inputSchema: { type: 'object' },
              annotations: { readOnlyHint: true }
            }
          ]
        }
      },
      async callTool(_input, options) {
        callOptions.push(options)
        return { ok: true }
      },
      async close() {
        // no-op
      }
    }
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => client
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const controller = new AbortController()
    const context = { ...buildContext('/tmp/project'), abortSignal: controller.signal }

    await host.execute({
      callId: 'call_1',
      toolName: 'mcp_call',
      arguments: { toolId: 'mcp_github_read', arguments: {} }
    }, context)

    expect(listOptions[0]?.timeout).toBe(1234)
    expect(callOptions[0]?.timeout).toBe(1234)
    expect(callOptions[0]?.signal).toBe(controller.signal)
  })

})
