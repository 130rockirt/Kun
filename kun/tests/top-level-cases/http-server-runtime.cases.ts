import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dispatchRequest } from '../../src/server/http-server.js'
import { createApprovalRequest } from '../../src/domain/approval.js'
import { makeAssistantTextItem, makeToolCallItem, makeToolResultItem } from '../../src/domain/item.js'
import { encodeSseEvent } from '../../src/server/sse.js'
import { buildHarness, readJson, readSseEvents, usageSnapshot } from '../http-server-test-harness.js'
import type { TurnItem } from '../../src/contracts/items.js'
import {
  createApprovalConsentToken,
  KUN_APPROVAL_CONSENT_HEADER
} from '../../src/server/approval-consent.js'

describe('HTTP server', () => {
  let dataDir = ''
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kun-http-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  const approvalConsent = (approvalId: string, decision: 'allow' | 'deny') =>
    createApprovalConsentToken({
      runtimeToken: 'tok-1',
      approvalId,
      decision,
      expiresAt: Date.now() + 30_000
    })

  it('returns 200 on /health without auth', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(h.router, new Request('http://localhost/health'))
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body).toEqual({ status: 'ok', service: 'kun', mode: 'serve' })
  })

  it('returns runtime info with accurate CLI and disabled provider capability defaults', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/info', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = await readJson(response) as {
      model?: string
      capabilities?: {
        contractVersion?: number
        mcp?: { available?: boolean; reason?: string }
        web?: { available?: boolean; fetch?: { available?: boolean } }
        attachments?: { available?: boolean; allowedMimeTypes?: string[] }
        cli?: {
          serve?: { available?: boolean }
          run?: { available?: boolean; reason?: string }
          chat?: { available?: boolean; reason?: string }
          exec?: { available?: boolean; reason?: string }
        }
        model?: { inputModalities?: string[]; supportsToolCalling?: boolean; contextWindowTokens?: number }
      }
    }
    expect(body.model).toBe('deepseek-chat')
    expect(body.capabilities?.contractVersion).toBe(1)
    expect(body.capabilities?.model?.inputModalities).toContain('text')
    expect(body.capabilities?.model?.supportsToolCalling).toBe(true)
    expect(body.capabilities?.model?.contextWindowTokens).toBe(1_000_000)
    expect(body.capabilities?.mcp?.available).toBe(false)
    expect(body.capabilities?.mcp?.reason).toMatch(/disabled/)
    expect(body.capabilities?.web?.fetch?.available).toBe(false)
    expect(body.capabilities?.attachments?.allowedMimeTypes).toContain('image/png')
    expect(body.capabilities?.cli?.serve?.available).toBe(true)
    expect(body.capabilities?.cli?.run?.available).toBe(true)
    expect(body.capabilities?.cli?.chat?.available).toBe(true)
    expect(body.capabilities?.cli?.exec?.available).toBe(true)
  })

  it('requires auth for runtime info', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/info')
    )

    expect(response.status).toBe(401)
  })

  it('applies runtime config through the authenticated hot apply route', async () => {
    const h = buildHarness()
    const applyConfig = vi.fn(async () => ({ ok: true as const }))
    h.runtime.applyConfig = applyConfig
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/config/apply', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          serve: {
            model: 'deepseek-reasoner',
            approvalPolicy: 'never',
            providers: {
              minimax: {
                apiKey: 'sk-minimax',
                baseUrl: 'https://api.minimax.example/v1'
              }
            }
          }
        })
      })
    )

    expect(response.status).toBe(200)
    expect(await readJson(response)).toEqual({ ok: true })
    expect(applyConfig).toHaveBeenCalledWith(expect.objectContaining({
      serve: expect.objectContaining({
        model: 'deepseek-reasoner',
        approvalPolicy: 'never',
        providers: expect.objectContaining({
          minimax: expect.objectContaining({
            apiKey: 'sk-minimax',
            baseUrl: 'https://api.minimax.example/v1'
          })
        })
      })
    }))
  })

  it('requires auth for runtime config hot apply', async () => {
    const h = buildHarness()
    h.runtime.applyConfig = vi.fn(async () => ({ ok: true as const }))
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/config/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serve: { model: 'deepseek-reasoner' } })
      })
    )

    expect(response.status).toBe(401)
    expect(h.runtime.applyConfig).not.toHaveBeenCalled()
  })

  it('rejects process-level runtime fields on the hot apply route', async () => {
    const h = buildHarness()
    h.runtime.applyConfig = vi.fn(async () => ({ ok: true as const }))
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/config/apply', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ serve: { port: 18899 } })
      })
    )

    expect(response.status).toBe(400)
    const body = await readJson(response) as { ok?: boolean; code?: string }
    expect(body).toMatchObject({ ok: false, code: 'invalid_config' })
    expect(h.runtime.applyConfig).not.toHaveBeenCalled()
  })

  it('returns structured validation errors for invalid JSON bodies', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json'
        },
        body: '{'
      })
    )

    expect(response.status).toBe(400)
    expect(await readJson(response)).toMatchObject({
      code: 'validation_error',
      message: 'invalid JSON body'
    })
  })

  it('returns runtime tool diagnostics', async () => {
    const h = buildHarness()
    h.runtime.toolDiagnostics = () => ({
      providers: [
        {
          id: 'mcp:github',
          kind: 'mcp',
          enabled: true,
          available: false,
          reason: 'token=provider-secret'
        }
      ],
      mcpServers: [
        {
          id: 'github',
          enabled: true,
          transport: 'stdio',
          trustScope: 'user',
          available: false,
          status: 'error',
          toolCount: 0,
          lastError: 'Authorization: Bearer server-secret'
        }
      ],
      webProviders: [],
      skills: {
        enabled: false,
        roots: [],
        globalRoots: [],
        skills: [],
        validationErrors: [],
        lastActivations: []
      },
      attachments: {
        enabled: false,
        rootDir: '',
        count: 0,
        totalBytes: 0
      },
      memory: {
        enabled: false,
        rootDir: '',
        activeCount: 0,
        tombstoneCount: 0,
        lastInjectedIds: []
      }
    })
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/tools', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = await readJson(response) as {
      providers: Array<{ id: string; reason?: string }>
      mcpServers: Array<{ id: string; lastError?: string }>
      webProviders: unknown[]
      skills: unknown
      attachments: unknown
      memory: unknown
    }
    expect(body.providers[0]).toMatchObject({ id: 'mcp:github', reason: 'token=<redacted>' })
    expect(body.mcpServers[0]).toMatchObject({
      id: 'github',
      lastError: 'Authorization=<redacted>'
    })
    expect(JSON.stringify(body)).not.toContain('provider-secret')
    expect(JSON.stringify(body)).not.toContain('server-secret')
  })

  it('requires auth for runtime tool diagnostics', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/tools')
    )

    expect(response.status).toBe(401)
  })

  it('reports and clears MCP OAuth diagnostics through the HTTP layer', async () => {
    const h = buildHarness()
    h.runtime.mcpOAuth = () => [
      {
        serverId: 'google_drive',
        enabled: true,
        configured: true,
        transport: 'streamable-http',
        url: 'https://drivemcp.googleapis.com/mcp/v1',
        status: 'authorized',
        hasClientInformation: true,
        hasTokens: true,
        hasRefreshToken: true,
        hasCodeVerifier: false,
        hasDiscoveryState: true
      }
    ]
    h.runtime.clearMcpOAuth = async (serverId?: string) => ({ cleared: serverId ? [serverId] : ['google_drive'] })

    const listed = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/mcp/oauth', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(listed.status).toBe(200)
    await expect(readJson(listed)).resolves.toMatchObject({
      servers: [{ serverId: 'google_drive', status: 'authorized', hasTokens: true }]
    })

    const cleared = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/mcp/oauth/google_drive', {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(cleared.status).toBe(200)
    await expect(readJson(cleared)).resolves.toEqual({ cleared: ['google_drive'] })
  })

  it('runs MCP OAuth authorization through the HTTP layer', async () => {
    const h = buildHarness()
    const authorized: string[] = []
    h.runtime.authorizeMcpOAuth = async (serverId: string) => {
      authorized.push(serverId)
      return { serverId, status: 'authorized', authorized: true }
    }

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/mcp/oauth/google_drive', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    await expect(readJson(response)).resolves.toEqual({
      serverId: 'google_drive',
      status: 'authorized',
      authorized: true
    })
    expect(authorized).toEqual(['google_drive'])
  })

  it('reports MCP OAuth authorization as unavailable when the runtime lacks it', async () => {
    const h = buildHarness()
    h.runtime.authorizeMcpOAuth = undefined

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/mcp/oauth/google_drive', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(503)
  })

  it('lists discovered skills through the HTTP layer', async () => {
    const h = buildHarness()
    h.runtime.skills = () => ({
      enabled: true,
      roots: ['/tmp/skills'],
      globalRoots: [],
      skills: [
        {
          id: 'review',
          name: 'Review',
          description: 'Review the current change',
          version: '1.0.0',
          root: '/tmp/skills/review',
          source: 'project' as const,
          legacy: false,
          triggers: { commands: ['/review'], promptPatterns: [], fileTypes: [] },
          allowedTools: ['read']
        }
      ],
      validationErrors: [],
      lastActivations: []
    })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/skills', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = await readJson(response) as { skills: Array<{ id: string; description?: string }> }
    expect(body.skills[0]).toMatchObject({
      id: 'review',
      description: 'Review the current change'
    })
  })
})
