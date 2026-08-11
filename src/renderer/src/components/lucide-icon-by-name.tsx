import { icons, Bot, type LucideProps } from 'lucide-react'
import type { ReactElement } from 'react'

function isLucideIconName(name: string): name is keyof typeof icons {
  return Object.prototype.hasOwnProperty.call(icons, name)
}

/**
 * Renders a lucide icon by its PascalCase name, falling back to `Bot` for
 * unknown or stale names (e.g. an icon removed in a lucide upgrade, or a row
 * persisted by an older build). Keeps stored strings safe to render blindly.
 */
export function LucideIconByName({
  name,
  ...props
}: { name: string } & LucideProps): ReactElement {
  const Icon = isLucideIconName(name) ? icons[name] : Bot
  return <Icon {...props} />
}
