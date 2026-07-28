import { createElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { formatQuotaValue, ProviderQuotaPanel } from './ProviderQuotaPanel'

describe('ProviderQuotaPanel', () => {
  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads and renders configured providers with available and unsupported states', async () => {
    const listProviderQuotas = vi.fn(async () => ({
      refreshedAt: '2027-01-15T08:00:00.000Z',
      entries: [{
        providerId: 'deepseek-work',
        providerName: 'DeepSeek Work',
        status: 'available' as const,
        source: 'DeepSeek balance API',
        metrics: [{
          id: 'balance',
          label: 'Account balance',
          unit: 'CNY',
          remaining: 12.5
        }],
        updatedAt: '2027-01-15T08:00:00.000Z'
      }, {
        providerId: 'custom',
        providerName: 'Custom provider',
        status: 'unsupported' as const,
        metrics: [],
        message: 'This provider does not expose a supported quota API in this version.'
      }]
    }))
    vi.stubGlobal('window', {
      kunGui: {
        listProviderQuotas,
        openExternal: vi.fn()
      }
    })

    let renderer!: ReturnType<typeof createRenderer>
    await act(async () => {
      renderer = createRenderer(createElement(ProviderQuotaPanel))
    })

    expect(listProviderQuotas).toHaveBeenCalledTimes(1)
    expect(renderer.root.findAllByProps({ 'data-provider-quota-status': 'available' })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ 'data-provider-quota-status': 'unsupported' })).toHaveLength(1)
    expect(renderer.root.findByProps({ 'aria-label': 'Refresh' })).toBeTruthy()
    expect(JSON.stringify(renderer.toJSON())).toContain('12.5 CNY')
    act(() => renderer.unmount())
  })

  it('formats large quotas compactly while preserving their unit', () => {
    expect(formatQuotaValue(250_000, 'tokens', 'en')).toBe('250K tokens')
  })
})
