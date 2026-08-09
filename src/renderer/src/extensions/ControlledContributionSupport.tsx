import { Puzzle } from 'lucide-react'
import type { ReactElement } from 'react'
import { extensionHostIconUrl, type RegisteredContribution } from './contribution-registry'
import { boundedPlainText } from './safe-text'

export function plainText(value: string, max = 256): string {
  return boundedPlainText(value, max)
}

export function isTrustedNotificationActivation(event: {
  nativeEvent: { isTrusted: boolean }
}): boolean {
  return event.nativeEvent.isTrusted === true
}

export function ContributionIcon({
  contribution
}: {
  contribution: RegisteredContribution
}): ReactElement {
  const icon = 'icon' in contribution.payload ? contribution.payload.icon : undefined
  if (icon && contribution.owner.kind === 'extension') {
    return (
      <img
        src={extensionHostIconUrl(contribution.owner.extensionId, icon)}
        alt=""
        aria-hidden="true"
        className="h-4 w-4 shrink-0 object-contain"
      />
    )
  }
  return <Puzzle className="h-4 w-4 shrink-0" aria-hidden />
}
