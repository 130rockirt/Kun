import { describe, expect, it } from 'vitest'
import { geminiCliSubscriptionModels } from './gemini-cli-subscription'

describe('geminiCliSubscriptionModels', () => {
  it('returns the direct Gemini CLI API catalog without Antigravity-only ids', () => {
    expect(geminiCliSubscriptionModels()).toEqual([
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash'
    ])
    expect(geminiCliSubscriptionModels()).not.toContain('gemini-3.6-flash')
  })
})
