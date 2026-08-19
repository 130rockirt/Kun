import { describe, expect, it } from 'vitest'
import {
  aggregateCodexReferenceValue,
  estimateCodexSubscriptionValue,
  resolveCodexUsageProviderId,
  USD_TO_CNY_REFERENCE_RATE
} from './codex-subscription-pricing.js'

describe('estimateCodexSubscriptionValue', () => {
  it('prices clamped cache reads and writes exactly once', () => {
    const value = estimateCodexSubscriptionValue({
      model: ' gpt-5.6-sol ',
      promptTokens: 1_000_000,
      cacheHitTokens: 800_000,
      cacheWriteTokens: 400_000,
      completionTokens: 100_000
    })
    expect(value?.valueEstimateUsd).toBeCloseTo(0.8 + 2.5 + 4.5)
    expect(value?.valueEstimateCny).toBeCloseTo(7.8 * USD_TO_CNY_REFERENCE_RATE)
  })

  it('uses long-context rates for the full request only above 272K input', () => {
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-sol', promptTokens: 272_000, completionTokens: 100_000
    })?.valueEstimateUsd).toBeCloseTo(4.36)
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-sol', promptTokens: 272_001, completionTokens: 100_000
    })?.valueEstimateUsd).toBeCloseTo(7.22001)
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.4-pro', promptTokens: 300_000, completionTokens: 10_000
    })?.valueEstimateUsd).toBeCloseTo(10.8)
  })

  it('uses Fast pricing for supported Priority requests without combining it with long context', () => {
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.5', promptTokens: 100_000, completionTokens: 10_000, serviceTier: 'priority'
    })?.valueEstimateUsd).toBeCloseTo(2)
    const longStandard = estimateCodexSubscriptionValue({
      model: 'gpt-5.6-sol', promptTokens: 272_001, completionTokens: 10
    })
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-sol', promptTokens: 272_001, completionTokens: 10, serviceTier: 'priority'
    })).toEqual(longStandard)
    const unsupportedStandard = estimateCodexSubscriptionValue({
      model: 'gpt-5.3-codex', promptTokens: 1, completionTokens: 1
    })
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.3-codex', promptTokens: 1, completionTokens: 1, serviceTier: 'priority'
    })).toEqual(unsupportedStandard)
  })

  it('uses historical Terra and Luna prices before the July 30 cutoff', () => {
    const before = '2026-07-29T23:59:59.999Z'
    const atCutoff = '2026-07-30T00:00:00.000Z'
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-terra', promptTokens: 200_000, completionTokens: 0, completedAt: before
    })?.valueEstimateUsd).toBeCloseTo(0.5)
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-terra', promptTokens: 200_000, completionTokens: 0, completedAt: atCutoff
    })?.valueEstimateUsd).toBeCloseTo(0.4)
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-luna', promptTokens: 200_000, completionTokens: 0, completedAt: before
    })?.valueEstimateUsd).toBeCloseTo(0.2)
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-luna', promptTokens: 200_000, completionTokens: 0, completedAt: atCutoff
    })?.valueEstimateUsd).toBeCloseTo(0.04)
  })

  it('distinguishes known zero prices from unknown models', () => {
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.3-codex-spark', promptTokens: 1_000, completionTokens: 200
    })?.valueEstimateUsd).toBe(0)
    expect(estimateCodexSubscriptionValue({
      model: 'custom-gpt', promptTokens: 1, completionTokens: 1
    })).toBeNull()
    expect(estimateCodexSubscriptionValue({
      model: 'constructor', promptTokens: 1, completionTokens: 1, serviceTier: 'priority'
    })).toBeNull()
    expect(estimateCodexSubscriptionValue({
      model: 'toString-2026-08-01', promptTokens: 1, completionTokens: 1
    })).toBeNull()
  })

  it('normalizes trusted aliases without fuzzy matching', () => {
    expect(estimateCodexSubscriptionValue({
      model: 'openai/gpt-5.6 (current)', promptTokens: 200_000, completionTokens: 0
    })?.valueEstimateUsd).toBeCloseTo(1)
    expect(estimateCodexSubscriptionValue({
      model: 'codex/gpt-5.6-sol-2099-01-01', promptTokens: 1, completionTokens: 1
    })).not.toBeNull()
    expect(estimateCodexSubscriptionValue({
      model: 'openai/gpt-5.4-mini-2026-08-01', promptTokens: 1, completionTokens: 1
    })).not.toBeNull()
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-2026-08-01', promptTokens: 1, completionTokens: 1
    })).not.toBeNull()
    expect(estimateCodexSubscriptionValue({
      model: 'custom/gpt-5.6-luna', promptTokens: 1, completionTokens: 1
    })).toBeNull()
  })

  it('clamps negative and non-finite token values', () => {
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-sol',
      promptTokens: -10,
      cacheHitTokens: Number.POSITIVE_INFINITY,
      cacheWriteTokens: -1,
      completionTokens: Number.NaN
    })?.valueEstimateUsd).toBe(0)
  })

  it('does not bill provider-reported reasoning a second time', () => {
    const base = estimateCodexSubscriptionValue({
      model: 'gpt-5.6-sol', promptTokens: 100, completionTokens: 20
    })
    expect(estimateCodexSubscriptionValue({
      model: 'gpt-5.6-sol', promptTokens: 100, completionTokens: 20, reasoningTokens: 10_000
    })).toEqual(base)
  })
})

describe('aggregateCodexReferenceValue', () => {
  it('reports complete zero-price, partial mixed, and unavailable unknown coverage', () => {
    expect(aggregateCodexReferenceValue([{
      model: 'gpt-5.3-codex-spark', promptTokens: 100, completionTokens: 20
    }])).toMatchObject({ amountUsd: 0, coverage: 'complete', pricedRequests: 1, unpricedRequests: 0 })

    expect(aggregateCodexReferenceValue([
      { model: 'gpt-5.6-sol', promptTokens: 100, completionTokens: 20, requestCount: 2 },
      { model: 'unknown', promptTokens: 100, completionTokens: 20 }
    ])).toMatchObject({ coverage: 'partial', pricedRequests: 2, unpricedRequests: 1 })

    expect(aggregateCodexReferenceValue([{
      model: 'unknown', promptTokens: 100, completionTokens: 20
    }])).toEqual({
      amountUsd: null,
      amountCny: null,
      coverage: 'unavailable',
      pricedRequests: 0,
      unpricedRequests: 1
    })
  })
})

describe('resolveCodexUsageProviderId', () => {
  it('keeps explicit accounts isolated and only assigns legacy usage to one account', () => {
    expect(resolveCodexUsageProviderId('codex-work', ['codex-work', 'codex-personal']))
      .toBe('codex-work')
    expect(resolveCodexUsageProviderId('codex-other', ['codex-work', 'codex-personal']))
      .toBeNull()
    expect(resolveCodexUsageProviderId(undefined, ['codex-work'])).toBe('codex-work')
    expect(resolveCodexUsageProviderId(undefined, ['codex-work', 'codex-personal'])).toBeNull()
  })
})
