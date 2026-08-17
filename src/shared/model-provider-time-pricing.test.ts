import { describe, expect, it } from 'vitest'
import type { ModelProviderProfileV1 } from './app-settings-types'
import { modelTimePricingState, resolveModelTimePricingRule, timePricingBenefitLabel } from './model-provider-time-pricing'

function provider(overrides: Partial<ModelProviderProfileV1>): ModelProviderProfileV1 {
  return {
    id: 'custom',
    name: 'Custom',
    apiKey: '',
    baseUrl: '',
    endpointFormat: 'chat_completions',
    models: [],
    modelProfiles: {},
    ...overrides
  }
}

describe('model provider time pricing', () => {
  it('requires the official DeepSeek identity, endpoint, and model', () => {
    const official = provider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-v4-pro'] })
    expect(resolveModelTimePricingRule(official, 'deepseek-v4-pro')?.benefitKind).toBe('unit-price-discount')
    expect(resolveModelTimePricingRule({ ...official, baseUrl: 'https://proxy.example' }, 'deepseek-v4-pro')).toBeUndefined()
    expect(resolveModelTimePricingRule({ ...official, id: 'custom' }, 'deepseek-v4-pro')).toBeUndefined()
    expect(resolveModelTimePricingRule(official, 'fixed-price-model')).toBeUndefined()
  })

  it('classifies DeepSeek peak windows in UTC', () => {
    const official = provider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com' })
    expect(modelTimePricingState(official, 'deepseek-v4-flash', '2030-01-01T02:00:00Z').state).toBe('standard')
    expect(modelTimePricingState(official, 'deepseek-v4-flash', '2030-01-01T05:00:00Z').state).toBe('off-peak')
  })

  it('keeps Coding Plan quota semantics separate from API prices', () => {
    const zhipu = provider({
      id: 'zhipu-account-2',
      presetSource: { presetId: 'zhipu-coding-plan', mode: 'api' }
    })
    const peakMonday = '2030-01-07T07:00:00Z'
    expect(modelTimePricingState(zhipu, 'glm-5.3', peakMonday).state).toBe('standard')
    expect(modelTimePricingState(zhipu, 'glm-5.3', '2030-01-06T07:00:00Z').state).toBe('off-peak')
    expect(timePricingBenefitLabel('quota-multiplier')).toContain('quota')
    expect(timePricingBenefitLabel('unit-price-discount')).toContain('price')
  })
})
