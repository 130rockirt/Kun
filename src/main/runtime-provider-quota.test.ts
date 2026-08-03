import { describe, expect, it, vi } from 'vitest'
import { requestRuntimeProviderQuotas } from './runtime-provider-quota'

describe('requestRuntimeProviderQuotas', () => {
  it('uses the canonical Kun quota endpoint and validates its response', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        entries: [{
          providerId: 'grok-subscription',
          providerName: 'Grok',
          status: 'available',
          metrics: [{ id: 'credits', label: 'Credits usage', unit: 'percent', usedPercent: 12 }]
        }],
        refreshedAt: '2026-08-03T08:00:00.000Z'
      })
    }))

    await expect(requestRuntimeProviderQuotas(runtimeRequest)).resolves.toMatchObject({
      entries: [{ providerId: 'grok-subscription', status: 'available' }]
    })
    expect(runtimeRequest).toHaveBeenCalledWith('/v1/provider-quotas', 'GET')
  })

  it('does not expose an arbitrary runtime error body', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: false,
      status: 500,
      body: 'not-json secret upstream response'
    }))

    await expect(requestRuntimeProviderQuotas(runtimeRequest)).rejects.toThrow(
      'Kun returned malformed provider quota data.'
    )
  })
})
