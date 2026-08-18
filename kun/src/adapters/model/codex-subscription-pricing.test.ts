import { describe, expect, it } from 'vitest'
import { estimateCodexSubscriptionValue, USD_TO_CNY_REFERENCE_RATE } from './codex-subscription-pricing.js'

describe('estimateCodexSubscriptionValue', () => {
  it('prices uncached input, cache reads, and output without double-counting reasoning', () => {
    const value = estimateCodexSubscriptionValue({
      model: ' gpt-5.6-sol ',
      promptTokens: 1_000_000,
      cacheHitTokens: 200_000,
      cacheWriteTokens: 100_000,
      completionTokens: 100_000
    })
    expect(value?.valueEstimateUsd).toBeCloseTo(6.6)
    expect(value?.valueEstimateCny).toBeCloseTo(6.6 * USD_TO_CNY_REFERENCE_RATE)
  })

  it('normalizes provider-qualified model ids without fuzzy matching', () => {
    const value = estimateCodexSubscriptionValue({
      model: 'openai/gpt-5.6-luna (current)',
      promptTokens: 1_000_000,
      completionTokens: 0
    })
    expect(value?.valueEstimateUsd).toBeCloseTo(1)
    expect(estimateCodexSubscriptionValue({
      model: 'openai/gpt-5.6-luna-preview', promptTokens: 1, completionTokens: 1
    })).toBeNull()
    expect(estimateCodexSubscriptionValue({
      model: 'custom/gpt-5.6-luna', promptTokens: 1, completionTokens: 1
    })).toBeNull()
    expect(estimateCodexSubscriptionValue({
      model: 'custom:gpt-5.6-luna', promptTokens: 1, completionTokens: 1
    })).toBeNull()
  })

  it('does not invent a price for an unknown model', () => {
    expect(estimateCodexSubscriptionValue({
      model: 'custom-gpt', promptTokens: 1, completionTokens: 1
    })).toBeNull()
  })
})
