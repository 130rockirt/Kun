import { describe, expect, it } from 'vitest'
import { normalizeTurnLimits } from './turn-limits.js'

describe('normalizeTurnLimits', () => {
  it('leaves model steps unlimited by default', () => {
    expect(normalizeTurnLimits(undefined)).toEqual({
      maxWallTimeMs: 15 * 60_000,
      maxToolCallsPerStep: 32
    })
  })

  it('normalizes an explicitly configured model-step limit', () => {
    expect(normalizeTurnLimits({ maxSteps: 7.9 }).maxSteps).toBe(7)
  })
})
