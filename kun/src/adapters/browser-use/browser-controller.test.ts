import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV,
  KUN_BROWSER_USE_BRIDGE_TOKEN_ENV,
  KUN_BROWSER_USE_BRIDGE_URL_ENV,
  signBrowserUseBridgeResponse,
  signBrowserUseHostChallenge
} from '../../contracts/browser-use.js'
import { decryptBrowserUseActionEnvelope } from '../../contracts/browser-use-bridge-crypto.js'
import { HostBridgeBrowserController } from './browser-controller.js'
import {
  replaceBrowserUseHostAuthority,
  resetBrowserUseHostAuthorityForTests
} from './browser-controller-authority.js'

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

function authenticatedBridgeFetch(options: {
  authorityKeyForUrl?: (url: string) => string
  responseSigningKey?: string
  result?: { ok: boolean; code: string; message: string }
} = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as { nonce?: string }
    const authorityKey = options.authorityKeyForUrl?.(url) ?? approvalSigningKey
    if (url.endsWith('/v1/challenge')) {
      return new Response(JSON.stringify(signBrowserUseHostChallenge({
        contractVersion: 2,
        nonce: body.nonce ?? ''
      }, authorityKey)), { status: 200 })
    }
    const decrypted = decryptBrowserUseActionEnvelope(body, authorityKey)
    const request = decrypted.request as { requestId?: string }
    return new Response(JSON.stringify(signBrowserUseBridgeResponse({
      contractVersion: 2,
      requestId: request.requestId ?? '',
      result: options.result ?? {
        ok: true,
        code: 'snapshot',
        message: 'bounded'
      }
    }, options.responseSigningKey ?? authorityKey)), { status: 200 })
  })
}

