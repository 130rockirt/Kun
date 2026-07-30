import { describe, expect, it, vi } from 'vitest'
import { buildRouter } from './index.js'
import type { ServerRuntime } from './server-runtime.js'

describe('provider quota route', () => {
  it('requires runtime authentication and returns the shared quota snapshot', async () => {
    const list = vi.fn(async () => ({
      entries: [{
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        status: 'available' as const,
        source: 'DeepSeek balance API',
        metrics: [{
          id: 'balance',
          label: 'Account balance',
          unit: 'CNY',
          remaining: 40.76
        }]
      }],
      refreshedAt: '2026-07-28T01:31:00.000Z'
    }))
    const router = buildRouter({
      runtimeToken: 'quota-token',
      insecure: false,
      providerQuotaService: { list }
    } as unknown as ServerRuntime)

    expect((await dispatch(router)).status).toBe(401)
    const response = await dispatch(router, { authorization: 'Bearer quota-token' })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      entries: [{ providerId: 'deepseek', status: 'available' }]
    })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable runtime service without exposing configuration', async () => {
    const router = buildRouter({
      runtimeToken: 'quota-token',
      insecure: false
    } as unknown as ServerRuntime)
    const response = await dispatch(router, { authorization: 'Bearer quota-token' })
    expect(response.status).toBe(503)
    expect(response.body).not.toContain('quota-token')
  })
})

async function dispatch(
  router: ReturnType<typeof buildRouter>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  const request = new Request('http://127.0.0.1/v1/provider-quotas', { headers })
  const match = router.match('GET', new URL(request.url).pathname)
  if (!match) throw new Error('provider quota route not found')
  const result = await match.handler(request, { params: match.params })
  return result instanceof Response
    ? { status: result.status, body: await result.text() }
    : { status: result.status, body: result.body }
}
