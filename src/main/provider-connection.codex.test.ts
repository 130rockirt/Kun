import { describe, expect, it, vi } from 'vitest'
import { probeModelProvider } from './provider-connection'

vi.mock('electron', () => ({ session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } }))
const request = {
  providerId: 'codex', useProxy: false,
  baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
  endpointFormat: 'custom_endpoint' as const,
  apiKey: JSON.stringify({ kind: 'codex-oauth', accessToken: 'access', refreshToken: 'refresh',
    accountId: 'account', expiresAt: Date.now() + 3600000 })
}

describe('Codex discovery failures', () => {
  it.each([401, 403, 500])('reports HTTP %s instead of a successful static list', async (status) => {
    const result = await probeModelProvider(request, undefined,
      async () => new Response('unavailable', { status }))
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(String(status)) })
  })
  it('handles full response endpoints and malformed model responses', async () => {
    const fetcher = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('{}'))
    expect(await probeModelProvider(request, undefined, fetcher)).toMatchObject({ ok: false })
    expect(fetcher.mock.calls[0][0]).toMatch(/\/codex\/models\?client_version=/)
  })
  it('reports transport failures and rejects expired credentials before fetching', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline') })
    expect(await probeModelProvider(request, undefined, fetcher)).toMatchObject({
      ok: false, message: expect.stringContaining('offline')
    })
    fetcher.mockClear()
    const expired = { ...request, apiKey: JSON.stringify({ ...JSON.parse(request.apiKey), expiresAt: 1 }) }
    expect(await probeModelProvider(expired, undefined, fetcher)).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