describe('HostBridgeBrowserController', () => {
  afterEach(() => {
    delete process.env[KUN_BROWSER_USE_BRIDGE_URL_ENV]
    delete process.env[KUN_BROWSER_USE_BRIDGE_TOKEN_ENV]
    delete process.env[KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV]
    resetBrowserUseHostAuthorityForTests()
  })

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
    const fetchMock = authenticatedBridgeFetch()
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

    const [challengeUrl, challengeInit] = fetchMock.mock.calls[0]!
    expect(challengeUrl).toBe('http://127.0.0.1:1234/v1/challenge')
    expect(challengeInit!.headers).not.toHaveProperty('authorization')
    expect(JSON.parse(String(challengeInit!.body))).toEqual({
      contractVersion: 2,
      nonce: expect.any(String)
    })

    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe('http://127.0.0.1:1234/v1/actions')
    expect(init!.headers).not.toHaveProperty('authorization')
    expect(init!.headers).toMatchObject({ 'content-type': 'application/json' })
    const wireAction = JSON.stringify(init!.body)
    expect(wireAction).not.toContain(token)
    expect(wireAction).not.toContain('thread-1')
    expect(wireAction).not.toContain('snapshot')
    expect(wireAction).not.toContain('"action"')
  })

  it('carries the one-call Kun grant only for an already reviewed boundary action', async () => {
    const fetchMock = authenticatedBridgeFetch({
      result: { ok: true, code: 'opened', message: 'opened' }
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

    const encrypted = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))
    const decrypted = decryptBrowserUseActionEnvelope(encrypted, approvalSigningKey)
    expect(decrypted.request).toMatchObject({
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
    const fetchMock = authenticatedBridgeFetch()
    fetchMock.mockImplementationOnce(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { nonce: string }
      return new Response(JSON.stringify(signBrowserUseHostChallenge({
        contractVersion: 2,
        nonce: body.nonce
      }, approvalSigningKey)), { status: 200 })
    }).mockImplementationOnce(async () => new Response(JSON.stringify({
      contractVersion: 2,
      requestId: '00000000-0000-4000-8000-000000000000',
      result: { ok: true, code: 'snapshot', message: 'wrong request' },
      responseMac: 'f'.repeat(64)
    }), { status: 200 }))
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
    })).rejects.toMatchObject({ code: 'browser_host_invalid_response' })
  })

  it('rejects an action response signed by a previous host authority', async () => {
    const fetchMock = authenticatedBridgeFetch({
      responseSigningKey: 'o'.repeat(43)
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
    })).rejects.toMatchObject({ code: 'browser_host_invalid_response' })
  })

  it('does not disclose bearer or action data to a reclaimed-port challenge impostor', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => new Response(JSON.stringify({
      contractVersion: 2,
      nonce: '00000000-0000-4000-8000-000000000000',
      proof: 'f'.repeat(64)
    }), { status: 200 }))
    const controller = new HostBridgeBrowserController({
      bridgeUrl: 'http://127.0.0.1:1234',
      bridgeToken: token,
      approvalSigningKey,
      fetch: fetchMock as typeof fetch
    })

    await expect(controller.execute({
      threadId: 'thread-secret',
      turnId: 'turn-secret',
      action: { action: 'open', url: 'https://sensitive.example/path' },
      kunApprovalMode: 'agent',
      kunApprovalGrant: approvalGrant,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'browser_host_identity_unverified' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:1234/v1/challenge')
    expect(JSON.stringify(init)).not.toContain(token)
    expect(JSON.stringify(init)).not.toContain('sensitive.example')
    expect(JSON.stringify(init)).not.toContain('thread-secret')
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

  it('rebinds existing controllers in memory and revokes the previous launch', async () => {
    const fetchMock = authenticatedBridgeFetch({
      authorityKeyForUrl: (url) => url.includes(':9876') ? 'p'.repeat(43) : 'k'.repeat(43)
    })
    const controller = new HostBridgeBrowserController({ fetch: fetchMock as typeof fetch })

    replaceBrowserUseHostAuthority({
      bridgeUrl: 'http://127.0.0.1:4321',
      bridgeToken: 't'.repeat(43),
      approvalSigningKey: 'k'.repeat(43)
    })
    expect(controller.readiness()).toEqual({ available: true })
    await controller.execute({
      threadId: 'thread-1',
      turnId: 'turn-1',
      action: { action: 'snapshot' },
      signal: new AbortController().signal
    })

    replaceBrowserUseHostAuthority({
      bridgeUrl: 'http://127.0.0.1:9876',
      bridgeToken: 'n'.repeat(43),
      approvalSigningKey: 'p'.repeat(43)
    })
    await controller.execute({
      threadId: 'thread-1',
      turnId: 'turn-2',
      action: { action: 'snapshot' },
      signal: new AbortController().signal
    })
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:4321/v1/challenge',
      'http://127.0.0.1:4321/v1/actions',
      'http://127.0.0.1:9876/v1/challenge',
      'http://127.0.0.1:9876/v1/actions'
    ])

    replaceBrowserUseHostAuthority(undefined)
    expect(controller.readiness()).toMatchObject({
      available: false,
      interactionRequired: true
    })
  })

  it('aborts an active request when its launch authority is revoked', async () => {
    replaceBrowserUseHostAuthority({
      bridgeUrl: 'http://127.0.0.1:4321',
      bridgeToken: 't'.repeat(43),
      approvalSigningKey: 'k'.repeat(43)
    })
    const controller = new HostBridgeBrowserController({
      fetch: vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })) as typeof fetch
    })
    const executing = controller.execute({
      threadId: 'thread-1',
      turnId: 'turn-1',
      action: { action: 'snapshot' },
      signal: new AbortController().signal
    })
    await Promise.resolve()
    replaceBrowserUseHostAuthority(undefined)

    await expect(executing).rejects.toMatchObject({
      code: 'browser_host_authority_revoked'
    })
  })

  it('fails an already-aborted input before disclosing the challenge or bearer', async () => {
    const abort = new AbortController()
    abort.abort(new Error('turn cancelled'))
    const fetchMock = authenticatedBridgeFetch()
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
      signal: abort.signal
    })).rejects.toMatchObject({ code: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
