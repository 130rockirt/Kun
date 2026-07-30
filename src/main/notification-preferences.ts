import type { NotificationConfigV1 } from '../shared/app-settings'
import type { TurnCompleteNotificationSource } from '../shared/kun-gui-api'

export type TurnCompleteNotificationDisabledReason = 'disabled' | 'source-disabled'

export function turnCompleteNotificationDisabledReason(
  settings: NotificationConfigV1,
  source: TurnCompleteNotificationSource
): TurnCompleteNotificationDisabledReason | undefined {
  if (!settings.turnComplete) return 'disabled'
  if (source === 'subagent') {
    return settings.subagentTurnComplete === true ? undefined : 'source-disabled'
  }
  return settings.mainAgentTurnComplete === false ? 'source-disabled' : undefined
}
