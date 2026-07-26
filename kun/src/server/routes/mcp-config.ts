import { z } from 'zod'
import { McpServerConfig } from '../../contracts/capabilities.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import type { ServerRuntime } from './server-runtime.js'
import { ERRORS } from './runtime-error.js'

const ServerId = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u)
const EnabledRequest = z.object({ enabled: z.boolean() }).strict()

export async function listMcpConfig(runtime: ServerRuntime): Promise<JsonResponse> {
  if (!runtime.mcpConfig) return ERRORS.unavailable('MCP configuration management is unavailable')
  const mcp = runtime.mcpConfig()
  return jsonResponse({
    enabled: mcp.enabled,
    servers: Object.entries(mcp.servers).map(([id, server]) => ({
      id,
      enabled: server.enabled,
      transport: server.transport,
      target: safeTarget(server),
      trustScope: server.trustScope,
      oauth: Boolean(server.oauth),
      timeoutMs: server.timeoutMs
    }))
  })
}

export async function putMcpConfig(
  runtime: ServerRuntime,
  serverId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.setMcpServer) return ERRORS.unavailable('MCP configuration management is unavailable')
  const id = ServerId.safeParse(serverId)
  if (!id.success) return ERRORS.validation('invalid MCP server id', id.error.issues)
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = McpServerConfig.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid MCP server configuration', parsed.error.issues)
  const result = await runtime.setMcpServer(id.data, parsed.data)
  if (!result.ok) return ERRORS.conflict(result.message)
  return listMcpConfig(runtime)
}

export async function deleteMcpConfig(
  runtime: ServerRuntime,
  serverId: string
): Promise<JsonResponse> {
  if (!runtime.setMcpServer) return ERRORS.unavailable('MCP configuration management is unavailable')
  const id = ServerId.safeParse(serverId)
  if (!id.success) return ERRORS.validation('invalid MCP server id', id.error.issues)
  const result = await runtime.setMcpServer(id.data, null)
  if (!result.ok) return ERRORS.conflict(result.message)
  return listMcpConfig(runtime)
}

export async function patchMcpConfig(
  runtime: ServerRuntime,
  serverId: string,
  request: Request
): Promise<JsonResponse | Response> {
  if (!runtime.mcpConfig || !runtime.setMcpServer) {
    return ERRORS.unavailable('MCP configuration management is unavailable')
  }
  const id = ServerId.safeParse(serverId)
  if (!id.success) return ERRORS.validation('invalid MCP server id', id.error.issues)
  const current = runtime.mcpConfig().servers[id.data]
  if (!current) return ERRORS.notFound(`MCP server not found: ${id.data}`)
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = EnabledRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid MCP server update', parsed.error.issues)
  const result = await runtime.setMcpServer(id.data, { ...current, enabled: parsed.data.enabled })
  if (!result.ok) return ERRORS.conflict(result.message)
  return listMcpConfig(runtime)
}

function safeTarget(server: z.infer<typeof McpServerConfig>): string {
  if (server.transport === 'stdio') return server.command ?? '(missing command)'
  try {
    const url = new URL(server.url ?? '')
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '(invalid URL)'
  }
}
