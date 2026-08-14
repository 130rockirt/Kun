import { describe, expect, it, vi } from 'vitest'
import {
  normalizeAppSettings,
  type AppSettingsV1
} from '../../shared/app-settings'
import { revokeManagedRuntimeBrowserUseBinding } from './browser-use-binding-revoke'

function settings(): AppSettingsV1 {
  return normalizeAppSettings({} as AppSettingsV1)
}

const owner = {
  url: 'http://127.0.0.1:23456',
  token: 'b'.repeat(43),
  approvalSigningKey: 's'.repeat(43)
}

describe('revokeManagedRuntimeBrowserUseBinding', () => {
  it('skips network work when the shared Runtime is not live', async () => {
    const fetchMock = vi.fn<typeof fetch>()

    await expect(revokeManagedRuntimeBrowserUseBinding(settings(), owner, {
      fetch: fetchMock,
      runtimeIsLive: () => false
    })).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts only an ephemeral binding revoke to the live shared Runtime', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ))

    await expect(revokeManagedRuntimeBrowserUseBinding(settings(), owner, {
      fetch: fetchMock,
      runtimeIsLive: () => true,
      timeoutMs: 25
    })).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/runtime\/config\/apply$/)
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        browserUseHostBinding: null,
        browserUseHostBindingRevoke: {
          bridgeUrl: owner.url,
          bridgeToken: owner.token,
          approvalSigningKey: owner.approvalSigningKey
        }
      }),
      signal: expect.any(AbortSignal)
    })
  })

  it('bounds best-effort shutdown revocation with a short abort timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }
    ))

    await expect(revokeManagedRuntimeBrowserUseBinding(settings(), owner, {
      fetch: fetchMock,
      runtimeIsLive: () => true,
      timeoutMs: 1
    })).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
