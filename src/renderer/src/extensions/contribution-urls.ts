import { ExtensionIdSchema } from '@kun/extension-api'
import type { RegisteredContribution } from './contribution-registry'

export function extensionResourceUrl(extensionId: string, relativePath: string): string {
  const safeId = ExtensionIdSchema.parse(extensionId)
  const segments = relativePath.split('/').map((segment) => encodeURIComponent(segment))
  return `kun-extension://${safeId}/${segments.join('/')}`
}

export function extensionHostIconUrl(extensionId: string, relativePath: string): string {
  return `${extensionResourceUrl(extensionId, relativePath)}?kunHostResource=icon`
}

export function resolveContributionCommand(
  contribution: RegisteredContribution,
  command: string
): string {
  if (command.startsWith('builtin:')) return command
  if (contribution.owner.kind === 'builtin') return command.startsWith('extension:') ? '' : command
  const prefix = `extension:${contribution.owner.extensionId}/`
  if (command.startsWith('extension:')) return command.startsWith(prefix) ? command : ''
  return `${prefix}${command}`
}
