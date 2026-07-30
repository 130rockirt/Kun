import { describe, expect, it, vi } from 'vitest'
import {
  KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV,
  KUN_BROWSER_USE_BRIDGE_TOKEN_ENV,
  KUN_BROWSER_USE_BRIDGE_URL_ENV
} from '../../contracts/browser-use.js'
import { HostBridgeBrowserController } from './browser-controller.js'

const token = 'a'.repeat(43)
const approvalSigningKey = 's'.repeat(43)
const approvalGrant = {
  id: `appr_${'a'.repeat(32)}`,
  source: 'agent' as const,
  toolName: 'browser_use' as const,
  callId: 'call-open',
  argumentsHash: 'b'.repeat(64),
  issuedAt: '2026-07-30T00:00:00.000Z',
  expiresAt: '2026-07-30T00:02:00.000Z'
}

describe('HostBridgeBrowserController', () => {
  it('is interaction-required without a strict loopback launch authority', () => {
    expect(new HostBridgeBrowserController().readiness()).toMatchObject({
      available: false,
      interactionRequired: true
    })
    expect(new HostBridgeBrowserController({
      bridgeUrl: 'http://localhost:1234',
      bridgeToken: token,
      approvalSigningKey
    }).readiness().available).toBe(false)
    expect(new HostBridgeBrowserController({
      bridgeUrl: 'http://127.0.0.1:1234',
      bridgeToken: 'short',
      approvalSigningKey
    }).readiness().available).toBe(false)
  })

  it('sends one bounded typed action and validates the correlated response', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requestId: string }
      return new Response(JSON.stringify({
        contractVersion: 2,
        requestId: body.requestId,
        result: {
          ok: true,
          code: 'snapshot',
          message: 'bounded'
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const controller = new HostBridgeBrowserController({
      bridgeUrl: 'http://127.0.0.1:1234',
      bridgeToken: token,
      approvalSigningKey,
      fetch: fetchMock as typeof fetch
    })
    await expect(controller.execute({
      threadId: 'thread-1',
      turnId: 'turn-1',
      action: { action: 'snapshot' },
      signal: new AbortController().signal
    })).resolves.toMatchObject({ ok: true, code: 'snapshot' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:1234/v1/actions')
    expect(init!.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    })
    expect(JSON.parse(String(init!.body))).toMatchObject({
      contractVersion: 2,
      threadId: 'thread-1',
      turnId: 'turn-1',
      action: { action: 'snapshot' }
    })
  })

  it('carries the one-call Kun grant only for an already reviewed boundary action', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requestId: string }
      return new Response(JSON.stringify({
        contractVersion: 2,
        requestId: body.requestId,
        result: {
          ok: true,
          code: 'opened',
          message: 'opened'
        }
      }), { status: 200 })
    })
    const controller = new HostBridgeBrowserController({
      bridgeUrl: 'http://127.0.0.1:1234',
      bridgeToken: token,
      approvalSigningKey,
      fetch: fetchMock as typeof fetch
    })

    await controller.execute({
      threadId: 'thread-1',
      turnId: 'turn-1',
      action: { action: 'open', url: 'https://example.test/' },
      kunApprovalMode: 'agent',
      kunApprovalGrant: approvalGrant,
      signal: new AbortController().signal
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      action: { action: 'open', url: 'https://example.test/' },
      kunApprovalMode: 'agent',
      kunApprovalGrant: {
        ...approvalGrant,
        threadId: 'thread-1',
        turnId: 'turn-1',
        signature: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
  })

  it('rejects mismatched response authority', async () => {
    const controller = new HostBridgeBrowserController({
      bridgeUrl: 'http://127.0.0.1:1234',
      bridgeToken: token,
      approvalSigningKey,
      fetch: async () => new Response(JSON.stringify({
        contractVersion: 2,
        requestId: '00000000-0000-4000-8000-000000000000',
        result: { ok: true, code: 'snapshot', message: 'wrong request' }
      }), { status: 200 })
    })
    await expect(controller.execute({
      threadId: 'thread-1',
      turnId: 'turn-1',
      action: { action: 'snapshot' },
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'browser_host_invalid_response' })
  })

  it('captures bridge authority once, scrubs process.env, and reuses it after a hot rebuild', () => {
    process.env[KUN_BROWSER_USE_BRIDGE_URL_ENV] = 'http://127.0.0.1:4321'
    process.env[KUN_BROWSER_USE_BRIDGE_TOKEN_ENV] = 't'.repeat(43)
    process.env[KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV] = 'k'.repeat(43)

    const first = new HostBridgeBrowserController()
    expect(first.readiness()).toEqual({ available: true })
    expect(process.env[KUN_BROWSER_USE_BRIDGE_URL_ENV]).toBeUndefined()
    expect(process.env[KUN_BROWSER_USE_BRIDGE_TOKEN_ENV]).toBeUndefined()
    expect(process.env[KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV]).toBeUndefined()

    const rebuilt = new HostBridgeBrowserController()
    expect(rebuilt.readiness()).toEqual({ available: true })
  })
})
