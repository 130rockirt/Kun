export const USD_TO_CNY_REFERENCE_RATE = 7.2

/**
 * Reference API prices verified for Codex subscription value estimates on
 * 2026-08-18. They describe value only, never an account charge.
 */
const PRICES_PER_MILLION: Record<string, {
  input: number
  cacheRead: number
  output: number
}> = {
  'gpt-5.6-sol': { input: 5, cacheRead: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2.5, cacheRead: 0.25, output: 15 },
  'gpt-5.6-luna': { input: 1, cacheRead: 0.1, output: 6 },
  'gpt-5.5': { input: 5, cacheRead: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cacheRead: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, output: 4.5 }
}

export type CodexSubscriptionEstimate = {
  valueEstimateUsd: number
  valueEstimateCny: number
}

export function estimateCodexSubscriptionValue(input: {
  model: string
  promptTokens: number
  completionTokens: number
  cacheHitTokens?: number
  cacheWriteTokens?: number
}): CodexSubscriptionEstimate | null {
  const prices = PRICES_PER_MILLION[normalizeModelId(input.model)]
  if (!prices) return null
  const cacheRead = nonNegative(input.cacheHitTokens)
  const freshInput = Math.max(
    nonNegative(input.promptTokens) - cacheRead - nonNegative(input.cacheWriteTokens),
    0
  )
  const usd = (
    freshInput * prices.input +
    cacheRead * prices.cacheRead +
    nonNegative(input.completionTokens) * prices.output
  ) / 1_000_000
  return {
    valueEstimateUsd: usd,
    valueEstimateCny: usd * USD_TO_CNY_REFERENCE_RATE
  }
}

function normalizeModelId(model: string): string {
  const withoutLabel = model.trim().toLowerCase().replace(/\s*\([^)]*\)\s*$/u, '')
  const qualified = /^(codex|openai)\/([^/]+)$/u.exec(withoutLabel)
  return qualified?.[2] ?? (withoutLabel.includes('/') || withoutLabel.includes(':') ? '' : withoutLabel)
}

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}
