import { describe, expect, it } from 'vitest'
import { activityFrame, activityTip, formatContextGauge } from './activity.js'

describe('TUI activity presentation', () => {
  it('uses distinct one-cell motion for model phases', () => {
    expect(activityFrame('waiting', 0)).toBe('⠋')
    expect(activityFrame('thinking', 0)).toBe('◐')
    expect(activityFrame('responding', 0)).toBe('▏')
    expect(activityFrame('tool', 0)).toBe('◢')
    expect(activityFrame('subagent', 0)).toBe('◇')
    expect(activityFrame('attention', 4)).toBe('◈')
    expect(activityFrame('responding', 1)).not.toBe(activityFrame('responding', 0))
  })

  it('keeps a tip stable for one activity identity and omits attention tips', () => {
    const first = activityTip('tool', 'turn_1:2026-07-24T00:00:00.000Z')
    expect(first).toBeTruthy()
    expect(activityTip('tool', 'turn_1:2026-07-24T00:00:00.000Z')).toBe(first)
    expect(activityTip('attention', 'approval_1')).toBeUndefined()
  })

  it('formats a compact bounded context gauge', () => {
    expect(formatContextGauge(7_100, 500_000)).toBe('7.1k / 500k · 1%')
    expect(formatContextGauge(750_000, 500_000)).toBe('750k / 500k · 150%')
    expect(formatContextGauge(10_000_000, 1)).toBe('10m / 1 · 999%')
  })
})
