import { describe, expect, it, vi } from 'vitest'
import { HostBridgeBrowserController } from './browser-controller.js'

const token = 'a'.repeat(43)

describe('HostBridgeBrowserController', () => {
  it('is interaction-required without a strict loopback launch authority', () => {
    expect(new HostBridgeBrowserController().readiness()).toMatchObject({
      available: false,
      interactionRequired: true
    })
    expect(new HostBridgeBrowserController({
      bridgeUrl: 'http://localhost:1234',
      bridgeToken: token
    }).readiness().available).toBe(false)
    expect(new HostBridgeBrowserController({
      bridgeUrl: 'http://127.0.0.1:1234',
      bridgeToken: 'short'
    }).readiness().available).toBe(false)
  })

  it('sends one bounded typed action and validates the correlated response', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requestId: string }
      return new Response(JSON.stringify({
        contractVersion: 1,
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
      contractVersion: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      action: { action: 'snapshot' }
    })
  })

  it('rejects mismatched response authority', async () => {
    const controller = new HostBridgeBrowserController({
      bridgeUrl: 'http://127.0.0.1:1234',
      bridgeToken: token,
      fetch: async () => new Response(JSON.stringify({
        contractVersion: 1,
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
})
