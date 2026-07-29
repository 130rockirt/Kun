import { describe, expect, it } from 'vitest'
import type { NotificationConfigV1 } from '../shared/app-settings'
import { turnCompleteNotificationDisabledReason } from './notification-preferences'

function preferences(
  overrides: Partial<NotificationConfigV1> = {}
): NotificationConfigV1 {
  return {
    turnComplete: true,
    mainAgentTurnComplete: true,
    subagentTurnComplete: false,
    ...overrides
  }
}

describe('turn completion notification preferences', () => {
  it('blocks every source when the master switch is off', () => {
    const settings = preferences({
      turnComplete: false,
      mainAgentTurnComplete: true,
      subagentTurnComplete: true
    })

    expect(turnCompleteNotificationDisabledReason(settings, 'main-agent')).toBe('disabled')
    expect(turnCompleteNotificationDisabledReason(settings, 'subagent')).toBe('disabled')
  })

  it('applies main-agent and subagent switches independently', () => {
    const mainDisabled = preferences({
      mainAgentTurnComplete: false,
      subagentTurnComplete: true
    })
    expect(turnCompleteNotificationDisabledReason(mainDisabled, 'main-agent'))
      .toBe('source-disabled')
    expect(turnCompleteNotificationDisabledReason(mainDisabled, 'subagent')).toBeUndefined()

    const subagentDisabled = preferences({
      mainAgentTurnComplete: true,
      subagentTurnComplete: false
    })
    expect(turnCompleteNotificationDisabledReason(subagentDisabled, 'main-agent')).toBeUndefined()
    expect(turnCompleteNotificationDisabledReason(subagentDisabled, 'subagent'))
      .toBe('source-disabled')
  })

  it('uses safe legacy defaults when source fields are missing', () => {
    const legacy = { turnComplete: true }

    expect(turnCompleteNotificationDisabledReason(legacy, 'main-agent')).toBeUndefined()
    expect(turnCompleteNotificationDisabledReason(legacy, 'subagent')).toBe('source-disabled')
  })
})
