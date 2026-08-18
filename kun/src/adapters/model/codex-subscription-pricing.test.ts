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
    expect(value?.valueEstimateUsd).toBeCloseTo(6.1)
    expect(value?.valueEstimateCny).toBeCloseTo(6.1 * USD_TO_CNY_REFERENCE_RATE)
  })

  it('does not invent a price for an unknown model', () => {
    expect(estimateCodexSubscriptionValue({
      model: 'custom-gpt', promptTokens: 1, completionTokens: 1
    })).toBeNull()
  })
})
